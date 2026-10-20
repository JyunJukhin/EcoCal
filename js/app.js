
'use strict';
/* =========================================================================
 * EcoCal - 个人资产持仓记录工具（纯本地，零依赖）
 * 数据：Asset（产品） + Valuation（价值快照） + Settings（基准币种/汇率）
 * ========================================================================= */
(function () {

/* ---------------- 常量与配置 ---------------- */
const STORAGE_KEY = 'ecocal.data.v1';

/* 应用版本：主版本.次版本.补丁
 * - 主版本：重大架构/功能（v3 多文件、v4 股票交易与行情）
 * - 次版本：功能增强（v5 监察表模式与本次优化）
 * - 补丁：缺陷修复 */
const APP_VERSION = '5.1.0';

const CURRENCIES = {
  CNY: { symbol: '¥',  name: '人民币' },
  USD: { symbol: '$',  name: '美元' },
  HKD: { symbol: 'HK$', name: '港币' },
  EUR: { symbol: '€',  name: '欧元' },
  GBP: { symbol: '£',  name: '英镑' },
  JPY: { symbol: '¥',  name: '日元' },
  SGD: { symbol: 'S$', name: '新加坡元' },
  AUD: { symbol: 'A$', name: '澳元' },
  CAD: { symbol: 'C$', name: '加元' },
  CHF: { symbol: 'Fr', name: '瑞士法郎' },
};
const CUSTOM_CURRENCIES = {};   // 用户自定义币种（运行时累积，不入库存）

const CATEGORIES = {
  stock:     { label: '股票',      sub: ['A股', '港股', '美股', '其他市场'] },
  fund:      { label: '基金',      sub: ['货币型', '债券型', '混合型', '指数型', '股票型', 'QDII', '其他'] },
  bond:      { label: '债券',      sub: ['国债', '企业债', '可转债', '其他'] },
  deposit:   { label: '存款',      sub: ['活期', '定期', '大额存单'] },
  wealth:    { label: '银行理财',  sub: ['固收类', '权益类', '混合类'] },
  insurance: { label: '保险',      sub: ['年金险', '增额寿险', '其他'] },
  other:     { label: '其他',      sub: ['其他'] },
};

/* 苹果风格柔和色板（环图取色） */
const PALETTE = ['#0071e3', '#bf5af2', '#ff9f0a', '#34c759', '#ff375f', '#64d2ff', '#ac8e68', '#5e5ce6', '#ffd60a', '#8e8e93'];

/* 风险等级（R1–R5，参考银行理财风险分级）与对应标签色 */
const RISK_LEVELS = [
  { key: 'R1', label: 'R1（低风险）' },
  { key: 'R2', label: 'R2（中低风险）' },
  { key: 'R3', label: 'R3（中等风险）' },
  { key: 'R4', label: 'R4（中高风险）' },
  { key: 'R5', label: 'R5（高风险）' },
];
const RISK_COLORS = { R1: '#1d9e49', R2: '#34c759', R3: '#ff9f0a', R4: '#ff9500', R5: '#d70015' };

/* 排序选项（筛选栏动态生成） */
const SORT_OPTIONS = [
  ['valueDesc', '市值从高到低'],
  ['annualDesc', '年化从高到低'],
  ['annualAsc', '年化从低到高'],
  ['rateDesc', '收益率从高到低'],
  ['rateAsc', '收益率从低到高（亏损优先）'],
  ['daysDesc', '持有天数从多到少'],
  ['name', '名称'],
];

/* ---------------- 小工具 ---------------- */
function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d.getTime()) ? null : d;
}
/* 两个 YYYY-MM-DD 之间相差的自然日数（b - a），取整 */
function dayDiff(a, b) {
  const da = parseDate(a), db = parseDate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
/* 数量/单价保留 4 位小数（股票价格、基金份额等），避免浮点误差累积 */
function roundQty(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }
function roundPrice(n) { return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000; }
function currencySymbol(code) {
  if (CURRENCIES[code]) return CURRENCIES[code].symbol;
  if (CUSTOM_CURRENCIES[code]) return CUSTOM_CURRENCIES[code].symbol;
  return code + ' ';
}
function currencyName(code) {
  if (CURRENCIES[code]) return CURRENCIES[code].name;
  if (CUSTOM_CURRENCIES[code]) return CUSTOM_CURRENCIES[code].name;
  return code;
}
function fmtMoney(n, currency) {
  const num = Number(n);
  if (!isFinite(num)) return '--';
  const symbol = currencySymbol(currency);
  const digits = currency === 'JPY' ? 0 : 2;
  const abs = Math.abs(num);
  const parts = abs.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return (num < 0 ? '-' : '') + symbol + parts;
}
function fmtPct(n, digits) {
  const num = Number(n);
  if (!isFinite(num)) return '--';
  const d = digits == null ? 2 : digits;
  return (num >= 0 ? '+' : '') + num.toFixed(d) + '%';
}
function fmtSignedMoney(n, currency) {
  const num = Number(n);
  if (!isFinite(num)) return '--';
  return (num >= 0 ? '+' : '') + fmtMoney(num, currency);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function $id(id) { return document.getElementById(id); }
function fmtDateCN(s) { return s; }

/* ---------------- 数据层（localStorage，带内存回退） ---------------- */
let memory = null; // localStorage 不可用时的内存回退
function storageGet() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return memory;
  }
}
function storageSet(data) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    memory = null;
  } catch (e) {
    memory = data; // 隐私模式等无法写入时退化为内存保存
  }
}
function storageRemove() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (e) { /* ignore */ }
  memory = null;
}

const DEFAULT_SETTINGS = {
  baseCurrency: 'CNY', rates: {},
  demoDismissed: false,
  autoFetchRates: true,   // 每次启动自动获取一次最新汇率
  ratesUpdatedAt: null,   // 最近一次联网更新汇率的时间戳
  ratesSource: null,      // 汇率来源（公开接口名称）
  autoQuote: true,        // 打开页面自动刷新行情开关
  quotes: {},             // 行情缓存 { symbol: { price, time } }
  kline: {},              // 日K缓存  { symbol: { days, time } }
};

let state = { assets: [], valuations: [], trades: [], settings: Object.assign({}, DEFAULT_SETTINGS) };

function saveState() { storageSet(state); }

