/**
 * EcoCal v6 回归测试：先做 js/app.js 语法检查，再用模拟浏览器环境验证计算引擎与功能。
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
    onclick: null, onchange: null, checked: false,
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
// 录入方式单选桩：三个值各一个对象；默认选中「总金额」
// 外币「兑换」测试通过将 tmodeStubs.exchange.checked 置 true、其余置 false 来切换
const tmodeStubs = {
  qty: { value: 'qty', checked: false, onchange: null },
  amount: { value: 'amount', checked: true, onchange: null },
  exchange: { value: 'exchange', checked: false, onchange: null },
};
globalThis.window = globalThis;
globalThis.document = {
  readyState: 'complete',
  getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
  querySelector(sel) {
    // 交易录入方式单选：按选择器返回对应桩；:checked 返回当前选中项
    if (sel && sel.includes('tmode')) {
      if (sel.includes(':checked')) return Object.values(tmodeStubs).find(s => s.checked) || tmodeStubs.amount;
      const m = sel.match(/\[value="([^"]+)"\]/);
      if (m) return tmodeStubs[m[1]] || tmodeStubs.qty;
      return tmodeStubs.amount;
    }
    return null;
  },
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
// PIN 锁用 sessionStorage 记录「已解锁」状态，测试环境用内存对象补齐
const sessionStore = {};
globalThis.sessionStorage = {
  getItem(k) { return sessionStore[k] !== undefined ? sessionStore[k] : null; },
  setItem(k, v) { sessionStore[k] = String(v); },
  removeItem(k) { delete sessionStore[k]; },
};
globalThis.alert = () => {};
globalThis.prompt = () => null;
globalThis.Blob = function () {};
globalThis.FileReader = function () {};
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
// app.js 的 WebDAV Basic 认证用 btoa(unescape(encodeURIComponent(...)))，
// 测试环境没有 btoa，这里给一个纯 JS 实现（严格 UTF-8 base64 编码）
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = bin => {
    const bytes = new TextEncoder().encode(bin);
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += chars[b0 >> 2];
      out += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
      if (b1 === undefined) { out += '=='; continue; }
      out += chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 2)];
      if (b2 === undefined) { out += '='; continue; }
      out += chars[b2 & 63];
    }
    return out;
  };
}

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

/* ---- 4. 计算引擎测试（v6：纯交易记录口径） ---- */
const { Calc, round2, dayDiff } = EcoCal;

// 4.1 交易持仓：加权平均成本 / 市值 / 浮动
const tAsset = { id: 't1', name: '测试股票', category: 'stock', subCategory: 'A股', currency: 'CNY',
  principal: 0, quantity: null, startDate: null, note: '' };
