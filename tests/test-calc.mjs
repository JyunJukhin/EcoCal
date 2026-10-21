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
globalThis.window = globalThis;
globalThis.document = {
  readyState: 'complete',
  getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
  querySelector(sel) {
    // 交易录入方式：测试默认「总金额」模式（表单静态 HTML 仍按 defMode 生成）
    if (sel && sel.includes('tmode')) return { value: 'amount', checked: true, onchange: null };
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

// 4.11 设置面板（清空数据入口 + 汇率/行情开关）
EcoCal.openSettings();
const settingsHtml = elements['modal-body'].innerHTML || '';
assert(settingsHtml.includes('id="s-fetch"') && settingsHtml.includes('id="s-base"'), '设置面板含汇率获取与基准币种');
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

// 5.1 整页渲染（renderAll）产物检查：卡片/汇总/图表 HTML
EcoCal.renderAll();
const listHtml = elements['asset-list'].innerHTML || '';
const summaryHtml = elements['summary-grid'].innerHTML || '';
const ringHtml = elements['ring-chart'].innerHTML || '';
const barHtml = elements['bar-chart'].innerHTML || '';
assert(summaryHtml.includes('总市值') && summaryHtml.includes('总盈亏'), '汇总卡渲染：总市值/总盈亏');
assert(listHtml.includes('持仓金额') && listHtml.includes('累计投入（成本）'), '非股票卡片侧重金额指标（持仓金额/累计投入）');
assert(listHtml.includes('USD/CNY') && listHtml.includes('外币余额') && listHtml.includes('当前汇率'), '外币卡片显示币种对与余额、当前汇率');
assert(listHtml.includes('持仓数量') && listHtml.includes('平均成本') && listHtml.includes('现价'), '股票卡片显示数量/均价/现价');
assert(listHtml.includes('＋ 买入') && listHtml.includes('− 卖出') && listHtml.includes('✎ 市值'), '卡片操作：买入/卖出/改市值按钮');
assert(listHtml.includes('不可卖 · 还需') && listHtml.includes('可卖'), '批次徽章：既有可卖也有不可卖（演示数据）');
assert(listHtml.includes('浮动盈亏') && listHtml.includes('已实现盈亏') && listHtml.includes('总盈亏'), '卡片含浮动/已实现/总盈亏指标');
assert(listHtml.includes('折合 CNY：¥19,440.00'), '非基准币种卡片折合金额按汇率换算（2700 USD × 7.2 = 19,440 CNY）');
assert(ringHtml.includes('<svg') && barHtml.includes('%'), '图表渲染：环图与条形图有内容');
assert(EcoCal.renderList() === undefined, 'renderList 可重复调用（展开/刷新无异常）');

/* ---- 汇总结果 ---- */
console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
if (fail > 0) process.exit(1);
