
'use strict';
/* =========================================================================
 * EcoCal - 个人资产持仓记录工具（纯本地，零依赖）
 * 数据：Asset（产品基本信息） + Trade（逐笔买卖记录） + Settings（基准币种/汇率）
 * v6 起：全面采用「交易记录」记账（删去价值快照模式）；
 *        新增「外币」大类（用人民币买入/卖出外币，按汇率计算收益）；
 *        买入/卖出支持「份数×单价」或「总金额」两种录入方式；
 *        非股票产品按每笔买入记录各自的最低持有天数。
 * ========================================================================= */
(function () {

/* ---------------- 常量与配置 ---------------- */
const STORAGE_KEY = 'ecocal.data.v1';

/* 应用版本：主版本.次版本.补丁
 * - 主版本：重大架构/功能（v3 多文件、v4 股票交易与行情、v6 交易记录全模式）
 * - 次版本：功能增强（v5 监察表模式与优化、v6.1 统计增强）
 * - 补丁：缺陷修复 */
const APP_VERSION = '6.1.0';

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
  other:     { label: '其他',      sub: ['其他'] },
};

/* 外币大类可选的币种（买卖时填「汇率」= 1 外币兑多少人民币，金额按人民币计） */
const FX_CURRENCIES = ['USD', 'HKD', 'EUR', 'GBP', 'JPY', 'SGD', 'AUD', 'CAD', 'CHF'];

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
      // data-dim-key 供「点击环图切片筛选」使用
      paths += '<path d="' + arc(acc, a1) + '" fill="none" stroke="' + d.color +
               '" stroke-width="' + sw + '" stroke-linecap="butt" data-dim-key="' + esc(d.key || d.label) + '"' +
               ' title="' + esc(d.label) + '" style="cursor:pointer"/>';
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
      // data-bar-id 供「点击条形图筛选该产品」使用
      return '<div' + (it.assetId ? ' data-bar-id="' + esc(it.assetId) + '"' : '') +
        ' style="cursor:pointer;display:grid;grid-template-columns:110px 1fr 110px;gap:10px;align-items:center;padding:5px 0;font-size:12px">' +
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
  },
  /**
   * 组合走势双线图：组合市值（估算，蓝实线）与累计净投入（灰虚线）。
   * points: [{ date, value, net }]，至少 2 个时间点才绘制。
   */
  trend(points, w, h) {
    if (!Array.isArray(points) || points.length < 2) {
      return '<div class="chart-empty">交易数据不足 2 个时间点，暂无法绘制组合走势</div>';
    }
    const W = w || 360, H = h || 150, pad = { l: 34, r: 8, t: 12, b: 20 };
    let min = Infinity, max = -Infinity;
    points.forEach(p => {
      [p.value, p.net].forEach(v => { if (isFinite(v)) { min = Math.min(min, v); max = Math.max(max, v); } });
    });
    if (!isFinite(min)) return '<div class="chart-empty">暂无数据</div>';
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    const spanW = W - pad.l - pad.r, spanH = H - pad.t - pad.b;
    const xAt = i => pad.l + (points.length === 1 ? spanW / 2 : i / (points.length - 1) * spanW);
    const yAt = v => pad.t + (1 - (v - min) / range) * spanH;
    const fmtTick = v => (Math.abs(v) >= 10000 ? (v / 10000).toFixed(1) + '万' : Math.round(v));
    let ticks = '';
    for (let k = 0; k <= 2; k++) {
      const v = min + range * k / 2;
      const yy = pad.t + (1 - k / 2) * spanH;
      ticks += '<line x1="' + pad.l + '" y1="' + yy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + yy.toFixed(1) + '" stroke="rgba(0,0,0,.06)" stroke-width="1"/>' +
               '<text x="' + (pad.l - 5) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="#a1a1a6">' + fmtTick(v) + '</text>';
    }
    const polyline = (key, stroke, dash) => {
      let path = '';
      points.forEach((p, i) => {
        path += (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(p[key]).toFixed(1) + ' ';
      });
      return '<path d="' + path.trim() + '" fill="none" stroke="' + stroke + '" stroke-width="' + (dash ? 1.6 : 2) +
             '" stroke-linejoin="round" stroke-linecap="round"' + (dash ? ' stroke-dasharray="5 4"' : '') + '/>';
    };
    const last = points[points.length - 1];
    const first = points[0];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-height:180px">' + ticks +
      polyline('value', '#0071e3', false) +
      polyline('net', '#8e8e93', true) +
      '<circle cx="' + xAt(points.length - 1).toFixed(1) + '" cy="' + yAt(last.value).toFixed(1) + '" r="3" fill="#0071e3"/>' +
      '<text x="' + xAt(0) + '" y="' + (H - 6) + '" font-size="9" fill="#a1a1a6">' + esc(first.date) + '</text>' +
      '<text x="' + (W - pad.r) + '" y="' + (H - 6) + '" text-anchor="end" font-size="9" fill="#a1a1a6">' + esc(last.date) + '</text>' +
      '</svg>' +
      '<div class="chart-legend">' +
        '<span><i style="background:#0071e3"></i>组合市值（估算）</span>' +
        '<span><i style="background:#8e8e93"></i>累计净投入（负数为净流出）</span>' +
      '</div>' +
      '<div class="hint" style="margin-top:6px;font-size:11px;color:var(--ink-3)">市值按「最近已知成交价 / 最新现价」逐日估算；两条线之间的差距即各个时期的估算盈亏。</div>';
  }
};