const mkTrade = (type, date, qty, price, fee, minHold) => ({
  id: EcoCal.uid('trade_'), assetId: 't1', type, date, quantity: qty, price, fee: fee || 0, note: '',
  mode: 'qty', minHoldDays: minHold != null ? minHold : null,
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
assert(approx(pos.realized, 100) && approx(pos.received, 650), '已实现盈亏=100；卖出回收金额=650');
assert(approx(pos.totalProfit, pos.float + 100), '总盈亏 = 浮动 + 已实现');

// 手续费口径
pos = Calc.tradePosition(tAsset, [
  mkTrade('buy', '2025-01-01', 100, 10, 5),
  mkTrade('sell', '2025-02-01', 50, 13, 2),
], null);
assert(approx(pos.cost, 502.5), '买入含手续费1005，卖出扣50×10.05=502.5 → 成本502.5');
assert(approx(pos.realized, 145.5) && approx(pos.received, 648), '卖出金额648 − 502.5 = 145.5；回收648');

// 超卖钳制
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

// 4.1b lastPrice 缺失时市值回退最近成交价（与走势图口径一致）
pos = Calc.tradePosition(tAsset, [
  mkTrade('buy', '2025-01-01', 100, 10),
  mkTrade('buy', '2025-01-10', 100, 12),
], null);
assert(pos.marketValue != null && approx(pos.marketValue, 2400), '无现价但有持仓 → 市值按最近成交价 12 估算 2400');
assert(approx(pos.float, 200) && approx(pos.totalProfit, 200), '无现价回退：浮动 = 2400 − 2200 = 200，总盈亏 200');
// 清仓后无持仓 → 市值仍为 null（避免把已清仓资产误算成有市值）
pos = Calc.tradePosition(tAsset, [
  mkTrade('buy', '2025-01-01', 100, 10),
  mkTrade('sell', '2025-02-01', 100, 12),
], null);
assert(pos.qty === 0 && pos.marketValue === null, '清仓后无持仓 → 市值保持 null');
// 完全无交易 → 市值 null
pos = Calc.tradePosition(tAsset, [], null);
assert(pos.marketValue === null && pos.cost === 0 && pos.qty === 0, '无任何交易 → 市值 null、成本 0');

// 4.2 FIFO 批次（lots）与可卖判定（批次各自最低持有天数）
const fundAsset = { id: 'f1', name: '基金', category: 'fund', subCategory: '混合型', currency: 'CNY',
  principal: 0, quantity: null, startDate: null, note: '' };
const fTrades = [
  { ...mkTrade('buy', '2025-01-01', 5000, 10, 0, 30), assetId: 'f1' },
  { ...mkTrade('buy', '2025-01-26', 2000, 10.6, 0, 7), assetId: 'f1' },
  { ...mkTrade('sell', '2025-01-28', 500, 11), assetId: 'f1' },
];
let lots = Calc.lots(fundAsset, fTrades, '2025-02-05');
assert(lots.length === 2 && approx(lots[0].qty, 4500) && approx(lots[1].qty, 2000), 'FIFO：先卖消耗首笔批次（5000→4500）');
assert(lots[0].sellable === true && lots[1].sellable === true, '两批均到期（35天≥30 / 10天≥7）→ 可卖');
let sell = Calc.sellStatus(fundAsset, fTrades, '2025-02-05');
assert(sell.sellable === true && sell.partial === false, '全部批次可卖 → sellable=true');
sell = Calc.sellStatus(fundAsset, fTrades, '2025-01-20');
assert(sell.sellable === false && sell.partial === false && sell.remainingDays === 11, '两批均未到期（首批19天<30）→ 整仓锁定，还需11天');
// 部分可卖：第一天批 90 天锁，第二批无限制
const mixedTrades = [
  { ...mkTrade('buy', '2025-01-01', 100, 10, 0, 90), assetId: 'f1' },
  { ...mkTrade('buy', '2025-01-10', 50, 11), assetId: 'f1' },
];
sell = Calc.sellStatus(fundAsset, mixedTrades, '2025-01-20');
assert(sell.partial === true && approx(sell.lockedQty, 100) && sell.remainingDays === 71, '仅首批锁定（已持19天，还需71天）→ 部分可卖，锁定100份');
// 无任何批次限制 → sellable=null（不限制）；资产级 minHoldDays 回退
const noLimit = Calc.sellStatus({ ...fundAsset, minHoldDays: null }, [{ ...mkTrade('buy', '2025-01-01', 100, 10), assetId: 'f1' }], '2025-01-20');
assert(noLimit.sellable === null, '未配置任何最低持有天数 → 不限制');
const assetLv = Calc.sellStatus({ ...fundAsset, minHoldDays: 30 }, [{ ...mkTrade('buy', '2025-01-01', 100, 10), assetId: 'f1' }], '2025-01-20');
assert(assetLv.sellable === false && assetLv.remainingDays === 11, '批次无限制但资产级 30 天 → 从首笔交易日回退判定（已持19天，还需11天）');

// 4.3 外币资产：人民币买卖按汇率计算
const fxAsset = { id: 'fx1', name: '美元现汇', category: 'fx', subCategory: '现汇', currency: 'CNY', foreignCurrency: 'USD',
  principal: 0, quantity: null, startDate: null, note: '' };
const fxTrades = [
  { ...mkTrade('buy', '2025-01-01', 2000, 7.15), assetId: 'fx1' },   // 花 14300 元买 2000 USD
  { ...mkTrade('sell', '2025-01-30', 500, 7.30), assetId: 'fx1' },   // 卖 500 USD 得 3650 元
];
pos = Calc.tradePosition(fxAsset, fxTrades, 7.22);
assert(approx(pos.qty, 1500) && approx(pos.cost, 10725), '外币：余额1500、按平均汇率扣减后成本10725（人民币）');
assert(approx(pos.realized, 75), '外币已实现盈亏 = 500×(7.30−7.15) = 75 元');
assert(approx(pos.marketValue, 10830) && approx(pos.float, 105), '当前汇率7.22：市值10830、浮动105（人民币）');
assert(approx(pos.totalProfit, 180), '外币总盈亏 = 105 + 75 = 180');

// 4.4 fxRateFromCache：基准币种换算
assert(approx(EcoCal.fxRateFromCache('USD', { baseCurrency: 'CNY', rates: { USD: 7.2 } }), 7.2), '基准CNY：1 USD 兑 CNY = rates[USD]');
assert(approx(EcoCal.fxRateFromCache('USD', { baseCurrency: 'HKD', rates: { CNY: 0.92, USD: 7.2 } }), 7.2 / 0.92), '基准HKD：USD兑CNY = rates[USD]/rates[CNY]');
assert(EcoCal.fxRateFromCache('JPY', { baseCurrency: 'CNY', rates: { USD: 7.2 } }) === null, '缺汇率返回 null');

// 4.5 汇总（全交易口径）
const settings = { baseCurrency: 'CNY', rates: { USD: 7.2 } };
const assets = [
  { id: 'a1', name: '基金', category: 'fund', subCategory: '混合型', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 10.5 },
  { id: 'a2', name: '美股', category: 'stock', subCategory: '美股', currency: 'USD', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 21 },
  { id: 'a3', name: '欧元缺汇率', category: 'fund', subCategory: '其他', currency: 'EUR', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 11 },
];
const allTrades = [
  { id: 'x1', assetId: 'a1', type: 'buy', date: '2025-01-01', quantity: 1000, price: 10, fee: 0, note: '' },
  { id: 'x2', assetId: 'a2', type: 'buy', date: '2025-01-01', quantity: 100, price: 20, fee: 0, note: '' },
  { id: 'x3', assetId: 'a3', type: 'buy', date: '2025-01-01', quantity: 100, price: 10, fee: 0, note: '' },
];
const sum = Calc.summary(assets, [], settings, allTrades);
assert(approx(sum.totalCost, 10000 + 2000 * 7.2), '总成本 = 10000 + 14400（EUR 缺汇率不计入）');
assert(approx(sum.totalValue, 10500 + 2100 * 7.2), '总市值 = 10500 + 15120（EUR 不计入）');
assert(sum.missingRateCurrencies.includes('EUR'), '缺失汇率列表包含 EUR');
assert(approx(sum.totalProfit, (10500 - 10000) + (2100 - 2000) * 7.2), '总收益求和正确（浮动+已实现）');
assert(sum.metrics.length === 3 && sum.metrics.every(m => m.trade), '每个 metric 均为交易口径并带 trade 信息');
assert(approx(sum.metrics[0].simpleAnnual, 500 / 10000 * 365 / EcoCal.dayDiff('2025-01-01', EcoCal.todayStr())), 'trade metric 带单利年化（供排序/展示）');

// 4.6 汇率联网查询（注入假 fetcher）
const fakeOk = async () => ({ ok: true, json: async () => ({ rates: { CNY: 7.2, USD: 1, EUR: 0.92 } }) });
const fakeFail = async () => { throw new Error('offline'); };
const res = await EcoCal.fetchLatestRates('USD', fakeOk);
assert(approx(res.rates.CNY, round2(1 / 7.2)), 'USD 基准下 1 CNY = 1/7.2 USD，换算正确');
assert(res.rates.USD === undefined, '基准币种自身不进入汇率表');
let rejected = false;
try { await EcoCal.fetchLatestRates('USD', fakeFail); } catch (e) { rejected = true; }
assert(rejected, '全部接口失败时抛出异常（调用方可提示用户）');

// 4.7 产品表单（v6：单一入口、仅基本信息、大类联动）
EcoCal.openAssetForm(null);
let assetFormHtml = elements['modal-body'].innerHTML || '';
assert(assetFormHtml.includes('id="f-name"') && assetFormHtml.includes('id="f-category"'), '产品表单含名称与大类');
assert(assetFormHtml.includes('value="fund" selected>基金'), '单一入口默认大类=基金');
assert(!assetFormHtml.includes('id="f-principal"') && !assetFormHtml.includes('id="f-quantity"'), '不再填写本金/数量');
assert(!assetFormHtml.includes('id="f-start"') && !assetFormHtml.includes('id="f-mode"') && !assetFormHtml.includes('id="f-minhold"'), '不再填开始日期/记账模式/资产级最低持有天数');
assert(assetFormHtml.includes('id="f-sym-row"') && assetFormHtml.includes('style="display:none"'), '默认隐藏股票代码栏，大类切换后显示');
assert(assetFormHtml.includes('id="f-fx-row"') && assetFormHtml.includes('id="f-foreign"'), '含外币币种选择栏（默认隐藏）');
assert(assetFormHtml.includes('id="f-risk"') && assetFormHtml.includes('id="f-tplusn"') && assetFormHtml.includes('id="f-note"'), '含风险等级/T+n/备注基本信息');
// 股票入口预设：股票代码必填
EcoCal.openAssetForm(null, { category: 'stock' });
const stockForm = elements['modal-body'].innerHTML || '';
assert(stockForm.includes('value="stock" selected>股票'), '股票预设默认大类=股票');
assert(stockForm.includes('股票代码 *') && stockForm.includes('id="f-symbol"'), '股票预设显示代码必填栏');
assert(!stockForm.includes('id="f-principal"') && !stockForm.includes('id="f-minhold"'), '股票添加仅基本信息+代码');
// 外币入口预设：外币币种选择
EcoCal.openAssetForm(null, { category: 'fx' });
const fxForm = elements['modal-body'].innerHTML || '';
assert(fxForm.includes('value="fx" selected>外币'), '外币预设默认大类=外币');
assert(fxForm.includes('id="f-foreign"') && fxForm.includes('美元'), '外币预设含外币币种下拉');
assert(fxForm.includes('value="CNY"'), '外币产品的本位币固定为 CNY');

// 4.8 交易表单（v6：两种录入方式 + 批次最低持有天数）
EcoCal.state.assets = [
  { id: 'tf1', name: '交易股票', category: 'stock', subCategory: 'A股', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 12, symbol: 'sh600036' },
  { id: 'tf2', name: '交易基金', category: 'fund', subCategory: '混合型', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 1.05 },
];
EcoCal.state.trades = [{ id: 'trx', assetId: 'tf1', type: 'buy', date: '2026-01-01', quantity: 100, price: 10, fee: 0, note: '' }];
EcoCal.openTradeForm('tf1', 'sell', null);
let tradeHtml = elements['modal-body'].innerHTML || '';
assert(tradeHtml.includes('name="tmode"') && tradeHtml.includes('份数 × 单价') && tradeHtml.includes('总金额'), '卖出表单含录入方式切换');
assert(tradeHtml.includes('id="t-amount-row"') && tradeHtml.includes('style="display:none"'), '股票默认份数×单价（金额行隐藏）');
assert(!tradeHtml.includes('id="t-minhold"'), '股票买入不使用批次最低持有天数（回退资产级）');
EcoCal.openTradeForm('tf2', 'buy', null);
tradeHtml = elements['modal-body'].innerHTML || '';
assert(tradeHtml.includes('id="t-qty-row"') && tradeHtml.includes('id="t-amount-row"'), '基金买入含份数与总金额两套输入');
assert(tradeHtml.includes('id="t-minhold"') && tradeHtml.includes('这笔买入的最低持有天数'), '非股票买入可填批次最低持有天数');

// 模拟表单填值：先准备好 DOM 元素（$id 在打开表单后才会创建实际输入框）
const touch = id => elements[id] || (elements[id] = makeEl(id));

// 4.9 总金额模式端到端提交（模拟填表 → 保存）
EcoCal.openTradeForm('tf2', 'buy', null);
touch('t-amount').value = '10500';   // 总金额
touch('t-price').value = '1.05';     // 单价
touch('t-fee').value = '0';
touch('t-note').value = '总金额模式买入';
touch('t-date').value = '2026-02-01';
touch('t-minhold').value = '7';
EcoCal.state.trades = []; // 从空开始
EcoCal.submitTrade('tf2', null, 'buy');
assert(EcoCal.state.trades.length === 1, '总金额模式提交后生成一笔交易');
assert(approx(EcoCal.state.trades[0].quantity, 10000) && approx(EcoCal.state.trades[0].price, 1.05), '份额 = 10500/1.05 = 10000 份');
assert(EcoCal.state.trades[0].minHoldDays === 7 && EcoCal.state.trades[0].mode === 'amount', '批次最低持有天数与录入方式已保存');
// 总金额模式：不填单价时按当前单位价值折算
EcoCal.state.trades = [];
EcoCal.openTradeForm('tf2', 'buy', null);
touch('t-amount').value = '1050';
touch('t-price').value = '';
touch('t-date').value = '2026-02-01';
EcoCal.submitTrade('tf2', null, 'buy');
assert(approx(EcoCal.state.trades[0].price, 1.05) && approx(EcoCal.state.trades[0].quantity, 1000), '金额模式缺单价 → 用当前单位价值1.05折算份额');
// 总金额模式：卖出超持仓被拦截
EcoCal.state.trades = [{ id: 'tx0', assetId: 'tf2', type: 'buy', date: '2026-01-01', quantity: 10, price: 1, fee: 0, note: '' }];
EcoCal.openTradeForm('tf2', 'sell', null);
touch('t-amount').value = '99999';
touch('t-price').value = '1';
touch('t-date').value = '2026-02-01';
EcoCal.submitTrade('tf2', null, 'sell');
assert(EcoCal.state.trades.length === 1, '金额模式超持仓卖出被拦截（未生成交易）');

// 4.10 手动设置当前市值：股票=现价；非股票=持仓总金额
EcoCal.state.assets = [
  { id: 'mps', name: '股票', category: 'stock', subCategory: 'A股', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', lastPrice: null },
  { id: 'mpf', name: '基金', category: 'fund', subCategory: '混合型', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', lastPrice: null },
];
EcoCal.state.trades = [
  { id: 'mt1', assetId: 'mps', type: 'buy', date: '2026-01-01', quantity: 100, price: 10, fee: 0, note: '' },
  { id: 'mt2', assetId: 'mpf', type: 'buy', date: '2026-01-01', quantity: 1000, price: 1, fee: 0, note: '' },
];
EcoCal.manualPriceline({ ...EcoCal.state.assets[0] });
let priceHtml = elements['modal-body'].innerHTML || '';
assert(priceHtml.includes('id="p-price"'), '股票现价弹窗：填现价');
EcoCal.manualPriceline({ ...EcoCal.state.assets[1] });
priceHtml = elements['modal-body'].innerHTML || '';
assert(priceHtml.includes('id="p-value"') && priceHtml.includes('当前持仓总金额'), '非股票市值弹窗：填当前持仓总金额');
assert(!priceHtml.includes('id="p-price"'), '非股票不出现单价输入');

// 4.10b 手动录价不四舍五入：录多少存多少（roundPriceSoft，修复「更新市值自动四舍五入」）
const stockA = EcoCal.state.assets[0];           // mps 股票，持仓 100 股
EcoCal.manualPriceline(stockA);
elements['p-price'] = { value: '7.25255' };      // 5 位小数股价（仅在提交回调中被读取，桩需先存在）
elements['modal-ok'].onclick();                  // 保存（bindModalButtons 已把 modalOnOk 接到该 handler）
assert(stockA.lastPrice === 7.25255, '股票手动现价原样保存（7.25255 不四舍五入为 7.2526）');
const fundA = EcoCal.state.assets[1];            // mpf 基金，份额 1000
EcoCal.manualPriceline(fundA);
elements['p-value'] = { value: '7252.555' };     // 持仓总金额（3 位小数）
elements['modal-ok'].onclick();
assert(approx(fundA.lastPrice, 7252.555 / 1000), '非股票折算单位价值不取整（7252.555/1000 原样）');
assert(approx(fundA.lastPrice * 1000, 7252.555), '市值回算保持录入精度（总金额 7252.555 不丢）');
// 回归：整数/普通小数价格不受影响
EcoCal.state.assets[0].lastPrice = 12.5;
EcoCal.manualPriceline(EcoCal.state.assets[0]);
elements['p-price'] = { value: '12.5' };
elements['modal-ok'].onclick();
assert(stockA.lastPrice === 12.5, '普通小数现价仍为原值（12.5）');
EcoCal.state.assets[0].lastPrice = null;
fundA.lastPrice = null;

// 4.11 设置面板（清空数据入口 + 汇率/行情开关）
EcoCal.openSettings();
const settingsHtml = elements['modal-body'].innerHTML || '';
assert(settingsHtml.includes('id="s-fetch"') && settingsHtml.includes('id="s-base"'), '设置面板含汇率获取与基准币种');
assert(settingsHtml.includes('id="s-rf"') && settingsHtml.includes('无风险'), '设置面板含统计设置（无风险利率，用于夏普）');
assert(settingsHtml.includes('id="s-liab"') && settingsHtml.includes('负债'), '设置面板含负债（净资产口径）');
assert(settingsHtml.includes('id="s-cap"') && settingsHtml.includes('单一标的上限'), '设置面板含单一标的上限阈值（集中度）');
assert(settingsHtml.includes('id="s-clear"') && settingsHtml.includes('清空全部数据'), '设置面板含清空数据（危险操作）');
assert(settingsHtml.includes('id="s-autoquote"') && settingsHtml.includes('id="s-autofetch"'), '设置面板含行情/汇率自动开关');

// 4.12 帮助页：使用指南 + 演示数据区（演示数据移出主页）
EcoCal.state.assets = [];     // 模拟"无真实数据"的空主页
EcoCal.state.trades = [];
EcoCal.openHelp();
const helpHtml = elements['modal-body'].innerHTML || '';
assert(helpHtml.includes('演示数据') && helpHtml.includes('id="help-demo-load"'), '帮助页含演示数据区与载入按钮');
assert(helpHtml.includes('外币投资') && helpHtml.includes('总金额'), '帮助页介绍外币与两种录入方式');
assert(EcoCal.state.assets.length === 0, '帮助页打开不自动载入演示数据（主页面留白）');
elements['help-demo-load'].onclick();
assert(EcoCal.state.assets.length === 7, '点击「载入演示数据」后载入 7 个产品');
assert(EcoCal.state.assets.some(a => a.category === 'fx' && a.foreignCurrency === 'USD'), '演示数据含外币产品');

// 4.13 行情模块：代码标准化 + 接口响应解析（注入 fetcher）
const norm = EcoCal.normalizeSymbol;
assert(norm('sh600519').ok && norm('sh600519').code === 'sh600519', '代码标准化：sh 前缀保留');
assert(norm('600519').code === 'sh600519', '纯6开头 → 沪 sh');
assert(norm('000001').code === 'sz000001', '纯0开头 → 深 sz');
assert(norm('hk00700').code === 'hk00700' && norm('usAAPL').code === 'usAAPL', '港股/美股前缀保留');
assert(norm('KO').code === 'usKO' && norm('ko').code === 'usKO', '直接输入美股代码 KO → usKO（大小写不敏感）');
assert(norm('00700').code === 'hk00700', '5位数字 → 港股');
assert(norm('123').ok === false, '3位数字不是有效代码');

const fakeQ = async () => ({ ok: true, text: async () => 'v_sh600519="1~贵州茅台~600519~1450.00~1448.00~…";' });
const prices = await EcoCal.fetchQuote(['sh600519'], fakeQ);
assert(approx(prices.sh600519, 1450), '行情解析：现价=1450');
const info = await EcoCal.fetchStockInfo('sh600036', async () => ({
  ok: true, text: async () => 'v_sh600036="1~招商银行~600036~43.05~42.76~…";',
}));
assert(info.name === '招商银行' && approx(info.price, 43.05), '证券信息解析：名称+现价');
const fakeK = async () => ({ ok: true, json: async () => ({
  data: { sh600519: { qfqday: [['2026-01-02', 10, 10.5, 10.8, 9.9], ['2026-01-05', 10.5, 10.8, 11.0, 10.4]] } },
}) });
const kline = await EcoCal.fetchKline('sh600519', 60, fakeK);
assert(kline.length === 2 && kline[1][2] === 10.8, '日K解析：返回 [date,open,close,high,low] 且收盘价正确');

// 4.14 旧数据迁移（v5「价值快照」→ v6 首笔买入 + 折算现价）
EcoCal.state.trades = [];
const oldAsset = { id: 'mig1', name: '旧基金', category: 'fund', subCategory: '混合型', currency: 'CNY',
  principal: 30000, quantity: 800, startDate: '2025-01-01', note: '', minHoldDays: 30 };
EcoCal.state.valuations = [
  { id: 'v1', assetId: 'mig1', date: '2025-02-01', value: 32000 },
];
const migrated = EcoCal.migrateToTrades(oldAsset);
assert(migrated === true && EcoCal.state.trades.length === 1 && EcoCal.state.trades[0].type === 'buy', '迁移生成一笔买入');
assert(approx(EcoCal.state.trades[0].price, 37.5) && EcoCal.state.trades[0].quantity === 800, '迁移单价 = 30000/800 = 37.5');
assert(oldAsset.lastPrice === 40, '最近价值记录折算现价 = 32000/800 = 40');
assert(EcoCal.migrateToTrades(oldAsset) === false && EcoCal.state.trades.length === 1, '已有交易记录时不重复迁移');
// 无数量 → 按 1 份迁移（金额即单价）；无本金 → 不迁移
EcoCal.state.trades = [];
const noQty = { id: 'mig2', name: '存款', category: 'deposit', subCategory: '定期', currency: 'CNY', principal: 100000, quantity: null, startDate: '2025-01-01' };
assert(EcoCal.migrateToTrades(noQty) === true && EcoCal.state.trades[0].quantity === 1 && EcoCal.state.trades[0].price === 100000, '无份额时按 1 份迁移（金额=100000=单价）');
EcoCal.state.trades = [];
assert(EcoCal.migrateToTrades({ id: 'mig3', name: '监察股', category: 'stock', subCategory: 'A股', currency: 'CNY', principal: 0, quantity: null }) === false, '无本金（监察表类）不生成迁移交易');

// 4.15 v6 全量迁移 migrateToV6（导入旧备份等价路径）
EcoCal.state.assets = [
  { id: 'm1', name: '理财', category: 'wealth', subCategory: '固收类', currency: 'CNY', principal: 10000, quantity: null, startDate: '2025-01-01', note: '' },
  { id: 'm2', name: '已交易股', category: 'stock', subCategory: 'A股', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', symbol: 'sh600000', lastPrice: 12 },
];
EcoCal.state.trades = [{ id: 'tr9', assetId: 'm2', type: 'buy', date: '2025-01-01', quantity: 100, price: 10, fee: 0, note: '' }];
EcoCal.state.valuations = [];
EcoCal.migrateToV6();
assert(EcoCal.state.trades.filter(t => t.assetId === 'm1').length === 1, 'migrateToV6 为无交易资产生成首笔买入');
assert(EcoCal.state.trades.filter(t => t.assetId === 'm2').length === 1, '已有交易的产品不受影响');
assert(EcoCal.state.valuations.length === 0, 'v6 迁移后价值快照数组清空');

// 4.16 手机友好导入/导出 + 版本号
EcoCal.seedDemo();
EcoCal.openExportModal();
const exportHtml = elements['modal-body'].innerHTML || '';
assert(exportHtml.includes('exp-download') && exportHtml.includes('exp-copy'), '导出面板提供「下载」与「复制到剪贴板」');
const payloadText = EcoCal.buildExportPayload();
assert(JSON.parse(payloadText).assets.length === 7, 'buildExportPayload 输出合法且含全部产品');
// 端到端导入（v5 旧格式：含 valuations）→ 应自动迁移
const importData = {
  assets: [{ id: 'x1', name: '迁移产品', category: 'fund', subCategory: '混合型', currency: 'CNY',
    principal: 2000, quantity: 100, startDate: '2026-01-01', note: '',
    minHoldDays: null, riskLevel: null, tPlusN: null, createdAt: 1, updatedAt: 1 }],
  valuations: [{ id: 'vx', assetId: 'x1', date: '2026-02-01', value: 2100 }],
  trades: [],
  settings: { baseCurrency: 'CNY', rates: {}, demoDismissed: true },
};
EcoCal.importPayloadText(JSON.stringify(importData));
assert(!elements['confirm-backdrop'].classList.contains('hidden'), '粘贴导入后先弹出覆盖确认');
elements['confirm-ok'].onclick();
assert(EcoCal.state.assets.length === 1 && EcoCal.state.assets[0].name === '迁移产品', '确认后备份数据替换当前数据');
assert(EcoCal.state.trades.length === 1 && approx(EcoCal.state.trades[0].price, 20), '导入后旧本金+数量自动迁移为首笔买入（2000/100=20）');
assert(EcoCal.state.assets[0].lastPrice === 21, '导入后最近估值折算现价（2100/100=21）');
assert(EcoCal.state.valuations.length === 0, '导入后价值快照清空');
const beforeLen = EcoCal.state.assets.length;
EcoCal.importPayloadText('{not json');
assert(EcoCal.state.assets.length === beforeLen, '非法 JSON 导入被拒绝且数据不变');
assert(/^v?\d+\.\d+\.\d+$/.test(EcoCal.APP_VERSION), '版本号格式为 x.y.z（当前 v' + EcoCal.APP_VERSION + '）');

// 4.17 外币「兑换」录入方式（买入填花费人民币 + 买入外币，卖出相反，汇率自动反推）
function setTmode(exchange) {
  tmodeStubs.qty.checked = false;
  tmodeStubs.amount.checked = !exchange;
  tmodeStubs.exchange.checked = exchange;
}
const fxExAsset = { id: 'fxf', name: '美元现汇', category: 'fx', subCategory: '现汇', currency: 'CNY',
  foreignCurrency: 'USD', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 7.22 };
EcoCal.state.assets = [fxExAsset];
EcoCal.state.trades = [];
setTmode(true); // 兑换模式
EcoCal.openTradeForm('fxf', 'buy', null);
let fxTradeHtml = elements['modal-body'].innerHTML || '';
assert(fxTradeHtml.includes('value="exchange"') && fxTradeHtml.includes('兑换（人民币 × USD）'), '外币买入表单含「兑换」录入方式');
assert(fxTradeHtml.includes('花费人民币') && fxTradeHtml.includes('买入外币（USD）'), '兑换买入标签：花费人民币 + 买入外币');
assert(fxTradeHtml.includes('id="t-exchange-row"') && fxTradeHtml.includes('style="display:"'), '兑换行默认可见');
assert(fxTradeHtml.includes('id="t-qty-row" style="display:none"') && fxTradeHtml.includes('id="t-price-row" style="display:none"') && fxTradeHtml.includes('id="t-amount-row" style="display:none"'), '兑换模式隐藏份数/单价/总金额行');
// 切到「总金额」：兑换行隐藏、金额行显示（录入方式联动）
tmodeStubs.qty.checked = false; tmodeStubs.amount.checked = true; tmodeStubs.exchange.checked = false;
tmodeStubs.amount.onchange(); // 触发 applyMode
assert(elements['t-exchange-row'].style.display === 'none' && elements['t-amount-row'].style.display === '' && elements['t-qty-row'].style.display === 'none', '切换到总金额：兑换行隐藏、金额行显示');
setTmode(true);
// 实时汇率显示：14300 ÷ 2000 = 7.15
const cnyInput = touch('t-cny'); cnyInput.value = '14300';
const fxqtyInput = touch('t-fxqty'); fxqtyInput.value = '2000';
cnyInput.oninput(); fxqtyInput.oninput();
assert(elements['t-fx-rate'].textContent === '1 USD ≈ 7.15 人民币', '兑换模式实时汇率：14300÷2000 → 1 USD ≈ 7.15 人民币');
// 兑换买入提交
touch('t-date').value = '2026-03-01';
EcoCal.submitTrade('fxf', null, 'buy');
assert(EcoCal.state.trades.length === 1, '兑换买入生成一笔交易');
assert(approx(EcoCal.state.trades[0].quantity, 2000) && approx(EcoCal.state.trades[0].price, 7.15) && EcoCal.state.trades[0].mode === 'exchange', '兑换买入：外币 2000、汇率 7.15、模式 exchange');
// 兑换卖出提交（收回 3650 人民币换出 500 USD → 汇率 7.30）
EcoCal.openTradeForm('fxf', 'sell', null);
touch('t-cny').value = '3650';
touch('t-fxqty').value = '500';
touch('t-date').value = '2026-03-10';
EcoCal.submitTrade('fxf', null, 'sell');
assert(EcoCal.state.trades.length === 2 && approx(EcoCal.state.trades[1].quantity, 500) && approx(EcoCal.state.trades[1].price, 7.3), '兑换卖出：外币 500、汇率 7.30');
// 兑换卖出超持仓被拦截
EcoCal.openTradeForm('fxf', 'sell', null);
touch('t-cny').value = '25000';
touch('t-fxqty').value = '3000';
touch('t-date').value = '2026-03-12';
EcoCal.submitTrade('fxf', null, 'sell');
assert(EcoCal.state.trades.length === 2, '兑换卖出超持仓被拦截（未生成交易）');
// 编辑已有 exchange 交易：回填人民币与外币数量，汇率 span 恢复
EcoCal.openTradeForm('fxf', 'buy', EcoCal.state.trades[0].id);
fxTradeHtml = elements['modal-body'].innerHTML || '';
assert(fxTradeHtml.includes('value="2000"') && fxTradeHtml.includes('value="14300"'), '编辑兑换买入：外币 2000 / 人民币 14300 回填');
assert(fxTradeHtml.includes('1 USD ≈ 7.15 人民币') && fxTradeHtml.includes('id="t-cny"'), '编辑兑换买入：汇率提示恢复为 7.15');
// 非外币资产：不出现「兑换」方式，也无法以兑换提交
EcoCal.state.assets = [
  { id: 'fxx', name: '普通基金', category: 'fund', subCategory: '混合型', currency: 'CNY',
    principal: 0, quantity: null, startDate: null, note: '', lastPrice: 1.05 },
];
EcoCal.state.trades = [];
setTmode(true); // 尝试强制兑换
EcoCal.openTradeForm('fxx', 'buy', null);
const fundTradeHtml = elements['modal-body'].innerHTML || '';
assert(!fundTradeHtml.includes('t-exchange-row') && !fundTradeHtml.includes('兑换（'), '非外币资产表单无「兑换」方式');
EcoCal.submitTrade('fxx', null, 'buy'); // 兑换分支应直接拦截
assert(EcoCal.state.trades.length === 0, '非外币资产用兑换方式提交被拦截');
setTmode(false); // 恢复默认：总金额

/* ---- 5. 持久化往返：seedDemo → save → load ---- */
EcoCal.seedDemo();
assert(EcoCal.state.assets.length === 7, '演示数据含 7 个产品');
assert(EcoCal.state.assets.some(a => a.category === 'fx'), '演示数据包含外币大类');
assert(EcoCal.state.trades.some(t => t.minHoldDays === 1095), '演示数据含批次最低持有天数（定期锁定）');
assert(EcoCal.state.trades.length > 0, '演示数据全部通过交易记录记账（无价值快照）');
assert(EcoCal.SORT_OPTIONS.some(o => o[0] === 'annualDesc'), '排序选项包含「年化从高到低」');
const saved = EcoCal.loadState();
assert(saved === true, 'seedDemo 后 loadState 返回 true（数据已持久化）');
const sum2 = Calc.summary(EcoCal.state.assets, EcoCal.state.valuations, EcoCal.state.settings, EcoCal.state.trades);
assert(sum2.totalValue > 0, '演示数据汇总市值 > 0');
assert(sum2.metrics.every(mm => mm.assetId && mm.assetCurrency), '每个 metric 都带 assetId 与 assetCurrency（事件委托依赖）');
assert(sum2.gainCount + sum2.lossCount > 0, '演示数据有盈有亏，计数正常');
// 演示数据的可卖徽章语义
const demoDeposit = EcoCal.state.assets.find(a => a.category === 'deposit');
const depSell = Calc.sellStatus(demoDeposit, EcoCal.state.trades, EcoCal.todayStr());
assert(depSell.sellable === false, '演示大额存单未到期 → 不可卖');
const demoFxA = EcoCal.state.assets.find(a => a.category === 'fx');
const fxPos = Calc.tradePosition(demoFxA, EcoCal.state.trades, null);
assert(fxPos.qty === 1500 && fxPos.received === 3650, '演示外币余额 1500 USD、已回收 3650 元');

// 5.1 整页渲染（renderAll）产物检查：仪表盘/配置结构/集中度/明细/卡片 HTML
EcoCal.renderAll();
const listHtml = elements['asset-list'].innerHTML || '';
const dashHtml = elements['dash-cards'].innerHTML || '';
const groupsHtml = elements['dist-groups'].innerHTML || '';
const marketsHtml = elements['dist-markets'].innerHTML || '';
const currenciesHtml = elements['dist-currencies'].innerHTML || '';
const concHtml = elements['concentration'].innerHTML || '';
const detailHtml = elements['detail-table'].innerHTML || '';
assert(dashHtml.includes('总市值') && dashHtml.includes('净资产') && dashHtml.includes('总投入本金'), '仪表盘：总市值/净资产/总投入本金');
assert(dashHtml.includes('总浮动盈亏') && dashHtml.includes('已实现盈亏') && dashHtml.includes('总盈亏') && dashHtml.includes('现金 vs 风险资产'), '仪表盘：浮动/已实现/总盈亏/现金vs风险');
assert(dashHtml.includes('浮动盈亏率'), '仪表盘标注浮动盈亏率口径');
assert(groupsHtml.includes('股票') && groupsHtml.includes('现金及等价物') && groupsHtml.includes('%'), '资产类别配置：横向条形图含分组与百分比');
assert(marketsHtml.includes('A股') && marketsHtml.includes('美股'), '市场配置：A股/美股分组');
assert(currenciesHtml.includes('USD') && currenciesHtml.includes('CNY'), '币种敞口：CNY/USD 分组');
assert(concHtml.includes('Top 5 持仓占比') && concHtml.includes('Top 10 持仓占比'), '集中度指标卡：Top5/Top10');
assert(detailHtml.includes('标的名称') && detailHtml.includes('浮动盈亏率') && detailHtml.includes('当日盈亏') && detailHtml.includes('占比'), '明细表：全部所需列');
assert(!detailHtml.includes('NaN'), '明细表不出现 NaN');
assert(!concHtml.includes('NaN') && !dashHtml.includes('NaN'), '仪表盘与集中度不出现 NaN');
// 产品页卡片渲染（v6 口径）
assert(listHtml.includes('持仓金额') && listHtml.includes('累计投入（成本）'), '非股票卡片侧重金额指标（持仓金额/累计投入）');
assert(listHtml.includes('USD/CNY') && listHtml.includes('外币余额'), '外币卡片显示币种对与余额');
assert(listHtml.includes('持仓数量') && listHtml.includes('平均成本') && listHtml.includes('现价'), '股票卡片显示数量/均价/现价');
assert(listHtml.includes('＋ 买入') && listHtml.includes('− 卖出'), '卡片操作：买入/卖出按钮');
assert(listHtml.includes('不可卖 · 还需') && listHtml.includes('可卖'), '批次徽章：既有可卖也有不可卖（演示数据）');
assert(EcoCal.renderList() === undefined, 'renderList 可重复调用（展开/刷新无异常）');

// 5.1b 统计聚合正确性（Calc.statistics）
EcoCal.seedDemo();
const st = Calc.statistics(EcoCal.state.assets, EcoCal.state.trades, EcoCal.state.settings, { liabilities: 0, singleAssetCap: 20 });
assert(st.totalValue > 0 && approx(st.netWorth, st.totalValue - 0), '总市值>0，净资产 = 总市值 − 负债');
assert(approx(st.totalProfit, st.totalFloat + st.totalRealized), '总盈亏 = 总浮动 + 已实现');
assert(approx(st.floatRate, st.totalFloat / st.totalCost), '浮动盈亏率 = 总浮动 ÷ 总投入本金');
assert(st.cashValue > 0 && approx(st.riskValue, st.totalValue - st.cashValue) && approx((st.cashPct || 0) + (st.riskPct || 0), 1), '现金 + 风险资产 = 总市值，占比和为 100%');
// 现金及等价物包含：大额存单（存款）+ 美元现汇（外币）+ …（演示数据 a5/a7）
const groupSum = st.groups.reduce((s, g) => s + g.value, 0);
assert(approx(groupSum, st.totalValue), '类别分组市值合计 = 总市值');
assert(st.groups.some(g => g.label === '基金ETF') && st.groups.some(g => g.label === '现金及等价物') && st.groups.some(g => g.label === '股票'), '类别分组含基金ETF/现金及等价物/股票');
assert(st.markets.some(m => m.label === 'A股') && st.markets.some(m => m.label === '美股'), '市场分组含 A股/美股');
assert(st.currencies.some(c => c.label === 'CNY') && st.currencies.some(c => c.label === 'USD'), '币种敞口含 CNY/USD');
// 集中度：演示数据最大持仓 = 大额存单（¥100,600 / 总市值），占比超上限 20%
assert(st.maxAsset && st.maxAsset.name.includes('大额存单'), '单一标的最大持仓为大额存单');
assert(st.maxAsset.pct * 100 > 20 && st.overLimit.some(o => o.name.includes('大额存单')), '单一标的占比超过 20% 上限 → 超限提示');
assert(st.top10 >= st.top5 && st.top5 > 0, 'Top10 ≥ Top5 > 0');
// 明细：按市值降序；当日盈亏无行情缓存 → '--'
const sortedOk = st.detail.every((r, i) => i === 0 || (st.detail[i - 1].baseValue || 0) >= (r.baseValue || 0));
assert(sortedOk, '明细按市值降序');
assert(st.detail[0].asset.name.includes('大额存单'), '明细第一行为市值最大的大额存单');

// 5.2 组合市值走势（纯函数）
const trendAsset = { id: 'tr1', name: '股票', category: 'stock', subCategory: 'A股', currency: 'CNY',
  principal: 0, quantity: null, startDate: null, note: '', lastPrice: 11 };
const trendTrades = [
  { id: 'tt1', assetId: 'tr1', type: 'buy', date: '2025-01-01', quantity: 100, price: 10, fee: 0, note: '' },
  { id: 'tt2', assetId: 'tr1', type: 'sell', date: '2025-01-10', quantity: 20, price: 12, fee: 0, note: '' },
];
const trend = Calc.portfolioTrend([trendAsset], trendTrades, { baseCurrency: 'CNY', rates: {} }, '2025-01-15');
assert(trend.length === 3 && trend[0].date === '2025-01-01' && trend[2].date === '2025-01-15', '走势时间点 = 交易日期 ∪ 今天（升序）');
assert(approx(trend[0].value, 1000) && approx(trend[0].net, -1000), '首日：市值1000、净投入-1000');
assert(approx(trend[1].value, 960) && approx(trend[1].net, -760), '卖出日：市值960（80×12）、净投入-760');
assert(approx(trend[2].value, 880) && approx(trend[2].net, -760), '末点用最新现价11：市值880，盈利=880-760=120');
// 多币种换算进基准币种
const trendUsd = Calc.portfolioTrend(
  [{ id: 'tr2', name: '美股', category: 'stock', subCategory: '美股', currency: 'USD', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 12 }],
  [{ id: 'tt3', assetId: 'tr2', type: 'buy', date: '2025-01-01', quantity: 100, price: 10, fee: 0, note: '' }],
  { baseCurrency: 'CNY', rates: { USD: 7.2 } }, '2025-01-15');
assert(approx(trendUsd[1].value, 1200 * 7.2), 'USD 市值按汇率换算为 CNY');

// 5.3 统计页渲染：盈亏构成 + 走势（附加视图）
EcoCal.seedDemo();
EcoCal.renderAll();
assert((elements['trend-chart'].innerHTML || '').includes('组合市值'), '组合走势图渲染（含图例）');
const profitHtml = elements['profit-chart'].innerHTML || '';
assert(profitHtml.includes('浮动 vs 已实现') && profitHtml.includes('盈利 vs 亏损产品'), '盈亏构成以双环图渲染（浮动vs已实现 / 盈利vs亏损）');
assert((profitHtml.match(/chart-legend/g) || []).length >= 2, '盈亏构成含两个环图图例');

// 5.4 主界面分页：产品 / 统计（独立 Tab）
EcoCal.switchTab('stats');
assert(elements['panel-stats'].classList.contains('hidden') === false, '切到「统计」页签：统计面板显示');
assert(elements['panel-assets'].classList.contains('hidden') === true, '切到「统计」页签：产品面板隐藏');
EcoCal.switchTab('assets');
assert(elements['panel-assets'].classList.contains('hidden') === false, '切回「产品」页签：产品面板显示');
assert(elements['panel-stats'].classList.contains('hidden') === true, '切回「产品」页签：统计面板隐藏');
EcoCal.switchTab('unknown'); // 非法值回退到产品页
assert(elements['panel-assets'].classList.contains('hidden') === false, '非法 Tab 值回退到产品页');

// 5.5 走势卡扩展：回撤 / CAGR / 波动率 / 夏普 / XIRR / 模式切换
const ddPoints = [
  { date: '2025-01-01', value: 100 },
  { date: '2025-02-01', value: 120 },
  { date: '2025-03-01', value: 90 },
  { date: '2025-04-01', value: 110 },
];
const dd = Calc.maxDrawdown(ddPoints);
assert(approx(dd.maxDD, 90 / 120 - 1), '最大回撤 = 90/120 - 1 = -25%');
assert(dd.start === '2025-02-01' && dd.end === '2025-03-01', '回撤区间：峰值 2025-02-01 → 谷值 2025-03-01');
assert(approx(dd.currentDD, 110 / 120 - 1), '当前回撤相对历史峰值 -8.33%');
assert(approx(Calc.cagr([{ date: '2025-01-01', value: 100 }, { date: '2026-01-01', value: 110 }]), 0.10), 'CAGR：一年 100→110 = 10%');
assert(Calc.annualVol([{ date: '2025-01-01', value: 100 }, { date: '2025-02-01', value: 100 }, { date: '2025-03-01', value: 100 }]) === 0, '年化波动率：恒定市值 = 0');
const volUp = Calc.annualVol([{ date: '2025-01-01', value: 100 }, { date: '2025-02-01', value: 110 }, { date: '2025-03-01', value: 100 }]);
assert(volUp != null && volUp > 0, '年化波动率：波动序列为正');
const sh = Calc.sharpe([{ date: '2025-01-01', value: 100 }, { date: '2025-03-01', value: 110 }, { date: '2025-06-01', value: 95 }], 0.02);
assert(sh != null && isFinite(sh), '夏普比率可计算（下跌序列为负值）');
// XIRR / IRR
const xirrAsset = { id: 'xr1', name: '定投', category: 'fund', subCategory: '指数型', currency: 'CNY', principal: 0, quantity: null, startDate: null, note: '', lastPrice: 11 };
const xirrTrades = [{ id: 'xr1t', assetId: 'xr1', type: 'buy', date: '2025-01-01', quantity: 100, price: 10, fee: 0, note: '' }];
const xirr = Calc.xirr([xirrAsset], xirrTrades, { baseCurrency: 'CNY', rates: {} }, '2026-01-01');
assert(xirr != null && approx(xirr, 0.10, 1e-6), 'XIRR：投入1000 → 一年后市值1100，年化 10%');
assert(approx(Calc.irr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }], '2026-01-01'), 0.10, 1e-6), 'IRR：单笔现金流年化 10%');
// 走势模式切换
EcoCal.seedDemo();
EcoCal.renderAll();
const trendStats = elements['trend-stats'].innerHTML || '';
assert(trendStats.includes('最大回撤') && trendStats.includes('夏普') && trendStats.includes('XIRR'), '走势指标条渲染：回撤/夏普/XIRR');
assert((elements['trend-chart'].innerHTML || '').includes('组合市值（估算）'), '走势默认模式：市值 vs 净投入');
EcoCal.setTrendMode('profit');
assert((elements['trend-chart'].innerHTML || '').includes('累计收益'), '走势模式·累计收益');
EcoCal.setTrendMode('rate');
assert((elements['trend-chart'].innerHTML || '').includes('收益率'), '走势模式·收益率');
EcoCal.setTrendMode('dd');
assert((elements['trend-chart'].innerHTML || '').includes('回撤（%）'), '走势模式·回撤');
EcoCal.setTrendMode('dual');
assert((elements['trend-chart'].innerHTML || '').includes('组合市值（估算）'), '恢复走势模式·市值 vs 净投入');

/* ---- 6. 云备份（WebDAV）---- */
// 6.1 配置与路径规范化（纯逻辑，不依赖网络）
const wd = EcoCal.webdavBackup;
EcoCal.state.settings.webdav = {
  enabled: true, url: 'https://dav.example.com/dav/', user: 'alice', dir: 'EcoCal/备份',
  lastBackupAt: null, lastError: null,
};
assert(wd.normDir('EcoCal/备份') === 'EcoCal/备份', '目录规范化：正常路径保留');
assert(wd.normDir(' /a/b/c/ ') === 'a/b/c', '目录规范化：去除首尾斜杠与空格');
assert(wd.normDir('..\\..\\evil') === 'evil', '目录规范化：防目录穿越');
assert(wd.remotePath() === 'EcoCal/备份/ecocal-backup.json', '远程文件路径 = 目录 + 固定文件名 ecocal-backup.json');
EcoCal.state.settings.webdav.dir = '';
assert(wd.remotePath() === 'ecocal-backup.json', '目录为空时文件名放根路径');
wd.setPass('topsecret');
assert(wd.getPass() === 'topsecret', '应用密码独立存取（localStorage 专用键）');
const passKey = Object.keys(storage).find(k => k.includes('webdav'));
assert(passKey !== undefined && !JSON.stringify(EcoCal.buildExportPayload()).includes('topsecret'), '备份内容不包含应用密码');
EcoCal.state.settings.webdav.dir = 'EcoCal';
assert(wd.validate() === null, '配置齐全时校验通过');
assert(wd.validate() === null, '配置齐全时校验通过（无网络）');
assert(wd.remotePath() === 'EcoCal/ecocal-backup.json', '远程路径用配置的目录');

// 6.2 请求封装：凭据头部（验证 Basic 编码）
const base64 = wd.authHeader();
assert(typeof base64 === 'string' && base64.startsWith('Basic '), '认证头格式：Basic 前缀');
// 6.3 校验：缺配置/坏 URL 返回错误信息
const savedCfg = { ...EcoCal.state.settings.webdav };
EcoCal.state.settings.webdav = { enabled: true, url: '', user: 'u', dir: 'D' };
assert(wd.validate() !== null, '缺 URL 时校验失败');
EcoCal.state.settings.webdav = { enabled: true, url: 'not-a-url', user: 'u', dir: 'D' };
assert(wd.validate() !== null, '非 http(s) URL 时校验失败');
EcoCal.state.settings.webdav = savedCfg;

// 6.4 WebDAV 全链路（mock fetch）：测试连接 / 备份 PUT / 读取 GET / 恢复
//     与 app.js 的 WebDAV 语义对齐：PUT 需 201/204/200，MKCOL 容忍 201/405/200/301
const wdServer = { stores: new Map(), mkcol: new Set(), status: 201, lastAuth: null, lastMethod: null, lastUrl: null };
const fakeResp = (status, body = '', headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => headers[k] || null },
  text: () => Promise.resolve(body), json: () => Promise.resolve(JSON.parse(body)),
});
const origFetch = globalThis.fetch;
let wdThrew = null;
globalThis.fetch = async (url, opts = {}) => {
  wdServer.lastMethod = opts.method || 'GET';
  wdServer.lastUrl = url;
  wdServer.lastAuth = opts.headers ? opts.headers.Authorization || opts.headers.authorization || null : null;
  const method = opts.method || 'GET';
  const u = String(url);
  try {
    if (method === 'MKCOL') {
      // wdServer.mkcol 状态：已存在 405；403 模拟「Zotero 目录只读」；两者都应被宽容
      if (wdServer.mkcol.has(u)) return fakeResp(405);
      wdServer.mkcol.add(u);
      return fakeResp(wdServer.mkcolStatus || 201);
    }
    if (method === 'PUT') {
      const body = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
      wdServer.stores.set(u, body);
      return fakeResp(wdServer.status);
    }
    if (method === 'GET') {
      if (!wdServer.stores.has(u)) return fakeResp(404);
      return fakeResp(200, wdServer.stores.get(u));
    }
    if (method === 'DELETE') {
      wdServer.stores.delete(u);
      return fakeResp(204);
    }
    return fakeResp(200);
  } catch (e) { wdThrew = e; throw e; }
};

