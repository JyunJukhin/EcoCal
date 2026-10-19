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