/* ---------------- 状态 & 渲染 ---------------- */
let expanded = new Set();      // 展开卡片集合
// 筛选条件：category/currency（下拉） + risk/fxFlag/assetId（图表点击筛选）
let filters = { category: 'all', currency: 'all', risk: null, fxFlag: null, assetId: null, sort: 'valueDesc' };
let ringDim = 'category';      // 资产结构环图维度：category / currency / risk

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

/* ---- 图表区（v6.1：维度切换环图 + 组合走势 + 盈亏构成 + 点击筛选） ---- */
/** 按维度汇总各产品的市值（基准币种）：category 按大类 / currency 按币种（外币产品按其外币） / risk 按风险等级 */
function ringDataByDim(dim) {
  const s = Calc.summary(state.assets, state.valuations, state.settings, state.trades);
  const map = {};
  s.metrics.forEach(m => {
    const asset = state.assets.find(a => a.id === m.assetId);
    if (!asset || m.baseValue == null) return;
    let key;
    if (dim === 'currency') {
      key = asset.category === 'fx' ? (asset.foreignCurrency || '外币') + '（外币）' : asset.currency;
    } else if (dim === 'risk') {
      key = asset.riskLevel || '未设置';
    } else {
      key = CATEGORIES[asset.category] ? CATEGORIES[asset.category].label : (asset.category || '其他');
    }
    map[key] = (map[key] || 0) + m.baseValue;
  });
  return Object.keys(map).map((k, i) => ({
    key: k, label: k, value: map[k], color: PALETTE[i % PALETTE.length],
  }));
}

/** 盈亏构成卡片：总盈亏 = 浮动 + 已实现；产品盈利/亏损分布（双向比例条） */
function profitChartHTML(s) {
  if (!s.metrics.length) return '<div class="chart-empty">暂无数据</div>';
  const base = state.settings.baseCurrency;
  let gainSum = 0, lossSum = 0;
  s.metrics.forEach(m => {
    const total = m.baseTotal != null ? m.baseTotal : m.baseProfit;
    if (total > 0.004) gainSum += total;
    else if (total < -0.004) lossSum += total;
  });
  const stack = (items) => {
    const totalAbs = items.reduce((sum, it) => sum + Math.abs(it.value), 0);
    if (totalAbs <= 0) return '<div class="chart-empty" style="padding:6px 0">暂无盈亏数据</div>';
    return '<div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:rgba(0,0,0,.05)">' +
      items.filter(it => it.value !== 0).map(it => {
        const w = Math.abs(it.value) / totalAbs * 100;
        const color = it.value > 0 ? '#d70015' : '#1d9e49';
        return '<div style="width:' + w.toFixed(1) + '%;background:' + color +
               '" title="' + esc(it.label) + ' ' + fmtSignedMoney(it.value, base) + '"></div>';
      }).join('') + '</div>';
  };
  const row = (label, items) => {
    const totalAbs = items.reduce((sum, it) => sum + Math.abs(it.value), 0) || 1;
    const parts = items.filter(it => it.value !== 0).map(it =>
      '<span style="font-weight:600;color:' + (it.value > 0 ? 'var(--red)' : 'var(--green)') + '">' +
        fmtSignedMoney(it.value, base) +
        ' <em style="font-style:normal;color:var(--ink-3);font-weight:400">(' +
        Math.round(Math.abs(it.value) / totalAbs * 100) + '%)</em></span>').join(' · ');
    return '<div style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--ink-2);margin-bottom:5px;flex-wrap:wrap">' +
        '<span>' + esc(label) + '</span><span style="display:flex;gap:8px;flex-wrap:wrap">' + parts + '</span>' +
      '</div>' + stack(items) + '</div>';
  };
  return row('总盈亏构成（浮动 vs 已实现）', [
    { label: '浮动盈亏', value: s.totalFloat },
    { label: '已实现盈亏', value: s.totalRealized },
  ]) +
  row('产品盈亏分布（' + s.gainCount + ' 盈 / ' + s.lossCount + ' 亏，按总盈亏口径）', [
    { label: '盈利产品合计', value: gainSum },
    { label: '亏损产品合计', value: lossSum },
  ]) +
  '<div class="hint" style="font-size:11px;color:var(--ink-3)">浮动盈亏随当前市值/汇率变动；已实现盈亏为已落袋的卖出收益；两者相加即总盈亏。红=盈利（正），绿=亏损（负）。</div>';
}

