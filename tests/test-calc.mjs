/**
 * EcoCal 回归测试：先做 js/app.js 语法检查，再用模拟浏览器环境验证计算引擎与功能。
 * 运行：node tests/test-calc.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(join(root, 'js', 'app.js'), 'utf8');

/* ---- 1. 语法检查（js/app.js） ---- */
try {
  new Function(appJs);
} catch (e) {
  console.error('✗ 语法错误（js/app.js）：', e.message);
  process.exit(1);
}
console.log('✓ 语法检查通过（js/app.js）');

/* ---- 2. 模拟浏览器全局，执行脚本 ---- */
const elements = {};
function makeEl(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', files: [], dataset: {}, style: {},
    onclick: null, onchange: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; },
      contains(c) { return this._s.has(c); },
    },
    appendChild() {}, remove() {}, click() {}, addEventListener() {},
    setAttribute() {}, querySelectorAll() { return []; },
    select() {},
  };
}
const storage = {};
globalThis.window = globalThis;
globalThis.document = {
  readyState: 'complete',
  getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
  querySelectorAll() { return []; },
  addEventListener() {},
  createElement() { return makeEl('dyn'); },
  body: { appendChild() {} },
};
globalThis.localStorage = {
  getItem(k) { return storage[k] !== undefined ? storage[k] : null; },
  setItem(k, v) { storage[k] = String(v); },
  removeItem(k) { delete storage[k]; },
};
globalThis.alert = () => {};
globalThis.prompt = () => null;
globalThis.Blob = function () {};
globalThis.FileReader = function () {};
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };

eval(appJs);
const EcoCal = globalThis.__EcoCal;
if (!EcoCal) throw new Error('window.__EcoCal 未挂载，脚本执行失败');
console.log('✓ 脚本执行成功（含 init/renderAll，无异常）');

/* ---- 3. 断言辅助 ---- */
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

/* ---- 4. 计算引擎测试 ---- */
const { Calc, round2, dayDiff } = EcoCal;

// 4.1 单币种：30 天持有，成本 10000 → 现值 10300
let asset = { id: 'a1', name: '测试基金', category: 'fund', subCategory: '混合型', currency: 'CNY',
  principal: 10000, quantity: null, startDate: '2025-01-01', note: '' };
let m = Calc.assetMetrics(asset, [
  { id: 'v1', assetId: 'a1', date: '2025-01-01', value: 10000 },
  { id: 'v2', assetId: 'a1', date: '2025-01-31', value: 10300 },
], { baseCurrency: 'CNY', rates: {} });
assert(m.currentValue === 10300, '最新价值取最后一条记录 10300');
assert(m.profit === 300, '累计收益 = 10300 - 10000 = 300');
assert(approx(m.rate, 0.03), '收益率 = 3%');
assert(m.days === 30, '持有天数 = 30（1/1 → 1/31）');
assert(approx(m.simpleAnnual, 0.03 * 365 / 30, 1e-9), '单利年化 = 3% × 365/30 = ' + (0.03 * 365 / 30).toFixed(2));
assert(approx(m.compoundAnnual, Math.pow(1.03, 365 / 30) - 1, 1e-6), '复利年化 = (1.03)^(365/30) - 1');

// 4.2 无价值记录：市值 = 本金，收益 0，持有天数到「今天」
m = Calc.assetMetrics(asset, [], { baseCurrency: 'CNY', rates: {} });
assert(m.currentValue === 10000 && m.profit === 0, '无记录时按本金计、收益 0');
assert(m.days === dayDiff('2025-01-01', EcoCal.todayStr()), '无记录时持有天数算到今天');
assert(m.simpleAnnual === 0, '无记录时收益为 0，年化为 0%');