// —— 准备一份真实可导入的载荷 ——
EcoCal.state.settings.webdav = { enabled: true, url: 'https://wd.example.com/dav/', user: 'alice', dir: 'EcoCal', lastBackupAt: null, lastError: null };
wd.setPass('topsecret');

// 6.4.1 测试连接 → MKCOL + 探针 PUT/DELETE
try {
  const r = await wd.testConnection();
  assert(r === true, 'testConnection：MKCOL + 探针 PUT/DELETE 成功');
  assert(wdServer.mkcol.has('https://wd.example.com/dav/EcoCal'), 'testConnection 创建了目录 EcoCal');
} catch (e) {
  assert(false, 'testConnection 不应抛错（' + e.message + '）' + (wdThrew ? '；fetch 异常：' + wdThrew.message : ''));
}

// 6.4.1b Zotero 式只读目录（MKCOL 403）：不应阻断探针 PUT 判定真实写权限
wdServer.mkcolStatus = 403;
const r403 = await wd.testConnection();
assert(r403 === true, 'MKCOL 返回 403（目录只读/不可建）时 testConnection 仍通过（写权限由探针 PUT 判定）');
wdServer.mkcolStatus = 201;

// 6.4.2 立即备份 → PUT 远端文件，内容为导出载荷
const bk = await wd.backup();
assert(typeof bk === 'string' && bk.length > 0, 'backup() 返回备份文本（PUT 远端 ecocal-backup.json）');
const remoteKey = wd.remotePath();
const keyFull = 'https://wd.example.com/dav/' + remoteKey;
assert(wdServer.stores.has(keyFull), '远端文件已写入（' + keyFull + '）');
const stored = JSON.parse(wdServer.stores.get(keyFull));
assert(stored.app === 'EcoCal' && Array.isArray(stored.assets) && stored.assets.length > 0, '远端备份为 EcoCal 导出格式且含资产');
wdServer.status = 409;
let putFail = null;
try { await wd.backup(); } catch (e) { putFail = e; }
assert(putFail !== null, 'PUT 被拒（409）时 backup() 抛错');
wdServer.status = 201;
assert(wdServer.lastAuth != null && String(wdServer.lastAuth).startsWith('Basic '), 'WebDAV 请求带 Basic 认证头');