function renderCharts() {
  const s = Calc.summary(state.assets, state.valuations, state.settings, state.trades);
  const base = state.settings.baseCurrency;

  // 环图（维度可切换：类别 / 币种 / 风险等级）
  $id('ring-chart').innerHTML = Charts.ring(ringDataByDim(ringDim), 190);

  // 条形图：各产品市值（基准币种，可点击筛选该产品）
  const barItems = s.metrics.map(m => {
    const asset = state.assets.find(a => a.id === m.assetId);
    return {
      label: asset ? asset.name : '?',
      value: m.baseValue || 0,
      loss: m.baseProfit != null && m.baseProfit < 0,
      sub: m.baseProfit != null ? '· ' + fmtPct(m.rate * 100) : '· 缺汇率',
      assetId: m.assetId,
    };
  }).slice(0, 12);
  $id('bar-chart').innerHTML = Charts.bars(barItems, base);

  // 组合市值走势（估算：市值 vs 累计净投入）
  $id('trend-chart').innerHTML = Charts.trend(Calc.portfolioTrend(state.assets, state.trades, state.settings));

  // 盈亏构成
  $id('profit-chart').innerHTML = profitChartHTML(s);

  // 图表交互：环图切片/条形 → 联动筛选产品列表；维度切换按钮
  bindChartInteractions();
}

/* ---- 图表点击筛选 ---- */
function setChartFilter(dim, key) {
  clearChartFilter(false);
  if (dim === 'category') filters.category = key;
  else if (dim === 'currency') {
    if (/（外币）$/.test(key)) { filters.fxFlag = key.replace(/（外币）$/, ''); filters.currency = 'all'; }
    else filters.currency = key;
  } else if (dim === 'risk') filters.risk = key;
  syncChartFilterBar();
  renderFilters();
  renderList();
}
function clearChartFilter() {
  filters.category = 'all'; filters.currency = 'all';
  filters.risk = null; filters.fxFlag = null; filters.assetId = null;
  syncChartFilterBar();
  renderFilters();
  renderList();
}
function syncChartFilterBar() {
  const bar = $id('chart-filter-bar');
  if (!bar) return;
  const has = filters.category !== 'all' || filters.currency !== 'all' || filters.risk || filters.fxFlag || filters.assetId;
  bar.classList.toggle('hidden', !has);
  if (has) {
    const parts = [];
    if (filters.category !== 'all') parts.push('类别 ' + (CATEGORIES[filters.category] ? CATEGORIES[filters.category].label : filters.category));
    if (filters.currency !== 'all') parts.push('币种 ' + filters.currency);
    if (filters.risk) parts.push('风险 ' + filters.risk);
    if (filters.fxFlag) parts.push('外币 ' + filters.fxFlag);
    if (filters.assetId) { const a = getAsset(filters.assetId); parts.push('产品「' + (a ? a.name : '?') + '」'); }
    $id('chart-filter-text').textContent = '当前筛选：' + parts.join(' · ');
  }
}