function loadState() {
  const raw = storageGet();
  if (raw && raw.assets && Array.isArray(raw.assets) && Array.isArray(raw.valuations)) {
    state.assets = raw.assets;
    state.valuations = raw.valuations;
    state.trades = Array.isArray(raw.trades) ? raw.trades : [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    state.settings.rates = raw.settings && raw.settings.rates ? raw.settings.rates : {};
    return true; // 已有数据
  }
  return false; // 无数据
}

/**
 * 旧数据迁移：产品从「价值快照/本金」模式切换为「交易记录」模式时，
 * 若该产品尚无任何交易记录，用原有 quantity + principal 生成一笔买入交易，
 * 保证切换后持仓/成本/盈亏计算正确。
 * 返回是否生成了迁移交易。
 */
function migrateToTrades(asset) {
  if (!asset || !state.trades || state.trades.some(t => t.assetId === asset.id)) return false;
  const qty = Number(asset.quantity);
  const p = Number(asset.principal);
  if (!(isFinite(qty) && qty > 0) || !(isFinite(p) && p > 0)) return false; // 无有效数量或金额，无法生成单价
  const price = p / qty;
  state.trades.push({
    id: uid('trade_'), assetId: asset.id, type: 'buy',
    date: asset.startDate || todayStr(),
    quantity: roundQty(qty), price: roundPrice(price), fee: 0,
    note: '由旧数据迁移（原本金 ' + round2(p) + '）',
    createdAt: Date.now(),
  });
  saveState();
  return true;
}

/* ---------------- 计算引擎（纯函数，便于测试） ---------------- */
const Calc = {
  /**
   * 交易记录模式持仓计算（加权平均成本口径）。
   * trades：该产品的全部交易（buy/sell）；lastPrice：最新股价（null 表示行情缺失）。
   * 返回 { qty, cost, avgCost, realized, marketValue, float, totalProfit, events, days, hasTrades }
   *   - float    浮动盈亏 = 市值 − 持仓成本
   *   - realized 已实现盈亏 = Σ(卖出金额 − 卖出数量×当时平均成本)
   *   - totalProfit = 浮动 + 已实现
   */
  tradePosition(asset, trades, lastPrice, today) {
    const list = trades
      .filter(t => t.assetId === asset.id)
      .sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    let qty = 0, cost = 0, realized = 0;
    const events = [];
    list.forEach(t => {
      const q = Number(t.quantity) || 0;
      const p = Number(t.price) || 0;
      const fee = Number(t.fee) || 0;
      if (t.type === 'sell') {
        // 卖出：按当前加权平均成本扣减，差额记入已实现盈亏
        const avg = qty > 0 ? cost / qty : 0;
        const sellAmount = q * p - fee;
        const baseCost = q * avg;
        const r = round2(sellAmount - baseCost);
        realized = round2(realized + r);
        cost = round2(Math.max(0, cost - baseCost));
        qty = Math.max(0, qty - q);
        events.push({ trade: t, qty, cost, realized: r });
      } else {
        // 买入：成本累加（含手续费）
        cost = round2(cost + q * p + fee);
        qty += q;
        events.push({ trade: t, qty, cost, realized: 0 });
      }
    });
    const avgCost = qty > 0 ? cost / qty : 0;
    const marketValue = (lastPrice != null && qty > 0) ? round2(qty * lastPrice) : null;
    const float = marketValue != null ? round2(marketValue - cost) : null;
    const totalProfit = round2((float != null ? float : 0) + realized);
    // 持有天数（近似口径）：从首笔交易日到今天
    const firstDate = list.length ? list[0].date : asset.startDate;
    const days = Math.max(0, dayDiff(firstDate, today || todayStr()));
    return {
      qty, cost, avgCost, realized, marketValue, float, totalProfit,
      events, days, firstDate, hasTrades: list.length > 0,
    };
  },
  /**
   * 汇率换算：金额 → 基准币种。汇率未设置时返回 null。
   */
  toBase(amount, currency, settings) {
    if (currency === settings.baseCurrency) return Number(amount);
    const rate = settings.rates[currency];
    if (rate == null || !(Number(rate) > 0)) return null;
    return Number(amount) * Number(rate);
  },
  /**
   * 单产品指标（本币口径）。
   * 返回 { currentValue, days, profit, rate, simpleAnnual, compoundAnnual, latestDate, hasValuation }
   */
  assetMetrics(asset, valuations, settings) {
    const vals = valuations
      .filter(v => v.assetId === asset.id)
      .sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const latest = vals.length ? vals[vals.length - 1] : null;
    const currentValue = latest ? latest.value : asset.principal;
    // 持有天数：截止日为「最新记录日期」；无记录时截止到今天（仍在持有中）
    const endDate = latest
      ? (latest.date > asset.startDate ? latest.date : asset.startDate)
      : (dayDiff(asset.startDate, todayStr()) > 0 ? todayStr() : asset.startDate);
    const days = Math.max(0, dayDiff(asset.startDate, endDate));
    const profit = round2(currentValue - asset.principal);
    const rate = asset.principal > 0 ? profit / asset.principal : 0;
    let simpleAnnual = null, compoundAnnual = null;
    if (days > 0 && asset.principal > 0 && currentValue > 0) {
      simpleAnnual = rate * 365 / days;
      compoundAnnual = Math.pow(currentValue / asset.principal, 365 / days) - 1;
    }
    // 基准币种口径
    const baseCost = Calc.toBase(asset.principal, asset.currency, settings);
    const baseValue = Calc.toBase(currentValue, asset.currency, settings);
    return {
      assetId: asset.id, assetCurrency: asset.currency,
      valuations: vals, currentValue, days, profit, rate,
      simpleAnnual, compoundAnnual,
      latestDate: latest ? latest.date : null, hasValuation: vals.length > 0,
      baseCost, baseValue,
      baseProfit: (baseCost != null && baseValue != null) ? round2(baseValue - baseCost) : null,
      rateMissing: baseCost == null || baseValue == null,
      valuationCount: vals.length,
    };
  },
  /**
   * 可卖判定：按「开始持有日期」与「最低持有天数」（非必填）判断当前是否可卖。
   * sellable 为 null 表示未设置最低持有天数（不限制）。
   */
  sellStatus(asset, today) {
    const heldDays = Math.max(0, dayDiff(asset.startDate, today || todayStr()));
    const minDays = asset.minHoldDays != null && Number(asset.minHoldDays) > 0
      ? Math.floor(Number(asset.minHoldDays)) : null;
    if (minDays == null) return { heldDays, minDays: null, sellable: null, remainingDays: 0 };
    return {
      heldDays, minDays,
      sellable: heldDays >= minDays,
      remainingDays: Math.max(0, minDays - heldDays),
    };
  },
  /**
   * 全部资产汇总（基准币种口径）。
   * 返回 { totalCost, totalValue, totalProfit, totalRate, overallAnnual, currencyBreakdown, assetMetrics: [...], gainCount, lossCount, missingRateCurrencies }
   */
  summary(assets, valuations, settings, trades) {
    const tradesList = trades || [];
    // 分发两种记账模式：交易记录模式（enableTrades）走 tradePosition，其余走价值快照
    const metrics = assets.map(a => {
      if (a.enableTrades) {
        const pos = Calc.tradePosition(a, tradesList, a.lastPrice != null ? Number(a.lastPrice) : null);
        const baseCost = Calc.toBase(pos.cost, a.currency, settings);
        const baseValue = pos.marketValue != null ? Calc.toBase(pos.marketValue, a.currency, settings) : null;
        const baseFloat = pos.float != null ? Calc.toBase(pos.float, a.currency, settings) : null;
        const baseRealized = Calc.toBase(pos.realized, a.currency, settings);
        const baseTotal = (baseFloat != null ? baseFloat : 0) + (baseRealized != null ? baseRealized : 0);
        return {
          assetId: a.id, assetCurrency: a.currency,
          valuations: [], currentValue: pos.marketValue, days: pos.days,
          profit: pos.float,         // 浮动盈亏（本币）
          realized: pos.realized,    // 已实现盈亏（本币）
          rate: pos.cost > 0 && pos.float != null ? pos.float / pos.cost : null,
          simpleAnnual: null, compoundAnnual: null, latestDate: null, hasValuation: false,
          valuationCount: 0,
          baseCost, baseValue, baseProfit: baseFloat,
          baseRealized, baseTotal: round2(baseTotal),
          rateMissing: baseCost == null || baseValue == null,
          trade: pos,
        };
      }
      return Calc.assetMetrics(a, valuations, settings);
    });
    let totalCost = 0, totalValue = 0, totalFloat = 0, totalRealized = 0;
    let costDays = 0, totalDaysWeight = 0;
    let gainCount = 0, lossCount = 0;
    const missingRateCurrencies = new Set();
    const breakdown = {}; // 分币种小计（基准币种）
    const usedCurrencies = new Set();

    metrics.forEach(m => {
      if (m.baseCost != null) totalCost += m.baseCost;
      if (m.baseValue != null) totalValue += m.baseValue;
      if (m.baseProfit != null) totalFloat += m.baseProfit;
      else if (m.baseCost == null) missingRateCurrencies.add(m.assetCurrency);
      if (m.baseRealized != null) totalRealized += m.baseRealized;
      if (m.baseCost != null) {
        costDays += m.baseCost * m.days;
        totalDaysWeight += m.baseCost;
      }
      // 盈亏计数：按总口径（浮动 + 已实现）
      const totalBase = m.baseTotal != null ? m.baseTotal : m.baseProfit;
      if (totalBase > 0.004) gainCount++;
      else if (totalBase < -0.004) lossCount++;
      const cur = m.assetCurrency;
      usedCurrencies.add(cur);
      const b = breakdown[cur] = breakdown[cur] || { cost: 0, value: 0, profit: 0, realized: 0, count: 0 };
      b.count++;
      if (m.baseCost != null) b.cost += m.baseCost;
      if (m.baseValue != null) b.value += m.baseValue;
      if (m.baseProfit != null) b.profit += m.baseProfit;
      if (m.baseRealized != null) b.realized += m.baseRealized;
    });

    const totalProfit = round2(totalFloat + totalRealized); // 总盈亏 = 浮动 + 已实现
    const totalRate = totalCost > 0 ? totalProfit / totalCost : null;
    let overallAnnual = null;
    if (totalRate != null && costDays > 0) {
      overallAnnual = totalRate * 365 / (costDays / totalDaysWeight);
    }
    // 排序：默认按市值降序
    const sorted = metrics.slice().sort((a, b) => (b.baseValue || 0) - (a.baseValue || 0));
    return {
      totalCost, totalValue, totalProfit, totalFloat, totalRealized, totalRate, overallAnnual,
      metrics: sorted, gainCount, lossCount,
      missingRateCurrencies: Array.from(missingRateCurrencies),
      breakdown, usedCurrencies: Array.from(usedCurrencies),
    };
  },
};

/* ---------------- SVG 图表生成（返回字符串） ---------------- */
const Charts = {
  /* 环形图：data = [{label, value, color}]，value 非正数时跳过 */
  ring(data, size) {
    const S = size || 180, cx = S / 2, cy = S / 2, r = S / 2 - 14, sw = 26;
    const total = data.reduce((s, d) => s + (d.value > 0 ? d.value : 0), 0);
    if (total <= 0) return '<div class="chart-empty">暂无数据</div>';
    const arc = (a0, a1) => {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
             'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
    };
    let acc = -Math.PI / 2;
    let paths = '';
    const legend = [];
    data.forEach((d) => {
      if (!(d.value > 0)) return;
      const angle = d.value / total * Math.PI * 2;
      const a1 = acc + angle;
      paths += '<path d="' + arc(acc, a1) + '" fill="none" stroke="' + d.color +
               '" stroke-width="' + sw + '" stroke-linecap="butt"/>';
      legend.push('<span><i style="background:' + d.color + '"></i>' + esc(d.label) +
                  ' · ' + (Math.round(d.value / total * 1000) / 10) + '%</span>');
      acc = a1;
    });
    return '<div style="display:flex;flex-direction:column;align-items:center">' +
           '<svg viewBox="0 0 ' + S + ' ' + S + '" style="max-width:' + S + 'px">' + paths + '</svg>' +
           '<div class="chart-legend">' + legend.join('') + '</div></div>';
  },
  /* 横向条形图：items = [{label, value, sub, loss}] */
  bars(items, baseCurrency) {
    if (!items.length) return '<div class="chart-empty">暂无数据</div>';
    const max = Math.max.apply(null, items.map(i => Math.abs(i.value))) || 1;
    const rows = items.map((it, idx) => {
      const pct = Math.max(2, Math.round(Math.abs(it.value) / max * 100));
      const barColor = it.loss ? 'rgba(29,158,73,.75)' : 'rgba(0,113,227,.78)';
      return '<div style="display:grid;grid-template-columns:110px 1fr 110px;gap:10px;align-items:center;padding:5px 0;font-size:12px">' +
        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)" title="' + esc(it.label) + '">' + esc(it.label) + '</div>' +
        '<div style="position:relative;height:16px;background:rgba(0,0,0,.05);border-radius:8px">' +
          '<div style="position:absolute;left:0;top:0;bottom:0;width:' + pct + '%;background:' + barColor + ';border-radius:8px;transition:width .3s"></div>' +
        '</div>' +
        '<div style="text-align:right;font-feature-settings:tnum;font-weight:600">' + fmtMoney(it.value, baseCurrency) +
          (it.loss ? '<span style="color:var(--green);font-size:11px;font-weight:400"> ' + it.sub + '</span>'
                   : '<span style="color:var(--ink-3);font-size:11px;font-weight:400"> ' + it.sub + '</span>') +
        '</div></div>';
    }).join('');
    return '<div style="width:100%">' + rows + '</div>';
  },
  /* 折线走势图：points = [{date, value}]，>=2 点才画 */
  line(points, w, h) {
    if (points.length < 2) return '<div class="chart-empty">价值记录不足 2 条，暂无法绘制走势（可继续添加价值记录）</div>';
    const W = w || 320, H = h || 140, pad = { l: 30, r: 6, t: 8, b: 20 };
    const values = points.map(p => p.value);
    let min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    const spanW = W - pad.l - pad.r, spanH = H - pad.t - pad.b;
    const x = i => pad.l + (points.length === 1 ? spanW / 2 : i / (points.length - 1) * spanW);
    const y = v => pad.t + (1 - (v - min) / range) * spanH;
    const lastIdx = points.length - 1;
    let linePath = '', areaPath = 'M' + x(0).toFixed(1) + ' ' + y(values[0]).toFixed(1);
    points.forEach((p, i) => {
      linePath += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1) + ' ';
    });
    // 面积填充：首点 → 末点 → 底部 → 闭合
    areaPath += ' L' + x(lastIdx).toFixed(1) + ' ' + (pad.t + spanH).toFixed(1) +
                ' L' + x(0).toFixed(1) + ' ' + (pad.t + spanH).toFixed(1) + ' Z';
    // Y 轴刻度（3 条）
    let ticks = '';
    for (let k = 0; k <= 2; k++) {
      const v = min + range * k / 2;
      const yy = pad.t + (1 - k / 2) * spanH;
      ticks += '<line x1="' + pad.l + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pad.r) +
               '" y2="' + yy.toFixed(1) + '" stroke="rgba(0,0,0,.06)" stroke-width="1"/>' +
               '<text x="' + (pad.l - 5) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#a1a1a6">' +
               (v >= 10000 ? (v / 10000).toFixed(1) + '万' : Math.round(v)) + '</text>';
    }
    const last = points[points.length - 1];
    const dates = points.map(p => p.date);
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-height:180px">' + ticks +
      '<path d="' + areaPath + '" fill="rgba(0,113,227,.10)" stroke="none"/>' +
      '<path d="' + linePath.trim() + '" fill="none" stroke="#0071e3" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + x(points.length - 1).toFixed(1) + '" cy="' + y(last.value).toFixed(1) +
      '" r="3.2" fill="#0071e3"/>' +
      '<text x="' + x(points.length - 1) + '" y="' + (y(last.value) - 8).toFixed(1) +
      '" text-anchor="end" font-size="9" fill="#86868b">' + fmtMoney(last.value, '') + '</text>' +
      '<text x="' + pad.l + '" y="' + (H - 6) + '" font-size="9" fill="#a1a1a6">' + esc(dates[0]) + '</text>' +
      '<text x="' + (W - pad.r) + '" y="' + (H - 6) + '" text-anchor="end" font-size="9" fill="#a1a1a6">' + esc(last.date) + '</text>' +
      '</svg>';
  }
};

/* ---------------- 状态 & 渲染 ---------------- */
let expanded = new Set();      // 展开卡片集合
let filters = { category: 'all', currency: 'all', sort: 'valueDesc' };

function getAsset(id) { return state.assets.find(a => a.id === id); }

/* ---- 汇总区 ---- */
function renderSummary() {
  const s = Calc.summary(state.assets, state.valuations, state.settings, state.trades);
  const base = state.settings.baseCurrency;
  const html = [
    {
      label: '总成本（' + base + '）',
      value: fmtMoney(s.totalCost, base),
      sub: state.assets.length + ' 个产品 · ' + s.usedCurrencies.length + ' 个币种',
    },
    {
      label: '总市值（' + base + '）',
      value: fmtMoney(s.totalValue, base),
      sub: s.gainCount + ' 个盈利 · ' + s.lossCount + ' 个亏损',
      cls: s.totalProfit >= 0 ? 'money-red' : 'money-green',
    },
    {
      label: '累计收益（' + base + '，总盈亏）',
      value: fmtSignedMoney(s.totalProfit, base),
      sub: '浮动 ' + fmtSignedMoney(s.totalFloat, base) + ' · 已实现 ' + fmtSignedMoney(s.totalRealized, base)
        + (s.totalRate == null ? '' : ' · 收益率 ' + fmtPct(s.totalRate * 100)),
      cls: s.totalProfit >= 0 ? 'money-red' : 'money-green',
    },
    {
      label: '整体年化（单利）',
      value: s.overallAnnual == null ? '--' : fmtPct(s.overallAnnual * 100),
      sub: '按成本加权持有天数估算',
      cls: s.overallAnnual != null && s.overallAnnual >= 0 ? 'money-red' : 'money-green',
    },
  ].map(c => '<div class="summary-card"><div class="label">' + c.label + '</div>' +
             '<div class="value ' + (c.cls || '') + '">' + c.value + '</div>' +
             '<div class="sub">' + c.sub + '</div></div>').join('');
  $id('summary-grid').innerHTML = html;

  // 分币种小计
  const chips = Object.keys(s.breakdown).map(cur => {
    const b = s.breakdown[cur];
    const cls = b.profit >= 0 ? 'gain' : 'loss';
    return '<span class="currency-chip">' + esc(cur) +
           '<b>' + fmtMoney(b.value, base) + '</b>' +
           '<span class="' + cls + '">' + fmtSignedMoney(b.profit, base) + '</span></span>';
  });
  const missing = s.missingRateCurrencies.length
    ? '<span class="currency-chip" style="color:#b25000">⚠ 缺汇率：' + s.missingRateCurrencies.join('、') + '（请在汇率设置中维护）</span>'
    : '';
  $id('currency-subtotals').innerHTML = chips.join('') + missing;
}

/* ---- 图表区 ---- */
function renderCharts() {
  const s = Calc.summary(state.assets, state.valuations, state.settings, state.trades);
  const base = state.settings.baseCurrency;

  // 环图：按大类汇总市值
  const byCat = {};
  s.metrics.forEach(m => {
    const asset = state.assets.find(a => a.id === m.assetId);
    if (!asset || m.baseValue == null) return;
    const key = CATEGORIES[asset.category] ? CATEGORIES[asset.category].label : asset.category;
    byCat[key] = (byCat[key] || 0) + m.baseValue;
  });
  const catKeys = Object.keys(byCat);
  const ringData = catKeys.map((k, i) => ({
    label: k,
    value: byCat[k],
    color: PALETTE[i % PALETTE.length],
  }));
  $id('ring-chart').innerHTML = Charts.ring(ringData, 190);

  // 条形图：各产品市值（基准币种）
  const barItems = s.metrics.map(m => {
    const asset = state.assets.find(a => a.id === m.assetId);
    return {
      label: asset ? asset.name : '?',
      value: m.baseValue || 0,
      loss: m.baseProfit != null && m.baseProfit < 0,
      sub: m.baseProfit != null ? '· ' + fmtPct(m.rate * 100) : '· 缺汇率',
      currency: base,
    };
  }).slice(0, 12);
  $id('bar-chart').innerHTML = Charts.bars(barItems, base);
}