// 4.3 多币种换算
const settings = { baseCurrency: 'CNY', rates: { USD: 7.2 } };
let usdAsset = { ...asset, id: 'a2', currency: 'USD', principal: 2000 };
m = Calc.assetMetrics(usdAsset, [{ id: 'v3', assetId: 'a2', date: '2025-01-31', value: 2100 }], settings);
assert(m.baseValue === 2100 * 7.2, 'USD 市值按汇率 7.2 换算为 CNY');
assert(m.baseProfit === round2(2100 * 7.2 - 2000 * 7.2), 'USD 收益换算为 CNY');

// 4.4 缺失汇率
let eurAsset = { ...asset, id: 'a3', currency: 'EUR', principal: 500 };
m = Calc.assetMetrics(eurAsset, [{ id: 'v4', assetId: 'a3', date: '2025-01-31', value: 520 }], settings);
assert(m.baseValue === null && m.baseCost === null && m.rateMissing === true, 'EUR 缺汇率 → baseValue 为 null 并标记');

// 4.5 汇总
const sum = Calc.summary(
  [asset, usdAsset, eurAsset],
  [
    { id: 'v1', assetId: 'a1', date: '2025-01-31', value: 10300 },
    { id: 'v3', assetId: 'a2', date: '2025-01-31', value: 2100 },
    { id: 'v4', assetId: 'a3', date: '2025-01-31', value: 520 },
  ],
  settings
);
assert(approx(sum.totalCost, 10000 + 2000 * 7.2), '总成本 = 10000 + 14400（EUR 不计）');
assert(approx(sum.totalValue, 10300 + 2100 * 7.2), '总市值 = 10300 + 15120（EUR 不计）');
assert(sum.missingRateCurrencies.includes('EUR'), '缺失汇率列表包含 EUR');
assert(approx(sum.totalProfit, (10300 - 10000) + (2100 - 2000) * 7.2), '总收益求和正确');
assert(sum.gainCount === 2 && sum.lossCount === 0, '盈利计数 = 2（CNY 基金 + USD 盈利；EUR 缺汇率不参与统一口径计数）');

// 4.6 持有天数（用 dayDiff）
assert(dayDiff('2024-12-01', '2025-02-01') === 62, 'dayDiff 12/1→2/1 = 62 天');

// 4.7 可卖判定（最低持有天数）
let sellAsset = { id: 's1', name: '定开基金', category: 'fund', subCategory: '混合型', currency: 'CNY',
  principal: 10000, quantity: null, startDate: '2025-01-01', note: '', minHoldDays: 90, riskLevel: 'R3', tPlusN: 2 };
let sell = Calc.sellStatus(sellAsset, '2025-02-20');
assert(sell.heldDays === 50 && sell.sellable === false && sell.remainingDays === 40, '持有 50 天 < 最低 90 天 → 不可卖，还需 40 天');
sell = Calc.sellStatus(sellAsset, '2025-04-01');
assert(sell.heldDays === 90 && sell.sellable === true && sell.remainingDays === 0, '持有满 90 天 → 可卖');
sell = Calc.sellStatus({ ...sellAsset, minHoldDays: null }, '2025-02-20');
assert(sell.minDays === null && sell.sellable === null, '未设置最低持有天数 → 不限制（sellable 为 null）');

// 4.8 汇率联网查询（注入假 fetcher）
const fakeOk = async () => ({ ok: true, json: async () => ({ rates: { CNY: 7.2, USD: 1, EUR: 0.92 } }) });
const fakeFail = async () => { throw new Error('offline'); };
const res = await EcoCal.fetchLatestRates('USD', fakeOk);
assert(approx(res.rates.CNY, round2(1 / 7.2)), 'USD 基准下 1 CNY = 1/7.2 USD，换算正确');
assert(res.rates.USD === undefined, '基准币种自身不进入汇率表');
assert(typeof res.source === 'string' && res.updatedAt > 0, '返回来源与更新时间');
let rejected = false;
try { await EcoCal.fetchLatestRates('USD', fakeFail); } catch (e) { rejected = true; }
assert(rejected, '全部接口失败时抛出异常（调用方可提示用户）');