function bindChartInteractions() {
  const ringEl = $id('ring-chart');
  ringEl.onclick = (e) => {
    const path = e.target && e.target.closest ? e.target.closest('path[data-dim-key]') : null;
    if (!path) return;
    setChartFilter(ringDim, path.dataset.dimKey);
  };
  const barEl = $id('bar-chart');
  barEl.onclick = (e) => {
    const row = e.target && e.target.closest ? e.target.closest('[data-bar-id]') : null;
    if (!row) return;
    const id = row.dataset.barId;
    filters.assetId = (filters.assetId === id) ? null : id; // 再次点击取消
    syncChartFilterBar();
    renderList();
  };
  // 环图维度切换按钮（index.html 内静态按钮）
  document.querySelectorAll('#ring-dims button').forEach(btn => {
    btn.onclick = () => {
      ringDim = btn.dataset.dim;
      document.querySelectorAll('#ring-dims button').forEach(b => b.classList.toggle('active', b === btn));
      renderCharts();
    };
  });
  const clearBtn = $id('chart-filter-clear');
  if (clearBtn) clearBtn.onclick = clearChartFilter;
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
  syncChartFilterBar(); // 图表点击筛选的状态条（与下拉筛选联动显示）
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
 * 交易表单（v6）：支持两种录入方式
 *  - qty（份数×单价）：填份数与成交单价，金额自动算——股票默认
 *  - amount（总金额）：填总金额，份额自动折算——非股票默认
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
  // 默认录入方式：股票 → 份数×单价；其他 → 总金额
  const defMode = trade ? (trade.mode || 'qty') : (isStock ? 'qty' : 'amount');
  const pos = Calc.tradePosition(asset, state.trades, null);

  const modeSwitch = '<div class="field full"><label>录入方式</label>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<label class="input-mode"><input type="radio" name="tmode" value="qty"' + (defMode === 'qty' ? ' checked' : '') + '> 份数 × 单价</label>' +
      '<label class="input-mode"><input type="radio" name="tmode" value="amount"' + (defMode === 'amount' ? ' checked' : '') + '> 总金额</label>' +
    '</div></div>';

  const qtyField = '<div class="field" id="t-qty-row"><label>' + qtyLabel + ' *</label>' +
    '<input id="t-qty" type="number" min="0" step="any" placeholder="如 100" value="' + esc(t.quantity) + '">' +
    '<div class="hint">份数 × 单价 = ' + (isFx ? '人民币金额' : '交易金额') + '（自动计算）</div></div>';

  const amountField = '<div class="field" id="t-amount-row" style="display:' + (defMode === 'amount' ? '' : 'none') + '">' +
    '<label>' + (isFx ? '人民币金额' : '总金额（' + esc(asset.currency) + '）') + ' *</label>' +
    '<input id="t-amount" type="number" min="0" step="0.01" placeholder="如 10000" value="' + esc(t.quantity != null && t.quantity !== '' ? round2(Number(t.quantity) * Number(t.price || 1)) : '') + '">' +
    '<div class="hint">填写这次交易的总投入/总回收金额，' + (isFx ? '外币数量' : '份额') + '自动按单价折算。</div></div>';

  const priceField = '<div class="field" id="t-price-row"><label>' + priceLabel + ' *</label>' +
    '<input id="t-price" type="number" min="0" step="any" placeholder="如 12.50" value="' + esc(t.price) + '">' +
    '<div class="hint">总金额模式下可不填：将按「当前单位价值」折算' + (isFx ? '外币数量' : '份额') + '；当前无单位价值时整笔金额按 1 份记录（金额即单价）。</div></div>';

  const minHoldField = (isBuy && !isStock)
    ? '<div class="field full"><label>这笔买入的最低持有天数（可选）</label><input id="t-minhold" type="number" min="0" step="1" placeholder="如 7（持有 7 天后再卖免手续费）" value="' + esc(t.minHoldDays != null ? t.minHoldDays : '') + '">' +
      '<div class="hint">不同时期买入可设置各自天数：未到期批次显示「锁定」，全部到期显示「可卖」</div></div>'
    : '';

  return '<div class="form-grid">' +
    '<div class="field"><label>日期 *</label><input id="t-date" type="date" value="' + esc(t.date) + '"></div>' +
    '<div class="field"><label>手续费（可选）</label><input id="t-fee" type="number" min="0" step="0.01" placeholder="0.00" value="' + esc(t.fee) + '"></div>' +
    modeSwitch +
    qtyField + amountField + priceField +
    minHoldField +
    '<div class="field full"><label>备注（可选）</label><input id="t-note" type="text" placeholder="如：分批建仓 / 部分止盈" value="' + esc(t.note) + '"></div>' +
    (isBuy ? '' : '<div class="field full"><div class="hint">当前持仓 <b>' + fmtQty(pos.qty) + '</b>' + (isFx ? '（' + esc(fxName) + '）' : '') + '，卖出数量不能超过持仓。</div></div>') +
  '</div>';
}