/* ---- 产品列表 ---- */
function filteredAssets() {
  let list = state.assets.slice();
  if (filters.category !== 'all') list = list.filter(a => a.category === filters.category);
  if (filters.currency !== 'all') list = list.filter(a => a.currency === filters.currency);
  const metricsOf = a => Calc.assetMetrics(a, state.valuations, state.settings);
  list.sort((a, b) => {
    const ma = metricsOf(a), mb = metricsOf(b);
    switch (filters.sort) {
      case 'name': return a.name.localeCompare(b.name, 'zh');
      case 'rateDesc': return (mb.rate - ma.rate);
      case 'rateAsc': return (ma.rate - mb.rate);
      case 'daysDesc': return mb.days - ma.days;
      // 年化排序：未计算出年化（null）的排最后
      case 'annualDesc':
        return (mb.simpleAnnual == null ? -Infinity : mb.simpleAnnual) - (ma.simpleAnnual == null ? -Infinity : ma.simpleAnnual);
      case 'annualAsc':
        return (ma.simpleAnnual == null ? Infinity : ma.simpleAnnual) - (mb.simpleAnnual == null ? Infinity : mb.simpleAnnual);
      default: return (mb.baseValue || 0) - (ma.baseValue || 0);
    }
  });
  return list;
}

function timelineHTML(asset, metrics) {
  const rows = metrics.valuations.map((v, i) => {
    const prev = i > 0 ? metrics.valuations[i - 1].value : asset.principal;
    const delta = round2(v.value - prev);
    const deltaPct = prev > 0 ? delta / prev : 0;
    const cls = delta >= 0 ? 'money-red' : 'money-green';
    const deltaTxt = i === 0
      ? '<span class="tl-delta ' + (delta >= 0 ? 'money-red' : 'money-green') + '">' + fmtSignedMoney(delta, asset.currency) + '（较成本 ' + fmtPct(deltaPct * 100) + '）</span>'
      : '<span class="tl-delta ' + cls + '">' + fmtSignedMoney(delta, asset.currency) + '（' + fmtPct(deltaPct * 100) + '）</span>';
    return '<div class="tl-item">' +
      '<span class="tl-date">' + esc(v.date) + '</span>' +
      '<span class="tl-value">' + fmtMoney(v.value, asset.currency) + '</span>' +
      '<span class="tl-delta">' + deltaTxt + '</span>' +
      '<span class="tl-ops">' +
        '<button data-action="editValuation" data-id="' + v.id + '" title="编辑">✎</button>' +
        '<button data-action="deleteValuation" data-id="' + v.id + '" class="del" title="删除">🗑</button>' +
      '</span>' +
      (v.note ? '<span class="tl-note" style="grid-column:2/-1">' + esc(v.note) + '</span>' : '') +
      '</div>';
  }).join('');

  const addBtn = '<button data-action="addValuation" class="btn btn-mini btn-primary" style="align-self:flex-start;margin-top:6px">＋ 记录当前价值</button>';
  return '<div class="expand-grid">' +
    '<div>' +
      '<div class="tl-head"><span>价值记录时间线（' + metrics.valuationCount + '）</span><span>最新记录：' + (metrics.latestDate || '无') + '</span></div>' +
      (rows || '<div class="chart-empty" style="text-align:left;padding:12px 0">暂无价值记录，添加后此处展示历史市值</div>') +
      addBtn +
    '</div>' +
    '<div>' +
      '<div class="tl-head"><span>市值走势</span><span>' + esc(asset.currency) + '</span></div>' +
      Charts.line(metrics.valuations.map(v => ({ date: v.date, value: v.value })), 360, 150) +
    '</div>' +
  '</div>';
}

function assetCardHTML(asset) {
  // 按记账模式分发：交易记录模式走交易卡片，其余走价值快照卡片
  if (asset.enableTrades) return tradeAssetCardHTML(asset);
  return valueAssetCardHTML(asset);
}

function valueAssetCardHTML(asset) {
  const m = Calc.assetMetrics(asset, state.valuations, state.settings);
  const cat = CATEGORIES[asset.category] || { label: asset.category || '其他' };
  const isExpanded = expanded.has(asset.id);
  const subTag = asset.subCategory && asset.subCategory !== '其他' ? asset.subCategory : '';
  const shortHold = m.days > 0 && m.days < 30;

  // 收益颜色（正红负绿）
  const profitCls = m.profit >= 0 ? 'money-red' : 'money-green';
  const rateCls = m.rate >= 0 ? 'money-red' : 'money-green';
  let annualStr = '--';
  let annualCls = '';
  if (m.simpleAnnual != null) {
    annualStr = fmtPct(m.simpleAnnual * 100);
    annualCls = m.simpleAnnual >= 0 ? 'money-red' : 'money-green';
  }
  const annualHint = !m.hasValuation ? '（无价值记录，按成本计）'
    : shortHold ? '持有过短，仅供参考' : '';

  const base = state.settings.baseCurrency;
  const baseHint = (asset.currency !== base && m.baseValue != null)
    ? '<div class="asset-meta" style="margin-top:2px">折合 ' + base + '：' + fmtMoney(m.baseValue, base) + '</div>'
    : '';

  // 新增信息：风险等级 / T+n / 可卖状态
  const riskTag = asset.riskLevel && RISK_LEVELS.some(r => r.key === asset.riskLevel)
    ? '<span class="tag risk" style="color:' + RISK_COLORS[asset.riskLevel] + ';background:' + RISK_COLORS[asset.riskLevel] + '1a">' + asset.riskLevel + '</span>'
    : '';
  const tplusTag = asset.tPlusN != null
    ? '<span class="tag alt">T+' + asset.tPlusN + '</span>'
    : '';
  const sell = Calc.sellStatus(asset, todayStr());
  const sellBadge = sell.minDays == null ? ''
    : sell.sellable
      ? '<span class="badge-sell sellable">可卖</span>'
      : '<span class="badge-sell locked">不可卖 · 还需 ' + sell.remainingDays + ' 天</span>';

  return '<div class="asset-card' + (isExpanded ? ' expanded' : '') + '" data-asset-id="' + asset.id + '">' +
    '<div class="asset-main">' +
      '<div>' +
        '<div class="asset-head">' +
          '<span class="asset-name">' + esc(asset.name) + '</span>' +
          '<span class="tag">' + esc(cat.label) + '</span>' +
          (subTag ? '<span class="tag alt">' + esc(subTag) + '</span>' : '') +
          riskTag + tplusTag +
          '<span class="tag alt">' + esc(asset.currency) + '</span>' +
        '</div>' +
        '<div class="asset-meta">' +
          sellBadge +
          '<span>开始持有：' + esc(asset.startDate) + '</span>' +
          (sell.minDays != null ? '<span>最低持有 ' + sell.minDays + ' 天 · 已持 ' + sell.heldDays + ' 天</span>' : '<span>持有 ' + m.days + ' 天</span>') +
          (asset.quantity ? '<span>数量：' + esc(String(asset.quantity)) + '</span>' : '') +
          (m.valuationCount ? '<span>价值记录 ' + m.valuationCount + ' 条</span>' : '') +
        '</div>' +
        '<div class="asset-figures">' +
          '<div class="fig"><div class="k">成本（' + asset.currency + '）</div><div class="v">' + fmtMoney(asset.principal, asset.currency) + '</div></div>' +
          '<div class="fig"><div class="k">最新市值</div><div class="v">' + fmtMoney(m.currentValue, asset.currency) + '</div></div>' +
          '<div class="fig"><div class="k">累计收益</div><div class="v ' + profitCls + '">' + fmtSignedMoney(m.profit, asset.currency) + '</div></div>' +
          '<div class="fig"><div class="k">收益率</div><div class="v ' + rateCls + '">' + fmtPct(m.rate * 100) + '</div></div>' +
          '<div class="fig"><div class="k">年化（单利）' + (annualHint ? ' · ' + annualHint : '') + '</div><div class="v annual ' + annualCls + '">' + annualStr + '</div></div>' +
        '</div>' +
        (baseHint) +
        (asset.note ? '<div class="asset-meta" style="margin-top:2px">备注：' + esc(asset.note) + '</div>' : '') +
      '</div>' +
      '<div class="asset-actions">' +
        '<button class="btn btn-mini btn-primary" data-action="addValuation">＋ 记价值</button>' +
        '<button class="btn btn-mini ghost" data-action="toggleExpand">' + (isExpanded ? '收起时间线' : '查看时间线') + '</button>' +
        '<button class="btn btn-mini ghost" data-action="editAsset">编辑</button>' +
        '<button class="btn btn-mini ghost" data-action="deleteAsset" style="color:var(--red)">删除</button>' +
      '</div>' +
    '</div>' +
    (isExpanded ? '<div class="asset-expand">' + timelineHTML(asset, m) + '</div>' : '') +
  '</div>';
}

/** 交易记录模式卡片 */
function tradeAssetCardHTML(asset) {
  const cat = CATEGORIES[asset.category] || { label: asset.category || '其他' };
  const isExpanded = expanded.has(asset.id);
  const subTag = asset.subCategory && asset.subCategory !== '其他' ? asset.subCategory : '';
  const m = Calc.tradePosition(asset, state.trades, asset.lastPrice != null ? Number(asset.lastPrice) : null);

  const floatCls = m.float == null ? '' : (m.float >= 0 ? 'money-red' : 'money-green');
  const realCls = m.realized >= 0 ? 'money-red' : 'money-green';
  const totalCls = m.totalProfit >= 0 ? 'money-red' : 'money-green';
  let annualStr = '--', annualCls = '';
  if (m.days > 0 && m.cost > 0 && m.float != null) {
    const annual = m.float / m.cost * 365 / m.days;
    annualStr = fmtPct(annual * 100);
    annualCls = annual >= 0 ? 'money-red' : 'money-green';
  }

  const riskTag = asset.riskLevel && RISK_LEVELS.some(r => r.key === asset.riskLevel)
    ? '<span class="tag risk" style="color:' + RISK_COLORS[asset.riskLevel] + ';background:' + RISK_COLORS[asset.riskLevel] + '1a">' + asset.riskLevel + '</span>'
    : '';
  const tplusTag = asset.tPlusN != null
    ? '<span class="tag alt">T+' + asset.tPlusN + '</span>'
    : '';
  const sell = Calc.sellStatus(asset, todayStr());
  const sellBadge = sell.minDays == null ? ''
    : sell.sellable
      ? '<span class="badge-sell sellable">可卖</span>'
      : '<span class="badge-sell locked">不可卖 · 还需 ' + sell.remainingDays + ' 天</span>';

  const base = state.settings.baseCurrency;
  const baseHint = (asset.currency !== base && m.marketValue != null)
    ? '<div class="asset-meta" style="margin-top:2px">折合 ' + base + '：' + fmtMoney(m.marketValue, base) + '</div>'
    : '';
  const quoteInfo = asset.symbol
    ? '<div class="asset-meta" style="margin-top:2px"><span>代码 ' + esc(asset.symbol) + '</span>' +
      (asset.lastPrice != null ? '<span>现价 ' + fmtQty(asset.lastPrice) + '</span>' : '') +
      (asset.lastQuoteAt ? '<span>行情 ' + new Date(asset.lastQuoteAt).toLocaleString('zh-CN') + '</span>' : '') + '</div>'
    : '';

  const expand = isExpanded
    ? '<div class="asset-expand"><div class="expand-grid">' +
        '<div>' + tradeTimelineHTML(asset, m) + '</div>' +
        '<div>' + quoteChartHTML(asset) + '</div>' +
      '</div></div>'
    : '';

  return '<div class="asset-card' + (isExpanded ? ' expanded' : '') + '" data-asset-id="' + asset.id + '">' +
    '<div class="asset-main">' +
      '<div>' +
        '<div class="asset-head">' +
          '<span class="asset-name">' + esc(asset.name) + '</span>' +
          '<span class="tag">' + esc(cat.label) + '</span>' +
          (subTag ? '<span class="tag alt">' + esc(subTag) + '</span>' : '') +
          riskTag + tplusTag +
          '<span class="tag alt">' + esc(asset.currency) + '</span>' +
        '</div>' +
        '<div class="asset-meta">' +
          sellBadge +
          '<span>开始持有：' + esc(asset.startDate) + '</span>' +
          '<span>持有 ' + m.days + ' 天</span>' +
          '<span>交易 ' + m.events.length + ' 笔</span>' +
        '</div>' +
        '<div class="asset-figures">' +
          '<div class="fig"><div class="k">持仓数量</div><div class="v">' + fmtQty(m.qty) + '</div></div>' +
          '<div class="fig"><div class="k">平均成本</div><div class="v">' + fmtQty(m.avgCost) + '</div></div>' +
          '<div class="fig"><div class="k">现价</div><div class="v">' + priceStr(asset) + '</div></div>' +
          '<div class="fig"><div class="k">当前市值</div><div class="v">' + (m.marketValue != null ? fmtMoney(m.marketValue, asset.currency) : '--') + '</div></div>' +
          '<div class="fig"><div class="k">浮动盈亏</div><div class="v ' + floatCls + '">' + (m.float != null ? fmtSignedMoney(m.float, asset.currency) : '--') + '</div></div>' +
          '<div class="fig"><div class="k">已实现盈亏</div><div class="v ' + realCls + '">' + fmtSignedMoney(m.realized, asset.currency) + '</div></div>' +
          '<div class="fig"><div class="k">总盈亏（浮动+已实现）</div><div class="v annual ' + totalCls + '">' + fmtSignedMoney(m.totalProfit, asset.currency) + '</div></div>' +
          '<div class="fig"><div class="k">年化（近似）' + (m.float == null ? ' · 需现价' : '') + '</div><div class="v ' + annualCls + '">' + annualStr + '</div></div>' +
        '</div>' +
        (baseHint) + quoteInfo +
        (asset.note ? '<div class="asset-meta" style="margin-top:2px">备注：' + esc(asset.note) + '</div>' : '') +
      '</div>' +
      '<div class="asset-actions">' +
        '<button class="btn btn-mini btn-primary" data-action="addBuy">＋ 买入</button>' +
        '<button class="btn btn-mini ghost" data-action="addSell">− 卖出</button>' +
        (asset.symbol ? '<button class="btn btn-mini ghost" data-action="refreshQuote">⟳ 刷新行情</button>' : '') +
        '<button class="btn btn-mini ghost" data-action="manualPrice">✎ 现价</button>' +
        '<button class="btn btn-mini ghost" data-action="toggleExpand">' + (isExpanded ? '收起记录' : '查看记录') + '</button>' +
        '<button class="btn btn-mini ghost" data-action="editAsset">编辑</button>' +
        '<button class="btn btn-mini ghost" data-action="deleteAsset" style="color:var(--red)">删除</button>' +
      '</div>' +
    '</div>' +
    expand +
  '</div>';
}

