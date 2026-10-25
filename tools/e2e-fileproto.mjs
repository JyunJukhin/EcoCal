/** 复现用户环境：file:// 直接打开 index.html，检查设置页安全 Tab */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9251;
const FILE_URL = 'file:///D:/Projects/EcoCal/index.html?demo=1';
const profile = mkdtempSync(join(tmpdir(), 'e2e-file-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900',
  '--disable-extensions', FILE_URL,
], { stdio: 'ignore' });

let pass = 0;
const check = (name, ok, detail) => { if (ok) pass++; console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '  [' + detail + ']' : '')); };

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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
  return { async send(method, params = {}) { await ready; return new Promise(r => { const i = ++id; pending.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); }); } };
})();
await cdp.send('Runtime.enable');
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
  if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result.result.value;
}

try {
  await sleep(2000);
  check('页面就绪（file:// + ?demo=1）', await evaluate(`!!window.__EcoCal && window.__EcoCal.state.assets.length === 7`));
  const proto = await evaluate(`location.protocol`);
  check('协议 = file:', proto === 'file:', proto);

  await evaluate(`window.__EcoCal.openSettings()`);
  await sleep(400);
  const tabInfo = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.set-tab')).map(t => t.dataset.tab))`);
  const tabs = JSON.parse(tabInfo);
  check('有 4 个 Tab', tabs.length === 4, tabs.join(','));

  await evaluate(`Array.from(document.querySelectorAll('.set-tab')).find(t => t.dataset.tab === 'security').click()`);
  await sleep(200);
  const sec = await evaluate(`(() => {
    const pane = Array.from(document.querySelectorAll('.set-pane')).find(p => p.dataset.tab === 'security');
    return JSON.stringify({ exists: !!pane, len: pane ? pane.textContent.trim().length : -1,
      pinToggle: !!document.getElementById('s-pin-toggle'),
      pin: !!document.getElementById('s-pin'), reset: !!document.getElementById('s-pin-reset'),
      html: pane ? pane.innerHTML.slice(0, 80) : '' });
  })()`);
  const s = JSON.parse(sec);
  check('安全 pane 存在且有内容', s.exists === true && s.len > 20, 'len=' + s.len);
  check('s-pin-toggle / s-pin / s-pin-reset 存在', s.pinToggle && s.pin && s.reset);
  const sec2 = await evaluate(`(() => {
    const icon = document.querySelector('.set-tab[data-tab="security"]');
    return JSON.stringify({
      tabText: icon ? icon.textContent.trim() : '',
      paneLen: Array.from(document.querySelectorAll('.set-pane')).find(p => p.dataset.tab === 'security').textContent.trim().length,
    });
  })()`);
  const s2 = JSON.parse(sec2);
  check('安全 Tab 含「安全」字样', s2.tabText.includes('安全'), s2.tabText);
  check('安全 pane 内容全量（截取200字）', s2.paneLen > 100, 'len=' + s2.paneLen);

  console.log(`\n结果：${pass}/10 项通过`);
  process.exit(pass >= 8 ? 0 : 1);
} catch (e) {
  console.error('E2E 异常：', e.message);
  process.exit(1);
} finally {
  try { chrome.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
