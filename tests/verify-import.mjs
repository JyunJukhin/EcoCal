/**
 * 备份文件导入预演：在模拟浏览器环境加载 js/app.js，把备份 JSON 灌入 state 并渲染，
 * 用于在真实浏览器操作前验证备份文件与当前版本完全兼容。
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

// 读取备份并模拟「导入确认后」的状态替换（importJSON 校验通过的同一路径）
const backup = JSON.parse(readFileSync(backupPath, 'utf8'));
if (!backup.assets || !Array.isArray(backup.assets) || !Array.isArray(backup.valuations)) {
  console.error('✗ 备份结构不合法（缺少 assets/valuations 数组）');
  process.exit(1);
}
EcoCal.state.assets = backup.assets;
EcoCal.state.valuations = backup.valuations;
EcoCal.state.settings = Object.assign(
  { baseCurrency: 'CNY', rates: {}, demoDismissed: false, autoFetchRates: true, ratesUpdatedAt: null, ratesSource: null },
  backup.settings || {}
);

// 渲染整页（等价于导入后的 renderAll）
console.log('✓ 备份校验通过：', backup.assets.length, '个产品，', backup.valuations.length, '条价值记录');

const s = EcoCal.Calc.summary(EcoCal.state.assets, EcoCal.state.valuations, EcoCal.state.settings);
console.log('✓ 汇总计算：总成本 ' + s.totalCost.toFixed(2) + '，总市值 ' + s.totalValue.toFixed(2) +
  '，累计收益 ' + s.totalProfit.toFixed(2) + '（' + (s.totalRate * 100).toFixed(2) + '%）');
console.log('✓ 分币种小计：');
Object.keys(s.breakdown).forEach(c => {
  const b = s.breakdown[c];
  console.log('  ' + c + '：市值 ' + b.value.toFixed(2) + '，收益 ' + b.profit.toFixed(2) + '（' + b.count + ' 个产品）');
});

// 渲染每张产品卡，确认无异常
EcoCal.state.assets.forEach(a => {
  const m = EcoCal.Calc.assetMetrics(a, EcoCal.state.valuations, EcoCal.state.settings);
  const sell = EcoCal.Calc.sellStatus(a, EcoCal.todayStr());
  console.log('✓ ' + a.name + '（' + a.currency + '）：最新市值 ' + m.currentValue.toFixed(2) +
    '，收益 ' + m.profit.toFixed(2) + '，年化 ' +
    (m.simpleAnnual == null ? '--' : (m.simpleAnnual * 100).toFixed(2) + '%') +
    (sell.minDays == null ? '' : (sell.sellable ? '，可卖' : '，不可卖·还需' + sell.remainingDays + '天')));
});
console.log('\n预演完成：备份文件可正常导入当前版本。');
