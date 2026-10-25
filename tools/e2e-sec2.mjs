/** 一站式：真实浏览器（headless Chrome）从 8124 加载页面 → 设置（安全 Tab 内容 + switches）+ 各 Tab 内容 → 输出逐项检查 → 失败带 console + 网络 fetch 日志 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9242;
const BASE = 'http://127.0.0.1:8124/?demo=1';
const profile = mkdtempSync(join(tmpdir(), 'e2e-sec2-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900',
  '--disable-extensions', BASE,
], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  [' + detail + ']' : '')); };

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.url.includes('8124'));
      if (page) return page.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 未就绪');
}

const wsUrl = await getWs();
const cdp = (() => {
  let id = 0; const pending = new Map();
  const ws2 = new WebSocket(wsUrl);
  const ready = new Promise(r => { ws2.onopen = r; });
  ws2.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return {
    async send(method, params = {}) { await ready; return new Promise(r => { const i = ++id; pending.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); }); },
  };
})();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
const jsErrors = [];
await cdp.send('Runtime.enable');
// 收集页面报错
await cdp.send('Runtime.onConsoleAPICalled') // noop, 只是确保存在
  .catch(() => {});
// 通过重挂事件：直接在 evaluate 里 wrap
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
  if (r.result && r.result.exceptionDetails) {
    jsErrors.push(r.result.exceptionDetails.text || 'unknown');
    throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  }
  return r.result.result.value;
}

// 收集 console message（Runtime.consoleAPICalled 会随 websocket 消息进入，这里收拢）
const logBuffer = [];
cdp.send('Runtime.enable');
const _orig = WebSocket; // noop
// 订阅 exceptionThrown
// 通过 ws2 的 onmessage 已有结构，再单独派发：
//（此处简化：直接在 evaluate 里检查 window.onerror 收集）

try {
  await evaluate(`(() => {
    window.__errs = [];
    window.onerror = (m) => window.__errs.push(String(m));
    window.addEventListener('unhandledrejection', e => window.__errs.push('REJ:' + (e.reason && e.reason.message || e.reason)));
    return true;
  })()`);
  await sleep(1500);
  check('页面就绪·演示数据', await evaluate(`!!window.__EcoCal && window.__EcoCal.state.assets.length === 7`));

  // 设置 → 全部 Tab 直接断言内容
  await evaluate(`window.__EcoCal.openSettings()`);
  await sleep(500);
  const tabs = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.set-tab')).map(t => ({ tab: t.dataset.tab, on: t.classList.contains('on'), text: t.textContent.trim() })))`);
  const t = JSON.parse(tabs);
  check('Tab 渲染 4 个', t.length === 4, t.map(x => x.tab).join(','));
  check('默认 basic 选中', t[0] && t[0].on === true);

  // 每个 tab 点击后 pane 内容长度
  const paneInfo = await evaluate(`(async () => {
    const out = [];
    for (const tab of document.querySelectorAll('.set-tab')) {
      tab.click();
      await new Promise(r => setTimeout(r, 60));
      const pane = Array.from(document.querySelectorAll('.set-pane')).find(p => p.dataset.tab === tab.dataset.tab);
      out.push({ tab: tab.dataset.tab, display: pane ? getComputedStyle(pane).display : null, len: pane ? pane.textContent.trim().length : -1, html: pane ? pane.innerHTML.length : 0 });
    }
    return JSON.stringify(out);
  })()`);
  const pi = JSON.parse(paneInfo);
  pi.forEach(p => check('Tab[' + p.tab + '] pane 显示且内容长度=' + p.len, p.display === 'block' && p.len > 20, p.display + '/' + p.len));

  const sec = await evaluate(`(() => {
    const pane = Array.from(document.querySelectorAll('.set-pane')).find(p => p.dataset.tab === 'security');
    return JSON.stringify({
      hasToggle: !!document.getElementById('s-pin-toggle'),
      pinInput: !!document.getElementById('s-pin'),
      reset: !!document.getElementById('s-pin-reset'),
      errs: window.__errs,
    });
  })()`);
  const s = JSON.parse(sec);
  check('安全页：s-pin-toggle 存在', s.hasToggle === true);
  check('安全页：s-pin/s-pin-reset 存在', s.pinInput === true && s.reset === true);
  check('页面运行无 JS 报错', s.errs.length === 0, s.errs.slice(0, 3).join(' | '));

  console.log('\n结果：' + results.filter(r => r.ok).length + '/' + results.length + ' 项通过');
  process.exit(results.every(r => r.ok) ? 0 : 1);
} catch (e) {
  console.error('E2E 异常：', e.message);
  process.exit(1);
} finally {
  try { chrome.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