// 6.4.3 自动备份节流：saveState() 后不立即上传；防抖窗口内（改后不久）不重复上传；
//      窗口结束后（60s 尾部防抖）才上传一次，且把整个窗口的改动合并成一次
wdServer.stores.delete(keyFull);
EcoCal.state.assets[0].name = '自动备份覆盖测试';
EcoCal.saveState();
assert(!wdServer.stores.has(keyFull), 'saveState 后尚未立即上传（防抖等待中）');
await new Promise(r => setTimeout(r, 300));
assert(!wdServer.stores.has(keyFull), '防抖窗口内（60s 前）不重复上传');
// 窗口内再次改动应重置计时：约 40s 后再改一次，60s 前仍不应上传
await new Promise(r => setTimeout(r, 40000));
EcoCal.state.assets[0].name = '自动备份合并测试';
EcoCal.saveState();
await new Promise(r => setTimeout(r, 300)); // 重置后仍在防抖窗口内
assert(!wdServer.stores.has(keyFull), '窗口内再次改动重置计时，仍不立即上传');
await new Promise(r => setTimeout(r, 60500));
assert(wdServer.stores.has(keyFull), '停止改动 60s 后自动备份已上传（合并了窗口内所有改动）');
const autoStored = JSON.parse(wdServer.stores.get(keyFull));
assert(autoStored.assets[0].name === '自动备份合并测试', '自动备份内容为最新本地数据（合并后只传一次）');
assert(autoStored.settings !== undefined, '自动备份含 settings');
// 精简载荷：云备份不含汇率/行情缓存等可重取部分
assert(autoStored.settings.rates === undefined, '云备份载荷不含汇率表（settings.rates）');
assert(autoStored.settings.quotes === undefined && autoStored.settings.kline === undefined, '云备份载荷不含行情缓存（quotes/kline）');
assert(autoStored.settings.ratesUpdatedAt === undefined && autoStored.settings.autoQuote === undefined, '云备份载荷不含行情相关设置（ratesUpdatedAt/autoQuote）');
assert(autoStored.settings.webdav !== undefined, '云备份仍保留 WebDAV 配置');
assert(autoStored.settings.webdav.lastBackupAt === undefined && autoStored.settings.webdav.lastError === undefined, '云备份不回传备份历史（lastBackupAt/lastError）');
// 云备份与导出的 payload 应一致地不含秘密（导出仍含汇率，属于完整备份）
const exportPayload = JSON.parse(EcoCal.buildExportPayload());
assert(exportPayload.settings.rates !== undefined, '导出载荷保留汇率表（与云备份精简不同）');
EcoCal.state.assets[0].name = '测试资产';