// 4.9 表单与面板 HTML 生成（新字段/新按钮均在表单中）
EcoCal.openSettings();
const settingsHtml = elements['modal-body'].innerHTML || '';
assert(settingsHtml.includes('id="s-fetch"'), '汇率面板含「获取最新汇率」按钮');
assert(settingsHtml.includes('每次启动自动获取一次'), '汇率面板含启动自动获取开关');
EcoCal.openAssetForm(null);
const assetFormHtml = elements['modal-body'].innerHTML || '';
assert(assetFormHtml.includes('id="f-minhold"'), '产品表单含「最低持有天数」字段');
assert(assetFormHtml.includes('id="f-risk"') && assetFormHtml.includes('R1（低风险）'), '产品表单含「风险等级」字段');
assert(assetFormHtml.includes('id="f-tplusn"'), '产品表单含「T+n」字段');
EcoCal.openHelp();
const helpHtml = elements['modal-body'].innerHTML || '';
assert(helpHtml.includes('年化收益率（年化）'), '帮助包含年化概念解释');
assert(helpHtml.includes('最低持有天数') && helpHtml.includes('T+n'), '帮助包含最低持有天数与 T+n 解释');

// 4.10 手机友好导入/导出
EcoCal.seedDemo(); // 确保有数据
EcoCal.openExportModal();
const exportHtml = elements['modal-body'].innerHTML || '';
assert(exportHtml.includes('exp-download') && exportHtml.includes('exp-copy'), '导出面板提供「下载」与「复制到剪贴板」');
assert(exportHtml.includes('exp-text'), '导出面板内嵌可复制的 JSON 文本域');
const payloadText = EcoCal.buildExportPayload();
assert(JSON.parse(payloadText).assets.length === 6, 'buildExportPayload 输出合法且含全部产品');

// 端到端导入：粘贴文本 → 确认 → 覆盖并持久化
const importData = {
  assets: [{ id: 'x1', name: '迁移产品', category: 'fund', subCategory: '混合型', currency: 'CNY',
    principal: 1000, quantity: null, startDate: '2026-01-01', note: '',
    minHoldDays: null, riskLevel: null, tPlusN: null, createdAt: 1, updatedAt: 1 }],
  valuations: [],
  settings: { baseCurrency: 'CNY', rates: {}, demoDismissed: true },
};
EcoCal.importPayloadText(JSON.stringify(importData));
assert(!elements['confirm-backdrop'].classList.contains('hidden'), '粘贴导入后先弹出覆盖确认');
elements['confirm-ok'].onclick();
assert(EcoCal.state.assets.length === 1 && EcoCal.state.assets[0].name === '迁移产品', '确认后备份数据替换当前数据');
assert(Object.keys(storage).length > 0, '导入后已持久化到 localStorage');
assert(EcoCal.state.settings.baseCurrency === 'CNY', '导入后设置生效');

// 非法内容导入被拒绝
const beforeLen = EcoCal.state.assets.length;
EcoCal.importPayloadText('{not json');
assert(EcoCal.state.assets.length === beforeLen, '非法 JSON 导入被拒绝且数据不变');

/* ---- 4.11 交易引擎（加权平均 / 浮动 / 已实现盈亏） ---- */
const tAsset = { id: 't1', name: '测试股票', category: 'stock', subCategory: 'A股', currency: 'CNY',
  principal: 0, quantity: null, startDate: '2025-01-01', note: '', enableTrades: true, symbol: 'sh600000', lastPrice: null };
const mkTrade = (type, date, qty, price, fee) => ({
  id: EcoCal.uid('trade_'), assetId: 't1', type, date, quantity: qty, price, fee: fee || 0, note: '',
});