function openTradeForm(assetId, type, tradeId) {
  const asset = getAsset(assetId);
  const trade = tradeId ? state.trades.find(x => x.id === tradeId) : null;
  const title = trade ? '编辑交易 · ' + asset.name : (type === 'buy' ? '买入 · ' : '卖出 · ') + asset.name;
  openModal(title, tradeFormHTML(asset, trade ? trade.type : type, trade),
    () => submitTrade(assetId, tradeId, trade ? trade.type : type));

  // 录入方式切换：份数×单价 ⇄ 总金额
  const qtyRadio = document.querySelector('input[name="tmode"][value="qty"]');
  const amountRadio = document.querySelector('input[name="tmode"][value="amount"]');
  if (qtyRadio && amountRadio) {
    const applyMode = () => {
      const isAmount = amountRadio.checked;
      $id('t-qty-row').style.display = isAmount ? 'none' : '';
      $id('t-amount-row').style.display = isAmount ? '' : 'none';
    };
    qtyRadio.onchange = applyMode;
    amountRadio.onchange = applyMode;
  }
}

function submitTrade(assetId, tradeId, type) {
  const asset = getAsset(assetId);
  const date = $id('t-date').value;
  const modeEl = document.querySelector('input[name="tmode"]:checked');
  const mode = modeEl ? modeEl.value : 'qty';
  let qty, price;
  if (mode === 'amount') {
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

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  bindModalButtons();

  $id('btn-add').onclick = () => openAssetForm(null);
  $id('empty-add').onclick = () => openAssetForm(null);

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
    note: (opts && opts.note) || '', mode: 'qty',
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
    // 外币：按汇率买卖（金额 = 外币数量 × 汇率，单位人民币）
    mkTrade(a7.id, 'buy', 100, 2000, 7.15, { note: '用人民币兑换美元' }),
    mkTrade(a7.id, 'sell', 30, 500, 7.30, { note: '部分卖出换回人民币' }),
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
  + '<li><b>记录买卖</b>：卡片上点「＋ 买入 / − 卖出」逐笔记账。每笔支持两种录入方式：<b>份数×单价</b>（金额自动算，股票默认）或<b>总金额</b>（份额自动折算，基金等默认）。卖出时系统自动校验不超持仓。</li>'
  + '<li><b>维护当前市值</b>：股票点「✎ 现价」填当前股价（或「⟳ 刷新行情」联网获取）；基金/存款/外币等点「✎ 市值」直接填<b>当前持仓总金额</b>，系统自动折算单位价值。</li>'
  + '<li><b>查看指标</b>：每张卡片显示持仓金额/数量、累计投入、浮动盈亏、已实现盈亏、总盈亏与年化（近似）；展开「查看记录」可见逐笔明细与（股票）近期走势。</li>'
  + '<li><b>统计与图表</b>：顶部汇总区按基准币种显示总市值 / 总盈亏 / 整体年化；图表区含资产结构环图（可切换按类别/币种/风险等级）、市值排行、<b>组合市值走势</b>（市值 vs 累计净投入）与<b>盈亏构成</b>。点击环图切片或条形图还可联动筛选下方产品列表（「✕ 清除图表筛选」恢复）；另可用下拉筛选与排序（市值 / 年化 / 收益率 / 持有天数）。</li>'
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
  + '<p><b>· 外币投资</b>：记录用<b>人民币</b>买入/卖出的外币，买卖时填写成交汇率（1 外币 = ? 人民币）。持仓金额 = 外币余额 × 当前汇率，收益 = 现在能换回的人民币 − 当初花出的人民币（含汇率变动影响）。</p>'
  + '<p><b>· 多币种与汇率</b>：不同币种资产先按各自币种记账，汇总统计时按你维护的汇率换算为基准币种；换算后的收益同时包含价格与汇率变动的影响。</p>'
  + '<p><b>· 红涨绿跌</b>：按国内习惯，收益为正显示红色、为负显示绿色。</p>'
  + '</section>'
  + '<section class="help-section"><h4>交易记录模式与行情</h4>'
  + '<p><b>· 两种录入方式</b>：<b>份数×单价</b>——填份额与成交单价，金额自动计算；<b>总金额</b>——填这次投入/回收的总金额，份额按单价（或当前单位价值）自动折算，适合"我买了 1 万元基金"这种表述。股票默认前者，其他产品默认后者，可随时切换。</p>'
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
  ringDataByDim, setChartFilter, clearChartFilter,
  openExportModal, openImportModal, importPayloadText, buildExportPayload,
  migrateToTrades, migrateToV6, fxRateFromCache, daysAgoStr,
  normalizeSymbol, symbolToCurrency, fetchQuote, fetchKline, fetchStockInfo,
  refreshQuoteForAsset, refreshAllQuotes, manualPriceline,
};

})();
