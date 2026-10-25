#!/usr/bin/env node
/*
 * e2e-settings-tabs.mjs —— 设置页分 Tab（汇率与行情/统计/备份/安全）+ 备份提醒 浏览器端到端验证
 * 用法：node tools/e2e-settings-tabs.mjs  （需先起 node tools/serve.mjs . 8123）
 * 依赖：headless Chrome + CDP（Node 24 内置 WebSocket），无第三方依赖
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9229;
const profile = mkdtempSync(join(tmpdir(), 'ecocal-set-tab-'));

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
      if (await evaluate(expr)) return true;
      await sleep(150);
    }
    return false;
  }

  // 覆盖 alert（headless 下 alert 会阻塞主线程）
  await evaluate('window.alert = m => { window.__alerts = window.__alerts || []; window.__alerts.push(String(m)); };');

  await waitFor('window.__EcoCal && document.querySelector(".asset-card")', 15000);
  check('设置面板可打开前页面已就绪（含演示数据）', true);

  // 1. 打开设置
  await evaluate('window.__EcoCal.openSettings()');
  await sleep(300);

  // 2. Tab 结构断言
  const exprTabInfo = [
    "(() => {",
    "  const tabs = Array.from(document.querySelectorAll('.set-tab'));",
    "  const sections = Array.from(document.querySelectorAll('.settings-section'));",
    "  const basic = tabs.find(t => t.dataset.tab === 'basic');",
    "  const basicSec = sections.find(s => s.dataset.section === 'basic');",
    "  const backupSec = sections.find(s => s.dataset.section === 'backup');",
    "  return JSON.stringify({",
    "    tabCount: tabs.length,",
    "    tabNames: tabs.map(t => t.dataset.tab),",
    "    sectionCount: sections.length,",
    "    basicOn: !!basic && basic.classList.contains('on'),",
    "    basicVisible: !!basicSec && !basicSec.classList.contains('hidden'),",
    "    backupHidden: !!backupSec && backupSec.classList.contains('hidden'),",
    "    hasRemEnabled: !!document.getElementById('rem-enabled'),",
    "    hasRemDays: !!document.getElementById('rem-days'),",
    "    hasSclear: !!document.getElementById('s-clear'),",
    "    hasPinToggle: !!document.getElementById('s-pin-toggle'),",
    "    hasWdB: !!document.getElementById('wd-backup'),",
    "    hasGB: !!document.getElementById('g-backup'),",
    "  });",
    "})()",
  ].join('\n');
  const tabInfo = await evaluate(exprTabInfo);
  const t = JSON.parse(tabInfo);
  check('设置页：4 个 Tab（basic/stats/backup/security）', t.tabCount === 4 && t.tabNames.join(',') === 'basic,stats,backup,security', t.tabNames.join(','));
  check('设置页：4 个分区', t.sectionCount === 4, String(t.sectionCount));
  check('设置页：默认 basic 选中且显示、backup 隐藏', t.basicOn && t.basicVisible && t.backupHidden);
  check('设置页：备份页含备份提醒开关与天数', t.hasRemEnabled && t.hasRemDays);
  check('设置页：备份页含数据管理（清空）', t.hasSclear);
  check('设置页：含 WebDAV 与 Gitee 面板', t.hasWdB && t.hasGB);
  check('设置页：安全页含 PIN 设置', t.hasPinToggle);

  // 3. 点击「备份」Tab → backup 显示、basic 隐藏
  const exprSwitch = [
    "(() => {",
    "  const backupTab = document.querySelector('.set-tab[data-tab=\"backup\"]');",
    "  backupTab.click();",
    "  return JSON.stringify({",
    "    backupOn: backupTab.classList.contains('on'),",
    "    basicOn: document.querySelector('.set-tab[data-tab=\"basic\"]').classList.contains('on'),",
    "    backupVisible: !document.querySelector('.settings-section[data-section=\"backup\"]').classList.contains('hidden'),",
    "    basicHidden: document.querySelector('.settings-section[data-section=\"basic\"]').classList.contains('hidden'),",
    "  });",
    "})()",
  ].join('\n');
  const switchInfo = await evaluate(exprSwitch);
  const s2 = JSON.parse(switchInfo);
  check('Tab 切换：点「备份」→ 高亮与分区显隐正确', s2.backupOn && !s2.basicOn && s2.backupVisible && s2.basicHidden);

  // 4. 备份提醒开关：勾选 → 写 settings + 保存
  const exprSetRem = [
    "(() => {",
    "  const rem = document.getElementById('rem-enabled');",
    "  rem.checked = true; rem.dispatchEvent(new Event('change'));",
    "  const days = document.getElementById('rem-days');",
    "  days.value = '14'; days.dispatchEvent(new Event('input'));",
    "  return JSON.stringify({",
    "    enabled: window.__EcoCal.state.settings.backupReminder.enabled,",
    "    days: window.__EcoCal.state.settings.backupReminder.days,",
    "  });",
    "})()",
  ].join('\n');
  const setRem = await evaluate(exprSetRem);
  const r = JSON.parse(setRem);
  check('备份提醒：勾选 N 天 → settings.backupReminder.enabled=true', r.enabled === true);
  check('备份提醒：天数输入 14 → days=14', r.days === 14);

  // 5. 保存后重开设置，开关状态持久化
  // 直接关闭模态框再重开设置
  await evaluate(`document.getElementById('modal-close').click()`);
  await sleep(200);
  await evaluate(`window.__EcoCal.openSettings()`);
  await sleep(300);
  const persisted = await evaluate([
    "(() => {",
    "  const rem = document.getElementById('rem-enabled');",
    "  const days = document.getElementById('rem-days');",
    "  return JSON.stringify({ checked: rem.checked, days: days.value });",
    "})()",
  ].join('\n'));
  const p = JSON.parse(persisted);
  check('备份提醒：重开设置后开关/天数保持', p.checked === true && String(p.days) === '14', JSON.stringify(p));

  // 6. 备份提醒触发：构造「未配置自动备份 + 从未备份 + 超过天数」状态 → 重载 → 出现提醒
  await evaluate([
    "(() => {",
    "  const st = window.__EcoCal.state.settings;",
    "  st.webdav = { enabled: false, lastBackupAt: null, lastError: null };",
    "  st.gitee = { enabled: false, lastBackupAt: null, lastError: null };",
    "  st.backupReminder = { enabled: true, days: 7 };",
    "  window.__EcoCal.saveState();",
    "  return true;",
    "})()",
  ].join('\n'));
  await evaluate(`location.reload(); true`);
  await sleep(500);
  await waitFor('window.__EcoCal', 15000);
  await sleep(300);
  const remind = await evaluate([
    "(() => {",
    "  const okBtn = document.getElementById('confirm-ok');",
    "  const backdrop = document.getElementById('confirm-backdrop');",
    "  const title = document.getElementById('confirm-title');",
    "  return JSON.stringify({",
    "    backdropShown: backdrop && !backdrop.classList.contains('hidden'),",
    "    okText: okBtn ? okBtn.textContent : null,",
    "    title: title ? title.textContent : null,",
    "  });",
    "})()",
  ].join('\n'));
  const rm = JSON.parse(remind);
  check('备份提醒：未备份超 N 天重载 → 提醒弹窗出现', rm.backdropShown === true, rm.title || '');
  check('备份提醒：按钮文案「去备份」', rm.okText === '去备份', String(rm.okText));

  // 7. 点「去备份」→ 打开导出面板
  await evaluate(`document.getElementById('confirm-ok').click()`);
  await sleep(300);
  const exportOpen = await evaluate([
    "(() => {",
    "  const body = document.getElementById('modal-body');",
    "  return !!(body && body.innerHTML.includes('exp-download'));",
    "})()",
  ].join('\n'));
  check('备份提醒：点「去备份」打开导出面板', exportOpen === true);

  // 8. 同一天不再重复提醒（再次重载）
  await evaluate(`location.reload(); true`);
  await sleep(500);
  await waitFor('window.__EcoCal', 15000);
  await sleep(300);
  const remind2 = await evaluate([
    "(() => {",
    "  const backdrop = document.getElementById('confirm-backdrop');",
    "  return !!(backdrop && !backdrop.classList.contains('hidden'));",
    "})()",
  ].join('\n'));
  check('备份提醒：同一天重载不重复弹窗', remind2 === false);

  console.log('\n结果：' + results.filter(x => x.ok).length + '/' + results.length + ' 项通过');
  process.exit(results.every(x => x.ok) ? 0 : 1);
} finally {
  try { chrome.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