/** 现价显示（行情缺失时给出可手动录入的入口提示） */
function priceStr(asset) {
  if (asset.lastPrice != null) return fmtQty(asset.lastPrice);
  return '<span style="color:var(--ink-3);font-size:13px">—</span>';
}

/** 展开区：行情走势（有缓存 K 线画折线，否则提示） */
function quoteChartHTML(asset) {
  const k = state.settings.kline && state.settings.kline[asset.symbol];
  if (k && Array.isArray(k.days) && k.days.length >= 2) {
    const points = k.days.map(d => ({ date: String(d[0]), value: Number(d[2]) }));
    return '<div class="tl-head"><span>近期走势（收盘价）</span><span>' + esc(asset.symbol) + '</span></div>' +
      Charts.line(points, 360, 150) +
      '<div style="margin-top:8px"><button data-action="refreshQuote" class="btn btn-mini ghost">⟳ 刷新走势</button>' +
      (k.time ? '<span class="hint" style="margin-left:8px">更新于 ' + new Date(k.time).toLocaleDateString('zh-CN') + '</span>' : '') + '</div>';
  }
  return '<div class="tl-head"><span>近期走势</span></div>' +
    '<div class="chart-empty" style="padding:22px 0;line-height:1.9">暂无行情数据，点击「刷新行情」获取现价与近期走势。<br>行情不可用时仍可手动记录现价。' +
    (asset.lastPrice != null ? '<br>当前手动现价：' + fmtQty(asset.lastPrice) : '') + '</div>';
}

function renderList() {
  const list = filteredAssets();
  const emptyOverall = state.assets.length === 0;
  $id('asset-list').innerHTML = list.map(assetCardHTML).join('');
  $id('empty-state').classList.toggle('hidden', !emptyOverall);
  $id('asset-list').classList.toggle('hidden', emptyOverall);
  const filterEmpty = !emptyOverall && list.length === 0;
  if (filterEmpty) {
    $id('asset-list').innerHTML = '<div class="card" style="text-align:center;color:var(--ink-3);padding:40px">当前筛选条件下暂无产品</div>';
  }
}

function renderFilters() {
  const catSel = $id('filter-category');
  catSel.innerHTML = '<option value="all">全部类别</option>' +
    Object.keys(CATEGORIES).map(k => '<option value="' + k + '">' + CATEGORIES[k].label + '</option>').join('');
  catSel.value = filters.category;

  const allCurrencies = new Set([...Object.keys(CURRENCIES), ...state.assets.map(a => a.currency)]);
  const curSel = $id('filter-currency');
  curSel.innerHTML = '<option value="all">全部币种</option>' +
    Array.from(allCurrencies).sort().map(c => '<option value="' + c + '">' + c + ' ' + currencyName(c) + '</option>').join('');
  curSel.value = filters.currency;

  const sortSel = $id('filter-sort');
  sortSel.innerHTML = SORT_OPTIONS.map(o => '<option value="' + o[0] + '">' + o[1] + '</option>').join('');
  sortSel.value = filters.sort;
}

function renderAll() {
  renderFilters();
  renderSummary();
  renderCharts();
  renderList();
}

/* ---------------- 模态框 ---------------- */
let modalOnOk = null;

