/**
 * 功能 3/4 浏览器验证：搜索框 + 排序 + 合并导入面板（headless Chrome + CDP）
 * 运行：node tools/e2e-search-merge.mjs
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9345;
const PROFILE = 'D:\\Projects\\EcoCal\\.e2e-search-merge-profile';
const BASE = 'http://127.0.0.1:8123/?demo=1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', BASE,
], { stdio: 'ignore' });

let ws;
try {
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets || !targets.length) throw new Error('CDP 未就绪');
  const page = targets.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++send._id;
    const h = ev => { const m = JSON.parse(ev.data); if (m.id === id) { ws.removeEventListener('message', h); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params }));
  });
  send._id = 0;
  await new Promise(r => ws.addEventListener('open', r));
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('evaluate 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  for (let i = 0; i < 40; i++) { if (await evaluate(`!!window.__EcoCal && !!document.getElementById('filter-search')`).catch(() => false)) break; await sleep(250); }

  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });

  // 1) 搜索框存在
  check('筛选栏有搜索框 #filter-search', await evaluate(`!!document.getElementById('filter-search')`));

  // 2) 输入搜索词 → 列表过滤
  const searchResult = await evaluate(`
    (() => {
      const input = document.getElementById('filter-search');
      input.value = '沪深';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(res => setTimeout(() => {
        const cards = document.querySelectorAll('.asset-card');
        const firstNames = Array.from(cards).slice(0, 5).map(c => c.querySelector('.aname')?.textContent || '');
        res({ count: cards.length, firstNames });
      }, 300));
    })()
  `);
  check('搜索「沪深」→ 列表被过滤（≤全部卡片数）', searchResult.count >= 1 && searchResult.count <= 8, JSON.stringify(searchResult));

  // 3) 清空搜索 → 恢复全部
  const clearResult = await evaluate(`
    (() => {
      const input = document.getElementById('filter-search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return new Promise(res => setTimeout(() => res(document.querySelectorAll('.asset-card').length), 300));
    })()
  `);
  check('清空搜索 → 恢复全部卡片', clearResult >= 5, `count=${clearResult}`);

  // 4) 排序选项含新项
  const sortOptions = await evaluate(`
    (() => { const s = document.getElementById('filter-sort'); return Array.from(s.options).map(o => o.textContent); })()
  `);
  check('排序含「市值从低到高」「已实现盈亏从高到低」', sortOptions.includes('市值从低到高') && sortOptions.includes('已实现盈亏从高到低'), JSON.stringify(sortOptions));

  // 5) 打开导入面板 → 有合并按钮
  await evaluate(`window.__EcoCal.openImportModal(); true`);
  await sleep(300);
  const hasMerge = await evaluate(`!!document.getElementById('imp-merge')`);
  check('导入面板有「合并导入」按钮', hasMerge === true);

  // 输出
  let pass = 0, fail = 0;
  for (const r of results) { if (r.ok) { pass++; console.log('✓ ' + r.name); } else { fail++; console.log('✗ ' + r.name + '  ' + r.detail); } }
  console.log(`\n功能 3/4 浏览器 e2e：${pass} 通过，${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  try { ws && ws.close(); } catch (e) {}
  chrome.kill();
  setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} }, 1000);
}