// 6.4.4 读取远端 / 恢复流程（fetchRemote + manualWebdavRestore 还原本地）
wdServer.status = 200;
const fr = await wd.fetchRemote();
assert(fr != null && fr.app === 'EcoCal' && fr.assets.length > 0, 'fetchRemote 读取远端备份成功');
// 远端当前内容 = 上次自动上传时（本地名为「自动备份覆盖测试」）
const cloudName = fr.assets[0].name;
// 篡改本地一个字段，随后恢复应还原为云端内容
EcoCal.state.assets[0].name = '本地将被云端覆盖';
const restore = await EcoCal.manualWebdavRestore(); // 弹出确认框（异步，不执行覆盖）
assert(restore === undefined, 'manualWebdavRestore 先弹出确认框（等待用户点击）');
assert(elements['confirm-ok'].onclick != null, '恢复确认框已挂接确认回调');
assert(EcoCal.state.assets[0].name === '本地将被云端覆盖', '确认前本地数据尚未被覆盖');
// 点击确认 → 快照下载 + applyPayload + renderAll
elements['confirm-ok'].onclick();
assert(EcoCal.state.assets[0].name === cloudName, '确认恢复后本地数据已从云端还原（' + cloudName + '）');
const restoreCount = EcoCal.state.assets.length;
assert(restoreCount > 0, '恢复后资产数量正常（' + restoreCount + '）');
assert(wdServer.stores.has(keyFull), '恢复过程未删除远端文件');
// 恢复时本地应另存快照（下载 JSON）：downloadJSON 在桩中触发 a.click()，不抛错即可

