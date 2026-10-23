// 一次式 e2e：spawn Chrome（无头 + CDP），在真实浏览器里驱动设置面板的 Gitee 云备份流程。
// 需要：tools/mock-gitee.mjs 先运行（端口 8902）+ tools/serve.mjs（端口 8123）提供 ?demo=1 页面。
// 复用 e2e-webdav.mjs 的 CDP 封装结构（Node 24 内置 WebSocket）。
import { spawn } from 'node:child_process';
import http from 'node:http';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9227;
const URL = 'http://127.0.0.1:8123/?demo=1';
const profile = 'D:\\Projects\\EcoCal\\.e2e-gitee-profile';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile, URL,
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', d => {
  const s = d.toString();
  if (/DevTools listening/i.test(s)) console.log('[chrome]', s.trim().slice(0, 100));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:' + PORT + '/json', res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

let ws;
async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await getJson();
      const page = (list || []).find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
        return;
      }
    } catch (e) { /* retry */ }
    await sleep(400);
  }
  throw new Error('CDP 连接失败');
}

await connect();
let seq = 0;
const pending = new Map();
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  // 把真实 gitee.com 的 API 请求重定向到本地 mock（仅验证用；产品代码零改动）
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params;
    if (!request.url.includes('gitee.com/api/v5')) {
      send('Fetch.continueRequest', { requestId });
      return;
    }
    const redirected = request.url.replace('https://gitee.com', 'http://127.0.0.1:8902');
    console.log('[redirect]', request.method, request.url, '→', redirected);
    send('Fetch.continueRequest', { requestId, url: redirected });
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
// 拦截并重定向 /api/v5/* 请求到本地 mock-gitee
await send('Fetch.enable', { patterns: [{ urlPattern: '*gitee.com/api/v5/*', requestStage: 'Request' }] });
console.log('[e2e] Fetch 拦截已启用');
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

// 等待 EcoCal 就绪
for (let i = 0; i < 20; i++) {
  const ready = await evaluate('typeof __EcoCal !== "undefined" && __EcoCal.state && __EcoCal.state.assets && __EcoCal.state.assets.length > 0');
  if (ready) break;
  await sleep(500);
}
const base = await evaluate('({ count: __EcoCal.state.assets.length, name: __EcoCal.state.assets[0].name })');
console.log('[e2e] 初始化:', JSON.stringify(base));

// 真实驱动设置面板 UI：填字段 → 勾选启用 → 测试连接 → 立即备份 → 篡改 → 从云端恢复 → 自动备份
const script = `
(async () => {
  const E = window.__EcoCal;
  const alerts = [];
  window.alert = m => { alerts.push(String(m)); };
  const out = [];
  const ok = m => out.push('✓ ' + m);
  const bad = m => out.push('✗ ' + m);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = id => document.getElementById(id);
  try {
    // 打开设置面板
    E.openSettings();
    await sleep(300);
    if (!$('g-owner')) { bad('设置面板无 Gitee 区块（g-owner 不存在）'); return out.join('\\n'); }
    ok('设置面板含 Gitee 区块');
    // 填入配置
    $('g-owner').value = 'testuser';
    $('g-repo').value = 'ecocal-backup';
    $('g-path').value = 'ecocal-backup.json';
    $('g-token').value = 'test-token-abc';
    // 点击测试连接（onclick 会先读取输入 + 保存令牌）
    $('g-test').click();
    await sleep(1500);
    const testStatus = $('g-status').textContent;
    ok('测试连接状态=' + testStatus);
    if (testStatus.indexOf('✗') !== -1) return out.join('\\n'); // 失败提前结束
    // 立即备份
    $('g-backup').click();
    await sleep(1500);
    const backupStatus = $('g-status').textContent;
    ok('立即备份状态=' + backupStatus);
    if (backupStatus.indexOf('✗') !== -1) return out.join('\\n');
    // 令牌已独立保存
    ok('令牌已保存=' + (E.giteeBackup.getToken() === 'test-token-abc'));
    // 读取云端确认内容
    const remote = await E.giteeBackup.fetchRemote();
    const cloudName = remote.assets[0].name;
    ok('云端备份可读，资产 ' + remote.assets.length + '，首个=' + cloudName);
    // 篡改本地 → 从云端恢复
    E.state.assets[0].name = '【本地篡改】';
    E.openSettings(); // 重新打开（恢复按钮在面板里）
    await sleep(200);
    $('g-restore').click();
    await sleep(500);
    const confirmBtn = document.getElementById('confirm-ok');
    ok('恢复弹出确认框=' + (!!confirmBtn));
    confirmBtn.click();
    await sleep(800);
    ok('恢复后名称=' + E.state.assets[0].name + (E.state.assets[0].name === cloudName ? '（已还原）' : '（未还原！）'));
    // 启用自动备份：修改 state → saveState → 10s 内自动上传
    $('g-enabled').checked = true;
    try { $('g-enabled').dispatchEvent(new Event('change')); } catch (e) { /* 桩事件 */ }
    E.state.assets[0].name = '【自动备份】';
    E.saveState();
    await sleep(11500);
    const autoRemote = await E.giteeBackup.fetchRemote();
    ok('自动备份后远端=' + autoRemote.assets[0].name + (autoRemote.assets[0].name === '【自动备份】' ? '（已上传）' : '（未上传！）'));
    // 现场还原
    E.state.assets[0].name = cloudName;
    E.state.settings.gitee.enabled = false;
    E.saveState();
    ok('现场还原完成');
    if (alerts.length) ok('期间 alert: ' + alerts.join('; '));
  } catch (e) {
    bad('异常: ' + (e && e.message ? e.message : String(e)));
  }
  return out.join('\\n');
})()`;

const result = await evaluate(script);
console.log('=== e2e 输出 ===');
console.log(String(result));
const hasFail = /✗|异常/.test(String(result));
ws.close();
chrome.kill();
console.log(hasFail ? 'FAIL' : 'PASS');
process.exit(hasFail ? 1 : 0);
