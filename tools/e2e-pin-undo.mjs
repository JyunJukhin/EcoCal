/**
 * 浏览器端到端验证：PIN 锁 + 撤销（删除资产）。
 * 用法（本机）：node tools/e2e-pin-undo.mjs
 * 依赖：本机 Chrome（headless）+ 静态服务器（node tools/serve.mjs . 8123）
 */
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9228;
const PROFILE = path.join(os.tmpdir(), 'e2e-pin-' + Date.now());
const APP_URL = 'http://127.0.0.1:8123/?demo=1';

const wait = ms => new Promise(r => setTimeout(r, ms));
const tcpOk = (port, host = '127.0.0.1') => new Promise(res => {
  const sock = net.connect({ port, host });
  sock.on('connect', () => { sock.destroy(); res(true); });
  sock.on('error', () => res(false));
});
const waitTcp = async (port, tries = 60) => {
  for (let i = 0; i < tries; i++) { if (await tcpOk(port)) return true; await wait(500); }
  return false;
};

let chrome;
async function main() {
  console.log('[1] 启动静态服务器（8123）');
  const server = spawn(process.execPath, ['tools/serve.mjs', '.', '8123'], { cwd: process.cwd(), stdio: 'ignore' });
  await wait(1500);

  console.log('[2] 启动 Chrome（headless CDP ' + PORT + '）');
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE, '--no-first-run', '--disable-gpu', APP_URL,
  ], { stdio: 'ignore' });
  if (!await waitTcp(PORT, 80)) throw new Error('Chrome CDP 未就绪');

  const targets = await fetch('http://127.0.0.1:' + PORT + '/json').then(r => r.json());
  const page = targets.find(t => t.type === 'page' && t.url.includes('127.0.0.1:8123'));
  if (!page) throw new Error('未找到目标页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++msgId; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  const results = [];
  const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log((ok ? '✓ ' : '✗ ') + name); };

  console.log('[3] 等待应用加载 + 覆盖 alert');
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(`typeof window.__EcoCal !== 'undefined'`).catch(() => false);
    if (ready) break;
    await wait(500);
  }
  await evaluate(`window.__alertHook = []; window.alert = m => window.__alertHook.push(String(m)); 1`);

  console.log('[4] 载入演示数据（demo=1）');
  await evaluate(`(() => { const a = window.__EcoCal.state.assets; if (!a.length) { if (window.__EcoCal.seedDemo) window.__EcoCal.seedDemo(); window.__EcoCal.renderAll(); } return window.__EcoCal.state.assets.length; })()`);
  const assetCount = await evaluate(`window.__EcoCal.state.assets.length`);
  check('演示数据已载入（资产数>0）', assetCount > 0);

  console.log('[5] 打开设置 → 启用 PIN');
  await evaluate(`window.__EcoCal.openSettings(); 1`);
  await wait(300);
  const secExists = await evaluate(`!!document.getElementById('s-pin-toggle')`);
  check('设置面板含安全（PIN）段', secExists === true);
  await evaluate(`document.getElementById('s-pin-toggle').checked = true;
    document.getElementById('s-pin').value = '8888';
    document.getElementById('s-pin-reset').value = 'my-reset';
    document.getElementById('modal-ok').click(); 1`);
  await wait(400);
  const locked = await evaluate(`!document.getElementById('pin-lock').classList.contains('hidden')`);
  check('启用 PIN 后立即上锁（遮罩显示）', locked === true);
  const alerts = await evaluate(`window.__alertHook.slice(-3).join('|')`);
  check('启用提示已弹出（含重置口令）', alerts.includes('8888') || alerts.includes('my-reset'));

  console.log('[6] 解锁');
  await evaluate(`document.getElementById('pin-input').value = '9999';
    document.getElementById('pin-unlock-btn').click(); 1`);
  await wait(200);
  let stillLocked = await evaluate(`!document.getElementById('pin-lock').classList.contains('hidden')`);
  check('错误 PIN 不解锁', stillLocked === true);
  await evaluate(`document.getElementById('pin-input').value = '8888';
    document.getElementById('pin-unlock-btn').click(); 1`);
  await wait(200);
  const unlocked = await evaluate(`document.getElementById('pin-lock').classList.contains('hidden')`);
  check('正确 PIN 解锁（遮罩隐藏）', unlocked === true);

  console.log('[7] 删除一笔资产 → 撤销条');
  const firstId = await evaluate(`window.__EcoCal.state.assets[0].id`);
  const firstName = await evaluate(`window.__EcoCal.state.assets[0].name`);
  // 直接构造删除（走产品卡删除按钮事件委托等价逻辑：用 __EcoCal.undoWrap）——真实点击卡片删除按钮：
  // 卡片按钮 data-action=deleteAsset；打开产品卡已渲染，用代理点击
  const clicked = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.asset-card')).find(c => c.dataset.assetId === ${JSON.stringify(firstId)});
    if (!card) return false;
    const btn = card.querySelector('button[data-action="deleteAsset"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  check('产品卡「删除」按钮已点击', clicked === true);
  await wait(300);
  const confirmShown = await evaluate(`!document.getElementById('confirm-backdrop').classList.contains('hidden')`);
  check('删除确认框弹出（可撤销）', confirmShown === true);
  await evaluate(`document.getElementById('confirm-ok').click(); 1`);
  await wait(300);
  const deleted = await evaluate(`!window.__EcoCal.state.assets.some(a => a.id === ${JSON.stringify(firstId)})`);
  check('确认后资产已删除', deleted === true);
  const undoBar = await evaluate(`!!document.body.querySelector('.undo-toast')`);
  check('撤销提示条出现', undoBar === true);

  console.log('[8] 点击撤销 → 资产恢复');
  await evaluate(`(() => { const b = document.body.querySelector('.undo-toast #undo-btn'); if (b) b.click(); return !!b; })()`);
  await wait(400);
  const restored = await evaluate(`window.__EcoCal.state.assets.some(a => a.id === ${JSON.stringify(firstId)})`);
  check('撤销后资产恢复（' + firstName + '）', restored === true);
  const undoGone = await evaluate(`!document.body.querySelector('.undo-toast')`);
  check('撤销条已消失', undoGone === true);

  console.log('[9] 关闭 PIN（清理现场）');
  await evaluate(`(() => { if (window.__EcoCal.pinEnabled()) window.__EcoCal.clearPin(); })(); 1`);

  console.log('\n===== 结果 =====');
  const failed = results.filter(r => !r.ok);
  console.log(results.length + ' 项检查，' + failed.length + ' 项失败');
  ws.close();
  chrome.kill();
  server.kill();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  console.error('e2e 失败:', e.message);
  try { if (chrome) chrome.kill(); } catch (e2) {}
  process.exit(2);
});
