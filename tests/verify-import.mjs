/**
 * 备份文件导入预演（v6）：在模拟浏览器环境加载 js/app.js，把备份 JSON 走与
 * 「导入确认」完全相同的路径（applyPayload 等价逻辑 → migrateToV6 迁移），
 * 再汇总渲染，用于在真实浏览器操作前验证旧备份可正常迁移到当前版本。
 * 运行：node tests/verify-import.mjs <backup.json>
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backupPath = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, 'ecocal-backup-2026-10-18.json');
const appJs = readFileSync(join(root, 'js', 'app.js'), 'utf8');

// 模拟浏览器全局
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
  };
}
const storage = {};
globalThis.window = globalThis;
globalThis.document = {
  readyState: 'complete',
  getElementById(id) { return elements[id] || (elements[id] = makeEl(id)); },
  querySelector() { return null; },
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

// 读取备份并模拟「导入确认后」的状态替换（与 applyPayload 相同的路径）
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
if (!backup.assets || !Array.isArray(backup.assets) || !Array.isArray(backup.valuations)) {
  console.error('✗ 备份结构不合法（缺少 assets/valuations 数组）');
  process.exit(1);
}
EcoCal.state.assets = backup.assets;
EcoCal.state.valuations = backup.valuations;
EcoCal.state.trades = Array.isArray(backup.trades) ? backup.trades : [];
EcoCal.state.settings = Object.assign(
  {
    baseCurrency: 'CNY', rates: {}, demoDismissed: false, autoFetchRates: true,
    autoQuote: true, ratesUpdatedAt: null, ratesSource: null, quotes: {}, kline: {},
  },
  backup.settings || {}
);
EcoCal.state.settings.rates = backup.settings && backup.settings.rates ? backup.settings.rates : {};
EcoCal.migrateToV6(); // 旧「价值快照」资产 → 首笔买入 + 折算现价

console.log('✓ 备份校验通过：', backup.assets.length, '个产品，迁移后交易记录', EcoCal.state.trades.length, '笔');

const s = EcoCal.Calc.summary(EcoCal.state.assets, [], EcoCal.state.settings, EcoCal.state.trades);
console.log('✓ 汇总计算：总成本 ' + s.totalCost.toFixed(2) + '，总市值 ' + s.totalValue.toFixed(2) +
  '，累计收益 ' + s.totalProfit.toFixed(2) + '（' + (s.totalRate * 100).toFixed(2) + '%）');
console.log('✓ 分币种小计：');
Object.keys(s.breakdown).forEach(c => {
  const b = s.breakdown[c];
  console.log('  ' + c + '：市值 ' + b.value.toFixed(2) + '，收益 ' + b.profit.toFixed(2) + '（' + b.count + ' 个产品）');
});
if (s.missingRateCurrencies.length) {
  console.log('⚠ 缺汇率币种：' + s.missingRateCurrencies.join('、') + '（不计入总额，请在设置中维护）');
}

// 渲染每张产品卡口径，确认无异常
EcoCal.state.assets.forEach(a => {
  const pos = EcoCal.Calc.tradePosition(a, EcoCal.state.trades, a.lastPrice != null ? Number(a.lastPrice) : null);
  const sell = EcoCal.Calc.sellStatus(a, EcoCal.state.trades, EcoCal.todayStr());
  console.log('✓ ' + a.name + '（' + a.currency + '）：成本 ' + pos.cost.toFixed(2) +
    '，市值 ' + (pos.marketValue == null ? '--' : pos.marketValue.toFixed(2)) +
    '，浮动 ' + (pos.float == null ? '--' : pos.float.toFixed(2)) +
    '，已实现 ' + pos.realized.toFixed(2) +
    (sell.sellable == null ? '' : (sell.sellable ? '，可卖' : (sell.partial ? '，部分可卖' : '，不可卖·还需' + sell.remainingDays + '天'))));
});
console.log('\n预演完成：旧备份可正常迁移并导入 v' + EcoCal.APP_VERSION + '。');
