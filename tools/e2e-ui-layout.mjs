/**
 * UI/布局改造端到端冒烟验证（headless Chrome/Edge + CDP）
 * 覆盖：
 *   1) 产品页资产速览条（#asset-summary 4 项，随筛选联动、空状态隐藏）
 *   2) 统计页章节重排（走势提到仪表盘后）+ 锚点导航（吸顶、点击跳转不遮挡、
 *      scroll-spy 以「视口中线」判定当前章节）
 *   3) 盈亏构成圆环：演示数据下有圆环；全零盈亏时显示明确占位（非空白）
 *   4) 移动端顶栏收纳（窄屏「⋯」溢出菜单开合、点击外部/菜单项关闭，桌面端平铺）
 * 运行：node tools/e2e-ui-layout.mjs
 *   - 默认 file:// 直开（无需本地服务器）；也可 BASE=http://127.0.0.1:8123/?demo=1 走 http(s)
 *   - 可用 CHROME=... 指定浏览器，默认依次探测 Chrome / Edge
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const CHROME_CANDIDATES = [
  process.env.CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(p => existsSync(p));
if (!CHROME) { console.error('未找到 Chrome/Edge，请设置 CHROME 环境变量'); process.exit(1); }
const PORT = 9341;
const PROFILE = join(root, '..', '.e2e-ui-profile');
const fileBase = 'file:///' + join(root, '..', 'index.html').replace(/\\/g, '/') + '?demo=1';
const BASE = process.env.BASE || fileBase;

const sleep = ms => new Promise(r => setTimeout(r, ms));

try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', '--window-size=1280,900', BASE,
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', d => { chromeErr += d.toString(); });

let ws;
try {
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

  // 收集页面内未捕获 JS 异常
  let jsErrors = 0;
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.method === 'Runtime.exceptionThrown') jsErrors++;
  });

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

  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(`!!window.__EcoCal && !!document.getElementById('main-tabs')`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }

  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); };

  /* ================= 1. 产品页资产速览条 ================= */
  let r = await evaluate(`(() => {
    const el = document.getElementById('asset-summary');
    const texts = Array.from(el.querySelectorAll('.as-sum')).map(c => ({
      label: c.querySelector('.as-label')?.textContent || '',
      value: c.querySelector('.as-value')?.textContent || '',
    }));
    return { hidden: el.classList.contains('hidden'), count: texts.length, texts };
  })()`);
  check('产品页有资产速览条且非隐藏', !r.hidden && r.count === 4, JSON.stringify({ hidden: r.hidden, count: r.count }));
  check('速览条 4 项标签齐全', r.texts.map(t => t.label).join('|') === '总市值（CNY）|累计投入|总盈亏（浮+实）|总收益率', r.texts.map(t => t.label).join('|'));
  check('速览条数值已渲染（非空）', r.texts.every(t => t.value.length > 0), JSON.stringify(r.texts.map(t => t.value)));

  r = await evaluate(`(() => {
    const sel = document.getElementById('filter-category');
    sel.value = 'fund';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      sub: document.querySelector('#asset-summary .as-sum .as-sub')?.textContent || '',
      value: document.querySelector('#asset-summary .as-sum .as-value')?.textContent || '',
    };
  })()`);
  check('筛选后速览条标注「筛选后 N 项」', /筛选后 \d+ 项/.test(r.sub), r.sub);
  const filteredValue = r.value;
  r = await evaluate(`(() => {
    const sel = document.getElementById('filter-category');
    sel.value = 'all';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return document.querySelector('#asset-summary .as-sum .as-value')?.textContent || '';
  })()`);
  check('恢复全部后速览条总值还原（与筛选值不同）', r !== filteredValue, `all=${r} fund=${filteredValue}`);

  /* ================= 2. 统计页章节重排 + 锚点导航 + scroll-spy ================= */
  await evaluate(`window.__EcoCal.switchTab('stats'); true`);
  await sleep(300);
  r = await evaluate(`(() => {
    const nav = document.getElementById('stats-nav');
    const items = Array.from(nav.querySelectorAll('.stats-nav-item'));
    const order = ['dash-cards','sec-trend','sec-struct','sec-conc','sec-detail']
      .map(id => id + ':' + (document.getElementById(id).offsetParent !== null));
    const trendBeforeStruct = document.getElementById('sec-trend').compareDocumentPosition(document.getElementById('sec-struct')) & Node.DOCUMENT_POSITION_FOLLOWING;
    return { navItems: items.length, first: items[0].getAttribute('href'), order, trendBeforeStruct: !!trendBeforeStruct };
  })()`);
  check('统计页有 5 项章节锚点导航', r.navItems === 5, `navItems=${r.navItems}`);
  check('首项锚点为「核心仪表盘」', r.first === '#dash-cards', r.first);
  check('五个章节元素均可见', r.order.every(x => x.endsWith(':true')), r.order.join(','));
  check('章节顺序：走势在配置结构之前（已上移）', r.trendBeforeStruct, JSON.stringify(r.order));

  // scroll-spy：页面顶部 / 章节居中 / 页面底部三处，高亮均与「视口中线所在章节」一致
  const spyState = `(() => {
    const items = Array.from(document.querySelectorAll('#stats-nav .stats-nav-item'));
    const line = window.innerHeight / 2;
    let cur = items[0].dataset.spy;
    items.forEach(a => { const sec = document.getElementById(a.dataset.spy); if (sec && sec.getBoundingClientRect().top <= line) cur = a.dataset.spy; });
    const on = items.find(x => x.classList.contains('on'));
    return { expected: cur, actual: on ? on.dataset.spy : null };
  })()`;
  await evaluate(`window.scrollTo(0, 0); true`);
  await sleep(250);
  r = await evaluate(spyState);
  check('scroll-spy（页面顶部）：高亮 = 视口中线所在章节', r.expected === r.actual, JSON.stringify(r));

  await evaluate(`document.getElementById('sec-struct').scrollIntoView({ block: 'center' }); true`);
  await sleep(500);
  r = await evaluate(spyState);
  check('scroll-spy（章节居中）：把「配置与结构」滚到视口中线 → 高亮同步', r.expected === 'sec-struct' && r.actual === 'sec-struct', JSON.stringify(r));

  await evaluate(`window.scrollTo(0, document.body.scrollHeight); true`);
  await sleep(400);
  r = await evaluate(spyState);
  check('scroll-spy（页面底部）：高亮 = 视口中线所在章节', r.expected === r.actual, JSON.stringify(r));

  // 点击锚点：跳到章节标题正好位于吸顶导航下方（不遮挡），且 scroll-spy 重新对齐
  await evaluate(`(async () => {
    window.scrollTo(0, 0);
    await new Promise(res => setTimeout(res, 200));
    const a = Array.from(document.querySelectorAll('#stats-nav .stats-nav-item')).find(x => x.dataset.spy === 'sec-conc');
    a.click();
    await new Promise(res => setTimeout(res, 600));
    return true;
  })()`);
  r = await evaluate(`(() => {
    const sec = document.getElementById('sec-conc').getBoundingClientRect();
    const nav = document.getElementById('stats-nav').getBoundingClientRect();
    return { secTop: Math.round(sec.top), navBottom: Math.round(nav.bottom) };
  })()`);
  check('锚点跳转后章节标题未被吸顶导航遮挡', r.secTop >= r.navBottom - 2 && r.secTop <= r.navBottom + 40, `secTop=${r.secTop} navBottom=${r.navBottom}`);
  r = await evaluate(spyState);
  check('锚点跳转后 scroll-spy 与视口中线重新对齐', r.expected === r.actual, JSON.stringify(r));

  r = await evaluate(`(() => {
    const statsNav = document.getElementById('stats-nav').getBoundingClientRect();
    const tabs = document.getElementById('main-tabs').getBoundingClientRect();
    return { navTop: Math.round(statsNav.top), tabsBottom: Math.round(tabs.bottom) };
  })()`);
  check('锚点导航吸附在 Tab 栏下方', Math.abs(r.navTop - r.tabsBottom) <= 1, JSON.stringify(r));

  /* ================= 3. 盈亏构成圆环 ================= */
  r = await evaluate(`(() => {
    const html = document.getElementById('profit-chart').innerHTML || '';
    return { hasSvg: html.indexOf('<svg') > -1, pathCount: (html.match(/<path/g) || []).length, empty: html.indexOf('暂无盈亏构成') > -1 };
  })()`);
  check('演示数据：盈亏构成圆环正常渲染（含 SVG 路径）', r.hasSvg && r.pathCount > 0 && !r.empty, JSON.stringify(r));

  // 单段整圆场景（只有浮动盈亏、无已实现盈亏）：拆段后弧线必须真实渲染（getTotalLength() > 0）
  r = await evaluate(`(() => {
    const payload = {
      app: 'EcoCal', version: 1,
      assets: [{ id: 'sp1', name: '单产品', category: 'stock', currency: 'CNY', symbol: '600000', lastPrice: 12, priceSource: 'manual' }],
      valuations: [], trades: [{ id: 'st1', assetId: 'sp1', type: 'buy', date: '2026-10-01', quantity: 100, price: 10, fee: 0, mode: 'qty', note: '' }],
      settings: { baseCurrency: 'CNY', rates: {} },
    };
    window.__EcoCal.applyPayload(JSON.parse(JSON.stringify(payload)));
    window.__EcoCal.renderAll();
    window.__EcoCal.switchTab('stats');
    const paths = Array.from(document.querySelectorAll('#profit-chart svg path'));
    return {
      pathCount: paths.length,
      lengths: paths.map(p => Math.round(p.getTotalLength() * 10) / 10),
      segments: paths.map(p => ((p.getAttribute('d') || '').match(/A/g) || []).length),
    };
  })()`);
  check('单段整圆场景：弧线真实渲染（getTotalLength()>0 且每弧含 2 段）',
    r.pathCount === 2 && r.lengths.every(l => l > 0) && r.segments.every(n => n >= 2), JSON.stringify(r));

  // 全零盈亏（如纯存款/刚按现价买入）：显示明确占位而非空白
  r = await evaluate(`(() => {
    const payload = {
      app: 'EcoCal', version: 1,
      assets: [
        { id: 'zp1', name: '零盈亏存款', category: 'deposit', currency: 'CNY', lastPrice: 1, priceSource: 'manual', riskLevel: 'R1', tPlusN: 0 },
        { id: 'zp2', name: '零盈亏基金', category: 'fund', currency: 'CNY', lastPrice: 2, priceSource: 'manual', riskLevel: 'R2', tPlusN: 1 },
      ],
      valuations: [],
      trades: [
        { id: 'zt1', assetId: 'zp1', type: 'buy', date: '2026-10-01', quantity: 10000, price: 1, fee: 0, mode: 'qty', note: '' },
        { id: 'zt2', assetId: 'zp2', type: 'buy', date: '2026-10-01', quantity: 500, price: 2, fee: 0, mode: 'qty', note: '' },
      ],
      settings: { baseCurrency: 'CNY', rates: {} },
    };
    window.__EcoCal.applyPayload(JSON.parse(JSON.stringify(payload)));
    window.__EcoCal.renderAll();
    window.__EcoCal.switchTab('stats');
    const html = document.getElementById('profit-chart').innerHTML || '';
    return { hasSvg: html.indexOf('<svg') > -1, placeholder: html.indexOf('暂无盈亏构成') > -1 };
  })()`);
  check('零盈亏持仓：盈亏构成显示明确占位（不渲染空环）', r.placeholder === true && !r.hasSvg, JSON.stringify(r));

  // 恢复演示数据 → 圆环回来
  r = await evaluate(`(() => {
    window.__EcoCal.seedDemo();
    window.__EcoCal.renderAll();
    const html = document.getElementById('profit-chart').innerHTML || '';
    return { hasSvg: html.indexOf('<svg') > -1, pathCount: (html.match(/<path/g) || []).length };
  })()`);
  check('恢复演示数据后圆环重新渲染', r.hasSvg && r.pathCount > 0, JSON.stringify(r));

  /* ================= 4. 移动端顶栏收纳 ================= */
  await evaluate(`window.__EcoCal.switchTab('assets'); true`);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  r = await evaluate(`(() => {
    const more = document.getElementById('btn-more');
    const nav = document.getElementById('top-nav');
    return {
      moreDisplay: getComputedStyle(more).display,
      navOpen: nav.classList.contains('open'),
      navDisplay: getComputedStyle(nav).display,
      addVisible: getComputedStyle(document.getElementById('btn-add')).display,
    };
  })()`);
  // 注：Chromium 会把 <button> 上的 inline-flex 计算样式序列化为 flex（普通元素仍是 inline-flex），两者视觉一致
  check('窄屏下「⋯」按钮可见、添加按钮可见', (r.moreDisplay === 'inline-flex' || r.moreDisplay === 'flex') && r.addVisible !== 'none', JSON.stringify(r));
  check('窄屏下菜单默认收起', r.navOpen === false && r.navDisplay === 'none', JSON.stringify({ open: r.navOpen, display: r.navDisplay }));

  r = await evaluate(`(() => {
    const more = document.getElementById('btn-more');
    more.click();
    const opened = document.getElementById('top-nav').classList.contains('open');
    return { opened, expanded: more.getAttribute('aria-expanded') };
  })()`);
  check('点击「⋯」打开溢出菜单', r.opened === true && r.expanded === 'true', JSON.stringify(r));

  r = await evaluate(`(() => {
    document.getElementById('top-nav').querySelector('button').click();
    const closed = !document.getElementById('top-nav').classList.contains('open');
    return { closed, modalOpen: !document.getElementById('modal-backdrop').classList.contains('hidden') };
  })()`);
  check('点击菜单项后菜单关闭（帮助页弹出）', r.closed === true && r.modalOpen === true, JSON.stringify(r));
  await evaluate(`document.getElementById('modal-close').click(); true`);

  await evaluate(`document.getElementById('btn-more').click(); true`);
  await evaluate(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
  r = await evaluate(`!document.getElementById('top-nav').classList.contains('open')`);
  check('点击页面其它位置关闭菜单', r === true);

  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  r = await evaluate(`(() => {
    const more = document.getElementById('btn-more');
    const nav = document.getElementById('top-nav');
    return {
      moreDisplay: getComputedStyle(more).display,
      navDisplay: getComputedStyle(nav).display,
      navButtons: nav.querySelectorAll('button').length,
    };
  })()`);
  check('桌面端「⋯」隐藏、按钮平铺（4 个操作）', r.moreDisplay === 'none' && r.navDisplay === 'flex' && r.navButtons === 4, JSON.stringify(r));

  /* ================= 5. 无 JS 异常 ================= */
  check('运行期间无未捕获 JS 异常', jsErrors === 0, 'errors=' + jsErrors);

  let pass = 0, fail = 0;
  for (const item of results) {
    if (item.ok) { pass++; console.log(`✓ ${item.name}`); }
    else { fail++; console.log(`✗ ${item.name}  ${item.detail}`); }
  }
  console.log(`\nUI/布局 e2e：${pass} 通过，${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
} finally {
  try { ws && ws.close(); } catch (e) {}
  chrome.kill();
  setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {} }, 1000);
}
