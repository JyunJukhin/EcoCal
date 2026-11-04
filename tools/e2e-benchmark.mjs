// 端到端：组合走势「对比基准」模式（headless Chrome + CDP）
// 用法：node tools/e2e-benchmark.mjs [port]
// 依赖：静态服务器 http://127.0.0.1:8123（tools/serve.mjs . 8123）
import { spawn } from 'node:child_process';
import http from 'node:http';

const BASE = 'http://127.0.0.1:8123';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.argv[2] || 9237);
const PROFILE = '.e2e-bench-profile';

let results = [];

function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  [' + extra + ']' : ''));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
    BASE + '/?demo=1',
  ], { stdio: 'ignore' });
  try {
    // 等 DevTools 就绪
    let targets = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { targets = await getJson('http://127.0.0.1:' + PORT + '/json'); if (targets) break; } catch {}
    }
    if (!targets) throw new Error('DevTools 未就绪');
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('无 page target');

    // CDP 会话
    const wsUrl = page.webSocketDebuggerUrl;
    const { WebSocket } = globalThis;
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = (method, params) => new Promise((res, rej) => {
      const id = ++msgId;
      pending.set(id, m => m.error ? rej(new Error(m.error.message)) : res(m.result));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expr, awaitPromise) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };

    // 覆盖 alert 防止阻塞
    await send('Runtime.evaluate', { expression: 'window.alert = m => window.__alerts = (window.__alerts||[]).concat(String(m));' });
    await send('Runtime.evaluate', { expression: 'window.confirm = () => true;' });

    // 等 __EcoCal 就绪（?demo=1 注入演示数据）
    let ready = false;
    for (let i = 0; i < 60; i++) {
      ready = await evaluate('!!(window.__EcoCal && document.querySelector("#trend-chart"))');
      if (ready) break;
      await sleep(250);
    }
    check('demo 页面就绪（__EcoCal + #trend-chart）', ready);
    if (!ready) return;

    // 切到统计页签 + 切“对比基准”模式
    await evaluate(`(() => { window.__EcoCal.switchTab('stats'); })()`);
    await evaluate(`(() => { document.querySelector('#trend-modes button[data-mode="cmp"]').click(); })()`);
    await sleep(400);

    const chartHtml = await evaluate(`document.getElementById('trend-chart').innerHTML`);
    check('对比按钮存在于 #trend-modes', await evaluate(`!!document.querySelector('#trend-modes button[data-mode="cmp"]')`));
    check('对比模式按钮激活', await evaluate(`document.querySelector('#trend-modes button[data-mode="cmp"]').classList.contains('active')`));
    check('图已渲染（SVG 或提示）', chartHtml.length > 0);
    const hasSvg = chartHtml.includes('<svg');
    check('渲染出 SVG 图（组合线+基准线）', hasSvg);
    if (hasSvg) {
      // 拖延一会等基准异步到达
      await sleep(3000);
      const chartHtml2 = await evaluate(`document.getElementById('trend-chart').innerHTML`);
      check('基准线已异步并入（>1 条 path）', (chartHtml2.match(/<path/g) || []).length >= 2, 'paths=' + (chartHtml2.match(/<path/g) || []).length);
      check('基准图例含「沪深300」', (chartHtml2.includes('沪深300') || chartHtml2.includes('归一化')));
      const legendTxt = await evaluate(`document.querySelector('#trend-chart .chart-legend') ? document.querySelector('#trend-chart .chart-legend').textContent : ''`);
      check('图例含「组合累计收益率」与基准名', legendTxt.includes('组合累计收益率') && legendTxt.includes('沪深300'), legendTxt.slice(0, 80));
    } else {
      check('（无 SVG）显示空态提示', chartHtml.includes('暂无对比数据') || chartHtml.includes('chart-empty'));
    }

    // 设置面板：基准指数下拉存在
    await evaluate(`window.__EcoCal.openSettings()`);
    await sleep(200);
    check('设置面板含「基准指数」下拉', await evaluate(`!!document.querySelector('#s-benchmark')`));
    const benchOptions = await evaluate(`Array.from(document.querySelectorAll('#s-benchmark option')).map(o => o.textContent).join('|')`);
    check('基准下拉含 4 个指数', benchOptions.includes('沪深300') && benchOptions.includes('上证指数') && benchOptions.includes('中证500') && benchOptions.includes('创业板指'), benchOptions);
    const selected = await evaluate(`document.querySelector('#s-benchmark').value`);
    check('默认选中沪深300', selected === 'sh000300', selected);
    await evaluate(`document.getElementById('modal-cancel').click()`);

    console.log('\n结果：' + results.filter(r => r.ok).length + '/' + results.length + ' 通过');
    const failed = results.filter(r => !r.ok);
    // 非零退出码让 CI/脚本可感知
    if (failed.length) {
      console.log('失败项：' + failed.map(f => f.name).join('; '));
      process.exit(1);
    }
  } finally {
    try { chrome.kill(); } catch {}
    await sleep(300);
  }
}

main().catch(e => { console.error('e2e 异常：' + e.message); process.exit(1); });