// 6.4.5 enabled=false 时 saveState 不再触发上传
wdServer.stores.delete(keyFull);
EcoCal.state.settings.webdav.enabled = false;
EcoCal.saveState();
await new Promise(r => setTimeout(r, 300));
assert(!wdServer.stores.has(keyFull), '禁用自动备份后 saveState 不上传');
EcoCal.state.settings.webdav.enabled = true;

globalThis.fetch = origFetch;

/* ---- 7. 云备份（Gitee 仓库）：contents API 全链路 ---- */
const gb = EcoCal.giteeBackup;
EcoCal.state.settings.gitee = { enabled: true, owner: 'myuser', repo: 'ecocal-backup', path: '', lastBackupAt: null, lastError: null };
gb.setToken('git-secret-token-123');
// 7.1 令牌独立存取（不进 state / 备份内容）
assert(gb.getToken() === 'git-secret-token-123', 'Gitee 令牌独立存取（localStorage 专用键）');
const gTokenKey = Object.keys(storage).find(k => k.includes('gitee'));
assert(gTokenKey !== undefined && !JSON.stringify(EcoCal.buildExportPayload()).includes('git-secret-token-123'), '备份内容不包含 Gitee 令牌');
// 7.2 配置校验
assert(gb.validate() === null, 'Gitee 配置齐全时校验通过');
const savedCfgG = { ...EcoCal.state.settings.gitee };
EcoCal.state.settings.gitee = { enabled: true, owner: '', repo: 'r', path: '', lastBackupAt: null, lastError: null };
assert(gb.validate() !== null, '缺 owner 时校验失败');
EcoCal.state.settings.gitee = { enabled: true, owner: 'u!!!', repo: 'r', path: '', lastBackupAt: null, lastError: null };
assert(gb.validate() !== null, 'owner 含非法字符时校验失败');
EcoCal.state.settings.gitee = { enabled: true, owner: 'u', repo: 'r', path: '', lastBackupAt: null, lastError: null };
gb.setToken(''); // 清除令牌 → 缺令牌校验失败
assert(gb.validate() !== null, '缺令牌时校验失败');
EcoCal.state.settings.gitee = savedCfgG;
gb.setToken('git-secret-token-123');
// 7.3 仓库内路径
assert(gb.path === 'ecocal-backup.json', '默认备份路径 ecocal-backup.json');
EcoCal.state.settings.gitee.path = 'data/backup.json';
assert(gb.path === 'data/backup.json', '自定义备份路径');
EcoCal.state.settings.gitee.path = '';

// 7.4 mock Gitee contents API（GET 带 access_token query；写为 form body）
const giteeServer = { files: new Map(), lastGets: [], lastWrites: [], userStatus: null };
const fakeGJson = (status, obj) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: k => (k === 'content-type' ? 'application/json' : null) },
  text: () => Promise.resolve(JSON.stringify(obj)),
  json: () => Promise.resolve(obj),
});
const origFetch2 = globalThis.fetch;
let gThrew = null;
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const u = String(url);
  try {
    if (u.includes('/api/v5/user')) {
      giteeServer.lastGets.push(['user', u]);
      if (giteeServer.userStatus) return fakeGJson(giteeServer.userStatus, { message: '无效的令牌' });
      return fakeGJson(200, { login: 'myuser', name: 'My Name' });
    }
    const contentsIdx = u.indexOf('/contents/');
    if (contentsIdx !== -1) {
      const fileKey = decodeURIComponent(u.slice(contentsIdx + 10).split('?')[0]);
      if (method === 'GET') {
        giteeServer.lastGets.push(['contents', u]);
        if (!giteeServer.files.has(fileKey)) return fakeGJson(404, { message: 'Not Found' });
        return fakeGJson(200, { sha: 'sha-' + fileKey, content: giteeServer.files.get(fileKey) });
      }
      if (method === 'POST' || method === 'PUT') {
        // 解析 form body（app.js 用 URLSearchParams 编码 access_token/content/message/sha）
        const body = opts.body ? new URLSearchParams(opts.body) : new URLSearchParams();
        giteeServer.lastWrites.push([method, fileKey, body.get('content'), body.get('message')]);
        const exists = giteeServer.files.has(fileKey);
        if (method === 'PUT' && !exists) return fakeGJson(422, { message: 'file not found, need POST first' });
        if (method === 'POST' && exists) return fakeGJson(409, { message: 'already exists, need PUT with sha' });
        if (method === 'PUT' && body.get('sha') !== 'sha-' + fileKey) return fakeGJson(400, { message: 'sha mismatch' });
        giteeServer.files.set(fileKey, body.get('content'));
        return fakeGJson(method === 'POST' ? 201 : 200, { content: { sha: 'sha-' + fileKey, content: body.get('content') } });
      }
    }
    const rmatch = u.match(/\/api\/v5\/repos\/([^/]+)\/([^/?]+)/);
    if (rmatch) {
      if (rmatch[2] === 'ecocal-backup') return fakeGJson(200, { full_name: rmatch[1] + '/' + rmatch[2] });
      return fakeGJson(404, { message: 'Not Found Project' });
    }
    return fakeGJson(404, { message: 'Not Found' });
  } catch (e) { gThrew = e; throw e; }
};

// 7.5 测试连接：令牌校验（/user）+ 仓库存在性（/repos）
try {
  const who = await gb.testConnection();
  assert(typeof who === 'string' && who.includes('myuser/ecocal-backup'), '测试连接：令牌 + 仓库确认（' + who + '）');
  assert(giteeServer.lastGets.some(g => g[0] === 'user'), '测试连接调用了 /user');
} catch (e) {
  assert(false, '测试连接不应抛错（' + e.message + '）' + (gThrew ? '；fetch 异常：' + gThrew.message : ''));
}
gb.setToken('bad-token');
giteeServer.userStatus = 401; // 让 /user 返回 401
let connBad = null;
try { await gb.testConnection(); } catch (e) { connBad = e; }
assert(connBad !== null, '无效令牌时 testConnection 抛错');
giteeServer.userStatus = null;
gb.setToken('git-secret-token-123');
EcoCal.state.settings.gitee.repo = 'nope';
let repoBad = null;
try { await gb.testConnection(); } catch (e) { repoBad = e; }
assert(repoBad !== null, '仓库不存在时 testConnection 抛错');
EcoCal.state.settings.gitee.repo = 'ecocal-backup';

// 7.6 备份：首次 POST 新建（无 sha）→ 之后 PUT 更新（带 sha）
const gRemoteKey = gb.path; // ecocal-backup.json
giteeServer.lastWrites.length = 0;
const gbk1 = await gb.backup();
assert(typeof gbk1 === 'string' && gbk1.length > 0, 'backup() 返回备份文本');
assert(giteeServer.files.has(gRemoteKey), 'Gitee 云端已写入备份文件');
assert(giteeServer.lastWrites.length === 1 && giteeServer.lastWrites[0][0] === 'POST', '首次备份用 POST 新建文件');
const decodeB64 = b64s => decodeURIComponent(escape(atob(String(b64s).replace(/\s+/g, ''))));
let gRemoteObj = JSON.parse(decodeB64(giteeServer.files.get(gRemoteKey)));
assert(gRemoteObj.app === 'EcoCal' && Array.isArray(gRemoteObj.assets) && gRemoteObj.assets.length > 0, 'Gitee 云端备份为 EcoCal 导出格式且含资产');
giteeServer.lastWrites.length = 0;
await gb.backup();
assert(giteeServer.lastWrites.length === 1 && giteeServer.lastWrites[0][0] === 'PUT', '再次备份用 PUT 更新（带 sha）');
assert(giteeServer.lastWrites[0][1] === gRemoteKey, 'PUT 目标是同一备份文件');
assert(giteeServer.lastWrites[0][2] === giteeServer.files.get(gRemoteKey), 'PUT 内容已写入云端');

// 7.7 fetchRemote 读取
const gi = await gb.fetchRemote();
assert(gi != null && gi.app === 'EcoCal' && Array.isArray(gi.assets) && gi.assets.length > 0, 'fetchRemote 读取 Gitee 云端备份成功');
const cloudNameG = gi.assets[0].name;

