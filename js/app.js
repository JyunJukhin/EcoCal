
'use strict';
/* =========================================================================
 * EcoCal - 个人资产持仓记录工具（纯本地，零依赖）
 * 数据：Asset（产品基本信息） + Trade（逐笔买卖记录） + Settings（基准币种/汇率）
 * v6 起：全面采用「交易记录」记账（删去价值快照模式）；
 *        新增「外币」大类（用人民币买入/卖出外币，按汇率计算收益）；
 *        买入/卖出支持「份数×单价」、「总金额」或（外币）「兑换」三种录入方式；
 *        非股票产品按每笔买入记录各自的最低持有天数。
 * ========================================================================= */
(function () {

/* ---------------- 常量与配置 ---------------- */
const STORAGE_KEY = 'ecocal.data.v1';

/* 应用版本：主版本.次版本.补丁
 * - 主版本：重大架构/功能（v3 多文件、v4 股票交易与行情、v6 交易记录全模式）
 * - 次版本：功能增强（v5 监察表模式与优化、v6.1 统计功能、v6.2 统计页重设计）
 * - 补丁：缺陷修复 */
const APP_VERSION = '6.3.0';

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
  fx:        { label: '外币',      sub: ['现汇', '现钞', '外汇理财', '其他'] },
  commodity: { label: '商品',      sub: ['黄金', '原油', '大宗商品', '其他'] },
  crypto:    { label: '数字货币',  sub: ['比特币', '以太坊', '其他'] },
  other:     { label: '其他',      sub: ['其他'] },
};

/* 外币大类可选的币种（买卖时填「汇率」= 1 外币兑多少人民币，金额按人民币计） */
const FX_CURRENCIES = ['USD', 'HKD', 'EUR', 'GBP', 'JPY', 'SGD', 'AUD', 'CAD', 'CHF'];

/* 资产类别配置的 7 个聚合组（股票 / 债券 / 基金ETF / 商品 / 数字货币 / 现金及等价物 / 其他） */
const ASSET_GROUPS = ['股票', '债券', '基金ETF', '商品', '数字货币', '现金及等价物', '其他'];

/** 资产 → 聚合组（货币型基金、存款、外币现汇/现钞视为「现金及等价物」；银行理财/保险/其他归「其他」） */
function assetGroupOf(asset) {
  if (asset.category === 'stock') return '股票';
  if (asset.category === 'bond') return '债券';
  if (asset.category === 'commodity') return '商品';
  if (asset.category === 'crypto') return '数字货币';
  if (asset.category === 'fund') return (asset.subCategory === '货币型') ? '现金及等价物' : '基金ETF';
  if (asset.category === 'deposit') return '现金及等价物';
  if (asset.category === 'fx') return '现金及等价物';
  return '其他'; // 银行理财 / 保险 / 其他
}

/** 资产 → 市场（A股/港股/美股/其他）：优先股票小类，其次行情代码前缀 */
function marketOf(asset) {
  if (asset.category === 'stock') {
    if (asset.subCategory === 'A股') return 'A股';
    if (asset.subCategory === '港股') return '港股';
    if (asset.subCategory === '美股') return '美股';
  }
  const sym = String(asset.symbol || '').toLowerCase();
  if (/^hk/.test(sym)) return '港股';
  if (/^us/.test(sym)) return '美股';
  if (/^(sh|sz|bj)/.test(sym)) return 'A股';
  return '其他';
}

/** 币种敞口：外币产品按其外币币种（其市值已折合为人民币，但货币敞口在外币），其余按资产币种 */
function exposureCurrency(asset) {
  if (asset.category === 'fx') return asset.foreignCurrency || '其他';
  return asset.currency || '其他';
}

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
  riskFreeRate: 2,        // 无风险年化利率（%），用于夏普比率
  liabilities: 0,         // 负债总额（基准币种），净资产 = 总市值 − 负债
  singleAssetCap: 20,     // 单一标的上限阈值（%），超过则集中度高亮提示
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
 * 旧数据迁移：把「价值快照」时代的资产（原本金 + 数量 + 价值记录）转换为
 * 交易记录语义——用原有 quantity + principal 生成一笔买入交易。
 * 若该产品有历史价值记录，取最近一条折算为「当前现价」：
 *   现价 = 最近市值 ÷ 数量（数量缺失时数量按 1 处理，现价即市场总价）。
 * 返回是否生成了迁移交易。
 */
function migrateToTrades(asset) {
  if (!asset || !state.trades) return false;
  if (state.trades.some(t => t.assetId === asset.id)) {
    // 已有交易记录的产品无需迁移（可能原本已是交易模式）
    return false;
  }
  const qtyRaw = Number(asset.quantity);
  const p = Number(asset.principal);
  const validQty = isFinite(qtyRaw) && qtyRaw > 0;
  const validPrincipal = isFinite(p) && p > 0;
  if (!validPrincipal) return false; // 无本金（监察表类产品）则跳过，等待用户录入首笔买入
  const qty = validQty ? qtyRaw : 1;
  const price = p / qty;
  state.trades.push({
    id: uid('trade_'), assetId: asset.id, type: 'buy',
    date: asset.startDate || todayStr(),
    quantity: roundQty(qty), price: roundPrice(price), fee: 0,
    note: '由旧数据迁移（原本金 ' + round2(p) + '）',
    createdAt: Date.now(),
  });
  // 现价折算：优先取最近一条价值记录（现价 = 市值 ÷ 数量）；
  // 无价值记录时按成本价兜底（口径与旧版"无记录按本金计"一致，市值 = 本金、浮动 0），
  // 之后用户仍可在「✎ 现价 / ✎ 市值」更新为真实行情。
  if (asset.lastPrice == null) {
    const vals = (state.valuations || [])
      .filter(v => v.assetId === asset.id)
      .sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const latest = vals.length ? vals[vals.length - 1] : null;
    if (latest && isFinite(Number(latest.value)) && Number(latest.value) > 0) {
      asset.lastPrice = roundQty(Number(latest.value) / qty);
      asset.priceSource = 'manual';
      asset.lastQuoteAt = asset.lastQuoteAt || Date.now();
    } else {
      asset.lastPrice = roundQty(price); // 成本价兜底
      asset.priceSource = 'manual';
      asset.lastQuoteAt = asset.lastQuoteAt || Date.now();
    }
  }
  saveState();
  return true;
}

/**
 * v6 全量迁移（每次载入/导入后调用）：
 * 1. 把所有尚无交易记录的产品用旧本金/数量迁移出一笔买入；
 * 2. 旧数据以 value 快照做市值的产品，其 lastPrice 已在 migrateToTrades 中折算；
 * 3. v6 起不再维护价值快照数组（state.valuations 清空），
 *    持仓与盈亏统一由交易记录 + 现价推导。
 */
function migrateToV6() {
  if (!Array.isArray(state.assets)) state.assets = [];
  if (!Array.isArray(state.trades)) state.trades = [];
  state.assets.forEach(a => {
    // 外币产品兜底：强制人民币为本位币，外币币种取自 foreignCurrency
    if (a.category === 'fx' && (!a.foreignCurrency || !a.currency)) {
      a.foreignCurrency = a.foreignCurrency || 'USD';
      a.currency = a.currency || 'CNY';
    }
    if (a.category !== 'fx') a.foreignCurrency = a.foreignCurrency || null;
  });
  state.assets.forEach(a => migrateToTrades(a));
  state.valuations = []; // 价值快照已全部并入交易记录
  saveState();
}

/**
 * 从汇率缓存推算「1 单位外币兑多少人民币」。
 * settings.rates 的约定是「1 币种 = X 基准币种」，因此：
 *   基准为 CNY 时，外币兑 CNY = rates[外币]；
 *   基准不为 CNY 时，外币兑 CNY = rates[外币] ÷ rates[CNY]。
 * 汇率缺失返回 null。
 */
function fxRateFromCache(fxCode, settings) {
  const s = settings || state.settings;
  const base = s.baseCurrency;
  const fx = s.rates[fxCode];
  if (fx == null || !(Number(fx) > 0)) return null;
  if (base === 'CNY') return Number(fx);
  const cny = s.rates.CNY;
  if (cny == null || !(Number(cny) > 0)) return null;
  return Number(fx) / Number(cny);
}

/* 资产的「级」最低持有天数（历史数据/股票限售等场景仍支持；v6 默认推荐在买入时填写） */
function assetMinHold(asset) {
  if (asset == null) return null;
  const min = asset.minHoldDays != null && Number(asset.minHoldDays) > 0
    ? Math.floor(Number(asset.minHoldDays)) : null;
  return min;
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
    let qty = 0, cost = 0, realized = 0, received = 0;
    const events = [];
    list.forEach(t => {
      const q = Number(t.quantity) || 0;
      const p = Number(t.price) || 0;
      const fee = Number(t.fee) || 0;
      if (t.type === 'sell') {
        // 卖出：按当前加权平均成本扣减，差额记入已实现盈亏
        const avg = qty > 0 ? cost / qty : 0;
        const sellAmount = q * p - fee;
        received = round2(received + sellAmount);
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
      qty, cost, avgCost, realized, received, marketValue, float, totalProfit,
      events, days, firstDate, hasTrades: list.length > 0,
    };
  },
  /**
   * 组合市值走势（估算）：返回 [{ date, value, net }] 快照序列，
   * 时间点 = 全部交易日期 ∪ 今天（升序）。
   * - value：各产品在该日的估算市值（基准币种）——数量按当日已发生买卖精确计算，
   *   单价按「最近已知成交价」估算（最后一期用最新现价 lastPrice）
   * - net：截至该日的累计净投入（买入+费为负、卖出回收为正，基准币种）
   */
  portfolioTrend(assets, trades, settings, today) {
    const todayS = today || todayStr();
    const dateSet = new Set();
    const assetTrades = {};
    assets.forEach(a => { assetTrades[a.id] = []; });
    (trades || []).forEach(t => {
      if (assetTrades[t.assetId]) { assetTrades[t.assetId].push(t); dateSet.add(t.date); }
    });
    dateSet.add(todayS);
    const dates = Array.from(dateSet).sort();
    if (!dates.length) return [];

    const series = assets.map(a => {
      const list = assetTrades[a.id].slice().sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
      const pts = [];
      let qty = 0, lastPrice = null, net = 0, li = 0;
      dates.forEach(d => {
        while (li < list.length && list[li].date <= d) {
          const t = list[li];
          const q = Number(t.quantity) || 0;
          const p = Number(t.price) || 0;
          const fee = Number(t.fee) || 0;
          if (t.type === 'buy') { qty += q; net -= (q * p + fee); lastPrice = p; }
          else { qty -= q; net += (q * p - fee); lastPrice = p; }
          li++;
        }
        pts.push({ date: d, qty, price: lastPrice, net });
      });
      return { asset: a, pts };
    });

    const lastIdx = dates.length - 1;
    series.forEach(sr => {
      // 最后一期统一用最新现价（更贴近真实市值）
      if (sr.asset.lastPrice != null) sr.pts[lastIdx].price = Number(sr.asset.lastPrice);
      sr.pts.forEach(pt => {
        const val = (pt.qty > 0 && pt.price != null) ? pt.qty * pt.price : 0;
        pt.value = Calc.toBase(val, sr.asset.currency, settings) || 0;
        pt.net = Calc.toBase(pt.net, sr.asset.currency, settings) || 0;
      });
    });

    return dates.map((d, i) => {
      let value = 0, net = 0;
      series.forEach(sr => { value += sr.pts[i].value; net += sr.pts[i].net; });
      return { date: d, value: round2(value), net: round2(net) };
    });
  },
  /**
   * 最大回撤：基于市值曲线的历史峰值逐日计算回撤（当前值/峰值 - 1，≤0）。
   * 返回 { maxDD, start, end, currentDD, series:[{date, dd}] }
   */
  maxDrawdown(points) {
    if (!Array.isArray(points) || !points.length) return { maxDD: 0, start: null, end: null, currentDD: 0, series: [] };
    let peak = -Infinity, peakDate = null;
    let maxDD = 0, ddStart = null, ddEnd = null;
    const series = [];
    points.forEach(p => {
      const v = Number(p.value);
      if (!isFinite(v) || v <= 0) { series.push({ date: p.date, dd: 0 }); return; }
      if (v > peak) { peak = v; peakDate = p.date; }
      const dd = v / peak - 1;
      series.push({ date: p.date, dd });
      if (dd < maxDD) { maxDD = dd; ddStart = peakDate; ddEnd = p.date; }
    });
    const currentDD = series.length ? series[series.length - 1].dd : 0;
    return { maxDD, start: ddStart, end: ddEnd, currentDD, series };
  },
  /**
   * 简单年化（CAGR）：由市值曲线的首末两点按年折算 (V_end/V_start)^(365/天) - 1。
   * 市值数据不足或首值非正时返回 null。
   */
  cagr(points) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const first = points[0].value, last = points[points.length - 1].value;
    const days = dayDiff(points[0].date, points[points.length - 1].date);
    if (!(first > 0) || !(last > 0) || days <= 0) return null;
    return Math.pow(last / first, 365 / days) - 1;
  },
  /**
   * 年化波动率：市值曲线相邻两点的日收益率标准差 × √365（样本标准差）。
   * 曲线点数不足 3 时返回 null。
   */
  annualVol(points) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const rets = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].value, cur = points[i].value;
      if (prev > 0 && isFinite(cur)) rets.push(cur / prev - 1);
    }
    if (rets.length < 2) return null;
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const varr = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (rets.length - 1);
    return Math.sqrt(varr) * Math.sqrt(365);
  },
  /**
   * 夏普比率：(简单年化收益 − 无风险年化利率) ÷ 年化波动率。风险偏好指标，越高越好。
   * riskFreeAnnual 为小数（如 0.02）。波动率为 0 时返回 null。
   */
  sharpe(points, riskFreeAnnual) {
    const r = Calc.cagr(points);
    const vol = Calc.annualVol(points);
    if (r == null || vol == null || !(vol > 0)) return null;
    return (r - (Number(riskFreeAnnual) || 0)) / vol;
  },
  /**
   * 内部收益率 IRR（年化）：求解 Σ CF_i / (1+r)^(天数_i/365) = 0（二分法）。
   * 以「最早一笔现金流」为时间锚点（标准 XIRR 口径）；现金流同时存在正负才可解。
   */
  irr(flows, today) {
    if (!Array.isArray(flows) || flows.length < 2) return null;
    const firstDate = flows.map(f => f.date).sort()[0];
    const times = flows.map(f => Math.max(0, dayDiff(firstDate, f.date)));
    const amounts = flows.map(f => Number(f.amount) || 0);
    if (!amounts.some(a => a > 0) || !amounts.some(a => a < 0)) return null;
    const f = r => amounts.reduce((sum, a, i) => sum + a / Math.pow(1 + r, times[i] / 365), 0);
    let lo = -0.999, hi = 20;
    let flo = f(lo), fhi = f(hi);
    if (!isFinite(flo) || !isFinite(fhi) || flo * fhi > 0) return null;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if (Math.abs(fm) < 1e-9) return mid;
      if (flo * fm < 0) { hi = mid; fhi = fm; }
      else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  },
  /**
   * 资金加权年化收益率（XIRR 口径）：把所有买入（现金流出，负值）、卖出（现金流入，正值）
   * 折算为基准币种的现金流，加上今天的最新市值作为期末现金流，求内部收益率（年化）。
   * 适合定投等资金进出不规律的情形。
   */
  xirr(assets, trades, settings, today) {
    const flows = [];
    let finalValue = 0;
    (assets || []).forEach(a => {
      (trades || []).filter(t => t.assetId === a.id).forEach(t => {
        const q = Number(t.quantity) || 0;
        const p = Number(t.price) || 0;
        const fee = Number(t.fee) || 0;
        const amount = t.type === 'buy' ? -(q * p + fee) : (q * p - fee);
        const baseAmt = Calc.toBase(amount, a.currency, settings);
        if (baseAmt != null && Math.abs(baseAmt) > 0.004) flows.push({ date: t.date, amount: round2(baseAmt) });
      });
      const pos = Calc.tradePosition(a, trades, a.lastPrice != null ? Number(a.lastPrice) : null);
      if (pos.marketValue != null) {
        const baseValue = Calc.toBase(pos.marketValue, a.currency, settings);
        if (baseValue != null) finalValue += baseValue;
      }
    });
    if (flows.length) flows.push({ date: today || todayStr(), amount: round2(finalValue) });
    if (!flows.length) return null;
    return Calc.irr(flows, today);
  },
  /**
   * 组合走势的衍生统计（供走势卡指标条使用）。
   * 返回 { xirr, cagr, vol, sharpe, maxDD, currentDD }
   */
  portfolioMetrics(points, settings) {
    const rf = settings && Number(settings.riskFreeRate) != null
      ? Number(settings.riskFreeRate) / 100 : 0.02;
    const dd = Calc.maxDrawdown(points);
    return {
      xirr: null, // 由调用方用 assets/trades 计算（这里只放占位）
      cagr: Calc.cagr(points),
      vol: Calc.annualVol(points),
      sharpe: Calc.sharpe(points, rf),
      maxDD: dd.maxDD,
      maxDDStart: dd.start,
      maxDDEnd: dd.end,
      currentDD: dd.currentDD,
    };
  },
  /**
   * 统计页核心聚合（v6.3 重构）：返回仪表盘/分布/集中度/明细所需的全部数据。
   * opts: { liabilities, singleAssetCap }
   * 口径：金额一律折算为基准币种；占比分母 = 总市值；浮动盈亏率 = 浮动盈亏 ÷ 持仓成本；
   *       当日盈亏 = 数量 × (现价 − 前一交易日收盘)，仅有行情日K缓存时可算，否则 null。
   */
  statistics(assets, trades, settings, opts) {
    const base = settings.baseCurrency;
    const o = opts || {};
    const liabilities = Number(o.liabilities) || 0;
    const singleAssetCap = Number(o.singleAssetCap) != null ? Number(o.singleAssetCap) : 20;
    const tradesList = trades || [];

    const rows = (assets || []).map(a => {
      const pos = Calc.tradePosition(a, tradesList, a.lastPrice != null ? Number(a.lastPrice) : null);
      const isFx = a.category === 'fx';
      const unitRate = a.currency === base ? 1 : settings.rates[a.currency]; // 汇率：1 币种兑基准
      const rate = (isFx || a.currency === base) ? 1
        : (unitRate != null && Number(unitRate) > 0 ? Number(unitRate) : null);
      const baseCost = Calc.toBase(pos.cost, a.currency, settings);
      const baseValue = pos.marketValue != null ? Calc.toBase(pos.marketValue, a.currency, settings) : null;
      const baseFloat = pos.float != null ? Calc.toBase(pos.float, a.currency, settings) : null;
      const baseRealized = Calc.toBase(pos.realized, a.currency, settings);
      // 当日盈亏：股票且行情日K有前一交易日收盘时可算
      let dayPnL = null;
      const k = settings.kline && settings.kline[a.symbol];
      if (a.symbol && k && Array.isArray(k.days) && k.days.length >= 2 && a.lastPrice != null && pos.qty > 0) {
        const prevClose = Number(k.days[k.days.length - 2][2]);
        if (isFinite(prevClose)) {
          dayPnL = Calc.toBase(pos.qty * (Number(a.lastPrice) - prevClose), a.currency, settings);
        }
      }
      return {
        asset: a, pos,
        group: assetGroupOf(a),
        market: marketOf(a),
        exposure: exposureCurrency(a),
        rate,                                   // 汇率（折合基准）
        baseCost, baseValue, baseFloat, baseRealized, dayPnL,
        floatRate: pos.cost > 0 && pos.float != null ? pos.float / pos.cost : null,
        sharePct: null,
      };
    });

    const totalValue = round2(rows.reduce((s, r) => s + (r.baseValue != null ? r.baseValue : 0), 0));
    rows.forEach(r => { r.sharePct = (r.baseValue != null && totalValue > 0) ? r.baseValue / totalValue : null; });

    const totalCost = round2(rows.reduce((s, r) => s + (r.baseCost != null ? r.baseCost : 0), 0));
    const totalRealized = round2(rows.reduce((s, r) => s + (r.baseRealized != null ? r.baseRealized : 0), 0));
    const totalFloat = round2(rows.reduce((s, r) => s + (r.baseFloat != null ? r.baseFloat : 0), 0));
    const totalProfit = round2(totalFloat + totalRealized);
    const floatRate = totalCost > 0 ? totalFloat / totalCost : null;
    const netWorth = round2(totalValue - liabilities);

    // 现金 vs 风险资产（现金及等价物 = 存款 + 货币基金 + 外币现汇/现钞等）
    const cashValue = round2(rows.reduce((s, r) => s + (r.group === '现金及等价物' && r.baseValue != null ? r.baseValue : 0), 0));
    const riskValue = round2(totalValue - cashValue);
    const cashPct = totalValue > 0 ? cashValue / totalValue : null;
    const riskPct = totalValue > 0 ? riskValue / totalValue : null;

    // 分组聚合（类别 / 市场 / 币种），按市值降序，附占比
    const aggregate = (pick) => {
      const map = {};
      rows.forEach(r => { if (r.baseValue != null) { const k = pick(r); map[k] = (map[k] || 0) + r.baseValue; } });
      return Object.keys(map).map(k => ({
        label: k,
        value: round2(map[k]),
        pct: totalValue > 0 ? map[k] / totalValue : null,
      })).sort((x, y) => y.value - x.value);
    };
    const groups = aggregate(r => r.group);
    const markets = aggregate(r => r.market);
    const currencies = aggregate(r => (r.exposure === 'CNY' || r.exposure === 'USD' || r.exposure === 'HKD') ? r.exposure : '其他');

    // 集中度
    const valued = rows.filter(r => r.baseValue != null && r.baseValue > 0).sort((x, y) => y.baseValue - x.baseValue);
    const top5 = round2(valued.slice(0, 5).reduce((s, r) => s + r.baseValue, 0));
    const top10 = round2(valued.slice(0, 10).reduce((s, r) => s + r.baseValue, 0));
    const maxAsset = valued.length ? { name: valued[0].asset.name, pct: valued[0].sharePct, value: valued[0].baseValue } : null;
    const overLimit = valued.filter(r => r.sharePct != null && r.sharePct * 100 > singleAssetCap)
      .map(r => ({ name: r.asset.name, pct: r.sharePct * 100, value: r.baseValue }));

    const detail = rows.slice().sort((x, y) => (y.baseValue != null ? y.baseValue : -1) - (x.baseValue != null ? x.baseValue : -1));

    return {
      base, rows, detail,
      totalValue, netWorth, liabilities, totalCost,
      totalFloat, floatRate, totalRealized, totalProfit,
      cashValue, riskValue, cashPct, riskPct,
      groups, markets, currencies,
      maxAsset, top5, top10, overLimit, singleAssetCap,
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
   * FIFO 持仓批次：每笔买入成为一个批次（记录其买入日期与最低持有天数），
   * 卖出按「先进先出」消耗最早批次。用于判断可卖状态（不同时期买入可能
   * 有不同的最低持有天数，如基金持有 7 天后赎回免手续费）。
   * 返回批次列表：[{ qty, date, minHoldDays, heldDays, sellable, remainingDays }]
   */
  lots(asset, trades, today) {
    const list = trades
      .filter(t => t.assetId === asset.id)
      .sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const queue = []; // { qty, date, minHoldDays }
    list.forEach(t => {
      const q = Number(t.quantity) || 0;
      if (t.type === 'buy') {
        const minHold = t.minHoldDays != null ? Math.floor(Number(t.minHoldDays)) : null;
        queue.push({ qty: q, date: t.date, minHoldDays: (minHold != null && minHold > 0) ? minHold : null });
      } else {
        let remain = q;
        while (remain > 0 && queue.length) {
          const lot = queue[0];
          const take = Math.min(lot.qty, remain);
          lot.qty -= take;
          remain -= take;
          if (lot.qty <= 0) queue.shift();
        }
      }
    });
    const todayStr0 = today || todayStr();
    return queue.filter(l => l.qty > 0).map(l => {
      const heldDays = Math.max(0, dayDiff(l.date, todayStr0));
      return {
        qty: roundQty(l.qty), date: l.date, minHoldDays: l.minHoldDays, heldDays,
        sellable: l.minHoldDays == null ? null : heldDays >= l.minHoldDays,
        remainingDays: l.minHoldDays == null ? 0 : Math.max(0, l.minHoldDays - heldDays),
      };
    });
  },
  /**
   * 可卖判定（v6 批次制）：默认按持仓批次各自的「最低持有天数」判断；
   * 仅当没有任何批次配置限制时，回退到资产级 minHoldDays（历史数据/股票固定限售）。
   * 返回：
   *   sellable = null 表示不限制（无任何配置）；
   *   sellable  true  全部可卖；
   *   partial   true  部分批次未到期（其中 lockedQty 为锁定数量）；
   *   否则整仓锁定（remainingDays 为所有批次中还需等待的最大天数）。
   */
  sellStatus(asset, trades, today) {
    const tradeList = trades || [];
    const lots = Calc.lots(asset, tradeList, today);
    const baseDate = lots.length ? lots[0].date : (asset.startDate || today || todayStr());
    const heldDaysBase = Math.max(0, dayDiff(baseDate, today || todayStr()));
    const anyLimited = lots.some(l => l.minHoldDays != null);
    // 回退规则：无批次限制（或暂无持仓批次）→ 用资产级最低持有天数
    if (!anyLimited && !lots.length) {
      const minDays = assetMinHold(asset);
      if (minDays == null) return { heldDays: heldDaysBase, minDays: null, sellable: null, remainingDays: 0, lots: [], lockedQty: 0, partial: false, settled: false };
      return { heldDays: heldDaysBase, minDays, sellable: heldDaysBase >= minDays, remainingDays: Math.max(0, minDays - heldDaysBase), lots: [], lockedQty: 0, partial: false, settled: false };
    }
    if (!anyLimited) {
      const minDays = assetMinHold(asset);
      if (minDays == null) return { heldDays: heldDaysBase, minDays: null, sellable: null, remainingDays: 0, lots, lockedQty: 0, partial: false, settled: false };
      return { heldDays: heldDaysBase, minDays, sellable: heldDaysBase >= minDays, remainingDays: Math.max(0, minDays - heldDaysBase), lots, lockedQty: 0, partial: false, settled: false };
    }
    // 批次制判定
    const totalQty = lots.reduce((s, l) => s + l.qty, 0);
    const lockedQty = roundQty(lots.filter(l => l.sellable === false).reduce((s, l) => s + l.qty, 0));
    const maxRemaining = lots.filter(l => l.sellable === false).reduce((s, l) => Math.max(s, l.remainingDays), 0);
    return {
      heldDays: heldDaysBase, minDays: null, lots, totalQty, lockedQty,
      sellable: lockedQty <= 0,
      partial: lockedQty > 0 && lockedQty < totalQty,
      remainingDays: maxRemaining,
      settled: true,
    };
  },
  /**
   * 全部资产汇总（基准币种口径）。
   * 返回 { totalCost, totalValue, totalProfit, totalRate, overallAnnual, currencyBreakdown, metrics: [...], gainCount, lossCount, missingRateCurrencies }
   * v6：所有产品统一按交易记录（加权平均成本）计算；valuations 参数不再使用，仅为兼容旧调用保留。
   */
  summary(assets, valuations, settings, trades) {
    const tradesList = trades || [];
    const metrics = assets.map(a => {
      const pos = Calc.tradePosition(a, tradesList, a.lastPrice != null ? Number(a.lastPrice) : null);
      const baseCost = Calc.toBase(pos.cost, a.currency, settings);
      const baseValue = pos.marketValue != null ? Calc.toBase(pos.marketValue, a.currency, settings) : null;
      const baseFloat = pos.float != null ? Calc.toBase(pos.float, a.currency, settings) : null;
      const baseRealized = Calc.toBase(pos.realized, a.currency, settings);
      const baseTotal = (baseFloat != null ? baseFloat : 0) + (baseRealized != null ? baseRealized : 0);
      let simpleAnnual = null;
      // 单产品年化（单利口径）：浮动收益 / 投入成本 / 持有天数
      if (pos.days > 0 && pos.cost > 0 && pos.float != null) {
        simpleAnnual = pos.float / pos.cost * 365 / pos.days;
      }
      return {
        assetId: a.id, assetCurrency: a.currency,
        currentValue: pos.marketValue, days: pos.days,
        profit: pos.float,         // 浮动盈亏（本币）
        realized: pos.realized,    // 已实现盈亏（本币）
        rate: pos.cost > 0 && pos.float != null ? pos.float / pos.cost : null,
        simpleAnnual, compoundAnnual: null, latestDate: null, hasValuation: false,
        valuationCount: 0,
        baseCost, baseValue, baseProfit: baseFloat,
        baseRealized, baseTotal: round2(baseTotal),
        rateMissing: baseCost == null || baseValue == null,
        trade: pos,
      };
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
  /* 环形图：data = [{label, value, color}]，value 非正数时跳过；centerLines = [标题, 数值] 绘制圆心文字 */
  ring(data, size, centerLines) {
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
      // data-dim-key 供「点击环图切片筛选」使用
      paths += '<path d="' + arc(acc, a1) + '" fill="none" stroke="' + d.color +
               '" stroke-width="' + sw + '" stroke-linecap="butt" data-dim-key="' + esc(d.key || d.label) + '"' +
               ' title="' + esc(d.label) + '" style="cursor:pointer"/>';
      legend.push('<span><i style="background:' + d.color + '"></i>' + esc(d.label) +
                  ' · ' + (Math.round(d.value / total * 1000) / 10) + '%</span>');
      acc = a1;
    });
    // 圆心文字（如总市值）
    const centerText = (centerLines && Array.isArray(centerLines) && centerLines[1] != null)
      ? '<text x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" font-size="16" font-weight="650" fill="#1d1d1f" font-feature-settings="tnum">' + esc(String(centerLines[1])) + '</text>' +
        '<text x="' + cx + '" y="' + (cy + 17) + '" text-anchor="middle" font-size="9.5" fill="#86868b">' + esc(String(centerLines[0] || '')) + '</text>'
      : '';
    return '<div style="display:flex;flex-direction:column;align-items:center">' +
           '<svg viewBox="0 0 ' + S + ' ' + S + '" style="max-width:' + S + 'px">' + paths + centerText + '</svg>' +
           '<div class="chart-legend">' + legend.join('') + '</div></div>';
  },
  /* 横向条形图：items = [{label, value, sub, loss}] */
  bars(items, baseCurrency) {
    if (!items.length) return '<div class="chart-empty">暂无数据</div>';
    const max = Math.max.apply(null, items.map(i => Math.abs(i.value))) || 1;
    const rows = items.map((it, idx) => {
      const pct = Math.max(2, Math.round(Math.abs(it.value) / max * 100));
      const barColor = it.loss ? 'linear-gradient(90deg,#21a84d,#37c764)' : 'linear-gradient(90deg,#0071e3,#4fb0ff)';
      // data-bar-id 供「点击条形图筛选该产品」使用
      return '<div' + (it.assetId ? ' data-bar-id="' + esc(it.assetId) + '"' : '') +
        ' style="cursor:pointer;display:grid;grid-template-columns:170px 1fr 150px;gap:12px;align-items:center;padding:8px 0;font-size:13px">' +
        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)" title="' + esc(it.label) + '">' + esc(it.label) + '</div>' +
        '<div style="position:relative;height:18px;background:rgba(0,0,0,.05);border-radius:9px">' +
          '<div style="position:absolute;left:0;top:0;bottom:0;width:' + pct + '%;background:' + barColor + ';border-radius:9px;transition:width .3s"></div>' +
        '</div>' +
        '<div style="text-align:right;font-feature-settings:tnum;font-weight:600">' + fmtMoney(it.value, baseCurrency) +
          (it.loss ? '<span style="color:var(--green);font-size:12px;font-weight:400"> ' + it.sub + '</span>'
                   : '<span style="color:var(--ink-3);font-size:12px;font-weight:400"> ' + it.sub + '</span>') +
        '</div></div>';
    }).join('');
    return '<div style="width:100%">' + rows + '</div>';
  },
  /* 折线走势图：points = [{date, value}]，>=2 点才画 */
  line(points, w, h) {
    if (points.length < 2) return '<div class="chart-empty">价值记录不足 2 条，暂无法绘制走势（可继续添加价值记录）</div>';
    const W = w || 560, H = h || 200, pad = { l: 34, r: 8, t: 12, b: 22 };
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
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-height:260px">' + ticks +
      '<path d="' + areaPath + '" fill="rgba(0,113,227,.10)" stroke="none"/>' +
      '<path d="' + linePath.trim() + '" fill="none" stroke="#0071e3" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + x(points.length - 1).toFixed(1) + '" cy="' + y(last.value).toFixed(1) +
      '" r="3.2" fill="#0071e3"/>' +
      '<text x="' + x(points.length - 1) + '" y="' + (y(last.value) - 8).toFixed(1) +
      '" text-anchor="end" font-size="9" fill="#86868b">' + fmtMoney(last.value, '') + '</text>' +
      '<text x="' + pad.l + '" y="' + (H - 6) + '" font-size="9" fill="#a1a1a6">' + esc(dates[0]) + '</text>' +
      '<text x="' + (W - pad.r) + '" y="' + (H - 6) + '" text-anchor="end" font-size="9" fill="#a1a1a6">' + esc(last.date) + '</text>' +
      '</svg>';
  },
  /**
   * 通用多系列折线图（组合走势用，支持多种统计模式）。
   * series: [{ points:[{date,value}], color, dash?, label?, fill? }]
   * opts: { w, h, fmt: 'money'|'pct', zeroLine?: bool }
   * 至少 2 个时间点才绘制；fill 系列会自动叠加渐变面积（value 线下方）。
   */
  trendSeries(series, opts) {
    const o = opts || {};
    const W = o.w || 560, H = o.h || 300, pad = { l: 46, r: 12, t: 16, b: 26 };
    const list = (series || []).filter(s => Array.isArray(s.points) && s.points.length > 0);
    const len = list.length ? list[0].points.length : 0;
    if (len < 2) return '<div class="chart-empty">交易数据不足 2 个时间点，暂无法绘制走势</div>';
    let min = Infinity, max = -Infinity;
    list.forEach(s => s.points.forEach(p => { const v = Number(p.value); if (isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); } }));
    if (!isFinite(min)) return '<div class="chart-empty">暂无数据</div>';
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    const spanW = W - pad.l - pad.r, spanH = H - pad.t - pad.b;
    const xAt = i => pad.l + (len === 1 ? spanW / 2 : i / (len - 1) * spanW);
    const yAt = v => pad.t + (1 - (v - min) / range) * spanH;
    const isPct = o.fmt === 'pct';
    const fmtTick = v => isPct ? (Math.round(v * 10) / 10) + '%' : (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '万' : Math.round(v));
    let ticks = '';
    for (let k = 0; k <= 2; k++) {
      const v = min + range * k / 2;
      const yy = pad.t + (1 - k / 2) * spanH;
      ticks += '<line x1="' + pad.l + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + yy.toFixed(1) + '" stroke="rgba(0,0,0,.06)" stroke-width="1"/>' +
               '<text x="' + (pad.l - 6) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#a1a1a6">' + fmtTick(v) + '</text>';
    }
    // 零轴（收益率 / 回撤模式更直观）
    let zeroLine = '';
    if (o.zeroLine && min < 0 && max > 0) {
      const yz = yAt(0);
      zeroLine = '<line x1="' + pad.l + '" y1="' + yz.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + yz.toFixed(1) + '" stroke="rgba(0,0,0,.22)" stroke-width="1" stroke-dasharray="3 3"/>';
    }
    let chart = '<defs><linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#0071e3" stop-opacity=".16"/>' +
        '<stop offset="1" stop-color="#0071e3" stop-opacity=".02"/>' +
      '</linearGradient></defs>';
    list.forEach(s => {
      const pts = s.points;
      let path = '';
      pts.forEach((p, i) => { path += (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(Number(p.value)).toFixed(1) + ' '; });
      if (s.fill) {
        let area = 'M' + xAt(0).toFixed(1) + ' ' + yAt(Number(pts[0].value)).toFixed(1);
        pts.forEach((p, i) => { if (i) area += ' L' + xAt(i).toFixed(1) + ' ' + yAt(Number(p.value)).toFixed(1); });
        area += ' L' + xAt(pts.length - 1).toFixed(1) + ' ' + (pad.t + spanH).toFixed(1) +
                ' L' + xAt(0).toFixed(1) + ' ' + (pad.t + spanH).toFixed(1) + ' Z';
        chart += '<path d="' + area + '" fill="url(#trendArea)" stroke="none"/>';
      }
      chart += '<path d="' + path.trim() + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.dash ? 1.8 : 2.2) +
               '" stroke-linejoin="round" stroke-linecap="round"' + (s.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
    });
    const lastPt = list[0].points[list[0].points.length - 1];
    const firstPt = list[0].points[0];
    const legends = list.map(s => '<span><i style="background:' + s.color + '"></i>' + esc(s.label || '') + '</span>').join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-height:340px">' + ticks + zeroLine + chart +
      '<circle cx="' + xAt(len - 1).toFixed(1) + '" cy="' + yAt(Number(lastPt.value)).toFixed(1) + '" r="3.5" fill="' + list[0].color + '"/>' +
      '<text x="' + xAt(0) + '" y="' + (H - 8) + '" font-size="10" fill="#a1a1a6">' + esc(firstPt.date) + '</text>' +
      '<text x="' + (W - pad.r) + '" y="' + (H - 8) + '" text-anchor="end" font-size="10" fill="#a1a1a6">' + esc(lastPt.date) + '</text>' +
      '</svg>' +
      (legends ? '<div class="chart-legend">' + legends + '</div>' : '');
  },
  /** 兼容旧调用：市值 vs 累计净投入 双线图 */
  trend(points, w, h) {
    return Charts.trendSeries([
      { points: points.map(p => ({ date: p.date, value: p.value })), color: '#0071e3', label: '组合市值（估算）', fill: true },
      { points: points.map(p => ({ date: p.date, value: p.net })), color: '#8e8e93', label: '累计净投入', dash: true },
    ], { w, h, fmt: 'money' });
  }
};

/* ---------------- 状态 & 渲染 ---------------- */
let expanded = new Set();      // 展开卡片集合
// 筛选条件：category/currency（下拉）；risk/fxFlag/assetId 为旧版图表筛选遗留字段（恒为 null，保留兼容）
let filters = { category: 'all', currency: 'all', risk: null, fxFlag: null, assetId: null, sort: 'valueDesc' };
let trendMode = 'dual';        // 组合走势模式：dual / profit / rate / dd
let activeTab = 'assets';      // 主界面分页：assets（产品）/ stats（统计）

/* ---- 主界面分页切换：产品 / 统计 ---- */
function switchTab(name) {
  activeTab = (name === 'stats') ? 'stats' : 'assets';
  document.querySelectorAll('#main-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
  const assetsPanel = $id('panel-assets');
  const statsPanel = $id('panel-stats');
  if (assetsPanel) assetsPanel.classList.toggle('hidden', activeTab !== 'assets');
  if (statsPanel) statsPanel.classList.toggle('hidden', activeTab !== 'stats');
}

function getAsset(id) { return state.assets.find(a => a.id === id); }

/* ---- 汇总区（统计页：Hero 速览 + 指标磁贴 + 币种分布） ---- */
/* =====================================================================
 * 统计页（v6.3 重构）
 * 第一层 核心仪表盘（卡片）
 * 第二层 配置与结构（类别/市场/币种 横向条形图 + 金额 + 百分比）
 *        + 集中度（指标卡 + 超限提示）+ 持仓明细表
 * 附加  组合走势 / 盈亏构成（保留视图）
 * ===================================================================== */

/** 配置结构横向条形图：items = [{label, value, pct}] */
function distributionHTML(items, base, note) {
  if (!items.length) return '<div class="chart-empty">暂无数据</div>';
  const maxV = Math.max.apply(null, items.map(i => i.value)) || 1;
  const rows = items.map(it => {
    const w = Math.max(2, Math.round(Math.abs(it.value) / maxV * 100));
    const pct = it.pct != null ? Math.round(it.pct * 1000) / 10 : null;
    return '<div class="dist-row">' +
      '<div class="dist-label">' + esc(it.label) + '</div>' +
      '<div class="dist-track"><div style="width:' + w + '%;background:linear-gradient(90deg,#0a6cff,#4fb0ff)"></div></div>' +
      '<div class="dist-value">' + fmtMoney(it.value, base) +
        (pct != null ? '<em>' + pct + '%</em>' : '') + '</div>' +
    '</div>';
  }).join('');
  return '<div class="dist-list">' + rows + '</div>' +
    (note ? '<div class="hint" style="margin-top:8px;font-size:11px;color:var(--ink-3)">' + note + '</div>' : '');
}

/** 集中度：单一标的 / Top5 / Top10 指标卡 + 超限提示 */
function concentrationHTML(st, base) {
  const cards = [
    { l: '单一标的占比（最大持仓）', v: st.maxAsset ? fmtPct(st.maxAsset.pct * 100) : '--',
      sub: st.maxAsset ? esc(st.maxAsset.name) + ' · 市值 ' + fmtMoney(st.maxAsset.value, base) : '暂无持仓，无法计算' },
    { l: 'Top 5 持仓占比', v: st.totalValue > 0 ? fmtPct(st.top5 / st.totalValue * 100) : '--',
      sub: '市值最大的 5 个标的合计 ÷ 总市值' },
    { l: 'Top 10 持仓占比', v: st.totalValue > 0 ? fmtPct(st.top10 / st.totalValue * 100) : '--',
      sub: '市值最大的 10 个标的合计 ÷ 总市值' },
  ];
  const warn = st.overLimit.length
    ? '<div class="conc-warn"><b>⚠ 超过单一标的上限（阈值 ' + st.singleAssetCap + '%）</b>' +
      st.overLimit.map(o => '<div class="conc-warn-item">· ' + esc(o.name) + '：占比 ' + o.pct.toFixed(1) + '%（市值 ' + fmtMoney(o.value, base) + '）超过上限，注意集中度风险</div>').join('') + '</div>'
    : '<div class="conc-ok">✓ 各标的占比均未超过单一标的上限（阈值 ' + st.singleAssetCap + '%）</div>';
  return '<div class="conc-cards">' +
    cards.map(c => '<div class="conc-card"><div class="conc-label">' + c.l + '</div><div class="conc-value">' + c.v + '</div><div class="conc-sub">' + c.sub + '</div></div>').join('') +
  '</div>' + warn;
}

/** 持仓明细表（按市值降序；无数据时不显示 NaN） */
function detailTableHTML(st, base) {
  if (!st.detail.length) return '<div class="chart-empty" style="padding:26px 0">暂无持仓记录</div>';
  const head = ['标的名称', '资产类别', '市场', '币种', '数量', '成本价', '现价', '汇率', '市值', '浮动盈亏', '浮动盈亏率', '当日盈亏', '占比'];
  const rows = st.detail.map(r => {
    const a = r.asset;
    const isFx = a.category === 'fx';
    const curShow = isFx ? (a.foreignCurrency || 'FX') + '/CNY' : a.currency;
    const qtyTxt = r.pos.qty > 0 ? fmtQty(r.pos.qty) : '0';
    const avgCostTxt = r.pos.qty > 0 ? fmtQty(r.pos.avgCost) : '--';
    const priceTxt = a.lastPrice != null ? fmtQty(a.lastPrice) : '--';
    const rateTxt = isFx ? '1' : (r.rate == null ? '--' : fmtQty(r.rate));
    const mvTxt = r.baseValue != null ? fmtMoney(r.baseValue, base) : '--';
    const floatCls = r.baseFloat == null ? '' : (r.baseFloat >= 0 ? 'money-red' : 'money-green');
    const floatTxt = r.baseFloat != null ? fmtSignedMoney(r.baseFloat, base) : '--';
    const ratePctTxt = r.floatRate == null ? '--' : fmtPct(r.floatRate * 100);
    const dayCls = r.dayPnL == null ? '' : (r.dayPnL >= 0 ? 'money-red' : 'money-green');
    const dayTxt = r.dayPnL == null ? '--' : fmtSignedMoney(r.dayPnL, base);
    const shareTxt = r.sharePct == null ? '--' : fmtPct(r.sharePct * 100);
    return '<tr>' +
      '<td class="td-name">' + esc(a.name) + '</td>' +
      '<td>' + esc(CATEGORIES[a.category] ? CATEGORIES[a.category].label : (a.category || '其他')) + '</td>' +
      '<td>' + esc(r.market) + '</td>' +
      '<td>' + esc(curShow) + '</td>' +
      '<td class="tnum">' + qtyTxt + '</td>' +
      '<td class="tnum">' + avgCostTxt + '</td>' +
      '<td class="tnum">' + priceTxt + '</td>' +
      '<td class="tnum">' + rateTxt + '</td>' +
      '<td class="tnum">' + mvTxt + '</td>' +
      '<td class="tnum ' + floatCls + '">' + floatTxt + '</td>' +
      '<td class="tnum">' + ratePctTxt + '</td>' +
      '<td class="tnum ' + dayCls + '">' + dayTxt + '</td>' +
      '<td class="tnum">' + shareTxt + '</td>' +
    '</tr>';
  }).join('');
  return '<div class="table-wrap"><table class="detail-table">' +
    '<thead><tr>' + head.map(h => '<th>' + h + '</th>').join('') + '</tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>' +
    '<div class="hint" style="margin-top:10px;font-size:11px;color:var(--ink-3)">' +
    '口径：占比分母 = 总市值（基准 ' + esc(base) + '）；汇率 = 1 币种兑基准币种；浮动盈亏率 = 浮动盈亏 ÷ 持仓成本；' +
    '当日盈亏 = 数量 × (现价 − 前一交易日收盘)，仅有行情日K缓存的产品可算，否则显示 --；' +
    '已实现盈亏为卖出落袋收益（已折算为基准币种）。</div>';
}

/** 统计页总渲染（v6.3：仪表盘 + 配置结构 + 集中度 + 明细 + 走势/构成） */
function renderStats() {
  const st = Calc.statistics(state.assets, state.trades, state.settings, {
    liabilities: state.settings.liabilities || 0,
    singleAssetCap: state.settings.singleAssetCap != null ? state.settings.singleAssetCap : 20,
  });
  const base = st.base;
  const cls = v => (v > 0.004 ? 'money-red' : v < -0.004 ? 'money-green' : '');

  // 第一层：核心仪表盘（卡片，含金额与比率）
  const dash = [
    { l: '总市值（' + base + '）', v: fmtMoney(st.totalValue, base), sub: '全部持仓折合 ' + base, big: true },
    { l: '净资产（' + base + '）', v: fmtMoney(st.netWorth, base), sub: '总市值 − 负债 ' + fmtMoney(st.liabilities, base), big: true },
    { l: '总投入本金', v: fmtMoney(st.totalCost, base), sub: '当前持仓成本合计', c: '' },
    { l: '总浮动盈亏', v: fmtSignedMoney(st.totalFloat, base), sub: '浮动盈亏率 ' + (st.floatRate == null ? '--' : fmtPct(st.floatRate * 100)) + ' = 浮动 ÷ 投入本金', c: cls(st.totalFloat) },
    { l: '已实现盈亏', v: fmtSignedMoney(st.totalRealized, base), sub: '卖出落袋收益，已折算 ' + base, c: cls(st.totalRealized) },
    { l: '总盈亏', v: fmtSignedMoney(st.totalProfit, base), sub: '总浮动 + 已实现', c: cls(st.totalProfit) },
  ].map(d => '<div class="dash-card' + (d.big ? ' big' : '') + '">' +
    '<div class="dash-label">' + d.l + '</div>' +
    '<div class="dash-value ' + (d.c || '') + '">' + d.v + '</div>' +
    '<div class="dash-sub">' + d.sub + '</div></div>').join('');

  // 现金 vs 风险资产卡（含占比比例条）
  const cashCard = '<div class="dash-card dash-wide">' +
    '<div class="dash-label">现金 vs 风险资产（占比分母 = 总市值）</div>' +
    '<div class="dash-pair">' +
      '<div class="dash-pair-item"><b>' + fmtMoney(st.cashValue, base) + '</b><span>现金及等价物 · ' + (st.cashPct == null ? '--' : fmtPct(st.cashPct * 100)) + '</span></div>' +
      '<div class="dash-pair-item"><b>' + fmtMoney(st.riskValue, base) + '</b><span>风险资产 · ' + (st.riskPct == null ? '--' : fmtPct(st.riskPct * 100)) + '</span></div>' +
    '</div>' +
    '<div class="dash-bar"><div class="dash-bar-cash" style="width:' + (st.cashPct != null ? Math.max(0, Math.min(100, st.cashPct * 100)).toFixed(1) : 0) + '%"></div></div>' +
    '<div class="dash-note">口径：现金及等价物 = 存款 + 货币基金 + 外币现汇/现钞；其余为风险资产。两者占比之和 = 100%。</div>' +
  '</div>';
  $id('dash-cards').innerHTML = dash + cashCard;

  // 第二层：配置与结构（横向条形图 + 金额 + 百分比）
  $id('dist-groups').innerHTML = distributionHTML(st.groups, base,
    '类别口径：股票 / 债券 / 基金ETF（含各类非货币基金）/ 商品 / 数字货币 / 现金及等价物（存款 + 货币基金 + 外币现汇现钞）/ 其他（银行理财、保险等）。占比分母 = 总市值。');
  $id('dist-markets').innerHTML = distributionHTML(st.markets, base,
    '市场按标的代码与股票小类判断：A股（沪/深/北）/ 港股 / 美股；其余（如无行情代码的基金等）归入「其他」。占比分母 = 总市值。');
  $id('dist-currencies').innerHTML = distributionHTML(st.currencies, base,
    '币种敞口按资产计价币种（外币产品按其外币币种）归集为 CNY / USD / HKD / 其他；此处仅展示未对冲敞口占比，不做对冲测算。占比分母 = 总市值。');

  // 集中度
  $id('concentration').innerHTML = concentrationHTML(st, base);

  // 持仓明细表
  $id('detail-table').innerHTML = detailTableHTML(st, base);

  // 附加视图：组合走势（多模式）+ 盈亏构成
  renderTrendChart();
  $id('profit-chart').innerHTML = profitChartHTML(Calc.summary(state.assets, state.valuations, state.settings, state.trades));
}

/** 盈亏构成卡片（以图为主）：两个迷你环图——浮动 vs 已实现、盈利 vs 亏损 */
function profitChartHTML(s) {
  if (!s.metrics.length) return '<div class="chart-empty">暂无数据</div>';
  const base = state.settings.baseCurrency;
  let gainSum = 0, lossSum = 0;
  let gainCount = 0, lossCount = 0;
  s.metrics.forEach(m => {
    const total = m.baseTotal != null ? m.baseTotal : m.baseProfit;
    if (total > 0.004) { gainSum += total; gainCount++; }
    else if (total < -0.004) { lossSum += total; lossCount++; }
  });
  // 迷你环图：正(盈利)红 / 负(亏损)绿，环面积按绝对值占比
  const donutOf = (items, centerLines) => Charts.ring(
    items.filter(it => it.value !== 0).map(it => ({
      key: it.label,
      label: it.label + ' ' + fmtSignedMoney(it.value, base),
      value: Math.abs(it.value),
      color: it.value > 0 ? '#d70015' : '#1d9e49',
    })),
    175,
    centerLines
  );
  return '<div class="profit-donuts">' +
    '<div class="donut"><div class="donut-title">浮动 vs 已实现</div>' +
      donutOf([
        { label: '浮动盈亏', value: s.totalFloat },
        { label: '已实现盈亏', value: s.totalRealized },
      ], ['总盈亏', fmtSignedMoney(s.totalProfit, base)]) + '</div>' +
    '<div class="donut"><div class="donut-title">盈利 vs 亏损产品</div>' +
      donutOf([
        { label: '盈利产品合计', value: gainSum },
        { label: '亏损产品合计', value: lossSum },
      ], ['盈 ' + gainCount + ' / 亏 ' + lossCount, '']) + '</div>' +
  '</div>';
}

/* ---- 组合走势卡：多统计模式（市值/收益/收益率/回撤）+ 指标条 ---- */
const TREND_MODES = {
  dual:   { label: '市值 vs 净投入', desc: '估算市值与累计净投入对比' },
  profit: { label: '累计收益',      desc: '市值 − 累计净投入（按现价估算）' },
  rate:   { label: '收益率',        desc: '累计收益 ÷ 累计投入（%）' },
  dd:     { label: '回撤',          desc: '距历史峰值的回撤（%）' },
};

function renderTrendChart() {
  const s = Calc.summary(state.assets, state.valuations, state.settings, state.trades);
  const base = state.settings.baseCurrency;
  const pts = Calc.portfolioTrend(state.assets, state.trades, state.settings);

  // 按模式生成系列
  // 注意：portfolioTrend 的 net = Σ卖出 − Σ买入，即「负的累计净投入」；
  // 因此 累计净投入 = −net，累计收益 = 市值 − 净投入 = value + net。
  let series, opts;
  if (trendMode === 'profit') {
    series = [{ points: pts.map(p => ({ date: p.date, value: round2(p.value + p.net) })), color: '#0071e3', label: '累计收益', fill: true }];
    opts = { fmt: 'money' };
  } else if (trendMode === 'rate') {
    series = [{ points: pts.map(p => ({ date: p.date, value: p.net < 0 ? round2((p.value + p.net) / (-p.net) * 100) : 0 })), color: '#0071e3', label: '收益率（%）' }];
    opts = { fmt: 'pct', zeroLine: true };
  } else if (trendMode === 'dd') {
    const dd = Calc.maxDrawdown(pts);
    series = [{ points: dd.series.map(d => ({ date: d.date, value: round2(d.dd * 100) })), color: '#d70015', label: '回撤（%）' }];
    opts = { fmt: 'pct', zeroLine: true };
  } else {
    series = [
      { points: pts.map(p => ({ date: p.date, value: p.value })), color: '#0071e3', label: '组合市值（估算）', fill: true },
      { points: pts.map(p => ({ date: p.date, value: round2(-p.net) })), color: '#8e8e93', label: '累计净投入', dash: true },
    ];
    opts = { fmt: 'money' };
  }
  $id('trend-chart').innerHTML = Charts.trendSeries(series, opts);

  // 指标条：收益/年化/回撤/波动/夏普（一般投资产品常见统计）
  const pm = Calc.portfolioMetrics(pts, state.settings);
  const xirrValue = Calc.xirr(state.assets, state.trades, state.settings);
  const rfPct = Number(state.settings.riskFreeRate) != null ? Number(state.settings.riskFreeRate) : 2;
  const chips = [
    { l: '累计收益', v: fmtSignedMoney(s.totalProfit, base), cls: s.totalProfit >= 0 ? 'money-red' : 'money-green' },
    { l: '总收益率', v: s.totalRate == null ? '--' : fmtPct(s.totalRate * 100), cls: (s.totalRate || 0) >= 0 ? 'money-red' : 'money-green' },
    { l: '年化 · 资金加权（XIRR）', v: xirrValue == null ? '--' : fmtPct(xirrValue * 100), cls: (xirrValue || 0) >= 0 ? 'money-red' : 'money-green' },
    { l: '年化 · 简单（CAGR）', v: pm.cagr == null ? '--' : fmtPct(pm.cagr * 100), cls: (pm.cagr || 0) >= 0 ? 'money-red' : 'money-green' },
    { l: '最大回撤', v: pm.maxDD == null ? '--' : fmtPct(pm.maxDD * 100), cls: 'money-green' },
    { l: '当前回撤', v: pm.currentDD == null ? '--' : fmtPct(pm.currentDD * 100), cls: 'money-green' },
    { l: '年化波动率', v: pm.vol == null ? '--' : fmtPct(pm.vol * 100), cls: '' },
    { l: '夏普（无风险 ' + rfPct + '%）', v: pm.sharpe == null ? '--' : pm.sharpe.toFixed(2), cls: (pm.sharpe || 0) >= 0 ? 'money-red' : 'money-green' },
  ];
  $id('trend-stats').innerHTML = chips.map(c =>
    '<div class="ts"><span>' + c.l + '</span><b class="' + c.cls + '">' + c.v + '</b></div>').join('');

  // 描述与模式按钮联动
  const desc = $id('trend-desc');
  if (desc && TREND_MODES[trendMode]) desc.textContent = TREND_MODES[trendMode].desc + '（点击上方模式切换）';
  document.querySelectorAll('#trend-modes button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === trendMode);
    btn.onclick = () => setTrendMode(btn.dataset.mode);
  });
}

function setTrendMode(mode) {
  if (!TREND_MODES[mode]) return;
  trendMode = mode;
  renderTrendChart();
}

/* ---- 产品列表 ---- */
function filteredAssets() {
  let list = state.assets.slice();
  if (filters.category !== 'all') list = list.filter(a => a.category === filters.category);
  if (filters.currency !== 'all') list = list.filter(a => a.currency === filters.currency);
  // 图表点击筛选（v6.1）：风险等级 / 外币币种 / 单个产品
  if (filters.assetId) list = list.filter(a => a.id === filters.assetId);
  if (filters.risk === '未设置') list = list.filter(a => !a.riskLevel);
  else if (filters.risk) list = list.filter(a => a.riskLevel === filters.risk);
  if (filters.fxFlag) list = list.filter(a => a.category === 'fx' && a.foreignCurrency === filters.fxFlag);
  // 排序指标：统一按交易记录口径计算（v6）
  const metricsOf = a => {
    const pos = Calc.tradePosition(a, state.trades, a.lastPrice != null ? Number(a.lastPrice) : null);
    return {
      rate: pos.cost > 0 && pos.float != null ? pos.float / pos.cost : null,
      days: pos.days,
      baseValue: Calc.toBase(pos.marketValue, a.currency, state.settings),
      simpleAnnual: pos.days > 0 && pos.cost > 0 && pos.float != null ? pos.float / pos.cost * 365 / pos.days : null,
    };
  };
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

/* ---- 产品卡片（v6 统一：所有产品走交易记录口径，按类别区分展示侧重） ---- */
function assetCardHTML(asset) {
  const isStock = asset.category === 'stock';
  const isFx = asset.category === 'fx';
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
  // 币种标签：外币产品展示「外币/CNY」（金额以人民币计），其余展示资产币种
  const currencyTag = isFx
    ? '<span class="tag alt">' + esc(asset.foreignCurrency || '外币') + '/CNY</span>'
    : '<span class="tag alt">' + esc(asset.currency) + '</span>';

  // 可卖徽章（v6 批次制：非股票按每笔买入的最低持有天数；股票/历史数据回退资产级配置）
  const sell = Calc.sellStatus(asset, state.trades, todayStr());
  const sellBadge = sell.sellable === null ? ''
    : sell.sellable
      ? '<span class="badge-sell sellable">可卖</span>'
      : sell.partial
        ? '<span class="badge-sell partial">部分可卖 · ' + fmtQty(sell.lockedQty) + ' 份锁定</span>'
        : '<span class="badge-sell locked">不可卖 · 还需 ' + sell.remainingDays + ' 天</span>';

  const base = state.settings.baseCurrency;
  const baseValue = m.marketValue != null ? Calc.toBase(m.marketValue, asset.currency, state.settings) : null;
  const baseHint = (asset.currency !== base && baseValue != null)
    ? '<div class="asset-meta" style="margin-top:2px">折合 ' + base + '：' + fmtMoney(baseValue, base) + '</div>'
    : '';
  const quoteInfo = asset.symbol
    ? '<div class="asset-meta" style="margin-top:2px"><span>代码 ' + esc(asset.symbol) + '</span>' +
      (asset.lastPrice != null ? '<span>现价 ' + fmtQty(asset.lastPrice) + '</span>' : '') +
      (asset.lastQuoteAt ? '<span>行情 ' + new Date(asset.lastQuoteAt).toLocaleString('zh-CN') + '</span>' : '') + '</div>'
    : '';

  // 元信息行
  const metaLine =
    '<span>持有 ' + m.days + ' 天</span>' +
    '<span>交易 ' + m.events.length + ' 笔</span>' +
    (isStock ? '<span>持仓 ' + fmtQty(m.qty) + ' 股</span>' : '') +
    (isFx && m.qty > 0 ? '<span>' + esc(asset.foreignCurrency || '外币') + ' 余额 ' + fmtQty(m.qty) + '</span>' : '') +
    (sell.minDays != null && !sell.settled ? '<span>最低持有 ' + sell.minDays + ' 天</span>' : '') +
    (m.received > 0 ? '<span>已回收 ' + fmtMoney(m.received, asset.currency) + '</span>' : '');

  // 指标区：股票侧重视数量与单价；非股票侧重视金额（持仓总金额 / 累计投入）
  let figures;
  if (isStock) {
    figures =
      '<div class="fig"><div class="k">持仓数量</div><div class="v">' + fmtQty(m.qty) + '</div></div>' +
      '<div class="fig"><div class="k">平均成本</div><div class="v">' + fmtQty(m.avgCost) + '</div></div>' +
      '<div class="fig"><div class="k">现价</div><div class="v">' + priceStr(asset) + '</div></div>' +
      '<div class="fig"><div class="k">当前市值</div><div class="v">' + (m.marketValue != null ? fmtMoney(m.marketValue, asset.currency) : '--') + '</div></div>';
  } else {
    figures =
      '<div class="fig"><div class="k">持仓金额</div><div class="v">' + (m.marketValue != null ? fmtMoney(m.marketValue, asset.currency) : '--') + '</div></div>' +
      '<div class="fig"><div class="k">累计投入（成本）</div><div class="v">' + fmtMoney(m.cost, asset.currency) + '</div></div>' +
      (m.qty > 0
        ? '<div class="fig"><div class="k">当前' + (isFx ? '汇率' : '单位价值') + '</div><div class="v">' + priceStr(asset) + '</div></div>'
        : '') +
      '<div class="fig"><div class="k">持有份额' + (isFx ? '（外币余额）' : '') + '</div><div class="v">' + fmtQty(m.qty) + '</div></div>';
  }
  figures +=
    '<div class="fig"><div class="k">浮动盈亏</div><div class="v ' + floatCls + '">' + (m.float != null ? fmtSignedMoney(m.float, asset.currency) : '--') + '</div></div>' +
    '<div class="fig"><div class="k">已实现盈亏</div><div class="v ' + realCls + '">' + fmtSignedMoney(m.realized, asset.currency) + '</div></div>' +
    '<div class="fig"><div class="k">总盈亏（浮+实）</div><div class="v annual ' + totalCls + '">' + fmtSignedMoney(m.totalProfit, asset.currency) + '</div></div>' +
    '<div class="fig"><div class="k">年化（近似）' + (m.float == null ? ' · 需现价' : '') + '</div><div class="v ' + annualCls + '">' + annualStr + '</div></div>';

  const expand = isExpanded
    ? '<div class="asset-expand"><div class="expand-grid">' +
        '<div>' + tradeTimelineHTML(asset, m) + '</div>' +
        (isStock ? '<div>' + quoteChartHTML(asset) + '</div>' : '') +
      '</div></div>'
    : '';

  return '<div class="asset-card' + (isExpanded ? ' expanded' : '') + '" data-asset-id="' + asset.id + '">' +
    '<div class="asset-main">' +
      '<div>' +
        '<div class="asset-head">' +
          '<span class="asset-name">' + esc(asset.name) + '</span>' +
          '<span class="tag">' + esc(cat.label) + '</span>' +
          (subTag ? '<span class="tag alt">' + esc(subTag) + '</span>' : '') +
          riskTag + tplusTag + currencyTag +
        '</div>' +
        '<div class="asset-meta">' + sellBadge + metaLine + '</div>' +
        '<div class="asset-figures">' + figures + '</div>' +
        (baseHint) + quoteInfo +
        (asset.note ? '<div class="asset-meta" style="margin-top:2px">备注：' + esc(asset.note) + '</div>' : '') +
      '</div>' +
      '<div class="asset-actions">' +
        '<button class="btn btn-mini btn-primary" data-action="addBuy">＋ 买入</button>' +
        '<button class="btn btn-mini ghost" data-action="addSell">− 卖出</button>' +
        (asset.symbol ? '<button class="btn btn-mini ghost" data-action="refreshQuote">⟳ 刷新行情</button>' : '') +
        '<button class="btn btn-mini ghost" data-action="manualPrice">' + (isStock ? '✎ 现价' : '✎ 市值') + '</button>' +
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
      Charts.line(points, 560, 200) +
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
  renderStats();
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
  const isNew = !asset;
  // 单一「添加产品」入口：默认大类为基金，表单中可自由切换（选股票 → 填代码；选外币 → 选外币币种）
  const defCategory = (preset && preset.category) || 'fund';
  const a = asset || { name: '', category: defCategory, subCategory: '', currency: 'CNY', foreignCurrency: 'USD', note: '', riskLevel: '', tPlusN: '', symbol: '' };
  const catKey = CATEGORIES[a.category] ? a.category : Object.keys(CATEGORIES)[0];
  const isStock = catKey === 'stock';
  const isFx = catKey === 'fx';
  const effCurrency = isFx ? 'CNY' : (a.currency || 'CNY');

  // 股票：代码必填（自动识别市场/币种/名称）
  const symField = '<div class="field full" id="f-sym-row"' + (isStock ? '' : ' style="display:none"') + '><label>股票代码 *</label>' +
    '<input id="f-symbol" type="text" placeholder="A股 600519 / 000001，港股 00700，美股 KO / AAPL" value="' + esc(a.symbol || '') + '">' +
    '<div class="hint">输入代码后自动识别市场（A股/港股/美股/北交所）并带出币种与名称；网络不可用时名称可手动填写，币种也可手动改</div></div>';

  // 外币：选外币币种（用人民币买/卖，填汇率折算）
  const fxField = '<div class="field" id="f-fx-row"' + (isFx ? '' : ' style="display:none"') + '><label>外币币种 *</label>' +
    '<select id="f-foreign">' + FX_CURRENCIES.map(c =>
      '<option value="' + c + '"' + (c === (a.foreignCurrency || 'USD') ? ' selected' : '') + '>' + c + ' ' + currencyName(c) + '</option>').join('') + '</select>' +
    '<div class="hint">以人民币买入/卖出该外币；买卖时填写成交汇率（1 外币 = ? 人民币），持仓金额与收益均按人民币计</div></div>';

  // 普通币种（外币产品固定人民币，隐藏该栏）
  const currencyField = '<div class="field" id="f-cur-row"' + (isFx ? ' style="display:none"' : '') + '><label>币种 *</label>' +
    '<select id="f-currency">' + currencyOptionsHTML(effCurrency) + '</select>' +
    '<div class="hint" id="f-currency-custom-hint" style="display:none">自定义币种请输入 3 位大写代码（如 KRW）</div></div>';

  const hint = isStock
    ? '<div class="field full"><div class="hint" style="color:var(--ink-2);line-height:1.7">股票加入后为「监察表」状态：暂无买入与市值。随时点卡片「＋ 买入」录入首笔（统一填<b>单股价格</b>，金额自动计算）；点「✎ 现价」可手动记录当前股价，或「⟳ 刷新行情」联网获取。</div></div>'
    : isFx
      ? '<div class="field full"><div class="hint" style="color:var(--ink-2);line-height:1.7">外币产品买入时填写<b>花费的人民币</b>与成交<b>汇率</b>，系统自动算出外币金额；卖出同理。当前市值 = 外币余额 × 当前汇率（「✎ 市值」可改）。收益 = 现在能换回的人民币 − 当初花出的人民币。</div></div>'
      : '<div class="field full"><div class="hint" style="color:var(--ink-2);line-height:1.7">产品添加后通过卡片「＋ 买入 / − 卖出」逐笔记账，支持填<b>份数×单价</b>或<b>总金额</b>两种方式，买卖自动累计为持仓——无需在此填写本金。</div></div>';

  return '<div class="form-grid">' +
    '<div class="field full"><label>产品名称 *</label><input id="f-name" type="text" placeholder="如：沪深300指数基金 / 招商银行 / 美元现汇" value="' + esc(a.name) + '"></div>' +
    '<div class="field"><label>大类 *</label><select id="f-category">' + categoryOptionsHTML(catKey) + '</select></div>' +
    '<div class="field"><label>小类（子类）</label><select id="f-subcategory">' + subCategoryHTML(catKey, a.subCategory) + '</select></div>' +
    symField + fxField + currencyField +
    '<div class="field"><label>风险等级（可选）</label><select id="f-risk">' +
      '<option value="">未设置</option>' +
      RISK_LEVELS.map(r => '<option value="' + r.key + '"' + (r.key === a.riskLevel ? ' selected' : '') + '>' + r.label + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>T+n 到账（可选）</label><input id="f-tplusn" type="number" min="0" step="1" placeholder="如 1（T+1）" value="' + esc(a.tPlusN) + '">' +
      '<div class="hint">赎回/卖出后多少个交易日到账</div></div>' +
    '<div class="field full"><label>备注（可选）</label><input id="f-note" type="text" placeholder="如：定投账户 / 美元现金池" value="' + esc(a.note) + '"></div>' +
    hint +
  '</div>';
}

function openAssetForm(assetId, preset) {
  const asset = assetId ? getAsset(assetId) : null;
  openModal((asset ? '编辑产品 · ' + asset.name : '添加产品'), assetFormHTML(asset, preset), () => submitAsset(assetId));

  // 联动：大类变化 → 刷新小类，并切换「股票代码 / 外币币种 / 普通币种」三栏
  const catSel = $id('f-category');
  const subSel = $id('f-subcategory');
  const curSel = $id('f-currency');
  const applyCat = () => {
    subSel.innerHTML = subCategoryHTML(catSel.value);
    const isStockNow = catSel.value === 'stock';
    const isFxNow = catSel.value === 'fx';
    $id('f-sym-row').style.display = isStockNow ? '' : 'none';
    $id('f-fx-row').style.display = isFxNow ? '' : 'none';
    $id('f-cur-row').style.display = isFxNow ? 'none' : '';
  };
  catSel.onchange = applyCat;
  curSel.onchange = () => {
    $id('f-currency-custom-hint').style.display = curSel.value === '__custom__' ? 'block' : 'none';
  };
  // 股票监察表：输入代码自动识别市场并联动币种与名称
  const symSel = $id('f-symbol');
  if (symSel) {
    symSel.onchange = () => autoFillFromCode(symSel, curSel, $id('f-name'));
    symSel.onblur = () => autoFillFromCode(symSel, curSel, $id('f-name'));
  }
}

function submitAsset(assetId) {
  const asset = assetId ? getAsset(assetId) : null;
  const name = $id('f-name').value.trim();
  const category = $id('f-category').value;
  const subCategory = $id('f-subcategory').value;
  const isStock = category === 'stock';
  const isFx = category === 'fx';
  let currency = isFx ? 'CNY' : $id('f-currency').value;
  if (currency === '__custom__') {
    currency = prompt('请输入自定义币种代码（3 位大写字母，如 KRW）');
  }
  const symbolRaw = isStock ? $id('f-symbol').value.trim() : '';
  const symbol = symbolRaw === '' ? null : symbolRaw;
  const foreignCurrency = isFx ? ($id('f-foreign').value || 'USD') : (asset ? asset.foreignCurrency : null);

  // 股票监察表：代码必填且可识别
  if (isStock) {
    if (!symbol) {
      alert('股票只需填写代码即可加入监察表（如 A股 600519、港股 00700、美股 KO），买入信息之后再点「＋ 买入」录入。');
      return;
    }
    const norm = normalizeSymbol(symbol);
    if (!norm.ok) { alert(norm.error); return; }
  }
  const riskLevel = $id('f-risk').value || null;
  const tPlusNRaw = $id('f-tplusn').value.trim();
  const tPlusN = tPlusNRaw === '' ? null : Math.floor(parseFloat(tPlusNRaw));
  const note = $id('f-note').value.trim();
  if (tPlusN != null && (!isFinite(tPlusN) || tPlusN < 0)) {
    alert('T+n 必须是非负整数。'); return;
  }
  const valid = name && currency && /^[A-Z]{3}$/.test(currency);
  if (!valid) { alert('请检查：名称必填、币种为 3 位大写代码。'); return; }
  if (!CURRENCIES[currency] && !CUSTOM_CURRENCIES[currency]) {
    CUSTOM_CURRENCIES[currency] = { symbol: currency + ' ', name: currency };
  }

  if (asset) {
    asset.name = name; asset.category = category; asset.subCategory = subCategory;
    asset.currency = currency; asset.foreignCurrency = foreignCurrency;
    asset.note = note; asset.riskLevel = riskLevel; asset.tPlusN = tPlusN;
    asset.symbol = symbol;
    asset.updatedAt = Date.now();
  } else {
    state.assets.push({
      id: uid('asset_'), name, category, subCategory, currency, foreignCurrency,
      note, riskLevel, tPlusN, symbol,
      startDate: null, principal: 0, quantity: null, minHoldDays: null,
      createdAt: Date.now(), updatedAt: Date.now(),
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

/**
 * 交易表单（v6）：支持两到三种录入方式
 *  - qty（份数×单价）：填份数与成交单价，金额自动算——股票默认
 *  - amount（总金额）：填总金额，份额自动折算——非股票（非外币）默认
 *  - exchange（兑换，仅外币）：买入填「花费人民币 + 买入外币」，卖出填「收回人民币 + 卖出外币」，
 *    汇率 = 人民币金额 ÷ 外币数量 自动反推——外币默认
 * 非股票产品的每笔「买入」可单独设置最低持有天数（如基金持有 7 天后赎回免手续费）。
 */
function tradeFormHTML(asset, type, trade) {
  const t = trade || { date: todayStr(), quantity: '', price: '', fee: '', note: '', minHoldDays: '' };
  const isBuy = type === 'buy';
  const isStock = asset.category === 'stock';
  const isFx = asset.category === 'fx';
  const fxName = asset.foreignCurrency || '外币';
  const qtyLabel = isFx ? '外币金额（' + esc(fxName) + '）' : (isStock ? '数量（股）' : '数量 / 份额');
  const priceLabel = isFx
    ? '成交汇率（1 ' + esc(fxName) + ' = ? 人民币）'
    : '成交单价（' + esc(asset.currency) + '）';
  // 默认录入方式：股票 → 份数×单价；外币 → 兑换（人民币 × 外币）；其他 → 总金额
  const defMode = trade ? (trade.mode || (isFx ? 'exchange' : 'qty')) : (isStock ? 'qty' : (isFx ? 'exchange' : 'amount'));
  const pos = Calc.tradePosition(asset, state.trades, null);

  const modeSwitch = '<div class="field full"><label>录入方式</label>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<label class="input-mode"><input type="radio" name="tmode" value="qty"' + (defMode === 'qty' ? ' checked' : '') + '> 份数 × 单价</label>' +
      '<label class="input-mode"><input type="radio" name="tmode" value="amount"' + (defMode === 'amount' ? ' checked' : '') + '> 总金额</label>' +
      (isFx ? '<label class="input-mode"><input type="radio" name="tmode" value="exchange"' + (defMode === 'exchange' ? ' checked' : '') + '> 兑换（人民币 × ' + esc(fxName) + '）</label>' : '') +
    '</div></div>';

  // 份数行：总金额 / 兑换模式下隐藏（否则会同时要求填写份数与总金额）
  const qtyField = '<div class="field" id="t-qty-row" style="display:' + (defMode === 'amount' || defMode === 'exchange' ? 'none' : '') + '"><label>' + qtyLabel + ' *</label>' +
    '<input id="t-qty" type="number" min="0" step="any" placeholder="如 100" value="' + esc(t.quantity) + '">' +
    '<div class="hint">份数 × 单价 = ' + (isFx ? '人民币金额' : '交易金额') + '（自动计算）</div></div>';

  const amountField = '<div class="field" id="t-amount-row" style="display:' + (defMode === 'amount' ? '' : 'none') + '">' +
    '<label>' + (isFx ? '人民币金额' : '总金额（' + esc(asset.currency) + '）') + ' *</label>' +
    '<input id="t-amount" type="number" min="0" step="0.01" placeholder="如 10000" value="' + esc(t.quantity != null && t.quantity !== '' ? round2(Number(t.quantity) * Number(t.price || 1)) : '') + '">' +
    '<div class="hint">填写这次交易的总投入/总回收金额，' + (isFx ? '外币数量' : '份额') + '自动按「当前单位价值」折算；当前无单位价值时整笔金额按 1 份记录（金额即单价）。</div></div>';

  // 单价行：仅「份数 × 单价」模式需要；总金额 / 兑换模式隐藏，不要求填写单价
  const priceField = '<div class="field" id="t-price-row" style="display:' + (defMode === 'amount' || defMode === 'exchange' ? 'none' : '') + '"><label>' + priceLabel + ' *</label>' +
    '<input id="t-price" type="number" min="0" step="any" placeholder="如 12.50" value="' + esc(t.price) + '">' +
    '<div class="hint">份数 × 单价 = ' + (isFx ? '人民币金额' : '交易金额') + '（自动计算）。</div></div>';

  // 兑换行（仅外币）：买入填「花费人民币 + 买入外币」，卖出填「收回人民币 + 卖出外币」
  const exchangeField = isFx
    ? '<div class="field full" id="t-exchange-row" style="display:' + (defMode === 'exchange' ? '' : 'none') + '">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">' +
        '<div><label>' + (isBuy ? '花费人民币' : '收回人民币') + ' *</label>' +
        '<input id="t-cny" type="number" min="0" step="0.01" placeholder="如 14300" value="' + esc(t.quantity != null && t.quantity !== '' && t.price != null && t.price !== '' ? round2(Number(t.quantity) * Number(t.price)) : '') + '"></div>' +
        '<div><label>' + (isBuy ? '买入外币（' : '卖出外币（') + esc(fxName) + '） *</label>' +
        '<input id="t-fxqty" type="number" min="0" step="any" placeholder="如 2000" value="' + esc(t.quantity) + '"></div>' +
      '</div>' +
      '<div class="hint">成交汇率 = 人民币金额 ÷ 外币数量，自动计算：<span id="t-fx-rate">' +
        (t.price != null && t.price !== '' ? '1 ' + fxName + ' ≈ ' + fmtQty(t.price) + ' 人民币' : '待填写') +
        '</span>；手续费另填。</div></div>'
    : '';

  const minHoldField = (isBuy && !isStock)
    ? '<div class="field full"><label>这笔买入的最低持有天数（可选）</label><input id="t-minhold" type="number" min="0" step="1" placeholder="如 7（持有 7 天后再卖免手续费）" value="' + esc(t.minHoldDays != null ? t.minHoldDays : '') + '">' +
      '<div class="hint">不同时期买入可设置各自天数：未到期批次显示「锁定」，全部到期显示「可卖」</div></div>'
    : '';

  return '<div class="form-grid">' +
    '<div class="field"><label>日期 *</label><input id="t-date" type="date" value="' + esc(t.date) + '"></div>' +
    '<div class="field"><label>手续费（可选）</label><input id="t-fee" type="number" min="0" step="0.01" placeholder="0.00" value="' + esc(t.fee) + '"></div>' +
    modeSwitch +
    qtyField + amountField + priceField + exchangeField +
    minHoldField +
    '<div class="field full"><label>备注（可选）</label><input id="t-note" type="text" placeholder="如：分批建仓 / 部分止盈" value="' + esc(t.note) + '"></div>' +
    (isBuy ? '' : '<div class="field full"><div class="hint">当前持仓 <b>' + fmtQty(pos.qty) + '</b>' + (isFx ? '（' + esc(fxName) + '）' : '') + '，卖出数量不能超过持仓。</div></div>') +
  '</div>';
}

function openTradeForm(assetId, type, tradeId) {
  const asset = getAsset(assetId);
  const trade = tradeId ? state.trades.find(x => x.id === tradeId) : null;
  const fxName = asset.foreignCurrency || '外币';
  const title = trade ? '编辑交易 · ' + asset.name : (type === 'buy' ? '买入 · ' : '卖出 · ') + asset.name;
  openModal(title, tradeFormHTML(asset, trade ? trade.type : type, trade),
    () => submitTrade(assetId, tradeId, trade ? trade.type : type));

  // 录入方式切换：份数×单价 ⇄ 总金额（外币另有「兑换」方式）
  const qtyRadio = document.querySelector('input[name="tmode"][value="qty"]');
  const amountRadio = document.querySelector('input[name="tmode"][value="amount"]');
  const exchangeRadio = document.querySelector('input[name="tmode"][value="exchange"]');
  if (qtyRadio && amountRadio) {
    const applyMode = () => {
      const isAmount = amountRadio.checked;
      const isExchange = exchangeRadio ? exchangeRadio.checked : false;
      // 份数、单价只在「份数 × 单价」模式显示；总金额模式只要求填写总金额
      $id('t-qty-row').style.display = (isAmount || isExchange) ? 'none' : '';
      $id('t-amount-row').style.display = isAmount ? '' : 'none';
      $id('t-price-row').style.display = (isAmount || isExchange) ? 'none' : '';
      const fxRow = $id('t-exchange-row');
      if (fxRow) fxRow.style.display = isExchange ? '' : 'none';
    };
    qtyRadio.onchange = applyMode;
    amountRadio.onchange = applyMode;
    if (exchangeRadio) exchangeRadio.onchange = applyMode;
    // 打开表单时立即按默认录入方式同步一次：
    // 修复首次进入总金额模式时仍显示「份数 / 单价」输入行的问题
    applyMode();
  }
  // 兑换模式：实时显示折算汇率（人民币 ÷ 外币）
  if (exchangeRadio && document.getElementById('t-cny')) {
    const updateFxRate = () => {
      const cny = parseFloat($id('t-cny').value);
      const fq = parseFloat($id('t-fxqty').value);
      const rateEl = $id('t-fx-rate');
      if (isFinite(cny) && cny > 0 && isFinite(fq) && fq > 0 && rateEl) {
        rateEl.textContent = '1 ' + fxName + ' ≈ ' + fmtQty(cny / fq) + ' 人民币';
      }
    };
    $id('t-cny').oninput = updateFxRate;
    $id('t-fxqty').oninput = updateFxRate;
    updateFxRate();
  }
}

function submitTrade(assetId, tradeId, type) {
  const asset = getAsset(assetId);
  const date = $id('t-date').value;
  const modeEl = document.querySelector('input[name="tmode"]:checked');
  const mode = modeEl ? modeEl.value : 'qty';
  let qty, price;
  if (mode === 'exchange') {
    // 兑换模式（外币）：买入填「花费人民币 + 买入外币」，卖出填「收回人民币 + 卖出外币」
    if (asset.category !== 'fx') { alert('「兑换」仅适用于外币资产。'); return; }
    const cny = parseFloat($id('t-cny').value);
    const fxQty = parseFloat($id('t-fxqty').value);
    if (!isFinite(cny) || cny <= 0) { alert('请填写人民币金额（正数）。'); return; }
    if (!isFinite(fxQty) || fxQty <= 0) { alert('请填写外币数量（正数）。'); return; }
    qty = fxQty;
    price = cny / fxQty; // 汇率 = 人民币 ÷ 外币，自动反推
  } else if (mode === 'amount') {
    // 总金额模式：金额必填；单价可选（优先手填 → 当前单位价值 → 整笔按 1 份）
    const amount = parseFloat($id('t-amount').value);
    if (!isFinite(amount) || amount <= 0) { alert('请填写总金额（正数）。'); return; }
    const priceRaw = $id('t-price').value.trim();
    if (priceRaw !== '' && isFinite(parseFloat(priceRaw))) {
      price = parseFloat(priceRaw);
    } else if (asset.lastPrice != null && Number(asset.lastPrice) > 0) {
      price = Number(asset.lastPrice); // 用当前单位价值折算
    } else {
      price = 1; qty = amount; // 无单价可用：整笔金额当作 1 份（金额即单价）
    }
    if (!(price > 0)) price = 1;
    if (qty == null) qty = amount / price;
    if (!(qty > 0)) { alert('折算出的份数为 0，请检查金额与单价。'); return; }
  } else {
    qty = parseFloat($id('t-qty').value);
    price = parseFloat($id('t-price').value);
    if (!isFinite(qty) || qty <= 0 || !isFinite(price) || price <= 0) {
      alert('份数与成交单价必须为正数。'); return;
    }
  }
  const feeRaw = $id('t-fee').value.trim();
  const fee = feeRaw === '' || !isFinite(parseFloat(feeRaw)) ? 0 : parseFloat(feeRaw);
  if (fee < 0) { alert('手续费不能为负。'); return; }
  if (!date || parseDate(date) == null) { alert('日期格式不正确。'); return; }
  // 买入批次的最低持有天数（仅非股票）
  let minHoldDays = null;
  const minHoldEl = $id('t-minhold');
  if (minHoldEl && type === 'buy') {
    const raw = minHoldEl.value.trim();
    if (raw !== '') {
      const v = Math.floor(parseFloat(raw));
      if (!isFinite(v) || v < 0) { alert('最低持有天数必须是非负整数。'); return; }
      minHoldDays = v;
    }
  }
  const note = $id('t-note').value.trim();
  qty = roundQty(qty);
  price = roundPrice(price);
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
      t.date = date; t.quantity = qty; t.price = price;
      t.fee = round2(fee); t.note = note; t.mode = mode;
      if (type === 'buy') t.minHoldDays = minHoldDays;
    }
  } else {
    state.trades.push({
      id: uid('trade_'), assetId, type, date,
      quantity: qty, price, fee: round2(fee), note,
      mode, minHoldDays: type === 'buy' ? minHoldDays : null,
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
      '<span class="tl-value">' + (isBuy ? '🟢 买入 ' : '🔴 卖出 ') + fmtQty(t.quantity) + ' × ' + fmtQty(t.price) +
        (isBuy && t.minHoldDays != null ? '<span class="tag alt" style="margin-left:6px">锁 ' + t.minHoldDays + ' 天</span>' : '') + '</span>' +
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

/**
 * 手动录入当前价格/市值（行情不可用时的回退入口）：
 *  - 股票：填「现价」（单价）
 *  - 非股票（基金/债券/存款/外币等）：填「当前持仓总金额」，系统按「总金额 ÷ 份额」折算单位价值；
 *    外币产品还可点按钮用设置中已保存的汇率一键填入。
 */
function manualPriceline(asset) {
  if (!asset) return;
  const isStock = asset.category === 'stock';
  const isFx = asset.category === 'fx';
  const pos = Calc.tradePosition(asset, state.trades, null);
  const qty = pos.qty;
  if (!isStock && qty <= 0) { alert('尚无持仓，无法设置持仓总金额。请先添加一笔买入。'); return; }
  const currentValue = (asset.lastPrice != null && qty > 0) ? round2(qty * asset.lastPrice) : '';

  let body;
  if (isStock) {
    body = '<div class="hint" style="margin-bottom:12px">手动记录当前股价（行情不可用时使用）。</div>' +
      '<div class="field"><label>当前股价（' + esc(asset.currency) + '）*</label>' +
      '<input id="p-price" type="number" min="0" step="any" value="' + esc(asset.lastPrice != null ? asset.lastPrice : '') + '"></div>';
  } else {
    const fxName = asset.foreignCurrency || '外币';
    const fxLine = isFx
      ? '<div class="hint" style="margin-top:8px">当前持有 ' + esc(fxName) + ' <b>' + fmtQty(qty) + '</b>；持仓总金额 = 外币余额 × 当前汇率（均按人民币计）。</div>'
      : '<div class="hint" style="margin-top:8px">当前份额 <b>' + fmtQty(qty) + '</b>；持仓总金额 = 份额 × 单位价值。</div>';
    const fillBtn = isFx
      ? '<div style="margin-top:8px"><button type="button" id="p-fill-rate" class="btn btn-mini ghost">⟳ 用已保存汇率填入（1 ' + esc(fxName) + ' = ? CNY）</button></div>'
      : '';
    body = '<div class="hint" style="margin-bottom:12px">非股票产品请直接填写<b>当前持仓总金额</b>，系统按「总金额 ÷ 份额」折算当前' + (isFx ? '汇率' : '单位价值') + '。</div>' +
      '<div class="field"><label>当前持仓总金额（' + esc(asset.currency) + '）*</label>' +
      '<input id="p-value" type="number" min="0" step="0.01" value="' + esc(currentValue) + '"></div>' +
      fxLine + fillBtn +
      '<div class="hint" id="p-implied" style="margin-top:6px;color:var(--ink-3)"></div>';
  }
  openModal('设置当前市值 · ' + asset.name, body, () => {
    if (isStock) {
      const v = parseFloat($id('p-price').value);
      if (!isFinite(v) || v <= 0) { alert('现价必须为正数。'); return; }
      asset.lastPrice = roundQty(v);
    } else {
      const v = parseFloat($id('p-value').value);
      if (!isFinite(v) || v <= 0) { alert('持仓总金额必须为正数。'); return; }
      asset.lastPrice = roundQty(v / qty);
    }
    asset.priceSource = 'manual';
    asset.lastQuoteAt = Date.now();
    saveState(); renderAll(); closeModal();
  }, '保存');

  // 非股票：输入总金额时实时显示折算的单位价值；外币提供「按已保存汇率填入」
  if (!isStock) {
    const input = $id('p-value');
    const implied = $id('p-implied');
    const updateImplied = () => {
      const v = parseFloat(input.value);
      implied.textContent = (isFinite(v) && v > 0 && qty > 0)
        ? '折算' + (isFx ? '汇率' : '单位价值') + '：' + fmtQty(v / qty) +
          (isFx ? '（1 ' + (asset.foreignCurrency || '') + ' 兑 CNY）' : '（' + asset.currency + '）')
        : '';
    };
    input.oninput = updateImplied;
    updateImplied();
    if (isFx) {
      $id('p-fill-rate').onclick = () => {
        const rate = fxRateFromCache(asset.foreignCurrency);
        if (rate == null) { alert('汇率缓存中暂无「' + asset.foreignCurrency + '」。请先在「设置 → 汇率」中维护或联网获取。'); return; }
        input.value = round2(qty * rate);
        updateImplied();
      };
    }
  }
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
      '<div class="hint" style="margin-top:8px">行情来自腾讯公开免费接口，仅供记录与计算参考；接口不可用时用卡片上的「✎ 现价 / ✎ 市值」手动录入。</div>' +
    '</div>' +
    '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">' +
      '<div class="field" style="margin-bottom:4px"><label>统计设置</label></div>' +
      '<div class="field" style="margin-bottom:10px"><label>无风险年化利率（%，夏普比率用）</label>' +
      '<input type="number" id="s-rf" min="0" step="0.1" value="' + esc(settings.riskFreeRate != null ? settings.riskFreeRate : 2) + '">' +
      '<div class="hint">一般参考国债收益率取 1%–3%。</div></div>' +
      '<div class="field" style="margin-bottom:10px"><label>负债合计（' + esc(settings.baseCurrency) + '）</label>' +
      '<input type="number" id="s-liab" min="0" step="0.01" value="' + esc(settings.liabilities || 0) + '">' +
      '<div class="hint">用于核心仪表盘「净资产 = 总市值 − 负债」。</div></div>' +
      '<div class="field" style="margin-bottom:4px"><label>单一标的上限阈值（%）</label>' +
      '<input type="number" id="s-cap" min="0" max="100" step="1" value="' + esc(settings.singleAssetCap != null ? settings.singleAssetCap : 20) + '">' +
      '<div class="hint">集中度统计中，单一标的占比超过该比例时高亮提示。</div></div>' +
    '</div>' +
    '<div style="margin-top:24px;padding-top:14px;border-top:1px solid var(--line)">' +
      '<div class="field" style="margin-bottom:8px"><label>数据管理</label></div>' +
      '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
        '<button type="button" id="s-clear" class="btn btn-danger btn-mini">🗑 清空全部数据</button>' +
        '<span class="hint" style="font-size:12px;color:var(--ink-3)">删除所有产品、交易记录与汇率设置，不可恢复；建议先「导出」备份。</span>' +
      '</div>' +
    '</div>' +
    '<div style="margin-top:16px;font-size:12px;color:var(--ink-3)">EcoCal v' + APP_VERSION + ' · 数据仅保存在本机浏览器（localStorage），不联网上传。</div>';
}

function openSettings() {
  openModal('设置', settingsHTML(state.settings), null, null);
  $id('modal-ok').textContent = '保存设置';

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

  // 清空全部数据（危险操作，二次确认）
  $id('s-clear').onclick = clearAll;

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
    // 统计设置：无风险利率（夏普比率参数）
    const rfInput = $id('s-rf');
    if (rfInput) {
      const rf = parseFloat(rfInput.value);
      if (!isFinite(rf) || rf < 0) { alert('无风险利率必须是非负数字（%）。'); return; }
      state.settings.riskFreeRate = rf;
    }
    // 统计设置：负债与单一标的上限阈值
    const liabInput = $id('s-liab');
    if (liabInput) {
      const liab = parseFloat(liabInput.value);
      if (!isFinite(liab) || liab < 0) { alert('负债必须是非负数字。'); return; }
      state.settings.liabilities = liab;
    }
    const capInput = $id('s-cap');
    if (capInput) {
      const cap = parseFloat(capInput.value);
      if (!isFinite(cap) || cap < 0 || cap > 100) { alert('单一标的上限阈值必须在 0–100 之间（%）。'); return; }
      state.settings.singleAssetCap = cap;
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
  confirmAction('导入备份数据', '导入将覆盖当前全部数据（产品、交易记录、汇率设置），确定继续吗？', () => {
    applyPayload(data);
    renderAll();
    alert('导入成功。');
  });
}

/** 应用备份数据到 state 并持久化（自动执行 v6 迁移，兼容历史备份） */
function applyPayload(data) {
  state.assets = Array.isArray(data.assets) ? data.assets : [];
  state.valuations = Array.isArray(data.valuations) ? data.valuations : [];
  state.trades = Array.isArray(data.trades) ? data.trades : [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  state.settings.rates = data.settings && data.settings.rates ? data.settings.rates : {};
  migrateToV6(); // 旧「价值快照」资产 → 首笔买入 + 折算现价
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
  confirmAction('清空全部数据', '将删除所有产品、交易记录与汇率设置，此操作不可撤销。确定清空吗？', () => {
    state.assets = [];
    state.trades = [];
    state.valuations = [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveState(); renderAll();
  }, '清空');
}

/* ---------------- 顶部吸附定位（Tab / 筛选栏） ---------------- */
/**
 * 把顶栏、Tab 栏的实测高度写入 CSS 变量，供样式中的 position:sticky 使用。
 * 顶栏在窄屏会换行变高，因此用实测值而不是写死像素。
 */
function updateStickyOffsets() {
  const root = document.documentElement;
  if (!root || !root.style) return; // 无 DOM 环境（如单元测试）静默跳过
  const topbar = document.querySelector('.topbar');
  const tabs = document.querySelector('#main-tabs');
  if (topbar) root.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  if (tabs) root.style.setProperty('--tabs-h', tabs.offsetHeight + 'px');
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  bindModalButtons();

  // 窗口尺寸变化（含手机横竖屏切换）时重新测量顶部吸附高度
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', updateStickyOffsets);
  }
  // 顶栏/Tab 栏自身尺寸变化（如字体加载、窄屏换行）时也重新测量
  if (typeof ResizeObserver === 'function') {
    const resizeObserver = new ResizeObserver(() => updateStickyOffsets());
    const topbarEl = document.querySelector('.topbar');
    const tabsEl = document.querySelector('#main-tabs');
    if (topbarEl) resizeObserver.observe(topbarEl);
    if (tabsEl) resizeObserver.observe(tabsEl);
  }

  $id('btn-add').onclick = () => openAssetForm(null);
  $id('empty-add').onclick = () => openAssetForm(null);

  // 主界面分页：产品 / 统计
  document.querySelectorAll('#main-tabs .tab').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

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
          state.trades.filter(t => t.assetId === asset.id).length + ' 笔交易记录，且不可恢复。确定删除吗？', () => {
          state.assets = state.assets.filter(a => a.id !== asset.id);
          state.trades = state.trades.filter(t => t.assetId !== asset.id);
          expanded.delete(asset.id);
          saveState(); renderAll();
        }, '删除');
        break;
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
}

/* ---------------- 演示数据 ---------------- */
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function seedDemo() {
  const now = Date.now();
  const mk = (name, category, subCategory, currency, note, extra) => ({
    id: uid('asset_'), name, category, subCategory, currency,
    note, riskLevel: null, tPlusN: null, symbol: null, lastPrice: null, priceSource: null,
    principal: 0, quantity: null, minHoldDays: null, startDate: null,
    createdAt: now, updatedAt: now,
    ...(extra || {}),
  });
  const mkTrade = (assetId, type, daysAgo, qty, price, opts) => ({
    id: uid('trade_'), assetId, type, date: daysAgoStr(daysAgo),
    quantity: qty, price, fee: (opts && opts.fee) || 0,
    note: (opts && opts.note) || '', mode: (opts && opts.mode) || 'qty',
    minHoldDays: (opts && opts.minHoldDays != null) ? opts.minHoldDays : null,
    createdAt: now,
  });

  // 产品（v6：只含基本信息，全部通过交易记录记账）
  const a1 = mk('沪深300指数基金', 'fund', '指数型', 'CNY', '定投组合主力仓', { riskLevel: 'R3', tPlusN: 1 });
  const a2 = mk('某全球市场 QDII 基金', 'fund', 'QDII', 'USD', '美元资产配置', { riskLevel: 'R4', tPlusN: 3 });
  const a3 = mk('苹果（AAPL）', 'stock', '美股', 'USD', '长期持有', { riskLevel: 'R5', tPlusN: 0, symbol: 'usAAPL' });
  const a4 = mk('招商银行（A股）', 'stock', 'A股', 'CNY', '交易模式示例：分批买卖', { riskLevel: 'R4', tPlusN: 1, symbol: 'sh600036' });
  const a5 = mk('某 3 年期大额存单', 'deposit', '定期', 'CNY', '年利率 2.6% 的单利存款', { riskLevel: 'R1', tPlusN: 0 });
  const a6 = mk('国债（3年期）', 'bond', '国债', 'CNY', '', { riskLevel: 'R1', tPlusN: 0 });
  // 外币：人民币买入美元（qty = 美元金额，price = 汇率 → 金额即人民币）
  const a7 = mk('美元现汇（USD/CNY）', 'fx', '现汇', 'CNY', '外币演示：用人民币买卖美元', { riskLevel: 'R1', tPlusN: 0, foreignCurrency: 'USD' });

  // 当前市值/汇率（均可联网或手动更新）
  a1.lastPrice = 10.8;   a1.priceSource = 'manual';
  a2.lastPrice = 18.0;   a2.priceSource = 'manual';
  a3.lastPrice = 206;    a3.priceSource = 'manual';
  a4.lastPrice = 38.52;  a4.priceSource = 'manual';
  a5.lastPrice = 100600; a5.priceSource = 'manual'; // qty=1，单价即总市值
  a6.lastPrice = 40068;  a6.priceSource = 'manual';
  a7.lastPrice = 7.22;   a7.priceSource = 'manual'; // 当前汇率（1 USD = 7.22 CNY）

  const trades = [
    // 基金：两笔买入各自不同的最低持有天数（演示"不同批次不同锁定"）
    mkTrade(a1.id, 'buy', 180, 5000, 10.0, { note: '定投建仓', minHoldDays: 30 }),
    mkTrade(a1.id, 'buy', 30, 2000, 10.6, { note: '回调加仓', minHoldDays: 7 }),
    mkTrade(a2.id, 'buy', 150, 120, 16.6667, { note: '美元计资产', minHoldDays: 30 }),
    mkTrade(a2.id, 'buy', 40, 30, 17.2, { note: '加仓', minHoldDays: 7 }),
    // 股票：分批买入 + 部分卖出
    mkTrade(a3.id, 'buy', 210, 8, 185, { note: '分批建仓', minHoldDays: 1 }),
    mkTrade(a3.id, 'buy', 100, 2, 195, { note: '加仓', minHoldDays: 1 }),
    mkTrade(a3.id, 'sell', 20, 3, 210, { note: '部分止盈' }),
    mkTrade(a4.id, 'buy', 90, 800, 37.5, { note: '分批建仓 #1', minHoldDays: 1 }),
    mkTrade(a4.id, 'sell', 40, 200, 39.8, { note: '部分止盈' }),
    mkTrade(a4.id, 'buy', 20, 100, 36.6, { note: '回调补仓', minHoldDays: 1 }),
    // 定期类：单笔大额买入 + 1095 天锁定（演示"不可卖"徽章）
    mkTrade(a5.id, 'buy', 60, 1, 100000, { note: '三年期大额存单', minHoldDays: 1095 }),
    mkTrade(a6.id, 'buy', 120, 1, 40000, { note: '三年期国债', minHoldDays: 1095 }),
    // 外币：人民币 ⇄ 外币兑换记账（录入方式 = 兑换：填人民币 + 外币数量，汇率自动反推）
    mkTrade(a7.id, 'buy', 100, 2000, 7.15, { note: '用人民币兑换美元', mode: 'exchange' }),
    mkTrade(a7.id, 'sell', 30, 500, 7.30, { note: '部分卖出换回人民币', mode: 'exchange' }),
  ];

  state.assets = [a1, a2, a3, a4, a5, a6, a7];
  state.valuations = [];
  state.trades = trades;
  state.settings = Object.assign({}, DEFAULT_SETTINGS, {
    rates: { USD: 7.2, HKD: 0.92, EUR: 7.8, GBP: 9.1, JPY: 0.048 },
  });
  saveState();
}

/* ---------------- 帮助（使用指南 + 概念说明 + 演示数据） ---------------- */
const HELP_HTML = ''
  + '<div class="help-content">'
  + '<section class="help-section"><h4>如何使用（v6）</h4><ol>'
  + '<li><b>添加产品</b>：点右上角「＋ 添加产品」，只需填写<b>基本信息</b>（名称、大类小类、币种等）。选「股票」时多一步：填写股票代码（自动识别市场/币种/名称，直接进监察表）；选「外币」时选择外币币种（以人民币买卖，按汇率计算收益）。无需填写本金——所有资金进出都通过买卖记录。</li>'
  + '<li><b>记录买卖</b>：卡片上点「＋ 买入 / − 卖出」逐笔记账。每笔支持两种录入方式：<b>份数×单价</b>（金额自动算，股票默认）或<b>总金额</b>（份额自动折算，基金等默认）。<b>外币</b>另有<b>兑换</b>方式：买入填「花费人民币 + 买入外币」、卖出填「收回人民币 + 卖出外币」，汇率自动反推。卖出时系统自动校验不超持仓。</li>'
  + '<li><b>维护当前市值</b>：股票点「✎ 现价」填当前股价（或「⟳ 刷新行情」联网获取）；基金/存款/外币等点「✎ 市值」直接填<b>当前持仓总金额</b>，系统自动折算单位价值。</li>'
  + '<li><b>查看指标</b>：每张卡片显示持仓金额/数量、累计投入、浮动盈亏、已实现盈亏、总盈亏与年化（近似）；展开「查看记录」可见逐笔明细与（股票）近期走势。</li>'
  + '<li><b>统计与图表</b>：统计页分四层——①<b>核心仪表盘</b>（总市值 / 净资产 / 总投入本金 / 总浮动盈亏与浮动盈亏率 / 已实现盈亏 / 总盈亏 / 现金 vs 风险资产，比率口径均已标注）；②<b>配置与结构</b>（资产类别 / 市场 / 币种 三类横向条形图，金额 + 占比）；③<b>集中度</b>（单一标的、Top5 / Top10 占比与超限提示，上限阈值可在设置中调整）；④<b>持仓明细表</b>（按市值降序，含当日盈亏等指标）。另有组合走势（市值 / 收益 / 收益率 / 回撤多模式）与盈亏构成视图。产品页提供下拉筛选与排序（市值 / 年化 / 收益率 / 持有天数）。</li>'
  + '<li><b>多币种与汇率</b>：在「设置」中维护汇率（可联网获取或手动填写），跨币种统计统一换算为基准币种；缺汇率的币种不计入总额并会提醒。</li>'
  + '<li><b>数据保存</b>：所有数据保存在浏览器本地（localStorage），无需联网即可用；建议定期「导出」备份（下载或复制 JSON），换设备/清缓存前务必先导出。</li>'
  + '</ol></section>'
  + '<section class="help-section"><h4>金融概念说明</h4>'
  + '<p><b>· 持仓成本 / 累计投入</b>：所有买入的合计金额（含手续费）。卖出时会按「加权平均成本」扣减，因此持仓成本反映仍在手上的买入成本。</p>'
  + '<p><b>· 加权平均成本（均价）</b>：持仓成本 ÷ 持仓数量，即摊薄后的单位成本。买得贵/便宜都会摊进后续成本；部分卖出按当时均价扣减，不影响剩余部分。</p>'
  + '<p><b>· 浮动盈亏</b>：当前市值 − 持仓成本，随现价/汇率波动。总市值 = 数量（或外币金额）× 当前单位价值（或汇率）。</p>'
  + '<p><b>· 已实现盈亏</b>：每笔卖出"落袋"的盈亏 = 卖出金额（扣手续费）− 卖出数量 × 当时均价。清仓后再买入按新成本继续，历史已实现盈亏不受影响。</p>'
  + '<p><b>· 总盈亏 = 浮动 + 已实现</b>：部分卖出会"锁定"已实现盈亏，因此看总盈亏比只看市值更能反映整体战绩。</p>'
  + '<p><b>· 收益率</b>：总盈亏 ÷ 累计投入。例如投入 1 万、当前总盈亏 300 元，收益率 = 3%。</p>'
  + '<p><b>· 年化收益率（年化）</b>：把收益率折算成「持有一年」的口径，便于横向比较不同产品。本工具默认用<b>单利近似</b>：年化 = 浮动盈亏 ÷ 投入成本 × 365 ÷ 持有天数（持有太短时仅供参考）。</p>'
  + '<p><b>· 整体年化（汇总）</b>：把全部资产收益按投入成本加权统一折算的年化，用于评估整个组合。</p>'
  + '<p><b>· 最低持有天数（按买入批次）</b>：基金/存款等产品的<b>每笔买入</b>可单独设置最低持有天数（如持有满 7 天赎回免手续费、定期存款锁定期）。未到期的批次显示「锁定」，全部到期显示「可卖」，部分到期显示「部分可卖」。股票有固定限售（如 A 股 T+1）时可在产品编辑里保留资产级设置。</p>'
  + '<p><b>· T+n</b>：提交赎回/卖出申请后的到账时间，n 为交易日数。A 股卖出为 T+1（次日确认），货币基金常见 T+0/T+1，QDII 基金 T+3 左右。</p>'
  + '<p><b>· 风险等级（R1–R5）</b>：产品自身风险分级，R1 最低（存款、货币基金），R5 最高（股票型、期货等）。</p>'
  + '<p><b>· 外币投资</b>：记录用<b>人民币</b>买入/卖出的外币。默认「兑换」方式：买入填花费的人民币与实际买到的外币、卖出填收回的人民币与实际卖出的外币，成交汇率（1 外币 = ? 人民币）自动反推；也可切换「份数×汇率」或「总金额」。持仓金额 = 外币余额 × 当前汇率，收益 = 现在能换回的人民币 − 当初花出的人民币（含汇率变动影响）。</p>'
  + '<p><b>· 多币种与汇率</b>：不同币种资产先按各自币种记账，汇总统计时按你维护的汇率换算为基准币种；换算后的收益同时包含价格与汇率变动的影响。</p>'
  + '<p><b>· 红涨绿跌</b>：按国内习惯，收益为正显示红色、为负显示绿色。</p>'
  + '</section>'
  + '<section class="help-section"><h4>交易记录模式与行情</h4>'
  + '<p><b>· 两种录入方式</b>：<b>份数×单价</b>——填份额与成交单价，金额自动计算；<b>总金额</b>——填这次投入/回收的总金额，份额按单价（或当前单位价值）自动折算，适合"我买了 1 万元基金"这种表述。股票默认前者，其他产品默认后者，可随时切换。<b>外币</b>还可用「兑换」方式直接填人民币与外币数量。</p>'
  + '<p><b>· 股票监察表</b>：添加股票只需填写代码——自动识别市场（A股/港股/美股/北交所）并带出币种与名称。加入后点「＋ 买入」「− 卖出」统一填<b>单股价格</b>。</p>'
  + '<p><b>· 行情</b>：股票代码可直接输入——A股 600519 / 000001，港股 00700，美股 KO / AAPL。点「⟳ 刷新行情」获取现价与近期走势（腾讯公开免费接口，不保证实时，仅作参考）；行情不可用时用「✎ 现价」手动记录。</p>'
  + '<p><b>· 自动刷新</b>：可在「设置」中开关"打开页面自动刷新行情"，每只产品 10 分钟内最多刷新一次，避免频繁请求第三方接口。</p>'
  + '</section>'
  + '<section class="help-section"><h4>演示数据</h4>'
  + '<p>主页面<b>没有真实数据时保持空白</b>，不会自动载入演示数据。你可以先看看下面的演示示例长什么样：</p>'
  + '<ul style="padding-left:20px;font-size:13px;color:#3a3a3c;line-height:1.9">'
  + '<li>沪深300指数基金：两笔买入（5,000 份 @10.00 + 2,000 份 @10.60），两批分别锁定 30 天 / 7 天，当前净值 10.80</li>'
  + '<li>苹果（AAPL）：分批买入 10 股、部分卖出 3 股 @210，当前股价 206</li>'
  + '<li>招商银行（A股，代码 sh600036）：800 股建仓、卖 200、补 100，现价 38.52，演示加权平均与已实现盈亏</li>'
  + '<li>3 年期大额存单 / 国债：单笔大额买入，锁 1095 天 → 显示「不可卖」徽章</li>'
  + '<li>美元现汇（USD/CNY）：买入 2,000 USD @7.15，卖出 500 USD @7.30，现汇率 7.22，演示外币按人民币买卖</li>'
  + '</ul>'
  + '<p style="margin-top:6px">想实际体验操作？<b>只有在当前没有任何数据时</b>才能载入：</p>'
  + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
  + '<button type="button" id="help-demo-load" class="btn btn-primary btn-mini">📥 载入演示数据</button>'
  + '<span class="hint" style="font-size:12px;color:var(--ink-3)">载入后可随意修改；清空入口在「设置 → 数据管理」。</span>'
  + '</div>'
  + '</section>'
  + '<section class="help-section"><h4>数据说明</h4>'
  + '<p>· 汇率与股票行情来自<b>公开免费接口</b>（汇率：Frankfurter/Open Exchange Rates；行情：腾讯），仅作记录与计算参考，不保证实时精确；其余所有计算完全基于你记录的数据，结果仅供参考，不构成投资建议。</p>'
  + '<p>· 数据存放在浏览器 localStorage 中，不在任何源码文件里；可用「导出 / 导入」以 JSON 文件备份与迁移。更换浏览器或清除浏览器数据前请先导出。</p>'
  + '</section>'
  + '</div>';

function openHelp() {
  openModal('帮助 · 使用指南与概念说明', HELP_HTML, () => closeModal(), '关闭');
  const loadDemo = $id('help-demo-load');
  if (loadDemo) {
    loadDemo.onclick = () => {
      if (state.assets.length) {
        alert('当前已有数据，未载入演示数据。如需体验，可先在「设置 → 数据管理」中清空。');
        return;
      }
      seedDemo();
      renderAll();
      alert('已载入演示数据，可随意查看与修改；清空入口在「设置 → 数据管理」。');
    };
  }
}

/* ---------------- 启动 ---------------- */
function init() {
  bindEvents();
  const versionEl = $id('app-version');
  if (versionEl) versionEl.textContent = 'v' + APP_VERSION;
  const hasData = loadState();
  if (!hasData) {
    // 首次使用：保持空白（演示数据在「帮助」页按需载入）
    state.assets = [];
    state.trades = [];
    state.valuations = [];
    saveState();
  }
  migrateToV6(); // 旧版本数据自动迁移（价值快照 → 首笔买入 + 折算现价）
  // 调试/预览钩子：`?demo=1` 且当前无数据时注入演示数据（便于快速查看效果）
  if (!state.assets.length && typeof location !== 'undefined' && location.search.indexOf('demo=1') > -1) {
    seedDemo();
  }
  renderAll();
  // Tab / 筛选栏吸附定位：测量顶栏高度并写入 CSS 变量
  updateStickyOffsets();
  // 直链支持：`?tab=stats` 直接打开「统计」页（便于分享/快速查看）
  if (typeof location !== 'undefined' && location.search.indexOf('tab=stats') > -1) {
    switchTab('stats');
  }

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
  fetchLatestRates, applyLatestRates, RISK_LEVELS, SORT_OPTIONS, CATEGORIES, FX_CURRENCIES,
  openSettings, openAssetForm, openTradeForm, openHelp,
  submitTrade, submitAsset,
  renderAll, renderList,
  switchTab, setTrendMode,
  openExportModal, openImportModal, importPayloadText, buildExportPayload,
  migrateToTrades, migrateToV6, fxRateFromCache, daysAgoStr,
  normalizeSymbol, symbolToCurrency, fetchQuote, fetchKline, fetchStockInfo,
  refreshQuoteForAsset, refreshAllQuotes, manualPriceline,
};

})();
