// 真实浏览器端到端验证 v2：导出 Excel 按钮 → 下载 .xlsx → 落盘供 openpyxl 校验
// 用法：node tools/e2e-xlsx.mjs
// 前置：node tools/serve.mjs . 8123
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9228;
const profile = mkdtempSync(join(tmpdir(), 'e2e-xlsx-'));

let failures = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failures++; };

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
  '--user-data-dir=' + profile,
  'http://127.0.0.1:8123/?demo=1',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json');
      targets = await res.json();
      if (targets.some(t => t.type === 'page')) break;
    } catch (e) {}
    await sleep(500);
  }
  const page = targets && targets.find(t => t.type === 'page');
  if (!page) { console.log('✗ 未找到页面 target'); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let msgId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params) => new Promise(resolve => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Runtime.enable', {});
  await send('Page.enable', {});
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: profile });

  for (let i = 0; i < 40; i++) {
    if (await evaluate('!!window.__EcoCal')) break;
    await sleep(500);
  }
  check(await evaluate('!!window.__EcoCal'), '应用已就绪（?demo=1）');

  const btnInfo = await evaluate(`(() => {
    window.__EcoCal.openExportModal();
    const body = document.getElementById('modal-body');
    if (!body) return null;
    return {
      btns: Array.from(body.querySelectorAll('button')).map(b => b.id + ':' + b.textContent.trim()),
      hasXlsx: !!document.getElementById('exp-xlsx'),
    };
  })()`);
  check(btnInfo && btnInfo.btns.length === 3, '导出面板按钮数=3（实际 ' + (btnInfo ? btnInfo.btns.length : 'null') + '）');
  check(btnInfo && btnInfo.hasXlsx, '含「下载 .xlsx」按钮');
  check(btnInfo && btnInfo.btns.some(b => b.includes('Excel')), '按钮文案含 Excel');

  const clicked = await evaluate(`(() => { const b = document.getElementById('exp-xlsx'); if (!b) return false; b.click(); return true; })()`);
  check(clicked, '点击「下载 .xlsx」按钮成功');

  let found = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const files = readdirSync(profile).filter(f => f.endsWith('.xlsx'));
    if (files.length) { found = join(profile, files[0]); break; }
  }
  check(!!found, '下载目录出现 .xlsx 文件' + (found ? '（' + found.split('\\').pop() + '）' : ''));

  if (found) {
    const dest = 'D:\\Projects\\EcoCal\\tools\\_e2e-export.xlsx';
    const { readFileSync } = await import('node:fs');
    writeFileSync(dest, readFileSync(found));
    console.log('文件已复制到 ' + dest);
  }

  chrome.kill();
  console.log(failures === 0 ? '\n全部通过' : '\n存在失败项');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.log('✗ 异常：' + e.message); chrome.kill(); process.exit(1); });