// 7.8 恢复流程（先确认，后应用）
EcoCal.state.assets[0].name = '将被 Gitee 覆盖';
const rrG = await EcoCal.manualGiteeRestore();
assert(rrG === undefined, 'manualGiteeRestore 先弹出确认框');
assert(elements['confirm-ok'].onclick != null, 'Gitee 恢复确认框已挂接确认回调');
assert(EcoCal.state.assets[0].name === '将被 Gitee 覆盖', '确认前本地数据尚未被覆盖');
elements['confirm-ok'].onclick();
assert(EcoCal.state.assets[0].name === cloudNameG, '恢复后本地数据已从 Gitee 云端还原（' + cloudNameG + '）');

// 7.9 自动备份节流：saveState 后 60s（尾部防抖）内触发一次；切后台立即同步
giteeServer.files.delete(gRemoteKey);
EcoCal.state.assets[0].name = 'Gitee 自动备份测试';
EcoCal.saveState();
assert(!giteeServer.files.has(gRemoteKey), 'Gitee：saveState 后尚未立即上传（防抖等待中）');
await new Promise(r => setTimeout(r, 300));
assert(!giteeServer.files.has(gRemoteKey), 'Gitee：防抖窗口内（60s 前）不重复上传');
// 切后台（visibilitychange）立即同步剩余改动
await new Promise(r => setTimeout(r, 1000));
giteeServer.files.delete(gRemoteKey);
EcoCal.state.assets[0].name = 'Gitee 后台同步测试';
EcoCal.saveState(); // 在防抖窗口内登记
EcoCal.gateFlush(); // 模拟 visibilitychange → pagehide → 立即上传
await new Promise(r => setTimeout(r, 100)); // 等待异步上传完成
assert(giteeServer.files.has(gRemoteKey), 'Gitee：切后台（gateFlush）立即同步未上传改动');
let gAutoStored = JSON.parse(decodeB64(giteeServer.files.get(gRemoteKey)));
assert(gAutoStored.assets[0].name === 'Gitee 后台同步测试', 'Gitee：后台同步内容为最新本地数据');
assert(gAutoStored.settings.rates === undefined, 'Gitee：云备份载荷不含汇率表');
// 清空计时器：重置防抖后再停 60s（确保下一个断言不吞并上传）
EcoCal.saveState();
await new Promise(r => setTimeout(r, 61000));
gAutoStored = JSON.parse(decodeB64(giteeServer.files.get(gRemoteKey)));
assert(gAutoStored.assets[0].name === 'Gitee 后台同步测试', 'Gitee：60s 防抖上传与立即同步合并为一次');
EcoCal.state.assets[0].name = '测试资产';

// 7.10 禁用后不再上传
giteeServer.files.delete(gRemoteKey);
EcoCal.state.settings.gitee.enabled = false;
EcoCal.saveState();
await new Promise(r => setTimeout(r, 300));
assert(!giteeServer.files.has(gRemoteKey), 'Gitee：禁用自动备份后 saveState 不上传');
EcoCal.state.settings.gitee.enabled = true;
gb.setToken('');
globalThis.fetch = origFetch2;

// 7.11 精简载荷应用兼容：恢复（applyPayload）时缺 rates → 保留本地已有汇率
const localRatesBefore = Object.assign({}, EcoCal.state.settings.rates);
EcoCal.state.settings.rates.USD = 7.33; // 本地汇率（模拟已联网获取）
const slimData = {
  app: 'EcoCal', version: 1, exportedAt: '2026-10-24T00:00:00.000Z',
  assets: [], valuations: [], trades: [], settings: { baseCurrency: 'CNY' }, // 无 rates
};
EcoCal.applyPayload(slimData);
assert(EcoCal.state.settings.rates.USD === 7.33, '恢复精简云备份：缺 rates 时保留本地已有汇率（7.33 不丢）');
assert(EcoCal.state.settings.baseCurrency === 'CNY', '恢复精简云备份：基础设置仍生效');
EcoCal.state.settings.rates = localRatesBefore;

// —— 测试收尾：清空挂起的自动备份计时器（避免残留 60s/退避定时器拖住进程）——
EcoCal.clearBackupTimers();

/* ---- 8. PIN 锁（安全） ---- */
// 8.1 哈希与校验
const h1 = EcoCal.pinHash('1234');
assert(typeof h1 === 'string' && h1.length > 0, 'PIN 哈希：字符串且非空');
assert(h1 === EcoCal.pinHash('1234'), 'PIN 哈希：同一 PIN 结果稳定');
assert(h1 !== EcoCal.pinHash('12345'), 'PIN 哈希：不同 PIN 结果不同');
// 8.2 启用流程：设置 PIN → 锁生效（pinEnabled / pinLocked）
EcoCal.setPin('4321', 'my-reset');
assert(EcoCal.pinEnabled() === true, 'PIN：设置后启用');
assert(EcoCal.checkPin('4321') === true, 'PIN：正确 PIN 校验通过');
assert(EcoCal.checkPin('0000') === false, 'PIN：错误 PIN 校验失败');
sessionStore['ecocal.pin.unlocked'] = undefined; // 清解锁标记
assert(EcoCal.pinLocked() === true, 'PIN：未解锁时锁定');
EcoCal.pinUnlock();
assert(EcoCal.pinLocked() === false, 'PIN：解锁后不再锁定');
EcoCal.pinLock();
assert(EcoCal.pinLocked() === true, 'PIN：pinLock 再次上锁');
EcoCal.pinUnlock();
// 8.3 关闭流程
EcoCal.clearPin();
assert(EcoCal.pinEnabled() === false && storage['ecocal.pin.hash'] === undefined, 'PIN：清除后哈希键删除且禁用');
// 8.4 设置面板「安全」段渲染
const secHtml = EcoCal.securityHTML();
assert(secHtml.includes('PIN') && secHtml.includes('s-pin-toggle'), '安全段：含 PIN 开关与输入');
assert(EcoCal.pinEnabled() === false && secHtml.includes('启用启动 PIN 锁'), '安全段：未启用时显示启用文案');

/* ---- 9. 撤销（删除/清空可恢复） ---- */
// 9.0 撤销段需要真实资产：测试环境 demo 数据未注入，此处临时塞一个资产再删除
const undoOrigAssets = EcoCal.state.assets;
EcoCal.state.assets = [{ id: 'undo_a1', name: '撤销测试', category: 'deposit', currency: 'CNY', lastPrice: 1 }];
EcoCal.state.trades = [{ id: 'undo_t1', assetId: 'undo_a1', type: 'buy', date: '2026-10-01', quantity: 100, price: 10, fee: 0, note: '', mode: 'qty', createdAt: Date.now() }];
{
  const first = EcoCal.state.assets[0];
  EcoCal.undoWrap('删除产品', () => {
    EcoCal.state.assets = EcoCal.state.assets.filter(a => a.id !== first.id);
    EcoCal.state.trades = EcoCal.state.trades.filter(t => t.assetId !== first.id);
  });
  assert(elements['confirm-ok'].onclick != null, '撤销：确认框已挂接确认回调');
  elements['confirm-ok'].onclick(); // 触发确认 → 快照 + 执行删除
  assert(!EcoCal.state.assets.some(a => a.id === first.id), '撤销：确认后资产确实被删除');
  assert(EcoCal.state.trades.length === 0, '撤销：确认后关联交易也被删除');
  // 快照通过内部状态验证（window.__EcoCal 里 undoSnapshot 是初始化快照副本，不能直接读变化值）
  assert(EcoCal.undoApply() !== null, '撤销：快照已保存（undoApply 返回原快照）');
  // 应用撤销（undoApply 内部恢复快照并清空）
  EcoCal.undoApply();
  assert(EcoCal.undoSnapshot === null, '撤销：应用后快照清空');
  assert(EcoCal.state.assets.some(a => a.id === first.id), '撤销：资产恢复');
  assert(EcoCal.state.trades.some(t => t.assetId === first.id), '撤销：关联交易恢复');
}
// 还原测试前资产现场
EcoCal.state.assets = undoOrigAssets;
EcoCal.state.trades = [];

