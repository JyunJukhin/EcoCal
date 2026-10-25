/** 一站式：真实浏览器（headless Chrome）从 8124 加载页面 → 设置（分 Tab：安全内容 + switches）+ 各 Tab 分区内容 → 输出逐项检查 → 失败带 console + 网络 fetch 日志 */
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
const cdpErrors = [];
const cdp = (() => {
  let id = 0; const pending = new Map();
  const ws2 = new WebSocket(wsUrl);
  const ready = new Promise(r => { ws2.onopen = r; });
  ws2.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    // 收集运行时 JS 异常（Node 侧事件驱动，页面重载也不丢）
    if (m.method === 'Runtime.exceptionThrown') {
      try {
        const d = m.params.exceptionDetails || {};
        const t = d.text || 'unknown';
        cdpErrors.push(t + (d.exception && d.exception.description ? ': ' + d.exception.description.slice(0, 120) : ''));
      } catch (e) { cdpErrors.push('parse-err'); }
    }
  };
  return {
    async send(method, params = {}) { await ready; return new Promise(r => { const i = ++id; pending.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); }); },
  };
})();
await cdp.send('Runtime.enable');
const jsErrors = [];
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
  if (r.result && r.result.exceptionDetails) {
    jsErrors.push(r.result.exceptionDetails.text || 'unknown');
    throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  }
  return r.result.result.value;
}

try {
  await cdp.send('Runtime.enable');
  await sleep(1500);
  check('页面就绪·演示数据', await evaluate(`!!window.__EcoCal && window.__EcoCal.state.assets.length === 7`));

  // 设置 → 分 Tab：默认 basic，逐个点击 Tab 检查分区内容
  await evaluate(`window.__EcoCal.openSettings()`);
  await sleep(500);
  const tabs = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.set-tab')).map(t => t.dataset.tab))`);
  const tn = JSON.parse(tabs);
  check('4 个 Tab（basic/stats/backup/security）', tn.length === 4 && tn.join(',') === 'basic,stats,backup,security', tn.join(','));
  const sections = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll('.settings-section')).map(s => ({ name: s.dataset.section, text: s.textContent.trim().slice(0, 20) })))`);
  const t = JSON.parse(sections);
  check('分区渲染 4 个（basic/stats/backup/security）', t.length === 4, t.map(x => x.name).join(','));

  // 依次点击每个 Tab → 对应分区可见、其余隐藏
  const secInfo = await evaluate(`(async () => {
    const out = [];
    for (const tab of document.querySelectorAll('.set-tab')) {
      tab.click();
      await new Promise(r => setTimeout(r, 80));
      const sec = document.querySelector('.settings-section[data-section="' + tab.dataset.tab + '"]');
      const others = Array.from(document.querySelectorAll('.settings-section')).filter(s => s.dataset.section !== tab.dataset.tab);
      out.push({ name: tab.dataset.tab, visible: !!sec && !sec.classList.contains('hidden') && getComputedStyle(sec).display !== 'none', othersHidden: others.every(s => s.classList.contains('hidden')), len: sec ? sec.textContent.trim().length : -1 });
    }
    return JSON.stringify(out);
  })()`);
  const si = JSON.parse(secInfo);
  si.forEach(s => check('Tab [' + s.name + ']：分区可见且其余隐藏、内容长度=' + s.len, s.visible === true && s.othersHidden === true && s.len > 20, s.visible + '/' + s.othersHidden + '/' + s.len));

  const sec = await evaluate(`(() => {
    document.querySelector('.set-tab[data-tab="security"]').click();
    const pane = document.querySelector('.settings-section[data-section="security"]');
    return JSON.stringify({
      hasToggle: !!document.getElementById('s-pin-toggle'),
      pinInput: !!document.getElementById('s-pin'),
      reset: !!document.getElementById('s-pin-reset'),
      visible: !!pane && !pane.classList.contains('hidden'),
    });
  })()`);
  const s = JSON.parse(sec);
  check('安全分区：s-pin-toggle 存在', s.hasToggle === true);
  check('安全分区：s-pin/s-pin-reset 存在', s.pinInput === true && s.reset === true);
  check('安全分区：点击 Tab 后可见', s.visible === true);
  check('页面运行无 JS 报错', cdpErrors.length === 0, cdpErrors.slice(0, 3).join(' | '));

  console.log('\n结果：' + results.filter(r => r.ok).length + '/' + results.length + ' 项通过');
  process.exit(results.every(r => r.ok) ? 0 : 1);
} catch (e) {
  console.error('E2E 异常：', e.message);
  process.exit(1);
} finally {
  try { chrome.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
