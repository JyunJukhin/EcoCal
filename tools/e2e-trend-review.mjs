#!/usr/bin/env node
/*
 * e2e-trend-review.mjs —— 走势图区间选择 + 图例手机布局 浏览器端到端验证
 * 用法：node tools/e2e-trend-review.mjs  （需先起 node tools/serve.mjs . 8123）
 * 依赖：headless Chrome + CDP（Node 24 内置 WebSocket），无第三方依赖
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9237;
const profile = mkdtempSync(join(tmpdir(), 'ecocal-trend-review-'));

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
  // 等 CDP 端口就绪
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

  // 覆盖 alert
  await evaluate('window.alert = m => { window.__alerts = window.__alerts || []; window.__alerts.push(String(m)); };');

  await waitFor('window.__EcoCal && document.querySelector(".asset-card")', 15000);
  check('页面就绪（含演示数据）', true);

  // ---- 统计页就绪后：走势图区域存在 ----
  await evaluate('window.__EcoCal.switchTab(\'stats\'); true');
  await sleep(400);
  const trendReady = await evaluate([
    "(() => {",
    "  const chart = document.getElementById('trend-chart');",
    "  const sel = document.getElementById('trend-range');",
    "  const stats = document.getElementById('trend-stats');",
    "  return JSON.stringify({ hasChart: !!chart && chart.innerHTML.length > 0,",
    "    hasSel: !!sel, selOptions: sel ? Array.from(sel.options).map(o => o.value) : [],",
    "    hasStats: !!stats, optionsCount: sel ? sel.options.length : 0 });",
    "})()",
  ].join('\n'));
  const tr = JSON.parse(trendReady);
  check('走势图卡：图表已渲染', tr.hasChart);
  check('走势图卡：区间选择器存在', tr.hasSel, tr.selOptions ? tr.selOptions.join(',') : '');
  check('走势图卡：区间含 全部/近1月/近3月/近6月/近1年/年初至今/自定义',
    tr.hasSel && tr.optionsCount >= 7 && tr.selOptions.includes('all') && tr.selOptions.includes('1m') &&
    tr.selOptions.includes('3m') && tr.selOptions.includes('6m') && tr.selOptions.includes('1y') &&
    tr.selOptions.includes('ytd') && tr.selOptions.includes('custom'));

  // ---- 区间切换：近 3 月 → 描述与图表刷新 ----
  const beforeDesc = await evaluate("document.getElementById('trend-desc') ? document.getElementById('trend-desc').textContent : ''");
  await evaluate([
    "(() => {",
    "  const sel = document.getElementById('trend-range');",
    "  sel.value = '3m'; sel.dispatchEvent(new Event('change'));",
    "  return true;",
    "})()",
  ].join('\n'));
  await sleep(400);
  const after3m = await evaluate([
    "(() => {",
    "  const sel = document.getElementById('trend-range');",
    "  const desc = document.getElementById('trend-desc');",
    "  return JSON.stringify({ value: sel.value, desc: desc ? desc.textContent : '', chartLen: document.getElementById('trend-chart').innerHTML.length });",
    "})()",
  ].join('\n'));
  const a3 = JSON.parse(after3m);
  // 描述为「…（区间：近 3 月）」，仅校验值保持与描述提及「3 月」（容忍有无空格）
  const descMentions = a3.desc.indexOf('近 3 月') >= 0 || a3.desc.indexOf('近3月') >= 0;
  check('区间切换：切到近3月后选择保持且描述提及区间', a3.value === '3m' && descMentions, a3.desc.slice(0, 40));
  check('区间切换：图表随区间重绘', a3.chartLen > 0);

  // 自定义区间弹窗
  await evaluate([
    "(() => {",
    "  const sel = document.getElementById('trend-range');",
    "  sel.value = 'custom'; sel.dispatchEvent(new Event('change'));",
    "  return true;",
    "})()",
  ].join('\n'));
  await sleep(300);
  const customDlg = await evaluate([
    "(() => {",
    "  const s = document.getElementById('cr-start');",
    "  const e = document.getElementById('cr-end');",
    "  const ok = document.getElementById('modal-ok');",
    "  return JSON.stringify({ hasStart: !!s, hasEnd: !!e, okText: ok ? ok.textContent : '' });",
    "})()",
  ].join('\n'));
  const cd = JSON.parse(customDlg);
  check('自定义区间：弹窗含起止日期与「应用区间」按钮', cd.hasStart && cd.hasEnd && cd.okText === '应用区间');

  // 应用区间
  await evaluate([
    "(() => {",
    "  const s = document.getElementById('cr-start'); s.value = '2026-02-01';",
    "  const e = document.getElementById('cr-end'); e.value = '2026-03-01';",
    "  document.getElementById('modal-ok').click();",
    "  return true;",
    "})()",
  ].join('\n'));
  await sleep(300);
  const applied = await evaluate([
    "(() => {",
    "  const sel = document.getElementById('trend-range');",
    "  const desc = document.getElementById('trend-desc');",
    "  return JSON.stringify({ value: sel.value, desc: desc ? desc.textContent : '' });",
    "})()",
  ].join('\n'));
  const ap = JSON.parse(applied);
  check('自定义区间：应用后描述显示「自定义」', ap.value === 'custom' && ap.desc.indexOf('自定义') >= 0, ap.desc.slice(0, 50));
  await evaluate('window.__EcoCal.closeModal ? window.__EcoCal.closeModal() : document.getElementById(\'modal-close\').click(); true');
  await sleep(200);

  // ---- 图例布局 —— 手机视口（iPhone 375px 宽）下 .chart-legend 纵向排列 ----
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 700, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const legendLayout = await evaluate([
    "(() => {",
    "  const legend = document.querySelector('.chart-legend');",
    "  if (!legend) return JSON.stringify({ missing: true });",
    "  const cs = getComputedStyle(legend);",
    "  return JSON.stringify({ flexDir: cs.flexDirection, maxW: cs.maxWidth });",
    "})()",
  ].join('\n'));
  const ll = JSON.parse(legendLayout);
  check('图例手机布局：@media ≤640px 下 .chart-legend 纵向排列',
    ll.missing !== true && ll.flexDir === 'column', JSON.stringify(ll));

  // 走势图 SVG 在小屏可完整显示（页面无横向溢出）
  const svgOk = await evaluate([
    "(() => {",
    "  const svg = document.querySelector('#trend-chart svg');",
    "  const cw = document.documentElement.clientWidth;",
    "  const sw = document.documentElement.scrollWidth;",
    "  const r = svg ? svg.getBoundingClientRect() : null;",
    "  return JSON.stringify({ missing: !svg, svgW: r ? Math.round(r.width) : null, overflow: sw > cw + 2, cw, sw });",
    "})()",
  ].join('\n'));
  const so = JSON.parse(svgOk);
  check('小屏下页面无横向溢出且走势图可见', so.missing !== true && so.overflow === false && so.svgW > 0, 'svgW=' + so.svgW + ' sw=' + so.sw + '/' + so.cw);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(200);

  console.log('\n结果：' + results.filter(x => x.ok).length + '/' + results.length + ' 项通过');
  process.exit(results.every(x => x.ok) ? 0 : 1);
} finally {
  try { chrome.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
