/**
 * 深色模式浏览器端到端验证（headless Chrome + CDP）
 * 流程：打开 ?demo=1 → 打开设置 → 切「外观」Tab → 选深色 → 断言 data-theme + 计算样式
 * 运行：node tools/e2e-theme-dark.mjs
 */
import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const PROFILE = 'D:\\Projects\\EcoCal\\.e2e-theme-profile';
const BASE = 'http://127.0.0.1:8123/?demo=1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 启动 headless Chrome ----
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', BASE,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

let ws;
try {
  // 等 CDP 端口（headless 冷启动较慢，最多 15 秒）
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      targets = await res.json();
      if (targets && targets.length) break;
    } catch (e) {}
  }
  if (!targets || !targets.length) throw new Error('CDP 未就绪\nChrome stderr:\n' + chromeErr);
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('无页面 target：' + JSON.stringify(targets.map(t => t.type)) + '\nChrome stderr:\n' + chromeErr);
  ws = new WebSocket(page.webSocketDebuggerUrl);

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++send._id;
    const handler = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', handler); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
  send._id = 0;
  await new Promise(res => ws.addEventListener('open', res));

  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('evaluate 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  // 等应用就绪
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(`!!window.__EcoCal && !!document.getElementById('main-tabs')`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }

  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

  // 1) 初始为无 data-theme（跟随系统或未设置）
  const initialTheme = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  check('初始 data-theme 为空（auto）', initialTheme === null, `attr=${initialTheme}`);

  // 2) 打开设置面板
  await evaluate(`window.__EcoCal.openSettings(); true`);
  await sleep(300);

  // 3) 切到「外观」Tab
  const themeTab = await evaluate(`
    (() => {
      const tabs = document.querySelectorAll('.set-tab');
      const t = Array.from(tabs).find(x => x.dataset.tab === 'appearance');
      if (!t) return 'no-tab';
      t.click();
      return 'ok';
    })()
  `);
  check('设置页有「外观」Tab', themeTab === 'ok', themeTab);

  // 4) 外观分区可见
  const secVisible = await evaluate(`
    (() => {
      const sec = document.querySelector('.settings-section[data-section="appearance"]');
      return sec ? !sec.classList.contains('hidden') && sec.offsetParent !== null : 'no-sec';
    })()
  `);
  check('外观分区可见', secVisible === true, String(secVisible));

  // 5) 主题下拉存在
  const hasSelect = await evaluate(`!!document.getElementById('s-theme')`);
  check('存在 #s-theme 下拉', hasSelect === true);

  // 6) 选深色 → data-theme=dark + 计算样式背景变暗
  const darkResult = await evaluate(`
    (() => {
      const sel = document.getElementById('s-theme');
      sel.value = 'dark';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const attr = document.documentElement.getAttribute('data-theme');
      const bg = getComputedStyle(document.body).backgroundColor;
      const card = getComputedStyle(document.querySelector('.asset-card') || document.body).backgroundColor;
      return { attr, bg, card };
    })()
  `);
  check('选深色 → data-theme="dark"', darkResult.attr === 'dark', JSON.stringify(darkResult));
  check('深色下 body 背景为暗色', /rgba?\(2[0-9],/.test(darkResult.bg) || /#1a1a1e/.test(darkResult.bg), darkResult.bg);

  // 7) 选浅色 → data-theme 移除
  const lightResult = await evaluate(`
    (() => {
      const sel = document.getElementById('s-theme');
      sel.value = 'light';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return document.documentElement.getAttribute('data-theme');
    })()
  `);
  check('选浅色 → data-theme 移除（浅色模式）', lightResult === null, `attr=${lightResult}`);

  // 8) 选跟随系统 → 无 data-theme（headless 默认浅色偏好）
  const autoResult = await evaluate(`
    (() => {
      const sel = document.getElementById('s-theme');
      sel.value = 'auto';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { attr: document.documentElement.getAttribute('data-theme'), mode: window.__EcoCal.state.settings.themeMode };
    })()
  `);
  check('选自动 → themeMode=auto', autoResult.mode === 'auto', JSON.stringify(autoResult));

  // 9) 持久化：localStorage 里 settings.themeMode 是 dark（回写一次再断言）
  await evaluate(`
    (() => {
      const sel = document.getElementById('s-theme');
      sel.value = 'dark';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()
  `);
  const persisted = await evaluate(`(() => { const d = localStorage.getItem('ecocal.data.v1'); if (!d) return null; try { return JSON.parse(d).settings.themeMode; } catch(e) { return 'err'; } })()`);
  check('themeMode=dark 已持久化到 localStorage', persisted === 'dark', `persisted=${persisted}`);

  // 输出
  let pass = 0, fail = 0;
  for (const r of results) {
    if (r.ok) { pass++; console.log(`✓ ${r.name}`); }
    else { fail++; console.log(`✗ ${r.name}  ${r.detail}`); }
  }
  console.log(`\n深色模式 e2e：${pass} 通过，${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  try { ws && ws.close(); } catch (e) {}
  chrome.kill();
  setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} }, 1000);
}