function openModal(title, bodyHTML, onOk, okText) {
  $id('modal-title').textContent = title;
  $id('modal-body').innerHTML = bodyHTML;
  $id('modal-ok').textContent = okText || '保存';
  $id('modal-ok').classList.remove('hidden'); // 恢复默认显示（导出面板会隐藏它）
  modalOnOk = onOk;
  $id('modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $id('modal-backdrop').classList.add('hidden');
  $id('modal-ok').classList.remove('hidden');
  modalOnOk = null;
}

function confirmAction(title, text, onConfirm, okText) {
  $id('confirm-title').textContent = title;
  $id('confirm-text').textContent = text;
  $id('confirm-ok').textContent = okText || '确认';
  $id('confirm-ok').onclick = () => {
    $id('confirm-backdrop').classList.add('hidden');
    onConfirm();
  };
  $id('confirm-backdrop').classList.remove('hidden');
}

function bindModalButtons() {
  $id('modal-close').onclick = closeModal;
  $id('modal-cancel').onclick = closeModal;
  $id('modal-ok').onclick = () => { if (modalOnOk) modalOnOk(); };
  $id('confirm-close').onclick = () => $id('confirm-backdrop').classList.add('hidden');
  $id('confirm-cancel').onclick = () => $id('confirm-backdrop').classList.add('hidden');
}

/* ---- 产品表单 ---- */
function categoryOptionsHTML(selected) {
  return Object.keys(CATEGORIES).map(k =>
    '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + CATEGORIES[k].label + '</option>').join('');
}
function subCategoryHTML(category, selected) {
  const subs = CATEGORIES[category] ? CATEGORIES[category].sub : ['其他'];
  return subs.map(s => '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + s + '</option>').join('');
}
function currencyOptionsHTML(selected) {
  const all = Object.assign({}, CURRENCIES, CUSTOM_CURRENCIES);
  return Object.keys(all).map(c =>
    '<option value="' + c + '"' + (c === selected ? ' selected' : '') + '>' + c + ' ' + all[c].name + '</option>').join('')
    + '<option value="__custom__">＋ 自定义币种…</option>';
}

function assetFormHTML(asset, preset) {
  const FIRST_CATEGORY = Object.keys(CATEGORIES)[0];
  const isNew = !asset;
  // 新建默认：股票入口 → 监察表（交易记录）；其他入口（基金/债券/…）→ 价值快照
  const defCategory = (preset && preset.category) || 'fund';
  const defMode = (preset && preset.mode) || 'valuation';
  const a = asset || { name: '', category: defCategory, subCategory: '', currency: 'CNY', principal: '', quantity: '', startDate: todayStr(), note: '', minHoldDays: '', riskLevel: '', tPlusN: '', enableTrades: defMode === 'trades', symbol: '' };
  const catKey = CATEGORIES[a.category] ? a.category : FIRST_CATEGORY;
  // 新建默认记账模式：股票入口固定交易记录（监察表），其余默认价值快照
  const mode = isNew
    ? (preset && preset.mode ? preset.mode : (catKey === 'stock' ? 'trades' : 'valuation'))
    : (a.enableTrades ? 'trades' : 'valuation');
  const isStock = catKey === 'stock';

  // 买入信息字段：
  //  - 交易记录模式（股票监察表）：无需在添加时填写，保存后从卡片「＋ 买入」录入（统一填单股价格）
  //  - 价值快照模式：填本金（总金额）+ 可选数量
  const buyFields = mode === 'trades'
    ? '<div class="field full"><div class="hint" style="color:var(--ink-2);line-height:1.7">加入监察列表后，点卡片上的「＋ 买入」录入首笔买入；<b>买入/卖出均填写单股价格</b>（成交单价 × 数量自动计金额）。也可随时在「✎ 现价」更新当前股价。</div></div>'
    : '<div class="field"><label>本金 / 买入成本（' + (a.currency || 'CNY') + '）*</label><input id="f-principal" type="number" min="0" step="0.01" placeholder="0.00" value="' + esc(a.principal) + '">' +
      '<div class="hint">一次性投入的总金额（非单股价格）</div></div>' +
      '<div class="field"><label>买入数量 / 份额（可选）</label><input id="f-quantity" type="number" min="0" step="any" placeholder="如股票股数、基金份额" value="' + esc(a.quantity) + '"></div>';

  const symLabel = isStock ? '股票代码 *' : '行情代码（可选）';
  const symPlaceholder = isStock
    ? 'A股 600519 / 000001，港股 00700，美股 KO / AAPL'
    : 'A股 600519 / 000001，港股 00700，美股 KO / AAPL（不填则手动记录）';

  return '<div class="form-grid">' +
    '<div class="field full"><label>产品名称 *</label><input id="f-name" type="text" placeholder="如：沪深300指数基金（输入代码后自动带出名称，可修改）" value="' + esc(a.name) + '"></div>' +
    '<div class="field"><label>大类 *</label><select id="f-category">' + categoryOptionsHTML(catKey) + '</select></div>' +
    '<div class="field"><label>小类（子类）</label><select id="f-subcategory">' + subCategoryHTML(catKey, a.subCategory) + '</select></div>' +
    '<div class="field full" style="grid-column:1/-1"><label>记账模式</label>' +
      '<select id="f-mode">' +
        '<option value="valuation"' + (mode === 'valuation' ? ' selected' : '') + '>价值快照：记录本金 + 定期市值</option>' +
        '<option value="trades"' + (mode === 'trades' ? ' selected' : '') + '>交易记录（监察表）：多次买入 / 部分卖出，买卖填单股价格</option>' +
      '</select><div class="hint" id="f-mode-hint">' + (isStock && mode === 'trades' ? '股票默认交易记录模式：先加入监察表，再逐笔点「＋ 买入 / − 卖出」。' : '切换模式不删除数据；旧的本金+数量会自动转为首笔买入记录。') + '</div></div>' +
    '<div class="field"><label>币种 *（按代码自动识别，可改）</label><select id="f-currency">' + currencyOptionsHTML(a.currency || (isStock ? 'CNY' : 'CNY')) + '</select>' +
      '<div class="hint" id="f-currency-custom-hint" style="display:none">自定义币种请输入 3 位大写代码（如 KRW）</div></div>' +
    '<div class="field"><label>开始持有日期</label><input id="f-start" type="date" value="' + esc(a.startDate) + '">' +
      '<div class="hint">监察表加入日期；实际持有从首笔买入起算</div></div>' +
    '<div class="field full"><label>' + symLabel + '</label><input id="f-symbol" type="text" placeholder="' + symPlaceholder + '" value="' + esc(a.symbol || '') + '">' +
      '<div class="hint">输入代码后自动识别市场、自动选择币种，并尝试自动带出名称（网络不可用时手动填写）</div></div>' +
    buyFields +
    '<div class="field"><label>最低持有天数（可选）</label><input id="f-minhold" type="number" min="0" step="1" placeholder="如 30" value="' + esc(a.minHoldDays) + '">' +
      '<div class="hint">达到该天数前显示「不可卖」</div></div>' +
    '<div class="field"><label>风险等级（可选）</label><select id="f-risk">' +
      '<option value="">未设置</option>' +
      RISK_LEVELS.map(r => '<option value="' + r.key + '"' + (r.key === a.riskLevel ? ' selected' : '') + '>' + r.label + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>T+n 到账（可选）</label><input id="f-tplusn" type="number" min="0" step="1" placeholder="如 1（T+1）" value="' + esc(a.tPlusN) + '">' +
      '<div class="hint">赎回/卖出后多少个交易日到账</div></div>' +
    '<div class="field full"><label>备注（可选）</label><input id="f-note" type="text" placeholder="如：定投第 3 期" value="' + esc(a.note) + '"></div>' +
  '</div>';
}

function openAssetForm(assetId, preset) {
  const asset = assetId ? getAsset(assetId) : null;
  openModal((asset ? '编辑产品 · ' + asset.name : '添加产品'), assetFormHTML(asset, preset), () => submitAsset(assetId));

  // 联动：大类变化刷新小类；币种切换显示自定义输入提示；记账模式切换更新提示
  const catSel = $id('f-category');
  const subSel = $id('f-subcategory');
  const curSel = $id('f-currency');
  const modeSel = $id('f-mode');
  catSel.onchange = () => { subSel.innerHTML = subCategoryHTML(catSel.value); };
  curSel.onchange = () => {
    $id('f-currency-custom-hint').style.display = curSel.value === '__custom__' ? 'block' : 'none';
  };
  modeSel.onchange = () => {
    $id('f-mode-hint').textContent = modeSel.value === 'trades'
      ? '交易记录模式：先加入监察表，再逐笔点「＋ 买入 / − 卖出」，买卖均填单股价格。'
      : '价值快照模式保持原有记账方式（本金 + 定期市值）；切换不删除任何数据。';
  };
  // 股票监察表：输入代码自动识别市场并联动币种与名称
  const symSel = $id('f-symbol');
  if (symSel) {
    symSel.onchange = () => autoFillFromCode(symSel, curSel, $id('f-name'));
    symSel.onblur = () => autoFillFromCode(symSel, curSel, $id('f-name'));
  }
}

/** 根据行情代码自动带出：币种（按市场）+ 名称（联网获取，失败静默） */
async function autoFillFromCode(input, curSel, nameEl) {
  const raw = input.value.trim();
  if (!raw) return;
  const norm = normalizeSymbol(raw);
  if (!norm.ok) return;
  // 自动切换币种（仅当当前选项存在时）
  const autoCur = symbolToCurrency(norm.code);
  if (curSel && curSel.querySelector('option[value="' + autoCur + '"]')) {
    curSel.value = autoCur;
    $id('f-currency-custom-hint').style.display = 'none';
  }
  // 联网带出名称（用户未手动填写时才覆盖）
  if (nameEl && !nameEl.value.trim()) {
    try {
      const info = await fetchStockInfo(norm.code);
      if (info.name) nameEl.value = info.name;
    } catch (e) { /* 网络不可用时保持手动填写 */ }
  }
}

function submitAsset(assetId) {
  const asset = assetId ? getAsset(assetId) : null;
  const name = $id('f-name').value.trim();
  const category = $id('f-category').value;
  const subCategory = $id('f-subcategory').value;
  let currency = $id('f-currency').value;
  if (currency === '__custom__') {
    currency = prompt('请输入自定义币种代码（3 位大写字母，如 KRW）');
  }
  const startDate = $id('f-start').value;
  const mode = $id('f-mode').value;
  const enableTrades = mode === 'trades';
  const isStock = category === 'stock';
  const symbolRaw = $id('f-symbol').value.trim();
  const symbol = symbolRaw === '' ? null : symbolRaw;
  // 股票监察表：代码必填（仅需选定股票即可加入）
  if (isStock && !symbol) {
    alert('股票只需填写代码即可加入监察表（如 A股 600519、港股 00700、美股 KO），买入信息之后再点「＋ 买入」录入。');
    return;
  }
  let principal = 0;
  let quantity = null;
  if (!enableTrades) {
    // 价值快照模式：本金 = 一次性投入总金额（必填为正）+ 可选数量
    const principalRaw = $id('f-principal').value.trim();
    principal = principalRaw === '' || !isFinite(parseFloat(principalRaw)) ? 0 : parseFloat(principalRaw);
    const quantityRaw = $id('f-quantity').value.trim();
    quantity = quantityRaw === '' ? null : parseFloat(quantityRaw);
  }
  const minHoldRaw = $id('f-minhold').value.trim();
  const minHoldDays = minHoldRaw === '' ? null : Math.floor(parseFloat(minHoldRaw));
  const riskLevel = $id('f-risk').value || null;
  const tPlusNRaw = $id('f-tplusn').value.trim();
  const tPlusN = tPlusNRaw === '' ? null : Math.floor(parseFloat(tPlusNRaw));
  const note = $id('f-note').value.trim();

  if (minHoldDays != null && (!isFinite(minHoldDays) || minHoldDays < 0)) {
    alert('最低持有天数必须是非负整数。'); return;
  }
  if (tPlusN != null && (!isFinite(tPlusN) || tPlusN < 0)) {
    alert('T+n 必须是非负整数。'); return;
  }
  // 交易记录模式：本金可省（用逐笔买入代替）；价值快照模式：本金必填且为正
  const needPrincipal = !enableTrades;
  const valid = name
    && currency && /^[A-Z]{3}$/.test(currency)
    && (!needPrincipal || (isFinite(principal) && principal > 0))
    && startDate && parseDate(startDate);
  if (!valid) { alert('请检查：名称必填、币种为 3 位大写代码、本金必须为正数、日期格式正确。'); return; }
  if (!CURRENCIES[currency] && !CUSTOM_CURRENCIES[currency]) {
    CUSTOM_CURRENCIES[currency] = { symbol: currency + ' ', name: currency };
  }

  if (asset) {
    asset.name = name; asset.category = category; asset.subCategory = subCategory;
    asset.currency = currency; asset.principal = round2(principal);
    asset.quantity = quantity; asset.note = note; asset.startDate = startDate;
    asset.minHoldDays = minHoldDays; asset.riskLevel = riskLevel; asset.tPlusN = tPlusN;
    asset.enableTrades = enableTrades; asset.symbol = symbol;
    asset.updatedAt = Date.now();
  } else {
    state.assets.push({
      id: uid('asset_'), name, category, subCategory, currency,
      principal: round2(principal), quantity, note, startDate,
      minHoldDays, riskLevel, tPlusN,
      enableTrades, symbol,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  }
  // 交易模式下，用旧的/刚填的本金+数量自动生成首笔买入（无数量或已有交易时自动跳过）
  const target = asset ? asset : state.assets[state.assets.length - 1];
  if (enableTrades) migrateToTrades(target);
  saveState(); renderAll(); closeModal();
}

/* ---- 价值记录表单 ---- */
function valuationFormHTML(asset, val) {
  const v = val || { date: todayStr(), value: '', note: '' };
  return '<div class="form-grid">' +
    '<div class="field"><label>记录日期 *</label><input id="v-date" type="date" value="' + esc(v.date) + '"></div>' +
    '<div class="field"><label>当时市值（' + esc(asset.currency) + '）*</label><input id="v-value" type="number" min="0" step="0.01" placeholder="0.00" value="' + esc(v.value) + '"></div>' +
    '<div class="field full"><label>备注（可选）</label><input id="v-note" type="text" placeholder="如：分红到账 / 定投加仓" value="' + esc(v.note) + '"></div>' +
    '<div class="field full"><div class="hint">记录「当时」看到的账户市值即可，多记几条可形成持有时间线与走势图。</div></div>' +
  '</div>';
}

function openValuationForm(assetId, valId) {
  const asset = getAsset(assetId);
  const val = valId ? state.valuations.find(x => x.id === valId) : null;
  openModal(val ? '编辑价值记录 · ' + asset.name : '记录价值 · ' + asset.name,
    valuationFormHTML(asset, val), () => submitValuation(assetId, valId));
}

function submitValuation(assetId, valId) {
  const date = $id('v-date').value;
  const value = parseFloat($id('v-value').value);
  const note = $id('v-note').value.trim();
  if (!date || parseDate(date) == null || !isFinite(value) || value <= 0) {
    alert('请检查：日期格式正确，市值必须为正数。'); return;
  }
  if (valId) {
    const v = state.valuations.find(x => x.id === valId);
    if (v) { v.date = date; v.value = round2(value); v.note = note; }
  } else {
    state.valuations.push({
      id: uid('valuation_'), assetId, date, value: round2(value), note,
      createdAt: Date.now(),
    });
  }
  saveState(); renderAll(); closeModal();
}

/* ---- 汇率联网查询（免费公开接口，无凭证） ---- */
const RATE_SOURCES = [
  { key: 'erapi', url: base => 'https://open.er-api.com/v6/latest/' + base, name: 'Open Exchange Rates' },
  { key: 'frank', url: base => 'https://api.frankfurter.app/latest?base=' + base, name: 'Frankfurter（欧央行）' },
];

/**
 * 获取以 baseCurrency 为基准的最新汇率。
 * 返回 { rates: { 币种: 1币种兑基准币种数量 }, source, updatedAt }；全部接口失败则抛出异常。
 * fetcher 可注入，便于测试。
 */
async function fetchLatestRates(baseCurrency, fetcher) {
  const f = fetcher || window.fetch;
  if (typeof f !== 'function') throw new Error('当前环境不支持联网');
  let lastErr = null;
  for (const src of RATE_SOURCES) {
    try {
      const resp = await f(src.url(baseCurrency));
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const rates = data && data.rates;
      if (!rates || typeof rates !== 'object') throw new Error('响应格式异常');
      // 公开接口给出的是「1 基准币种 = X 币种」，换算为「1 币种 = X 基准币种」
      const out = {};
      Object.keys(rates).forEach(c => {
        const r = Number(rates[c]);
        if (c !== baseCurrency && isFinite(r) && r > 0) out[c] = round2(1 / r);
      });
      if (!Object.keys(out).length) throw new Error('无有效汇率数据');
      return { rates: out, source: src.name, updatedAt: Date.now() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('获取失败');
}

/**
 * 应用最新汇率：写入 settings.rates 并刷新界面。
 * silent = true 时不弹窗（用于启动时静默自动获取）。
 */
async function applyLatestRates(opts) {
  const silent = opts && opts.silent;
  try {
    const result = await fetchLatestRates(state.settings.baseCurrency);
    state.settings.rates = result.rates;
    state.settings.ratesUpdatedAt = result.updatedAt;
    state.settings.ratesSource = result.source;
    saveState(); renderAll();
    if (!silent) {
      alert('汇率已更新（' + result.source + ' · ' + new Date(result.updatedAt).toLocaleString() + '），统计已按最新汇率刷新。');
    }
    return true;
  } catch (e) {
    if (!silent) {
      alert('汇率获取失败：' + (e && e.message ? e.message : '网络错误') + '。可稍后重试，或在面板中手动填写汇率。');
    }
    return false;
  }
}

/* ---- 交易记录表单（交易记录模式） ---- */
/** 数量/单价显示：去掉冗余尾零，保留至多 4 位小数 */
function fmtQty(n) {
  const num = Number(n);
  if (!isFinite(num)) return '--';
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function tradeFormHTML(asset, type, trade) {
  const t = trade || { date: todayStr(), quantity: '', price: '', fee: '', note: '' };
  const isBuy = type === 'buy';
  const pos = Calc.tradePosition(asset, state.trades, null);
  return '<div class="form-grid">' +
    '<div class="field"><label>日期 *</label><input id="t-date" type="date" value="' + esc(t.date) + '"></div>' +
    '<div class="field"><label>数量（股/份）*</label><input id="t-qty" type="number" min="0" step="any" placeholder="如 100" value="' + esc(t.quantity) + '"></div>' +
    '<div class="field"><label>成交单价（' + esc(asset.currency) + '）*</label><input id="t-price" type="number" min="0" step="any" placeholder="如 12.50" value="' + esc(t.price) + '"></div>' +
    '<div class="field"><label>手续费（可选）</label><input id="t-fee" type="number" min="0" step="0.01" placeholder="0.00" value="' + esc(t.fee) + '"></div>' +
    '<div class="field full"><label>备注（可选）</label><input id="t-note" type="text" placeholder="如：分批建仓 / 部分止盈" value="' + esc(t.note) + '"></div>' +
    (isBuy ? '' : '<div class="field full"><div class="hint">当前持仓 <b>' + fmtQty(pos.qty) + '</b>，卖出数量不能超过持仓。</div></div>') +
  '</div>';
}

function openTradeForm(assetId, type, tradeId) {
  const asset = getAsset(assetId);
  const trade = tradeId ? state.trades.find(x => x.id === tradeId) : null;
  const title = trade ? '编辑交易 · ' + asset.name : (type === 'buy' ? '买入 · ' : '卖出 · ') + asset.name;
  openModal(title, tradeFormHTML(asset, trade ? trade.type : type, trade),
    () => submitTrade(assetId, tradeId, trade ? trade.type : type));
}

function submitTrade(assetId, tradeId, type) {
  const asset = getAsset(assetId);
  const date = $id('t-date').value;
  const qty = parseFloat($id('t-qty').value);
  const price = parseFloat($id('t-price').value);
  const feeRaw = $id('t-fee').value.trim();
  const fee = feeRaw === '' || !isFinite(parseFloat(feeRaw)) ? 0 : parseFloat(feeRaw);
  const note = $id('t-note').value.trim();
  if (!date || parseDate(date) == null || !isFinite(qty) || qty <= 0 || !isFinite(price) || price <= 0 || fee < 0) {
    alert('请检查：日期格式正确、数量与单价必须为正数、手续费不能为负。'); return;
  }
  if (type === 'sell') {
    // 卖出校验：排除待编辑交易本身后计算当前持仓
    const others = tradeId ? state.trades.filter(x => x.id !== tradeId) : state.trades;
    const pos = Calc.tradePosition(asset, others, null);
    if (qty > pos.qty) {
      alert('卖出数量（' + fmtQty(qty) + '）超过当前持仓（' + fmtQty(pos.qty) + '）。'); return;
    }
  }
  if (tradeId) {
    const t = state.trades.find(x => x.id === tradeId);
    if (t) {
      t.date = date; t.quantity = roundQty(qty); t.price = roundPrice(price);
      t.fee = round2(fee); t.note = note;
    }
  } else {
    state.trades.push({
      id: uid('trade_'), assetId, type, date,
      quantity: roundQty(qty), price: roundPrice(price), fee: round2(fee), note,
      createdAt: Date.now(),
    });
  }
  saveState(); renderAll(); closeModal();
}

/** 交易时间线（展开区） */
function tradeTimelineHTML(asset, pos) {
  const rows = pos.events.map(e => {
    const t = e.trade;
    const isBuy = t.type === 'buy';
    const amount = t.quantity * t.price;
    const realizedTxt = isBuy
      ? '<span class="tl-delta" style="color:var(--ink-3)">买入</span>'
      : '<span class="tl-delta ' + (e.realized >= 0 ? 'money-red' : 'money-green') + '">已实现 ' + fmtSignedMoney(e.realized, asset.currency) + '</span>';
    return '<div class="tl-item" style="grid-template-columns:88px 1fr auto auto">' +
      '<span class="tl-date">' + esc(t.date) + '</span>' +
      '<span class="tl-value">' + (isBuy ? '🟢 买入 ' : '🔴 卖出 ') + fmtQty(t.quantity) + ' × ' + fmtQty(t.price) + '</span>' +
      '<span class="tl-delta" style="font-feature-settings:tnum">' + fmtMoney(amount, asset.currency) + (t.fee ? '（费 ' + fmtMoney(t.fee, asset.currency) + '）' : '') + '</span>' +
      '<span class="tl-ops">' +
        '<button data-action="editTrade" data-id="' + t.id + '" title="编辑">✎</button>' +
        '<button data-action="deleteTrade" data-id="' + t.id + '" class="del" title="删除">🗑</button>' +
      '</span>' +
      (t.note ? '<span class="tl-note" style="grid-column:2/-1">' + esc(t.note) + '</span>' : '') +
    '</div>';
  }).join('');
  const addBtns = '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">' +
    '<button data-action="addBuy" class="btn btn-mini btn-primary">＋ 买入</button>' +
    '<button data-action="addSell" class="btn btn-mini ghost">− 卖出</button>' +
  '</div>';
  return '<div class="tl-head" style="margin-bottom:2px"><span>交易记录（' + pos.events.length + '）</span>' +
    '<span>持仓 ' + fmtQty(pos.qty) + ' · 均价 ' + fmtQty(pos.avgCost) + '</span></div>' +
    (rows || '<div class="chart-empty" style="text-align:left;padding:12px 0">暂无交易记录，用「＋ 买入」开始记录</div>') +
    addBtns;
}

/* ---- 行情模块（腾讯公开行情接口：A股/港股/美股，无 key） ---- */
const MARKET_PREFIXES = { sh: 'A股·沪', sz: 'A股·深', bj: '北交所', hk: '港股', us: '美股' };
const QUOTE_MIN_INTERVAL = 10 * 60 * 1000; // 自动刷新最小间隔：10 分钟

/** 行情代码标准化：
 *  - 标准前缀：sh600519 / sz000001 / hk00700 / usAAPL（前缀+主体原样）
 *  - 纯 6 位数字：A股（6→sh，0/3→sz，4/8→bj）
 *  - 纯 4-5 位数字：港股（如 00700 → hk00700）
 *  - 纯 2-5 位字母：美股（如 KO → usKO，AAPL → usAAPL）
 */
function normalizeSymbol(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, code: null, error: '请填写行情代码' };
  const lower = raw.toLowerCase();
  const prefixed = /^([a-z]{2})([0-9a-z.]+)$/.exec(lower);
  if (prefixed && MARKET_PREFIXES[prefixed[1]]) {
    // 前缀统一小写，主体保留用户输入原样（美股代码如 usAAPL）
    return { ok: true, code: prefixed[1] + raw.slice(2), market: MARKET_PREFIXES[prefixed[1]] };
  }
  if (/^\d{6}$/.test(raw)) {
    if (raw.startsWith('6')) return { ok: true, code: 'sh' + raw, market: MARKET_PREFIXES.sh };
    if (raw.startsWith('0') || raw.startsWith('3')) return { ok: true, code: 'sz' + raw, market: MARKET_PREFIXES.sz };
    if (raw.startsWith('4') || raw.startsWith('8')) return { ok: true, code: 'bj' + raw, market: MARKET_PREFIXES.bj };
    return { ok: false, code: null, error: '无法识别的 A股 代码：以 6 开头为沪、0/3 开头为深、4/8 开头为北交所' };
  }
  if (/^\d{4,5}$/.test(raw)) {
    return { ok: true, code: 'hk' + raw, market: MARKET_PREFIXES.hk }; // 港股（如 00700 汇丰）
  }
  if (/^[a-zA-Z]{2,5}$/.test(raw)) {
    return { ok: true, code: 'us' + raw.toUpperCase(), market: MARKET_PREFIXES.us }; // 美股（KO / AAPL 等）
  }
  return { ok: false, code: null, error: '无法识别的代码：请用 600519 / 000001 / 00700 / KO / AAPL 等格式，或带前缀 sh/sz/hk/us' };
}

/** 按行情代码自动推断币种（按市场）：sh/sz/bj → CNY，hk → HKD，us → USD */
function symbolToCurrency(code) {
  const lower = String(code || '').toLowerCase();
  if (lower.startsWith('hk')) return 'HKD';
  if (lower.startsWith('us')) return 'USD';
  return 'CNY';
}

/** 获取单只股票的证券信息（名称 + 现价），复用腾讯行情文本接口 */
async function fetchStockInfo(code, fetcher) {
  const f = fetcher || window.fetch;
  if (typeof f !== 'function') throw new Error('当前环境不支持联网');
  const resp = await f('https://qt.gtimg.cn/q=' + code);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const text = await resp.text();
  const m = new RegExp('v_' + code + '="([^"]*)"').exec(text);
  if (!m) throw new Error('查无此代码：' + code);
  const fields = m[1].split('~'); // [1]=证券简称, [3]=最新价
  const name = fields[1] || '';
  const price = parseFloat(fields[3]);
  return { name, price: isFinite(price) && price > 0 ? roundQty(price) : null };
}

/** 获取最新价：腾讯行情接口，返回 { code: price }；fetcher 可注入便于测试 */
async function fetchQuote(symbols, fetcher) {
  const f = fetcher || window.fetch;
  if (typeof f !== 'function') throw new Error('当前环境不支持联网');
  const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
  const resp = await f(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const text = await resp.text();
  const out = {};
  symbols.forEach(sym => {
    const m = new RegExp('v_' + sym + '="([^"]*)"').exec(text);
    if (m) {
      const fields = m[1].split('~'); // 字段[3] = 最新价
      const price = parseFloat(fields[3]);
      if (isFinite(price) && price > 0) out[sym] = roundQty(price);
    }
  });
  if (!Object.keys(out).length) throw new Error('行情返回为空（代码可能无效）');
  return out;
}

/** 获取日K（前复权）：腾讯K线接口，返回 [date, open, close, high, low] 数组 */
async function fetchKline(symbol, days, fetcher) {
  const f = fetcher || window.fetch;
  if (typeof f !== 'function') throw new Error('当前环境不支持联网');
  const n = days || 60;
  const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,' + n + ',qfq';
  const resp = await f(url);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  const node = data && data.data && (data.data[symbol] || data.data[symbol.toUpperCase()]);
  const arr = node && (node.qfqday || node.day);
  if (!Array.isArray(arr) || arr.length < 2) throw new Error('K线数据不足');
  // 过滤非法行，仅保留 [date, open, close, high, low]
  return arr
    .filter(r => Array.isArray(r) && r.length >= 3 && isFinite(Number(r[2])))
    .map(r => [String(r[0]), Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])]);
}

/** 刷新单个产品的行情（现价 + 日K缓存）；silent 时不弹窗 */
async function refreshQuoteForAsset(asset, opts) {
  const silent = opts && opts.silent;
  if (!asset || !asset.symbol) return false;
  const norm = normalizeSymbol(asset.symbol);
  if (!norm.ok) { if (!silent) { alert(norm.error); renderAll(); } return false; }
  try {
    const prices = await fetchQuote([norm.code]);
    const price = prices[norm.code];
    if (price == null) throw new Error('无有效现价');
    asset.lastPrice = price;
    asset.priceSource = 'auto';
    asset.lastQuoteAt = Date.now();
    // 顺带更新日K缓存（失败不影响现价）
    try {
      const klineDays = await fetchKline(norm.code, 60);
      state.settings.kline = state.settings.kline || {};
      state.settings.kline[asset.symbol] = { days: klineDays, time: Date.now() };
    } catch (e) { /* 走势获取失败不阻塞现价 */ }
    saveState(); renderAll();
    if (!silent) {
      alert('已更新「' + asset.name + '」现价 ' + fmtQty(price) + '（' + norm.market + '，' +
        new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）');
    }
    return true;
  } catch (e) {
    if (!silent) {
      alert('行情获取失败：' + (e && e.message ? e.message : '网络错误') + '。可稍后重试，或用「✎ 现价」手动记录。');
    }
    return false;
  }
}

/** 刷新全部已填代码产品的行情（受频率约束；force 强制刷新） */
async function refreshAllQuotes(opts) {
  const silent = opts && opts.silent;
  const force = opts && opts.force;
  const now = Date.now();
  const targets = state.assets.filter(a => a.symbol);
  for (const a of targets) {
    if (!force && a.lastQuoteAt && (now - a.lastQuoteAt) < QUOTE_MIN_INTERVAL) continue;
    await refreshQuoteForAsset(a, { silent: true });
  }
}

/** 手动录入现价（行情不可用时的回退） */
function manualPriceline(asset) {
  if (!asset) return;
  const raw = prompt('手动记录「' + asset.name + '」当前现价（' + asset.currency + '）：\n（行情缺失时可用此方式）',
    asset.lastPrice != null ? String(asset.lastPrice) : '');
  if (raw == null) return; // 取消
  const v = parseFloat(raw);
  if (!isFinite(v) || v <= 0) { alert('现价必须为正数。'); return; }
  asset.lastPrice = roundQty(v);
  asset.priceSource = 'manual';
  asset.lastQuoteAt = Date.now();
  saveState(); renderAll();
}

/* ---- 汇率设置面板 ---- */
function settingsHTML(settings) {
  const rows = Object.keys(CURRENCIES).map(c => {
    if (c === settings.baseCurrency) return '';
    const rate = settings.rates[c] || '';
    return '<div class="rate-row" data-cur="' + c + '">' +
      '<div><b>' + c + '</b> <span class="money">' + currencyName(c) + '</span></div>' +
      '<input type="number" min="0" step="any" class="rate-input" data-cur="' + c + '" value="' + esc(rate) + '" placeholder="如 7.25">' +
      '<span class="money">= 1 ' + c + ' 兑 ' + settings.baseCurrency + '</span>' +
    '</div>';
  }).join('');
  const lastUpdate = settings.ratesUpdatedAt
    ? '上次联网更新：' + new Date(settings.ratesUpdatedAt).toLocaleString() + '（' + esc(settings.ratesSource || '') + '）'
    : '尚未联网更新过汇率（可点击下方按钮获取）';
  return '<div class="settings-tip">汇率用于把各币种资产换算为<b>基准币种</b>做总价值统计。可点击下方按钮<b>联网获取最新汇率</b>（免费公开接口，仅供统计参考，不做行情依据）；也可手动维护。未设置汇率的币种会<b>不计入总额统计</b>，并在界面标注提醒。</div>' +
    '<div class="field" style="margin-bottom:10px"><label>基准（统计）币种</label>' +
    '<select id="s-base">' + Object.keys(CURRENCIES).map(c =>
      '<option value="' + c + '"' + (c === settings.baseCurrency ? ' selected' : '') + '>' + c + ' ' + currencyName(c) + '</option>').join('') +
    '</select><div class="hint">切换基准币种时，现有汇率会自动按比例折算，保持各币种相对价值不变。</div></div>' +
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">' +
      '<button type="button" id="s-fetch" class="btn btn-primary btn-mini">⟳ 获取最新汇率</button>' +
      '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center">' +
        '<input type="checkbox" id="s-autofetch"' + (settings.autoFetchRates !== false ? ' checked' : '') + '> 每次启动自动获取一次' +
      '</label>' +
    '</div>' +
    '<div class="hint" id="s-updated" style="font-size:12px;color:var(--ink-3);margin-bottom:10px">' + lastUpdate + '</div>' +
    '<div class="field" style="margin-bottom:4px"><label>各币种汇率（1 币种 = X 基准币种）</label></div>' + rows +
    '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">' +
      '<div class="field" style="margin-bottom:8px"><label>行情设置（填写了行情代码的产品）</label></div>' +
      '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
        '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center">' +
          '<input type="checkbox" id="s-autoquote"' + (settings.autoQuote !== false ? ' checked' : '') + '> 打开页面自动刷新行情（每产品 10 分钟一次）' +
        '</label>' +
        '<button type="button" id="s-refresh-all" class="btn btn-ghost btn-mini">⟳ 立即刷新全部行情</button>' +
      '</div>' +
      '<div class="hint" style="margin-top:8px">行情来自腾讯公开免费接口，仅供记录与计算参考；接口不可用时用卡片上的「✎ 现价」手动录入。</div>' +
    '</div>';
}

function openSettings() {
  openModal('汇率设置', settingsHTML(state.settings), null, null);
  $id('modal-ok').textContent = '保存汇率';

  // 获取最新汇率按钮：成功后仅刷新面板中的汇率输入值
  const fetchBtn = $id('s-fetch');
  fetchBtn.onclick = async () => {
    const oldText = fetchBtn.textContent;
    fetchBtn.textContent = '获取中…';
    fetchBtn.disabled = true;
    const ok = await applyLatestRates({ silent: true });
    if (ok) {
      document.querySelectorAll('.rate-input').forEach(inp => {
        const r = state.settings.rates[inp.dataset.cur];
        if (r != null) inp.value = r;
      });
      $id('s-updated').textContent = '已更新：' + new Date(state.settings.ratesUpdatedAt).toLocaleString() + '（' + (state.settings.ratesSource || '') + '）';
    } else {
      $id('s-updated').textContent = '获取失败，请检查网络后重试，或手动填写汇率。';
    }
    fetchBtn.textContent = oldText;
    fetchBtn.disabled = false;
  };

  // 自动获取开关
  const autoFetch = $id('s-autofetch');
  autoFetch.onchange = () => {
    state.settings.autoFetchRates = autoFetch.checked;
    saveState();
  };

  // 行情开关与批量刷新
  const autoQuote = $id('s-autoquote');
  autoQuote.onchange = () => {
    state.settings.autoQuote = autoQuote.checked;
    saveState();
  };
  $id('s-refresh-all').onclick = async () => {
    const btn = $id('s-refresh-all');
    const old = btn.textContent;
    btn.textContent = '刷新中…';
    btn.disabled = true;
    await refreshAllQuotes({ silent: true, force: true });
    btn.textContent = old;
    btn.disabled = false;
    alert('行情刷新完成；失败的产品保留原值，可稍后单个重试或手动录价。');
  };

  modalOnOk = () => {
    const base = $id('s-base').value;
    const oldBase = state.settings.baseCurrency;
    const oldRates = Object.assign({}, state.settings.rates);

    // 收集面板输入（面板只显示非基准币种，其余币种沿用旧汇率）
    const collected = {};
    document.querySelectorAll('.rate-input').forEach(inp => {
      const v = parseFloat(inp.value);
      if (isFinite(v) && v > 0) collected[inp.dataset.cur] = v;
      else if (inp.value.trim() !== '') { alert('汇率必须为正数：' + inp.dataset.cur); collected[inp.dataset.cur] = NaN; }
    });
    if (Object.values(collected).some(v => isNaN(v))) return;
    const merged = Object.assign({}, oldRates, collected);

    if (base !== oldBase) {
      // 切换基准币种：1 新基准币种 = newBaseRate 旧基准币种，其余汇率按比例折算
      const newBaseRate = merged[base];
      if (!(newBaseRate > 0)) {
        alert('切换基准币种前，请先为「' + base + '」填写对旧基准「' + oldBase + '」的汇率（本币 1 兑 ' + oldBase + ' 的数量）。');
        return;
      }
      const finalRates = {};
      Object.keys(merged).forEach(c => {
        if (c === base) return;
        finalRates[c] = merged[c] / newBaseRate;
      });
      finalRates[oldBase] = 1 / newBaseRate;
      state.settings.baseCurrency = base;
      state.settings.rates = finalRates;
    } else {
      const finalRates = {};
      Object.keys(merged).forEach(c => { if (c !== base) finalRates[c] = merged[c]; });
      state.settings.baseCurrency = base;
      state.settings.rates = finalRates;
    }
    saveState(); renderAll(); closeModal();
  };
}

/* ---------------- 导出 / 导入（手机友好：剪贴板 + 粘贴） ---------------- */
/** 生成完整备份 JSON 字符串 */
function buildExportPayload() {
  return JSON.stringify({ app: 'EcoCal', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

/** 触发浏览器下载 .json 文件 */
function downloadJSON(payload) {
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ecocal-backup-' + todayStr() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 复制文本到剪贴板；Clipboard API 不可用时降级为隐藏 textarea + execCommand */
function copyText(text, statusEl) {
  const ok = () => { if (statusEl) statusEl.textContent = '✓ 已复制到剪贴板，可粘贴到文件/云盘保存。'; };
  const fail = () => { if (statusEl) statusEl.textContent = '自动复制失败，请长按下方内容手动选择复制。'; };
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(ok).catch(() => fallbackCopy(text, ok, fail));
  } else {
    fallbackCopy(text, ok, fail);
  }
}
function fallbackCopy(text, ok, fail) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand && document.execCommand('copy');
    ta.remove();
    copied ? ok() : fail();
  } catch (e) {
    fail();
  }
}

/** 导出面板：下载 + 复制两种方式（手机友好） */
function openExportModal() {
  if (!state.assets.length) { alert('暂无数据可导出。'); return; }
  const payload = buildExportPayload();
  const html = '<div class="hint" style="margin-bottom:10px">两种保存方式任选：<b>下载</b>会存到「下载」文件夹；<b>复制</b>可粘贴到备忘录/云盘（推荐手机使用）。</div>' +
    '<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<button type="button" id="exp-download" class="btn btn-primary">⬇ 下载 .json 文件</button>' +
      '<button type="button" id="exp-copy" class="btn btn-ghost">📋 复制备份内容</button>' +
    '</div>' +
    '<div class="hint" id="exp-status" style="margin-bottom:6px"></div>' +
    '<textarea id="exp-text" readonly rows="10" spellcheck="false" ' +
      'style="width:100%;font-size:11px;font-family:ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:10px;padding:10px;box-sizing:border-box;background:#fafafa;color:var(--ink-2)">' + esc(payload) + '</textarea>';
  openModal('导出备份', html, null, null);
  $id('modal-ok').classList.add('hidden'); // 导出面板用面板内按钮，不需要底部保存
  $id('exp-download').onclick = () => downloadJSON(payload);
  $id('exp-copy').onclick = () => copyText(payload, $id('exp-status'));
}

/** 解析校验备份文本并弹出覆盖确认；通过后写入 state 与 localStorage */
function importPayloadText(text) {
  let data;
  try {
    data = JSON.parse(text);
    if (!data || !Array.isArray(data.assets) || !Array.isArray(data.valuations)) {
      throw new Error('结构不正确（缺少 assets/valuations）');
    }
  } catch (e) {
    alert('导入失败：不是有效的 EcoCal 备份内容（' + e.message + '）');
    return;
  }
  confirmAction('导入备份数据', '导入将覆盖当前全部数据（产品、价值记录、汇率设置），确定继续吗？', () => {
    applyPayload(data);
    renderAll();
    alert('导入成功。');
  });
}

/** 应用备份数据到 state 并持久化 */
function applyPayload(data) {
  state.assets = data.assets;
  state.valuations = data.valuations;
  state.trades = Array.isArray(data.trades) ? data.trades : [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  state.settings.rates = data.settings && data.settings.rates ? data.settings.rates : {};
  closeModal(); // 关闭导入模态框（确认框已由 confirmAction 关闭）
  saveState();
}

/** 导入面板：选择文件 或 粘贴 JSON（手机友好） */
function openImportModal() {
  const html = '<div class="hint" style="margin-bottom:12px">两种方式二选一，导入将<b>覆盖当前全部数据</b>：</div>' +
    '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
      '<button type="button" id="imp-file" class="btn btn-ghost">📁 选择 .json 文件</button>' +
      '<button type="button" id="imp-paste" class="btn btn-primary">📋 导入下方粘贴内容</button>' +
    '</div>' +
    '<div class="hint" style="margin-bottom:6px">或直接粘贴备份 JSON 文本（手机浏览器更快）：</div>' +
    '<textarea id="imp-text" rows="8" spellcheck="false" placeholder="粘贴 ecocal-backup-xxx.json 的完整内容" ' +
      'style="width:100%;font-size:11px;font-family:ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:10px;padding:10px;box-sizing:border-box;outline:none;resize:vertical"></textarea>' +
    '</div>';
  openModal('导入备份', html, () => {
    const text = $id('imp-text').value.trim();
    if (!text) { alert('请先粘贴备份内容，或使用「选择 .json 文件」。'); return; }
    importPayloadText(text);
  }, '导入');
  $id('imp-file').onclick = () => $id('import-input').click();
} 

function clearAll() {
  confirmAction('清空数据', '将删除所有产品、价值记录与汇率设置，此操作不可撤销。确定清空吗？', () => {
    state.assets = [];
    state.valuations = [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveState(); renderAll();
  }, '清空');
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  bindModalButtons();

  $id('btn-add-asset').onclick = () => openAssetForm(null, { category: 'fund', mode: 'valuation' });
  $id('btn-add-stock').onclick = () => openAssetForm(null, { category: 'stock', mode: 'trades' });
  $id('empty-add-other').onclick = () => openAssetForm(null, { category: 'fund', mode: 'valuation' });
  $id('empty-add-stock').onclick = () => openAssetForm(null, { category: 'stock', mode: 'trades' });

  // 列表事件委托
  $id('asset-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const card = btn.closest('.asset-card');
    const assetId = card ? card.dataset.assetId : null;
    const action = btn.dataset.action;
    const asset = assetId ? getAsset(assetId) : null;
    if (!asset) return;

    switch (action) {
      case 'addValuation':
        openValuationForm(asset.id, null);
        break;
      case 'addBuy':
        openTradeForm(asset.id, 'buy', null);
        break;
      case 'addSell':
        openTradeForm(asset.id, 'sell', null);
        break;
      case 'editTrade': {
        const t = state.trades.find(x => x.id === btn.dataset.id);
        if (t) openTradeForm(asset.id, null, t.id);
        break;
      }
      case 'deleteTrade': {
        const t = state.trades.find(x => x.id === btn.dataset.id);
        if (!t) return;
        confirmAction('删除交易记录', '将删除「' + (t.type === 'buy' ? '买入' : '卖出') + ' · ' + t.date +
          ' · ' + fmtQty(t.quantity) + ' @ ' + fmtQty(t.price) + '」，删除后持仓与盈亏将自动重算。确定吗？', () => {
          state.trades = state.trades.filter(x => x.id !== t.id);
          saveState(); renderAll();
        }, '删除');
        break;
      }
      case 'refreshQuote':
        refreshQuoteForAsset(asset, { silent: false });
        break;
      case 'manualPrice':
        manualPriceline(asset);
        break;
      case 'editAsset':
        openAssetForm(asset.id);
        break;
      case 'toggleExpand': {
        if (expanded.has(asset.id)) expanded.delete(asset.id);
        else expanded.add(asset.id);
        renderList();
        break;
      }
      case 'deleteAsset':
        confirmAction('删除产品', '将删除「' + asset.name + '」及其下 ' +
          state.valuations.filter(v => v.assetId === asset.id).length + ' 条价值记录，且不可恢复。确定删除吗？', () => {
          state.assets = state.assets.filter(a => a.id !== asset.id);
          state.valuations = state.valuations.filter(v => v.assetId !== asset.id);
          expanded.delete(asset.id);
          saveState(); renderAll();
        }, '删除');
        break;
      case 'editValuation': {
        const v = state.valuations.find(x => x.id === btn.dataset.id);
        if (!v) return;
        openValuationForm(asset.id, v.id);
        break;
      }
      case 'deleteValuation': {
        const v = state.valuations.find(x => x.id === btn.dataset.id);
        if (!v) return;
        confirmAction('删除价值记录', '将删除「' + v.date + ' · ' + fmtMoney(v.value, asset.currency) +
          '」这条记录，确定吗？', () => {
          state.valuations = state.valuations.filter(x => x.id !== v.id);
          saveState(); renderAll();
        }, '删除');
        break;
      }
    }
  });

  $id('filter-category').onchange = (e) => { filters.category = e.target.value; renderList(); };
  $id('filter-currency').onchange = (e) => { filters.currency = e.target.value; renderList(); };
  $id('filter-sort').onchange = (e) => { filters.sort = e.target.value; renderList(); };

  $id('btn-settings').onclick = openSettings;
  $id('btn-help').onclick = openHelp;
  $id('btn-export').onclick = openExportModal;
  $id('btn-import').onclick = openImportModal;
  $id('import-input').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) {
      const reader = new FileReader();
      reader.onload = () => importPayloadText(reader.result);
      reader.readAsText(f);
    }
    e.target.value = '';
  };
  $id('btn-clear').onclick = clearAll;
  $id('demo-close').onclick = () => {
    state.settings.demoDismissed = true;
    saveState();
    $id('demo-banner').classList.add('hidden');
  };
}

/* ---------------- 演示数据 ---------------- */
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function seedDemo() {
  const now = Date.now();
  const mk = (name, category, subCategory, currency, principal, quantity, startDaysAgo, note) => ({
    id: uid('asset_'), name, category, subCategory, currency, principal: round2(principal),
    quantity: quantity, startDate: daysAgoStr(startDaysAgo), note,
    minHoldDays: null, riskLevel: null, tPlusN: null,
    createdAt: now, updatedAt: now,
  });
  const mkVal = (assetId, daysAgo, value, note) => ({
    id: uid('valuation_'), assetId, date: daysAgoStr(daysAgo), value: round2(value), note, createdAt: now,
  });

  const a1 = mk('沪深300指数基金', 'fund', '指数型', 'CNY', 50000, 5000, 180, '定投组合主力仓');
  const a2 = mk('某全球市场 QDII 基金', 'fund', 'QDII', 'USD', 2000, 120, 150, '美元资产配置');
  const a3 = mk('苹果（AAPL）', 'stock', '美股', 'USD', 1850, 10, 210, '长期持有');
  const a4 = mk('招商银行（A股）', 'stock', 'A股', 'CNY', 30000, 800, 90, '交易模式示例：分批买卖');
  const a5 = mk('某 3 年期大额存单', 'deposit', '定期', 'CNY', 100000, null, 60, '年利率 2.6% 的单利存款');
  const a6 = mk('国债（3年期）', 'bond', '国债', 'CNY', 40000, null, 120, '');
  // 演示新字段：最低持有天数 / 风险等级 / T+n（minHoldDays=1 表示买入次日即可卖）
  a1.minHoldDays = 30; a1.riskLevel = 'R3'; a1.tPlusN = 1;
  a2.minHoldDays = 30; a2.riskLevel = 'R4'; a2.tPlusN = 3;
  a3.minHoldDays = 1;  a3.riskLevel = 'R5'; a3.tPlusN = 0;
  a4.minHoldDays = 1;  a4.riskLevel = 'R4'; a4.tPlusN = 1;   // A 股 T+1
  a5.minHoldDays = 1095; a5.riskLevel = 'R1'; a5.tPlusN = 0;  // 三年期未到期 → 演示「不可卖」
  a6.minHoldDays = 1095; a6.riskLevel = 'R1'; a6.tPlusN = 0;
  // 演示交易记录模式：招商银行（分批买入 + 部分卖出），并带行情代码
  a4.enableTrades = true;
  a4.symbol = 'sh600036';
  a4.lastPrice = 38.52;       // 手动现价演示（可点「⟳ 刷新行情」获取实时价）
  a4.priceSource = 'manual';
  a4.lastQuoteAt = now;

  const vals = [
    mkVal(a1.id, 180, 50000, '买入'),
    mkVal(a1.id, 120, 50800),
    mkVal(a1.id, 60, 51900),
    mkVal(a1.id, 0, 53350, '今日市值'),
    mkVal(a2.id, 150, 2000, '买入'),
    mkVal(a2.id, 30, 2110),
    mkVal(a2.id, 0, 2168, '今日市值'),
    mkVal(a3.id, 210, 1850, '买入'),
    mkVal(a3.id, 100, 1970),
    mkVal(a3.id, 0, 2060, '今日市值'),
    mkVal(a6.id, 120, 40000, '买入'),
    mkVal(a6.id, 0, 40280, '今日市值'),
  ];

  // 演示交易记录：招商银行 首笔买入 → 部分卖出 → 补仓（加权平均/已实现盈亏演示）
  const mkTrade = (assetId, type, daysAgo, qty, price, fee, note) => ({
    id: uid('trade_'), assetId, type, date: daysAgoStr(daysAgo),
    quantity: qty, price, fee: fee || 0, note: note || '', createdAt: now,
  });
  const trades = [
    mkTrade(a4.id, 'buy', 90, 800, 37.5, 0, '分批建仓 #1'),
    mkTrade(a4.id, 'sell', 40, 200, 39.8, 0, '部分止盈'),
    mkTrade(a4.id, 'buy', 20, 100, 36.6, 0, '回调补仓'),
  ];

  state.assets = [a1, a2, a3, a4, a5, a6];
  state.valuations = vals;
  state.trades = trades;
  state.settings = Object.assign({}, DEFAULT_SETTINGS, {
    rates: { USD: 7.2, HKD: 0.92, EUR: 7.8, GBP: 9.1, JPY: 0.048 },
  });
  saveState();
}

/* ---------------- 帮助（使用指南 + 概念说明） ---------------- */
const HELP_HTML = ''
  + '<div class="help-content">'
  + '<section class="help-section"><h4>如何使用</h4><ol>'
  + '<li><b>添加产品</b>：记录你持有的产品（股票 / 基金 / 债券 / 存款等），填写名称、大类小类、币种、本金（买入成本）、开始持有日期；可选填最低持有天数、风险等级、T+n 到账天数、数量份额与备注。</li>'
  + '<li><b>记录价值</b>：持有过程中，随时点击卡片上的「＋ 记价值」，把当天看到的账户市值记下来。记录得越多，时间线与走势图越完整，指标越准。</li>'
  + '<li><b>查看指标</b>：每张卡片显示成本、最新市值、累计收益、收益率与年化（单利）；展开「查看时间线」可看到历史记录与走势折线图。</li>'
  + '<li><b>统计与图表</b>：顶部汇总区显示全部资产的成本 / 市值 / 收益 / 整体年化（按基准币种），图表区有资产结构环图与市值排行。</li>'
  + '<li><b>多币种</b>：在「汇率设置」中维护汇率（可点「获取最新汇率」联网更新，或手动填写），总市值、收益等跨币种统计都换算为基准币种。</li>'
  + '<li><b>数据保存</b>：所有数据保存在浏览器本地（localStorage），关闭页面后重新打开仍会保留；建议定期「导出」备份，更换浏览器或清除浏览器数据前务必先导出。</li>'
  + '</ol></section>'
  + '<section class="help-section"><h4>金融概念说明</h4>'
  + '<p><b>· 持有天数</b>：从「开始持有日期」到「最新价值记录日期」（无记录时算到今天）之间经过的自然日数。</p>'
  + '<p><b>· 累计收益</b>：最新市值 − 买入成本（本金）。为正即盈利，为负即亏损。</p>'
  + '<p><b>· 收益率</b>：累计收益 ÷ 本金。例如本金 1 万元、收益 300 元，则收益率 = 3%。</p>'
  + '<p><b>· 年化收益率（年化）</b>：把某一段时间的收益率折算成「持有满一年」的收益率，便于横向比较不同产品。'
  + '本工具默认用<b>单利口径</b>：年化 = 收益率 × 365 ÷ 持有天数。'
  + '举例：30 天赚了 3%（0.03），年化 = 0.03 × 365 ÷ 30 ≈ 36.5%（注意：短期高收益不代表一年真能赚这么多，持有不足 30 天时工具会提示「仅供参考」）。'
  + '同时提供<b>复利口径</b>作参考：年化 = (最新市值 ÷ 本金)^(365 ÷ 持有天数) − 1，复利假设每日滚动再投资。</p>'
  + '<p><b>· 整体年化（汇总）</b>：把全部资产的收益按成本加权后统一折算的年化，用于评估整个组合。</p>'
  + '<p><b>· 最低持有天数</b>：某些产品要求持有满一定天数才可赎回/卖出（如定开基金、定期存款）。达到前卡片显示「不可卖 · 还需 X 天」，达到后显示「可卖」。</p>'
  + '<p><b>· T+n</b>：提交赎回/卖出申请后的到账时间，n 为交易日数。例如股票 A 股为 T+1（次日确认），货币基金有的 T+0 / T+1，QDII 基金常见 T+3 左右。A 股「T+1」也指当日买入次日才能卖出。</p>'
  + '<p><b>· 风险等级（R1–R5）</b>：产品自身的风险分级，R1 最低（如存款、货币基金），R5 最高（如股票型、期货等），等级越高潜在波动与亏损可能越大。</p>'
  + '<p><b>· 多币种与汇率</b>：不同币种的资产先按各自币种计算收益，再做「总价值统计」时由汇率换算为基准币种。汇率由你维护（可联网获取或手动填写），汇率变动会影响换算结果，因此换算后的收益同时包含价格变动与汇率变动的影响。</p>'
  + '<p><b>· 红涨绿跌</b>：本工具按国内习惯，收益为正显示红色、为负显示绿色。</p>'
  + '</section>'
  + '<section class="help-section"><h4>交易记录模式与行情（v4/v5）</h4>'
  + '<p><b>· 记账模式</b>：编辑产品时可选择「价值快照」或「交易记录」。价值快照：记录本金 + 定期市值，适合不频繁买卖的产品；交易记录：记录每次买入/卖出（数量/单价/手续费），自动计算持仓数量、平均成本与盈亏。切换模式不删除数据，旧的本金+数量会自动转为首笔买入记录。</p>'
  + '<p><b>· 股票监察表（v5）</b>：添加股票时<b>只需填写股票代码</b>即可加入——程序自动识别市场（A股/港股/美股/北交所）、自动选择币种，并尝试自动带出证券名称（网络不可用时手动填写）。加入后为"自选监察"状态，随时点卡片「＋ 买入」录入买入（或「− 卖出」），<b>买入/卖出统一填写单股价格</b>，金额自动按数量计算。</p>'
  + '<p><b>· 平均成本（加权平均）</b>：全部持仓摊薄后的单位成本 = 持仓成本 ÷ 持仓数量。买入增加成本；卖出按「卖出数量 × 当时平均成本」从持仓成本中扣减，因此买得贵/便宜都会摊进后续成本。</p>'
  + '<p><b>· 已实现盈亏</b>：每笔卖出"落袋"的盈亏 = 卖出金额（扣除手续费）− 卖出数量 × 卖出时平均成本。清仓后再买入会按新成本继续，不影响历史已实现盈亏。</p>'
  + '<p><b>· 浮动盈亏与总盈亏</b>：浮动盈亏 = 当前市值 − 持仓成本（随现价波动）；总盈亏 = 浮动 + 已实现。部分卖出会"锁定"一部分已实现盈亏，因此看总盈亏比只看市值更能反映整体战绩。</p>'
  + '<p><b>· 行情代码</b>：直接输入即可——A股 600519 / 000001（自动识别）· 港股 00700 · 美股 KO / AAPL（大小写不敏感）；也支持带前缀写法 sh600519 / usAAPL。点「⟳ 刷新行情」获取现价与近期走势；接口来自腾讯公开免费服务，仅作记录与计算参考。行情不可用时点「✎ 现价」手动录入。</p>'
  + '<p><b>· 自动刷新</b>：可在「汇率设置」面板开关"打开页面自动刷新行情"，每只产品 10 分钟内最多自动刷新一次，避免频繁请求第三方接口。</p>'
  + '</section>'
  + '<section class="help-section"><h4>数据说明</h4>'
  + '<p>· 本工具<b>不做任何行情联网查询</b>（汇率联网仅用于换算统计，不是投资建议）；所有收益均为按你记录数据计算的实际/估算结果，仅供参考，不构成投资建议。</p>'
  + '<p>· 数据存放在浏览器 localStorage 中，不在任何源码文件里；可通过「导出 / 导入」以 JSON 文件备份与迁移。</p>'
  + '</section>'
  + '</div>';

function openHelp() {
  openModal('帮助 · 使用指南与概念说明', HELP_HTML, () => closeModal(), '关闭');
}

/* ---------------- 启动 ---------------- */
function init() {
  bindEvents();
  const versionEl = $id('app-version');
  if (versionEl) versionEl.textContent = 'v' + APP_VERSION;
  const hasData = loadState();
  if (!hasData) {
    seedDemo();
    $id('demo-banner').classList.remove('hidden');
  } else if (!state.settings.demoDismissed && state.assets.length) {
    $id('demo-banner').classList.remove('hidden');
  }
  renderAll();

  // PWA：注册 Service Worker（仅在 http(s) 环境生效，file:// 双击打开时自动跳过）
  // 效果：把页面"添加到主屏幕"后，可全屏启动并离线使用
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.protocol === 'http:')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 注册失败静默处理，不影响正常使用 */
    });
  }

  // 每次启动自动获取一次最新汇率（失败静默，不影响使用）
  if (state.settings.autoFetchRates !== false) {
    applyLatestRates({ silent: true });
  }

  // 自动刷新已填行情代码的产品（受 10 分钟频率约束，失败静默）
  if (state.settings.autoQuote !== false) {
    refreshAllQuotes({ silent: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/* 暴露给测试/调试使用 */
window.__EcoCal = {
  APP_VERSION, Calc, state, uid, round2, roundQty, roundPrice, dayDiff, todayStr, seedDemo, loadState, saveState,
  fetchLatestRates, applyLatestRates, RISK_LEVELS, SORT_OPTIONS,
  openSettings, openAssetForm, openValuationForm, openTradeForm, openHelp,
  openExportModal, openImportModal, importPayloadText, buildExportPayload,
  migrateToTrades,
  normalizeSymbol, symbolToCurrency, fetchQuote, fetchKline, fetchStockInfo,
  refreshQuoteForAsset, refreshAllQuotes, manualPriceline,
};

})();
