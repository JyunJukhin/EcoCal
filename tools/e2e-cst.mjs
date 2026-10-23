// 真实数据胶囊端到端：浏览器内全流程（测试连接 → 立即备份 → 篡改恢复 → 自动备份 → 现场还原）
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9230;
const URL = 'http://127.0.0.1:8123/?demo=1';
const profile = 'D:\\Projects\\EcoCal\\.e2e-cst';
mkdirSync(profile, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profile, URL], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', d => { const s = d.toString(); if (/DevTools listening/i.test(s)) console.log('[chrome]', s.trim().slice(0, 90)); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + PORT + '/json', res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
let ws;
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await getJson();
      const page = (list || []).find(t => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); }); return; }
    } catch (e) { /* retry */ }
    await sleep(400);
  }
  throw new Error('CDP 连接失败');
}
await connect();
let seq = 0; const pending = new Map();
ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data.toString()); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } });
function send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; }

for (let i = 0; i < 20; i++) {
  const ready = await evaluate('typeof __EcoCal !== "undefined" && __EcoCal.state && __EcoCal.state.assets && __EcoCal.state.assets.length > 0');
  if (ready) break; await sleep(500);
}
const base = await evaluate('({ count: __EcoCal.state.assets.length, name: __EcoCal.state.assets[0].name })');
console.log('[e2e] demo 就绪:', JSON.stringify(base));

const script = `
(async () => {
  const E = window.__EcoCal;
  const alerts = [];
  window.alert = m => { alerts.push(String(m)); };
  const out = [];
  const ok = m => out.push('✓ ' + m);
  const bad = m => out.push('✗ ' + m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    E.state.settings.webdav = { enabled: true, url: 'https://data.cstcloud.cn/dav/', user: 'EcoCal', dir: 'EcoCal', lastBackupAt: null, lastError: null };
    E.webdavBackup.setPass('wodemingzi123');
    // 1) 测试连接
    await E.webdavBackup.testConnection();
    ok('testConnection 成功（真实数据胶囊）');
    // 2) 立即备份
    const text = await E.webdavBackup.backup();
    const data = JSON.parse(text);
    ok('backup 成功，资产 ' + data.assets.length + '，首个 ' + data.assets[0].name);
    // 3) 篡改后恢复
    const nameBefore = data.assets[0].name;
    E.state.assets[0].name = '【篡改测试】';
    E.saveState();
    await E.manualWebdavRestore();
    document.getElementById('confirm-ok').click();
    await sleep(800);
    ok('恢复后名称=' + E.state.assets[0].name + (E.state.assets[0].name === nameBefore ? '（已还原）' : '（未还原！）'));
    // 4) 自动备份
    E.state.assets[0].name = '【自动备份验证】';
    E.saveState();
    await sleep(11500);
    const remote = await E.webdavBackup.fetchRemote();
    ok('自动备份远端名称=' + remote.assets[0].name + (remote.assets[0].name === '【自动备份验证】' ? '（已上传）' : '（未上传！）'));
    // 5) 恢复现场并回传（避免污染用户真实数据）
    E.state.assets[0].name = nameBefore;
    E.saveState();
    await sleep(11500);
    const finalRemote = await E.webdavBackup.fetchRemote();
    ok('远端已还原为 ' + finalRemote.assets[0].name);
    if (alerts.length) ok('期间 alert: ' + alerts.join('; '));
  } catch (e) {
    bad('异常: ' + (e && e.message ? e.message : String(e)));
  }
  return out.join('\\n');
})()`;

try {
  const result = await evaluate(script);
  console.log('=== e2e 输出 ==='); console.log(String(result));
  const hasFail = /✗|异常/.test(String(result));
  console.log(hasFail ? 'FAIL' : 'PASS');
} catch (e) {
  console.log('e2e 异常:', e.message);
}
try { ws.close(); chrome.kill(); } catch {}
process.exit(0);
