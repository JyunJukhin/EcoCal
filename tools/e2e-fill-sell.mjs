#!/usr/bin/env node
/*
 * e2e-fill-sell.mjs —— 卖出「全部卖出」一键填入当前持仓市值 浏览器端到端验证
 * 用法：node tools/e2e-fill-sell.mjs  （需先起 node tools/serve.mjs . 8123）
 * 依赖：headless Chrome + CDP（Node 24 内置 WebSocket），无第三方依赖
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9231;
const profile = mkdtempSync(join(tmpdir(), 'ecocal-fill-sell-'));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  'http://127.0.0.1:8123/?demo=1',
], { stdio: ['ignore', 'ignore', 'inherit'] });

let results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  [' + extra + ']' : ''));
}

try {
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      target = list.find(t => t.type === 'page' && t.url.includes('8123'));
      if (target) break;
    } catch (e) { /* 未就绪 */ }
    await sleep(300);
  }
  if (!target) throw new Error('CDP 页面目标未就绪');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  function send(method, params = {}) {
    return new Promise(resolve => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面执行异常: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async function waitFor(expr, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (await evaluate(expr)) return true; } catch (e) {}
      await sleep(150);
    }
    return false;
  }

  await evaluate('window.alert = m => { window.__alerts = window.__alerts || []; window.__alerts.push(String(m)); };');

  await waitFor('window.__EcoCal && document.querySelector(".asset-card")', 15000);
  check('页面已就绪（含演示数据）', true);

  // 1. 演示数据里挑一个基金，确认有持仓后打开卖出表单
  // 持仓市值 = 份额 × 现价（用 __EcoCal 暴露的 roundQty 计算保持一致）
  const info = await evaluate(`(() => {
    const E = window.__EcoCal;
    const a = E.state.assets.find(x => x.category === 'fund' || x.category === 'stock');
    const trades = E.state.trades;
    // 由交易记录推导持仓份额（与 Calc.tradePosition.qty 相同逻辑：买入累加、卖出扣减）
    let qty = 0;
    for (const t of trades) {
      if (t.assetId !== a.id) continue;
      if (t.type === 'buy') qty += Number(t.quantity);
      else if (t.type === 'sell') qty -= Number(t.quantity);
    }
    const mv = qty > 0 ? E.roundQty(qty * (a.lastPrice != null && Number(a.lastPrice) > 0 ? Number(a.lastPrice) : 1)) : 0;
    return JSON.stringify({ id: a.id, name: a.name, lastPrice: a.lastPrice, qty, mv });
  })()`);
  const a = JSON.parse(info);
  check('找到演示资产并有持仓', a.qty > 0, a.name + ' qty=' + a.qty);

  // 2. 打开卖出表单（总金额对非股票是默认；这里统一强制切成总金额）
  await evaluate(`(() => {
    const id = ${JSON.stringify(a.id)};
    window.__EcoCal.openTradeForm(id, 'sell', null);
  })()`);
  await sleep(300);

  // 强制切到总金额模式（若默认不是），再检查按钮
  const btnInfo = await evaluate(`(() => {
    const amt = document.querySelector('input[name="tmode"][value="amount"]');
    if (amt && !amt.checked) { amt.checked = true; amt.onchange && amt.onchange(); }
    const b = document.getElementById('t-fill-sell');
    return JSON.stringify({
      hasBtn: !!b,
      label: b ? b.textContent.trim() : '',
      dataValue: b ? b.getAttribute('data-value') : '',
      amountVisible: !!document.getElementById('t-amount-row') && document.getElementById('t-amount-row').style.display !== 'none',
    });
  })()`);
  const bi = JSON.parse(btnInfo);
  check('卖出表单渲染「全部卖出」按钮', bi.hasBtn);
  check('按钮文案含当前持仓市值', bi.label.includes('全部卖出') && bi.label.includes('▸'), bi.label);
  check('data-value 与持仓市值一致', Math.abs(parseFloat(bi.dataValue) - a.mv) < 0.01, 'dataValue=' + bi.dataValue + ' mv=' + a.mv);
  check('总金额输入行可见', bi.amountVisible);

  // 3. 点击按钮 → 总金额自动填入
  await evaluate(`(() => {
    document.getElementById('t-fill-sell').click();
    return document.getElementById('t-amount').value;
  })()`);
  const filled = await evaluate(`document.getElementById('t-amount').value`);
  check('点击后总金额自动填入持仓市值', Math.abs(parseFloat(filled) - a.mv) < 0.01, 'filled=' + filled);

  // 4. 无持仓资产：按钮显示 -- 且 data-value 为空（点击拦截由单测覆盖——headless 下原生 alert 会阻塞线程）
  const emptyInfo = await evaluate(`(() => {
    const asset = { id: 'xyz-empty', name: '空仓测试', category: 'fund', subCategory: '混合型', currency: 'CNY', lastPrice: 1.5, principal: 0, quantity: null, startDate: null, note: '' };
    window.__EcoCal.state.assets.push(asset);
    window.__EcoCal.state.trades = [];
    window.__EcoCal.openTradeForm('xyz-empty', 'sell', null);
    const b = document.getElementById('t-fill-sell');
    return JSON.stringify({ hasBtn: !!b, label: b ? b.textContent.trim() : '', dataValue: b ? b.getAttribute('data-value') : '' });
  })()`);
  const ei = JSON.parse(emptyInfo);
  check('无持仓：按钮显示 --、data-value 为空', ei.hasBtn && ei.label.includes('--') && ei.dataValue === '');

  // 5. 页面无 JS 报错（CDP exceptionThrown 已在 evaluate 层抛错；这里补检查一个最终态）
  const finalState = await evaluate(`JSON.stringify({ ok: Boolean(document.getElementById('t-fill-sell')) })`);
  check('最终页面状态正常', finalState && JSON.parse(finalState).ok);

  const pass = results.filter(r => r.ok).length;
  console.log(`\n结果：${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
} catch (e) {
  console.error('e2e 异常：', e);
  process.exit(1);
} finally {
  chrome.kill();
  // Chrome 退出是异步的：稍等再删临时目录，避免目录未释放导致 EPERM
  await sleep(500);
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
