/**
 * 转换产物校验脚本（供「数据转换说明.md」的转换 Agent 使用）
 * 用 EcoCal 真实计算引擎校验转换产物：
 *   1) 结构性约束（assets/valuations 数组、id 唯一、币种、日期、引用完整性）
 *   2) 逐资产输出持仓/成本/市值/浮动/已实现/总盈亏，人工核对
 *   3) 卖出序列合法性（按日期升序重放，任一时刻卖出 ≤ 累计买入）
 * 用法：node tools/validate-converted.mjs <转换输出的json路径>
 *       （在本项目根目录下运行；输出文件放项目内或传绝对路径）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2];
if (!inputPath) {
  console.error('用法：node tools/validate-converted.mjs <转换输出的json路径>');
  process.exit(2);
}
const appJs = readFileSync(join(root, 'js', 'app.js'), 'utf8');
const payload = JSON.parse(readFileSync(join(root, inputPath), 'utf8'));

/* ---- 模拟浏览器环境（与 tests/test-calc.mjs 的桩一致） ---- */
const elements = {};
const makeEl = (id) => ({
  id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, files: [],
  onclick: null, onchange: null, checked: false,
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  appendChild() {}, remove() {}, click() {}, addEventListener() {}, setAttribute() {},
  querySelectorAll() { return []; }, select() {},
});
globalThis.window = globalThis;
globalThis.document = {
  readyState: 'complete',
  getElementById: (id) => elements[id] || (elements[id] = makeEl(id)),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  createElement: () => makeEl('dyn'), body: { appendChild() {} },
};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.alert = () => {};
globalThis.prompt = () => null;
globalThis.Blob = function () {};
globalThis.FileReader = function () {};
globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

eval(appJs);
const EcoCal = globalThis.__EcoCal;
if (!EcoCal) { console.error('✗ window.__EcoCal 未挂载'); process.exit(1); }
const { Calc } = EcoCal;

/* ---- 1. 结构校验 ---- */
let bad = 0;
if (!Array.isArray(payload.assets)) { console.error('✗ assets 必须为数组'); bad++; }
if (!Array.isArray(payload.valuations)) { console.error('✗ valuations 必须为数组'); bad++; }

// 应用载荷（等价于真实导入：importPayloadText → 覆盖确认 → applyPayload → migrateToV6）
EcoCal.importPayloadText(JSON.stringify(payload));
elements['confirm-ok'].onclick(); // 模拟点击「确认」覆盖，随后自动 renderAll
const { assets, trades, settings } = EcoCal.state;

const ids = new Set();
assets.forEach((a) => {
  if (ids.has(a.id)) { console.error('✗ 资产 id 重复: ' + a.id); bad++; }
  ids.add(a.id);
  if (!/^[A-Z]{3}$/.test(a.currency || '')) { console.error('✗ 币种必须 3 位大写: ' + a.name + ' -> ' + a.currency); bad++; }
  if (a.category === 'fx' && a.currency !== 'CNY') { console.error('✗ 外币产品币种必须 CNY: ' + a.name); bad++; }
  if (a.category !== 'fx' && a.foreignCurrency) { console.error('✗ 非外币产品不得有 foreignCurrency: ' + a.name); bad++; }
});
(trades || []).forEach((t) => {
  if (!ids.has(t.assetId)) { console.error('✗ 交易引用了不存在的资产: ' + t.assetId); bad++; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) { console.error('✗ 日期格式错误（需 YYYY-MM-DD）: ' + (t.date || t.id)); bad++; }
  if (!(Number(t.quantity) > 0) || !(Number(t.price) > 0)) { console.error('✗ 数量/单价必须为正: ' + (t.id || t.assetId)); bad++; }
  if (!['buy', 'sell'].includes(t.type)) { console.error('✗ type 必须 buy/sell: ' + (t.id || t.assetId)); bad++; }
});
console.log(bad === 0 ? '✓ 结构校验通过' : `✗ 结构校验发现 ${bad} 处问题`);

/* ---- 2. 逐资产计算输出（人工核对口径） ---- */
console.log('\n---- 逐资产计算结果（核对口径用） ----');
for (const a of assets) {
  const pos = Calc.tradePosition(a, trades, a.lastPrice != null ? Number(a.lastPrice) : null);
  const mv = pos.marketValue != null ? pos.marketValue : '--';
  const fl = pos.float != null ? pos.float : '--';
  if (pos.qty > 0 && pos.marketValue == null) {
    console.error(`✗ ${a.name} 有持仓但市值缺失（交易日为空或全部交易无有效价格）`);
    bad++;
  }
  console.log(
    `[${a.category}/${a.currency}] ${a.name}\t持仓=${pos.qty}\t成本=${pos.cost}\t` +
    `市值=${mv}\t浮动=${fl}\t已实现=${pos.realized}\t总盈亏=${pos.totalProfit}\t天数=${pos.days}`
  );
}

/* ---- 3. 卖出序列合法性（按日期升序重放，任一时刻卖出 ≤ 累计买入） ---- */
console.log('\n---- 卖出序列校验 ----');
for (const a of assets) {
  let held = 0;
  const ts = trades.filter((t) => t.assetId === a.id).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  for (const t of ts) {
    if (t.type === 'buy') held += Number(t.quantity);
    else {
      held -= Number(t.quantity);
      if (held < -1e-6) { console.error(`✗ ${a.name} 卖出超持仓 @${t.date}`); bad++; }
    }
  }
}
console.log(bad === 0 ? '✓ 卖出序列合法' : `✗ 卖出序列有 ${bad} 处非法`);

console.log(bad === 0 ? '\n✅ 全部校验通过，转换产物可导入 EcoCal' : `\n❌ 共 ${bad} 处问题，请修正后重跑`);
process.exit(bad === 0 ? 0 : 1);