let trades = [
  mkTrade('buy', '2025-01-01', 100, 10),
  mkTrade('buy', '2025-01-10', 100, 12),
];
let pos = Calc.tradePosition(tAsset, trades, null);
assert(pos.qty === 200 && pos.cost === 2200 && approx(pos.avgCost, 11), '两笔买入：数量200、成本2200、均价11');
pos = Calc.tradePosition(tAsset, trades, 12);
assert(approx(pos.marketValue, 2400) && approx(pos.float, 200), '现价12：市值2400、浮动200');

trades.push(mkTrade('sell', '2025-02-01', 50, 13));
pos = Calc.tradePosition(tAsset, trades, 12);
assert(pos.qty === 150 && approx(pos.cost, 1650), '卖出50股后：数量150、成本1650（按均价11扣减）');
assert(approx(pos.realized, 100), '已实现盈亏 = 50×(13−11) = 100');
assert(approx(pos.totalProfit, pos.float + 100), '总盈亏 = 浮动 + 已实现');

// 手续费口径
pos = Calc.tradePosition(tAsset, [
  mkTrade('buy', '2025-01-01', 100, 10, 5),
  mkTrade('sell', '2025-02-01', 50, 13, 2),
], null);
assert(approx(pos.cost, 502.5), '买入含手续费1005，卖出扣50×10.05=502.5 → 成本502.5');
assert(approx(pos.realized, 145.5), '卖出金额648 − 502.5 = 145.5');

// 超卖防御（UI 另有拦截，计算层钳制不抛错）
pos = Calc.tradePosition(tAsset, [mkTrade('buy', '2025-01-01', 50, 10), mkTrade('sell', '2025-02-01', 100, 12)], 12);
assert(pos.qty === 0 && pos.cost === 0, '超卖被钳制为零持仓、零成本（不抛错）');

// 清仓后再买
pos = Calc.tradePosition(tAsset, [
  mkTrade('buy', '2025-01-01', 100, 10),
  mkTrade('sell', '2025-02-01', 100, 12),
  mkTrade('buy', '2025-03-01', 100, 13),
], 14);
assert(pos.qty === 100 && approx(pos.cost, 1300) && approx(pos.realized, 200), '清仓再买：数量100、成本1300、已实现200');
assert(pos.events.length === 3 && pos.events[1].trade.date === '2025-02-01', '交易事件按日期排序');

/* ---- 4.12 汇总混合模式（价值快照 + 交易记录） ---- */
const mixedAssets = [
  { id: 'm1', name: '理财', category: 'wealth', subCategory: '固收类', currency: 'CNY', principal: 10000, quantity: null, startDate: '2025-01-01', note: '' },
  { id: 'm2', name: '股票', category: 'stock', subCategory: 'A股', currency: 'CNY', principal: 0, quantity: null, startDate: '2025-01-01', note: '', enableTrades: true, symbol: 'sh600000', lastPrice: 12 },
];
const mixed = Calc.summary(mixedAssets, [
  { id: 'v9', assetId: 'm1', date: '2025-06-01', value: 10300 },
], { baseCurrency: 'CNY', rates: {} }, [
  { id: 'tr1', assetId: 'm2', type: 'buy', date: '2025-01-01', quantity: 100, price: 10, fee: 0, note: '' },
  { id: 'tr2', assetId: 'm2', type: 'sell', date: '2025-02-01', quantity: 50, price: 13, fee: 0, note: '' },
]);
assert(approx(mixed.totalProfit, 300 + 250), '混合总盈亏 = 理财300 + 股票(浮动100+已实现150) = 550');
assert(approx(mixed.totalRealized, 150), '已实现盈亏汇总 = 150');
assert(mixed.metrics.length === 2 && mixed.metrics.some(m => m.trade), '交易模式 metric 带 trade 信息');

/* ---- 4.13 旧数据迁移为交易模式首笔买入 ---- */
EcoCal.state.trades = [];
const oldAsset = { id: 'mig1', name: '旧股票', category: 'stock', subCategory: 'A股', currency: 'CNY',
  principal: 30000, quantity: 800, startDate: '2025-01-01', note: '', enableTrades: true };
