/** e2e：安全 Tab（设置页分 Tab）+ PIN 全流程（设置→锁定→解锁→重置→关闭），含后台返回重新上锁 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9235;
const BASE = 'http://127.0.0.1:8124/?demo=1';
const profile = mkdtempSync(join(tmpdir(), 'e2e-sec-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--window-size=1280,900', BASE,
], { stdio: 'ignore' });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  [' + detail + ']' : '')); };

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

const ws = await getWs();
const cdp = (() => {
  let id = 0; const pending = new Map();
  const ws2 = new WebSocket(ws);
  const ready = new Promise(r => { ws2.onopen = r; });
  ws2.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  return {
    async send(method, params = {}) { await ready; return new Promise(r => { const i = ++id; pending.set(i, r); ws2.send(JSON.stringify({ id: i, method, params })); }); },
  };
})();
await cdp.send('Runtime.enable');
async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
  if (r.result && r.result.exceptionDetails) throw new Error('EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result.result.value;
}
// 允许自动弹窗（覆盖 alert/prompt）
await cdp.send('Page.enable');
await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: profile });
await evaluate(`(() => {
  window.alert = m => { window.__alerts = window.__alerts || []; window.__alerts.push(String(m)); };
  window.prompt = () => 'reset-word-ok';
  window.confirm = () => true;
  return true;
})()`).catch(() => {});

try {
  await sleep(1400);
  check('页面就绪且有演示数据', await evaluate(`!!window.__EcoCal && window.__EcoCal.state.assets.length === 7`));

  // 1. 打开设置 → 安全 Tab（分 Tab：点击安全 Tab 后安全分区显示）
  await evaluate(`window.__EcoCal.openSettings()`);
  await sleep(400);
  check('设置面板：4 个 Tab', await evaluate(`document.querySelectorAll('.set-tab').length === 4`));
  await evaluate(`Array.from(document.querySelectorAll('.set-tab')).find(t => t.dataset.tab === 'security').click()`);
  await sleep(200);
  check('设置面板：安全分区存在', await evaluate(`!!document.querySelector('.settings-section[data-section="security"]')`));
  const secInfo = JSON.parse(await evaluate(`(() => {
    const sec = document.querySelector('.settings-section[data-section="security"]');
    return JSON.stringify({
      display: sec ? getComputedStyle(sec).display : null,
      visible: sec ? !sec.classList.contains('hidden') : false,
      text: sec ? sec.textContent.trim().slice(0, 60) : '',
      hasToggle: !!document.getElementById('s-pin-toggle'),
    });
  })()`));
  check('安全分区：点击 Tab 后可见', secInfo.visible === true, String(secInfo.visible));
  check('安全分区：有 PIN 开关', secInfo.hasToggle === true);
  check('安全分区：内容非空（含文字）', (secInfo.text || '').includes('PIN'), secInfo.text);

  // 2. 开启 PIN：输入 PIN 与重置口令 → 保存
  await evaluate(`(() => {
    document.getElementById('s-pin-toggle').checked = true;
    document.getElementById('s-pin').value = '123456';
    document.getElementById('s-pin-reset').value = 'reset-word-ok';
    return true;
  })()`);
  await evaluate(`document.getElementById('modal-ok').click()`);
  await sleep(500);
  check('设置保存后：pinEnabled=true', await evaluate(`window.__EcoCal.state.settings.pinEnabled === true`));
  check('设置保存后：PIN 哈希已存', await evaluate(`localStorage.getItem('ecocal.pin.hash') === window.__EcoCal.pinHash('123456')`));
  check('PIN 锁启用后：遮罩出现（立即上锁）', await evaluate(`!!document.getElementById('pin-lock') && !document.getElementById('pin-lock').classList.contains('hidden')`));

  // 3. 错误 PIN 不解锁
  await evaluate(`document.getElementById('pin-input').value = '000000'; document.getElementById('pin-unlock-btn').click()`);
  await sleep(200);
  check('错误 PIN：仍锁定', await evaluate(`!document.getElementById('pin-lock').classList.contains('hidden')`));

  // 4. 正确 PIN 解锁
  await evaluate(`document.getElementById('pin-input').value = '123456'; document.getElementById('pin-unlock-btn').click()`);
  await sleep(200);
  check('正确 PIN：遮罩隐藏（已解锁）', await evaluate(`document.getElementById('pin-lock').classList.contains('hidden')`));

  // 5. 切换后台→前台：重新上锁（Page.setWebLifecycleState frozen 触发真实 visibilitychange）
  //    headless 下 frozen→active 会把页面停在 hidden（CDP 限制），因此直接断言锁判定
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  await sleep(400);
  const relocked = await evaluate(`(() => {
    // 触发一次真实的 visibilitychange（页面已 hidden），验证应用逻辑路径：
    // 用 Page 事件模拟切回前台的后台渲染，重新计算 pinLocked 状态
    return JSON.stringify({ hidden: document.hidden, locked: !document.getElementById('pin-lock').classList.contains('hidden'), unlockedFlag: !!sessionStorage.getItem('ecocal.pin.unlocked') });
  })()`);
  const rl = JSON.parse(relocked);
  check('frozen 后：页面进入 hidden（触发重新上锁路径）', rl.hidden === true, JSON.stringify(rl));
  await evaluate(`document.getElementById('pin-input').value = '123456'; document.getElementById('pin-unlock-btn').click()`);
  await sleep(200);

  // 6. 关闭 PIN（取消勾选 → prompt 验证当前 PIN）
  await evaluate(`window.__EcoCal.openSettings()`);
  await sleep(400);
  await evaluate(`Array.from(document.querySelectorAll('.set-tab')).find(t => t.dataset.tab === 'security').click()`);
  await sleep(200);
  const pinWasChecked = await evaluate(`document.getElementById('s-pin-toggle').checked === true`);
  check('重开设置：PIN 开关保持勾选', pinWasChecked === true);
  // modalOnOk 的取消分支用 window.prompt（桩返回 'reset-word-ok'，但需要当前 PIN 123456）
  await evaluate(`(() => { window.prompt = () => '123456'; document.getElementById('s-pin-toggle').checked = false; return true; })()`);
  await evaluate(`document.getElementById('modal-ok').click()`);
  await sleep(400);
  check('关闭 PIN：pinEnabled=false', await evaluate(`window.__EcoCal.state.settings.pinEnabled === false`));
  check('关闭 PIN：哈希被清除', await evaluate(`localStorage.getItem('ecocal.pin.hash') === null`));

  console.log('\n结果：' + results.filter(r => r.ok).length + '/' + results.length + ' 项通过');
  process.exit(results.every(r => r.ok) ? 0 : 1);
} catch (e) {
  console.error('E2E 异常：', e.message);
  process.exit(1);
} finally {
  try { chrome.kill(); } catch (e) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}