/* ---- 10. 导出 Excel（.xlsx） ---- */
// 10.1 ZIP 容器基础结构
let xlsxBytes;
{
  const savedAssets = EcoCal.state.assets, savedTrades = EcoCal.state.trades;
  EcoCal.state.assets = [{ id: 'xl_a1', name: '招行-测试', category: 'deposit', currency: 'CNY', lastPrice: 1 }];
  EcoCal.state.trades = [{ id: 'xl_t1', assetId: 'xl_a1', type: 'buy', date: '2026-10-01', quantity: 2350, price: 1, fee: 0, note: '定存', mode: 'amount', createdAt: Date.now() }];
  xlsxBytes = EcoCal.buildXlsxExcel();
  EcoCal.state.assets = savedAssets; EcoCal.state.trades = savedTrades;
}
assert(xlsxBytes && xlsxBytes.length > 1000, 'Excel：字节数组非空且大于 1KB');
assert(xlsxBytes[0] === 0x50 && xlsxBytes[1] === 0x4B, 'Excel：ZIP 魔数 PK（0x50 0x4B）');
assert(xlsxBytes[1] === 0x4B, 'Excel：ZIP 魔数第二位 0x4B');
{
  const txt = Buffer.from(xlsxBytes).toString('utf8'); // ZIP 内 XML 为 UTF-8
  assert(txt.includes('[Content_Types].xml'), 'Excel：包含 [Content_Types].xml 部件');
  assert(txt.includes('xl/workbook.xml'), 'Excel：包含 workbook.xml');
  assert(txt.includes('xl/sharedStrings.xml'), 'Excel：包含 sharedStrings.xml');
  assert(txt.includes('sheet1.xml') && txt.includes('sheet2.xml') && txt.includes('sheet3.xml'), 'Excel：含三个工作表部件');
  assert(txt.includes('招行-测试'), 'Excel：sharedStrings 含资产名');
  assert(txt.includes('持仓汇总') && txt.includes('交易流水') && txt.includes('按资产统计'), 'Excel：三个工作表名');
  assert(txt.includes('ecocal-export') === false, 'Excel：工作簿内不含导出文件名（只有下载时才用）');
}
// 10.2 下载触发
let dlName = '', blobType = '', xlsxClicked = false;
const xlsxDesc = { classList: { add() {}, remove() {}, toggle() {} }, remove() { xlsxClicked = true; }, click() { xlsxClicked = true; } };
const savedCreate = document.createElement;
document.createElement = tag => (tag === 'a' ? xlsxDesc : makeEl('dyn'));
const savedURL = globalThis.URL;
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
const savedBlob = globalThis.Blob;
globalThis.Blob = class { constructor(parts, opts) { blobType = opts && opts.type; } };
try {
  const savedBody = document.body;
  document.body = { appendChild() {}, removeChild() {} };
  const savedClick = document.body.appendChild;
  document.body.appendChild = () => {};
  EcoCal.downloadXlsx();
  dlName = xlsxDesc.download || '';
  document.body = savedBody;
  globalThis.Blob = savedBlob;
  globalThis.URL = savedURL;
  document.createElement = savedCreate;
} catch (e) {
  globalThis.Blob = savedBlob;
  globalThis.URL = savedURL;
  document.createElement = savedCreate;
  throw e;
}
assert(dlName === 'ecocal-export-' + EcoCal.todayStr() + '.xlsx', 'Excel：下载文件名 = ecocal-export-日期.xlsx（实际 ' + dlName + '）');
assert(blobType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel：Blob MIME 正确');
assert(xlsxClicked, 'Excel：锚点 click 被触发');

/* ---- 11. 备份提醒（未备份 > N 天提醒手动备份） ---- */
{
  const savedW = EcoCal.state.settings.webdav, savedG = EcoCal.state.settings.gitee, savedRem = EcoCal.state.settings.backupReminder;
  const savedNow = Date.now;
  try {
    // 11.1 未配置自动备份 + 从未备份过 → 需要提醒
    EcoCal.state.settings.webdav = { enabled: false, lastBackupAt: null };
    EcoCal.state.settings.gitee = { enabled: false, lastBackupAt: null };
    EcoCal.state.settings.backupReminder = { enabled: true, days: 7 };
    assert(EcoCal.anyAutoBackupEnabled() === false, '提醒：无自动备份启用');
    assert(EcoCal.lastBackupTime() === null, '提醒：从未备份 → lastBackupTime null');
    assert(EcoCal.needsBackupReminder() === true, '提醒：从未备份且开启提醒 → 需要提醒');

    // 11.2 有自动备份（任一）→ 不提醒
    EcoCal.state.settings.gitee = { enabled: true, lastBackupAt: null };
    assert(EcoCal.anyAutoBackupEnabled() === true, '提醒：Gitee 启用 → 有自动备份');
    assert(EcoCal.needsBackupReminder() === false, '提醒：有自动备份 → 不提醒');

    // 11.3 超过 N 天 → 提醒；N 天内 → 不提醒
    EcoCal.state.settings.gitee = { enabled: false, lastBackupAt: null };
    Date.now = () => 2000000000000; // 固定"现在"
    EcoCal.state.settings.webdav = { enabled: false, lastBackupAt: new Date(Date.now() - 10 * 86400000).toISOString() }; // 10 天前
    EcoCal.state.settings.backupReminder = { enabled: true, days: 7 };
    assert(EcoCal.lastBackupTime() !== null && EcoCal.needsBackupReminder() === true, '提醒：10 天 > 7 天上限 → 需要提醒');
    EcoCal.state.settings.webdav = { enabled: false, lastBackupAt: new Date(Date.now() - 3 * 86400000).toISOString() }; // 3 天前
    assert(EcoCal.needsBackupReminder() === false, '提醒：3 天 < 7 天上限 → 不提醒');
    // 边界：恰好 N 天 → 提醒
    EcoCal.state.settings.webdav = { enabled: false, lastBackupAt: new Date(Date.now() - 7 * 86400000).toISOString() };
    assert(EcoCal.needsBackupReminder() === true, '提醒：恰好 7 天 → 需要提醒');

    // 11.4 未启用提醒 / days 非法 → 不提醒
    EcoCal.state.settings.backupReminder = { enabled: false, days: 7 };
    assert(EcoCal.needsBackupReminder() === false, '提醒：未启用 → 不提醒');
    EcoCal.state.settings.backupReminder = { enabled: true, days: 0 };
    assert(EcoCal.needsBackupReminder() === false, '提醒：days=0（非法）→ 不提醒');

    // 11.5 两天不同 → 每天最多提醒一次（localStorage 标记）
    const savedLSGet = globalThis.localStorage.getItem, savedLSSet = globalThis.localStorage.setItem;
    const savedToday = EcoCal.todayStr;
    const lsKeys = {};
    globalThis.localStorage.getItem = k => (k in lsKeys ? lsKeys[k] : null);
    globalThis.localStorage.setItem = (k, v) => { lsKeys[k] = v; };
    EcoCal.state.settings.webdav = { enabled: false, lastBackupAt: null };
    EcoCal.state.settings.gitee = { enabled: false, lastBackupAt: null };
    EcoCal.state.settings.backupReminder = { enabled: true, days: 7 };
    EcoCal.todayStr = () => '2026-10-25';
    try {
      // initBackupReminders 内部用真实 confirmAction（函数内部定义，桩覆盖无效）
      // 通过 confirm-ok 元素的 onclick 是否被挂上来判断提醒弹窗是否触发
      elements['confirm-ok'].onclick = null;
      EcoCal.initBackupReminders();
      assert(elements['confirm-ok'].onclick !== null, '提醒：首次本地检查触发提醒弹窗（confirm-ok 已挂回调）');
      assert(lsKeys['ecocal.backup-reminder.2026-10-25'] === '1', '提醒：已写当天标记，避免重复弹窗');
      const okText = elements['confirm-ok'].textContent;
      assert(okText === '去备份', '提醒：确认按钮文案为「去备份」（实际 ' + okText + '）');
      // 同一天再次检查：先还原回调，标记存在 → 不重复弹窗
      elements['confirm-ok'].onclick = null;
      EcoCal.initBackupReminders();
      assert(elements['confirm-ok'].onclick === null, '提醒：同一天再次检查不重复弹窗');
    } finally {
      globalThis.localStorage.getItem = savedLSGet;
      globalThis.localStorage.setItem = savedLSSet;
      EcoCal.todayStr = savedToday;
    }
  } finally {
    Date.now = savedNow;
    EcoCal.state.settings.webdav = savedW;
    EcoCal.state.settings.gitee = savedG;
    EcoCal.state.settings.backupReminder = savedRem;
  }
}

/* ---- 12. 设置页 Tab + 备份提醒面板 ---- */
{
  const savedState = JSON.stringify(EcoCal.state);
  const savedSettings = JSON.parse(savedState).settings;
  const html = EcoCal.settingsHTML(savedSettings);
  assert(html.includes('class="set-tab on" data-tab="basic"'), '设置页：四 Tab（基础）已渲染且默认选中');
  assert(html.includes('data-tab="stats"') && html.includes('data-tab="backup"') && html.includes('data-tab="security"'), '设置页：四 Tab（统计/备份/安全）齐备');
  assert(html.includes('class="set-pane" data-tab="basic"') && html.includes('data-tab="security"'), '设置页：四个 pane 存在');
  assert(html.includes('id="rem-enabled"') && html.includes('id="rem-days"'), '设置页：备份提醒开关与天数输入存在');
  assert(html.includes('id="wd-backup"') && html.includes('id="g-backup"'), '设置页：备份页含 WebDAV 与 Gitee 面板');
  assert(html.includes('id="s-clear"'), '设置页：数据管理（清空）保留');
  assert(html.includes('id="s-pin-toggle"'), '设置页：安全页含 PIN 设置');

  // 打开设置面板 → 读入 Tab 绑定（openSettings 里挂 onclick）
  const savedConfirm = globalThis.confirmAction;
  const savedModal = globalThis.$id;
  const savedGEB = document.getElementById;
  // openSettings 会 openModal + 大量 $id 绑定；测试桩提供元素即可
  const setEls = {};
  ['s-base','s-fetch','s-autofetch','s-updated','s-autoquote','s-refresh-all','s-rf','s-liab','s-cap',
   'wd-url','wd-user','wd-pass','wd-dir','wd-test','wd-backup','wd-restore','wd-clear-pass','wd-status','wd-enabled',
   'g-owner','g-repo','g-token','g-path','g-test','g-backup','g-restore','g-clear-token','g-status','g-enabled',
   'rem-enabled','rem-days','s-clear','s-pin-toggle','s-pin','s-pin-reset','modal-ok','modal-close','modal-cancel'].forEach(id => {
    setEls[id] = makeEl(id);
    if (id === 'rem-days') setEls[id].value = '7';
  });
  // document.querySelectorAll('.rate-input') → []
  const oldQSA = document.querySelectorAll;
  document.querySelectorAll = sel => {
    if (sel === '.rate-input') return [];
    if (sel === '.set-tab') return [setEls.__tab_basic, setEls.__tab_stats, setEls.__tab_backup, setEls.__tab_security];
    if (sel === '.set-pane') return [setEls.__pane_basic, setEls.__pane_stats, setEls.__pane_backup, setEls.__pane_security];
    return oldQSA(sel);
  };
  ['__tab_basic','__tab_stats','__tab_backup','__tab_security'].forEach((k, i) => {
    setEls[k] = makeEl(k);
    setEls[k].dataset = { tab: ['basic','stats','backup','security'][i] };
  });
  ['__pane_basic','__pane_stats','__pane_backup','__pane_security'].forEach((k, i) => {
    setEls[k] = makeEl(k);
    setEls[k].dataset = { tab: ['basic','stats','backup','security'][i] };
    setEls[k].style.display = i === 0 ? '' : 'none';
  });
  document.getElementById = id => setEls[id] || elements[id] || (elements[id] = makeEl(id));
  const savedGet = globalThis.localStorage.getItem, savedSet = globalThis.localStorage.setItem;
  globalThis.localStorage.getItem = k => (k === 'ecocal.webdav.pass' || k === 'ecocal.gitee.token') ? null : (savedGet ? savedGet(k) : null);
  globalThis.localStorage.setItem = savedSet || (() => {});
  globalThis.confirmAction = function () {};
  try {
    EcoCal.openSettings();
    // Tab 切换：点击「备份」Tab → basic 隐藏、backup 显示
    const basicPane = setEls.__pane_basic, backupPane = setEls.__pane_backup, secPane = setEls.__pane_security;
    const basicTab = setEls.__tab_basic, backupTab = setEls.__tab_backup;
    backupTab.onclick();
    assert(basicPane.style.display === 'none' && backupPane.style.display === '', '设置页：点击「备份」Tab → 显示备份 pane、隐藏基础 pane');
    assert(backupTab.classList.contains('on'), '设置页：点击后 Tab 高亮切换');
    basicTab.onclick();
    assert(basicPane.style.display === '' && backupPane.style.display === 'none', '设置页：切回「基础」Tab 正常');
    // 备份提醒开关：勾选 → 写入 settings 并保存
    const remEnabled = setEls['rem-enabled'];
    remEnabled.checked = true;
    remEnabled.onchange();
    assert(EcoCal.state.settings.backupReminder && EcoCal.state.settings.backupReminder.enabled === true, '设置页：备份提醒开关勾选 → settings.backupReminder.enabled=true');
    remEnabled.checked = false;
    remEnabled.onchange();
    assert(EcoCal.state.settings.backupReminder.enabled === false, '设置页：取消勾选 → enabled=false');
    // 天数输入
    const remDays = setEls['rem-days'];
    remDays.value = '14'; remDays.oninput();
    assert(EcoCal.state.settings.backupReminder.days === 14, '设置页：天数输入 14 → settings.backupReminder.days=14');
    // 保存
    // modal-ok 的 onclick 在 init 的 bindModalButtons() 里已绑定（elements 里的原始桩），
    // document.getElementById 被本测试桩覆盖后 openSettings 内部取到的 setEls 桩没有 onclick；
    // 真正可执行保存逻辑的是 elements['modal-ok'].onclick（它包装了当前 modalOnOk）
    assert(elements['modal-ok'].onclick !== null, '设置页：modal-ok 已绑定保存');
    setEls['s-base'].value = setEls['s-base'].value || 'CNY';
    const okBtn = elements['modal-ok'];
    okBtn.onclick(); // 触发保存：modalOnOk() 执行（若缺字段会抛，测试即失败）
  } finally {
    document.getElementById = savedGEB;
    globalThis.$id = savedModal;
    globalThis.confirmAction = savedConfirm;
    document.querySelectorAll = oldQSA;
    globalThis.localStorage.getItem = savedGet;
    globalThis.localStorage.setItem = savedSet;
    EcoCal.state = JSON.parse(savedState);
  }
}

/* ---- 汇总结果 ---- */
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail > 0) process.exit(1);