const migrated = EcoCal.migrateToTrades(oldAsset);
assert(migrated === true && EcoCal.state.trades.length === 1 && EcoCal.state.trades[0].type === 'buy', '切换交易模式生成一笔买入');
assert(approx(EcoCal.state.trades[0].price, 37.5) && EcoCal.state.trades[0].quantity === 800, '迁移单价 = 30000/800 = 37.5');
assert(EcoCal.migrateToTrades(oldAsset) === false && EcoCal.state.trades.length === 1, '已有交易记录时不重复迁移');
assert(EcoCal.migrateToTrades({ ...oldAsset, id: 'mig2', quantity: null }) === false, '无有效数量时不生成迁移交易');

/* ---- 4.14 行情模块：代码标准化 + 接口响应解析（注入 fetcher） ---- */
const norm = EcoCal.normalizeSymbol;
assert(norm('sh600519').ok && norm('sh600519').code === 'sh600519', '代码标准化：sh 前缀保留');
assert(norm('600519').code === 'sh600519', '纯6开头 → 沪 sh');
assert(norm('000001').code === 'sz000001', '纯0开头 → 深 sz');
assert(norm('300750').code === 'sz300750', '纯3开头 → 深 sz');
assert(norm('hk00700').code === 'hk00700' && norm('usAAPL').code === 'usAAPL', '港股/美股前缀保留');
assert(norm('KO').code === 'usKO', '直接输入美股代码 KO → usKO（可口可乐）');
assert(norm('ko').code === 'usKO' && norm('Ko').code === 'usKO', '美股代码大小写不敏感');
assert(norm('AAPL').code === 'usAAPL', '直接输入 AAPL → usAAPL');
assert(norm('00700').code === 'hk00700', '5位数字 → 港股');
assert(norm('123').ok === false, '3位数字不是有效代码');
assert(norm('xyz').code === 'usXYZ', '2-5位字母按美股处理（不存在则行情查询失败提示）');

const fakeQ = async () => ({ ok: true, text: async () => 'v_sh600519="1~贵州茅台~600519~1450.00~1448.00~…";' });
const prices = await EcoCal.fetchQuote(['sh600519'], fakeQ);
assert(approx(prices.sh600519, 1450), '行情解析：现价=1450');
let quoteFail = false;
try { await EcoCal.fetchQuote(['sh999999'], async () => ({ ok: true, text: async () => '' })); } catch (e) { quoteFail = true; }
assert(quoteFail, '行情空响应抛错（调用方可提示）');

const fakeK = async () => ({ ok: true, json: async () => ({
  data: { sh600519: { qfqday: [['2026-01-02', 10, 10.5, 10.8, 9.9], ['2026-01-05', 10.5, 10.8, 11.0, 10.4]] } },
}) });
const kline = await EcoCal.fetchKline('sh600519', 60, fakeK);
assert(kline.length === 2 && kline[1][2] === 10.8, '日K解析：返回 [date,open,close,high,low] 且收盘价正确');

/* ---- 4.15 交易模式表单字段 ---- */
EcoCal.state.assets = [{ id: 'tf1', name: '交易股票', category: 'stock', subCategory: 'A股', currency: 'CNY',
  principal: 0, quantity: null, startDate: '2026-01-01', note: '', enableTrades: true, symbol: 'sh600036' }];
