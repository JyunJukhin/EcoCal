// 一次性诊断：真实浏览器(Chrome headless + CDP)里直连 dav.jianguoyun.com，
// 区分「CORS 被拦截」与「网络/认证错误」，并顺带用 Node 探测响应头。
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9231;
const profile = 'D:\\Projects\\EcoCal\\.cors-profile';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', () => {});
let nextId = 1;
let ws;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function wait(target) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 9000);
    const iv = setInterval(() => {
      if (ws && ws.readyState === 1) { clearTimeout(t); clearInterval(iv); resolve(); }
    }, 20);
  });
}
async function evaluate(script) {
  const r = await send('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return 'EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception);
  return r.result && r.result.result ? r.result.result.value : JSON.stringify(r);
}

async function main() {
  await wait();
  // 等 DevTools 端点就绪
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/json' }, r => {
          let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
        }).on('error', rej);
      });
      if (targets.length) break;
    } catch (e) { /* 重试 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  const page = targets.find(t => t.type === 'page');
  if (typeof WebSocket === 'undefined') { console.log('本 Node 无全局 WebSocket，无法继续'); chrome.kill(); process.exit(2); }
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m); }
  };
  await send('Runtime.enable');

  // 浏览器侧：直连 PUT 预检（模拟 WebDAV 请求）
  const browser = await evaluate(`(async () => {
    const out = {};
    try {
      const r = await fetch('https://dav.jianguoyun.com/dav/', {
        method: 'PUT',
        headers: { 'Authorization': 'Basic dGVzdDp0ZXN0', 'Content-Type': 'text/plain' },
        body: 'probe'
      });
      out.status = r.status;
      out.direct = '直接请求成功(status=' + r.status + ')';
    } catch (e) {
      out.direct = 'fetch 抛错: ' + e.message;
    }
    return JSON.stringify(out);
  })()`);

  // Node 侧：不带 Origin 探测响应头，确认服务器本身可达
  const node = await new Promise((resolve) => {
    const req = https.request({
      host: 'dav.jianguoyun.com', path: '/dav/', method: 'GET',
      headers: { 'Authorization': 'Basic dGVzdDp0ZXN0' }
    }, (res) => {
      const h = {
        status: res.statusCode,
        acao: res.headers['access-control-allow-origin'] || null,
        vary: res.headers['vary'] || null,
        acrm: res.headers['access-control-allow-methods'] || null,
        acrheaders: res.headers['access-control-allow-headers'] || null,
        server: res.headers['server'] || null
      };
      res.resume();
      resolve(JSON.stringify(h, null, 1));
    });
    req.on('error', e => resolve('ERR ' + e.message));
    req.end();
  });

  console.log('浏览器直连: ', browser);
  console.log('Node 探测响应头（无 Origin 的服务器视角）:');
  console.log(node);
  ws.close();
  chrome.kill();
  process.exit(0);
}
main();