EcoCal.state.trades = [{ id: 'trx', assetId: 'tf1', type: 'buy', date: '2026-01-01', quantity: 100, price: 10, fee: 0, note: '' }];
EcoCal.openTradeForm('tf1', 'sell', null);
const tradeHtml = elements['modal-body'].innerHTML || '';
assert(tradeHtml.includes('id="t-qty"') && tradeHtml.includes('id="t-price"') && tradeHtml.includes('当前持仓'), '卖出表单包含数量/单价/持仓提示');
EcoCal.openAssetForm('tf1');
const assetForm2 = elements['modal-body'].innerHTML || '';
assert(assetForm2.includes('id="f-mode"') && assetForm2.includes('id="f-symbol"'), '产品表单包含记账模式与行情代码字段');
assert(!assetForm2.includes('id="f-price"') && !assetForm2.includes('id="f-principal"'), '交易记录模式无需填写首笔买入/本金（监察表模式）');
assert(assetForm2.includes('单股价格'), '监察表模式提示「买入/卖出均填单股价格」');
// 股票入口：监察表
EcoCal.openAssetForm(null, { category: 'stock', mode: 'trades' });
const stockForm = elements['modal-body'].innerHTML || '';
assert(stockForm.includes('value="stock" selected>股票'), '股票入口默认大类=股票');
assert(stockForm.includes('value="trades" selected'), '股票入口默认交易记录（监察表）模式');
assert(stockForm.includes('id="f-symbol"') && stockForm.includes('股票代码 *'), '股票入口代码必填（选定即加入监察表）');
assert(!stockForm.includes('id="f-principal"'), '股票监察表新建不含本金字段');
// 其他产品入口：价值快照（如基金）
EcoCal.openAssetForm(null, { category: 'fund', mode: 'valuation' });
const fundForm = elements['modal-body'].innerHTML || '';
assert(fundForm.includes('value="fund" selected>基金'), '其他产品入口默认大类=基金');
assert(fundForm.includes('value="valuation" selected'), '其他产品入口默认价值快照模式');
assert(fundForm.includes('id="f-principal"'), '基金入口含本金（价值快照）输入');
assert(!fundForm.includes('股票代码 *') && fundForm.includes('行情代码（可选）'), '基金入口行情代码为可选');

/* ---- 4.16 市场→币种自动推断 + 证券信息解析 + 版本号 ---- */
const stc = EcoCal.symbolToCurrency;
assert(stc('sh600519') === 'CNY' && stc('sz000001') === 'CNY' && stc('bj830799') === 'CNY', 'A股/北交所 → CNY');
assert(stc('hk00700') === 'HKD', '港股 → HKD');
assert(stc('usKO') === 'USD' && stc('usAAPL') === 'USD', '美股 → USD');
const info = await EcoCal.fetchStockInfo('sh600036', async () => ({
  ok: true, text: async () => 'v_sh600036="1~招商银行~600036~43.05~42.76~…";',
}));
assert(info.name === '招商银行' && approx(info.price, 43.05), '证券信息解析：名称+现价');
assert(/^v?\d+\.\d+\.\d+$/.test(EcoCal.APP_VERSION), '版本号格式为 x.y.z（当前 v' + EcoCal.APP_VERSION + '）');

/* ---- 5. 持久化往返：seedDemo → save → load ---- */
EcoCal.seedDemo();
assert(EcoCal.state.assets.length === 6, '演示数据含 6 个产品');
assert(EcoCal.state.assets.some(a => a.minHoldDays === 1095 && a.riskLevel === 'R1'), '演示数据含最低持有天数/风险等级字段');
assert(EcoCal.SORT_OPTIONS.some(o => o[0] === 'annualDesc'), '排序选项包含「年化从高到低」');
const saved = EcoCal.loadState();
assert(saved === true, 'seedDemo 后 loadState 返回 true（数据已持久化）');
assert(EcoCal.state.settings.baseCurrency === 'CNY', '基准币种默认 CNY');
assert(EcoCal.state.settings.autoFetchRates === true, '默认开启启动自动获取汇率');
const sum2 = Calc.summary(EcoCal.state.assets, EcoCal.state.valuations, EcoCal.state.settings);
assert(sum2.totalValue > 0, '演示数据汇总市值 > 0');
assert(sum2.metrics.every(mm => mm.assetId), '每个 metric 都带 assetId（事件委托依赖）');
assert(sum2.metrics.every(mm => mm.assetCurrency), '每个 metric 都带 assetCurrency');

/* ---- 汇总结果 ---- */
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail > 0) process.exit(1);
