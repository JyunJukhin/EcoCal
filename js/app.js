
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
 * - 次版本：功能增强（v5 监察表模式与优化、v6.1 统计功能、v6.2 统计页重设计、v6.4 云备份）
 * - 补丁：缺陷修复 */
const APP_VERSION = '6.4.2';

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
/**
 * 价格「软修整」：只修正极小浮点误差（EPSILON 级别），不做任何取整。
 * 与 roundPrice 的区别：roundPrice 会把 7.25255 → 7.2526 等四舍五入到 4 位小数；
 * 用户通过「✎ 现价 / ✎ 市值」手动录入的数值应原样保留（不四舍五入）。
 */
function roundPriceSoft(n) {
  const x = Number(n);
  if (!isFinite(x)) return x;
  return Math.abs(Math.round(x) - x) < 1e-10 ? Math.round(x) : (Math.round(x * 1e12) / 1e12);
}
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
  // 云备份（WebDAV）：可选，配置后可把数据实时备份到 Web 端点
  // 注意：应用密码不存这里（不进备份文件、不进导出），单独存 localStorage 'ecocal.webdav.pass'
  webdav: {
    enabled: false,       // 是否启用自动备份
    url: '',              // WebDAV 端点（如 https://dav.jianguoyun.com/dav/）
    user: '',             // 用户名/邮箱（坚果云为账号邮箱）
    dir: 'EcoCal',        // 服务器上的备份目录（自动创建）
    lastBackupAt: null,   // 最近一次备份成功时间
    lastError: null,      // 最近一次失败原因（提示用）
  },
  // 云备份（Gitee 仓库）：可选，网页跨域直连 Gitee API（无需 Zotero UA 等门槛）
  // 注意：私人令牌不存这里（不进备份文件、不进导出），单独存 localStorage 'ecocal.gitee.token'
  gitee: {
    enabled: false,       // 是否启用自动备份
    owner: '',            // Gitee 用户名 / 组织名
    repo: '',             // 私有仓库名（如 ecocal-backup）
    path: 'ecocal-backup.json', // 仓库内备份文件路径（存储格式回到 .json）
    lastBackupAt: null,   // 最近一次备份成功时间
    lastError: null,      // 最近一次失败原因（提示用）
  },
  pinEnabled: false,      // 是否启用启动 PIN 锁（锁定时不显示任何资产数据）
  // 备份提醒：关闭自动备份（或自动备份连续失败）时，超过 N 天没有成功备份则提醒手动备份
  backupReminder: {
    enabled: false,       // 是否启用「未备份提醒」
    days: 7,              // 超过 N 天未成功备份时提醒（N 由用户设置）
  },
};

let state = { assets: [], valuations: [], trades: [], settings: Object.assign({}, DEFAULT_SETTINGS) };

function saveState() {
  storageSet(state);
  saveGateReal();
}

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
   * trades：该产品的全部交易（buy/sell）；lastPrice：最新股价/汇率（null 表示行情缺失）。
   * 返回 { qty, cost, avgCost, realized, marketValue, float, totalProfit, events, days, hasTrades }
   *   - float    浮动盈亏 = 市值 − 持仓成本
   *   - realized 已实现盈亏 = Σ(卖出金额 − 卖出数量×当时平均成本)
   *   - totalProfit = 浮动 + 已实现
   * 口径：lastPrice 缺失且有持仓时，市值回退用「最近成交价」估算（与走势图一致），
   *       已完成清仓（qty=0）或尚无任何交易时市值仍为 null。
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
    // 市场价：优先用传入的 lastPrice（现价/汇率）；缺失时有持仓则回退最近成交价
    // —— 与组合走势图（portfolioTrend）口径一致。修复：仅一笔买入且未设现价的
    //    资产（如导入数据没带 lastPrice）此前市值显示 --、统计总额漏算。
    let fallbackPrice = null;
    if (lastPrice == null && qty > 0) {
      for (let i = list.length - 1; i >= 0; i--) {
        const cand = Number(list[i].price);
        if (isFinite(cand) && cand > 0) { fallbackPrice = cand; break; }
      }
    }
    const valPrice = (lastPrice != null && Number(lastPrice) > 0) ? Number(lastPrice) : fallbackPrice;
    const marketValue = (valPrice != null && qty > 0) ? round2(qty * valPrice) : null;
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
/** 数量/单价显示：去掉冗余尾零，保留至多 8 位小数（可完整显示手动录入的 4 位以上小数价格） */
function fmtQty(n) {
  const num = Number(n);
  if (!isFinite(num)) return '--';
  return num.toLocaleString('zh-CN', { maximumFractionDigits: 8 });
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
  // 回填显示用当前单位价值 × 持有数量的总金额（4 位小数展示，提交时原样折算）
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
      // 手动录入的现价/市值原样保存（只做浮点误差修整，不取整）：
      // 之前 roundQty 会把 7.2525 → 7.2525 之外的值舍入到 4 位小数，用户录多少就是多少。
      asset.lastPrice = roundPriceSoft(v);
    } else {
      const v = parseFloat($id('p-value').value);
      if (!isFinite(v) || v <= 0) { alert('持仓总金额必须为正数。'); return; }
      // 持仓总金额 ÷ 份额折算单位价值：同样只修整浮点误差、不取整（用户录入的总金额要精确保留）
      asset.lastPrice = roundPriceSoft(v / qty);
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
  const rem = settings.backupReminder || {};
  const remDaysVal = (rem.days != null && Number(rem.days) > 0) ? Number(rem.days) : 7;
  return '<div class="settings-tabs">' +
      '<button type="button" class="set-tab on" data-tab="basic">汇率与行情</button>' +
      '<button type="button" class="set-tab" data-tab="stats">统计</button>' +
      '<button type="button" class="set-tab" data-tab="backup">备份</button>' +
      '<button type="button" class="set-tab" data-tab="security">安全</button>' +
    '</div>' +
    '<div class="set-pane" data-tab="basic">' +
      '<div class="settings-tip">汇率用于把各币种资产换算为<b>基准币种</b>做总价值统计。可点击下方按钮<b>联网获取最新汇率</b>（免费公开接口，仅供统计参考，不做行情依据）；也可手动维护。未设置汇率的币种会<b>不计入总额统计</b>，并在界面标注提醒。</div>' +
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
    '</div>' +
    '<div class="set-pane" data-tab="stats" style="display:none">' +
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
    '<div class="set-pane" data-tab="backup" style="display:none">' +
      '<div class="field" style="margin-bottom:8px"><label>云备份（WebDAV，可选）</label></div>' +
      '<div class="hint" style="margin-bottom:10px">配置后可把数据<b>自动备份到 WebDAV 网盘</b>，防止清缓存/换设备丢数据。每次改动后自动上传（停止编辑 60 秒后合并同步，切后台立即同步），云端为单文件覆盖式，最多保留最近一份。</div>' +
      '<div class="field" style="margin-bottom:8px"><label>WebDAV 地址</label>' +
      '<input type="url" id="wd-url" placeholder="https://data.cstcloud.cn/dav/" value="' + esc(settings.webdav && settings.webdav.url || '') + '">' +
      '<div class="hint">中国科技云·数据胶囊：https://data.cstcloud.cn/dav/；坚果云：dav.jianguoyun.com/dav/；需要「应用密码」而不是登录密码。部分服务（如 Zotero 专用 WebDAV）禁止新建目录，会自动改用其可写目录。</div></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 14px;margin-bottom:8px">' +
        '<div class="field"><label>用户名 / 邮箱</label>' +
        '<input type="text" id="wd-user" autocomplete="username" value="' + esc(settings.webdav && settings.webdav.user || '') + '"></div>' +
        '<div class="field"><label>应用密码</label>' +
        '<input type="password" id="wd-pass" autocomplete="new-password" placeholder="' + (webdavPwdSet() ? '（已保存，留空则不变）' : '') + '" value="">' +
        '<div class="hint">不会出现在备份文件与导出内容里，仅存本机。</div></div>' +
      '</div>' +
      '<div class="field" style="margin-bottom:10px"><label>云端目录（自动创建）</label>' +
      '<input type="text" id="wd-dir" value="' + esc(settings.webdav && settings.webdav.dir || 'EcoCal') + '" placeholder="EcoCal">' +
      '<div class="hint">备份文件将保存在该目录下的 ecocal-backup.json。</div></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px">' +
        '<button type="button" id="wd-test" class="btn btn-ghost btn-mini">🔌 测试连接</button>' +
        '<button type="button" id="wd-backup" class="btn btn-primary btn-mini">⬆ 立即备份</button>' +
        '<button type="button" id="wd-restore" class="btn btn-ghost btn-mini">⬇ 从云端恢复</button>' +
        '<button type="button" id="wd-clear-pass" class="btn btn-ghost btn-mini" style="display:' + (webdavPwdSet() ? '' : 'none') + '">清除已存密码</button>' +
      '</div>' +
      '<div class="hint" id="wd-status" style="font-size:12px;margin-bottom:6px"></div>' +
      '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center">' +
        '<input type="checkbox" id="wd-enabled"' + (settings.webdav && settings.webdav.enabled ? ' checked' : '') + '> 启用自动备份（每次数据改动后自动上传，停止编辑 60 秒后同步）' +
      '</label>' +
      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">' +
        '<div class="field" style="margin-bottom:8px"><label>云备份（Gitee 仓库，可选）</label></div>' +
        '<div class="hint" style="margin-bottom:10px">配置后可把数据<b>自动备份到你的 Gitee 仓库</b>，防止清缓存/换设备丢数据。网页可直接跨域访问 Gitee API（无需额外客户端），每次改动后自动上传（停止编辑 60 秒后合并同步，切后台立即同步），云端为单文件覆盖式（存储格式 .json）。</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 14px;margin-bottom:8px">' +
          '<div class="field"><label>Gitee 用户名 / 组织</label>' +
          '<input type="text" id="g-owner" autocomplete="username" placeholder="如 yourname" value="' + esc(settings.gitee && settings.gitee.owner || '') + '"></div>' +
          '<div class="field"><label>仓库名</label>' +
          '<input type="text" id="g-repo" placeholder="如 ecocal-backup" value="' + esc(settings.gitee && settings.gitee.repo || '') + '">' +
          '<div class="hint">建议使用<b>私有</b>仓库存放备份。</div></div>' +
        '</div>' +
        '<div class="field" style="margin-bottom:8px"><label>私人令牌（access_token）</label>' +
        '<input type="password" id="g-token" autocomplete="new-password" placeholder="' + (giteeTokenSet() ? '（已保存，留空则不变）' : '') + '" value="">' +
        '<div class="hint">在 gitee.com/profile/personal_access_tokens 生成，勾选 <b>projects</b> 读写权限；不会出现在备份文件与导出内容里，仅存本机。</div></div>' +
        '<div class="field" style="margin-bottom:10px"><label>仓库内备份文件路径</label>' +
        '<input type="text" id="g-path" value="' + esc(settings.gitee && settings.gitee.path || 'ecocal-backup.json') + '" placeholder="ecocal-backup.json">' +
        '<div class="hint">默认 ecocal-backup.json，存于仓库根目录。</div></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px">' +
          '<button type="button" id="g-test" class="btn btn-ghost btn-mini">🔌 测试连接</button>' +
          '<button type="button" id="g-backup" class="btn btn-primary btn-mini">⬆ 立即备份</button>' +
          '<button type="button" id="g-restore" class="btn btn-ghost btn-mini">⬇ 从云端恢复</button>' +
          '<button type="button" id="g-clear-token" class="btn btn-ghost btn-mini" style="display:' + (giteeTokenSet() ? '' : 'none') + '">清除已存令牌</button>' +
        '</div>' +
        '<div class="hint" id="g-status" style="font-size:12px;margin-bottom:6px"></div>' +
        '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center">' +
          '<input type="checkbox" id="g-enabled"' + (settings.gitee && settings.gitee.enabled ? ' checked' : '') + '> 启用自动备份（每次数据改动后自动上传，停止编辑 60 秒后同步）' +
        '</label>' +
      '</div>' +
      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">' +
        '<div class="field" style="margin-bottom:8px"><label>备份提醒（可选）</label>' +
        '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center;margin-bottom:8px">' +
          '<input type="checkbox" id="rem-enabled"' + (rem.enabled ? ' checked' : '') + '> 超过 N 天没有成功备份时，提醒我手动备份' +
        '</label>' +
        '<div class="field" style="margin-bottom:4px"><label>间隔天数（N）</label>' +
        '<input type="number" id="rem-days" min="1" max="365" step="1" value="' + remDaysVal + '">' +
        '<div class="hint">若本机数据超过 N 天没有成功备份（未配置自动备份或自动备份连续失败），打开页面时会提醒一次并引导去「导出 / 立即备份」。</div></div>' +
      '</div>' +
      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">' +
        '<div class="field" style="margin-bottom:8px"><label>数据管理</label></div>' +
        '<div class="hint" style="margin-bottom:10px">清空会删除全部产品、交易记录与汇率设置（可撤销：页面底部会出现「撤销」提示条）。</div>' +
        '<button type="button" id="s-clear" class="btn btn-danger btn-mini">🗑 清空全部数据</button>' +
      '</div>' +
    '</div>' +
    '<div class="set-pane" data-tab="security" style="display:none">' +
      securityHTML() +
    '</div>' +
    '<div style="margin-top:16px;font-size:12px;color:var(--ink-3)">EcoCal v' + APP_VERSION + ' · 数据默认仅保存在本机浏览器（localStorage）；可在「备份」页配置自动备份到 WebDAV 网盘或 Gitee 仓库（推荐 Gitee：国内直连、网页无门槛）。</div>';
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

  /* ---- 云备份（WebDAV）面板 ---- */
  const wdStatus = $id('wd-status');
  const wdLast = () => {
    const st = state.settings.webdav || {};
    if (st.lastBackupAt) {
      return '上次备份成功：' + new Date(st.lastBackupAt).toLocaleString() +
        (st.lastError ? '；上次失败：' + st.lastError : '');
    }
    if (st.lastError) return '上次备份失败：' + st.lastError;
    return '';
  };
  wdStatus.textContent = wdLast();

  const readWebdavInputs = () => {
    const st = state.settings.webdav || (state.settings.webdav = {});
    st.url = $id('wd-url').value.trim();
    st.user = $id('wd-user').value.trim();
    st.dir = $id('wd-dir').value.trim() || 'EcoCal';
  };
  const savePassFromInput = () => {
    const v = $id('wd-pass').value.trim();
    if (v) webdavBackup.setPass(v);
  };
  const updatePassBtn = () => {
    const btn = $id('wd-clear-pass');
    if (btn) btn.style.display = webdavPwdSet() ? '' : 'none';
  };

  const wdBtnState = (disable) => {
    ['wd-test', 'wd-backup', 'wd-restore'].forEach(id => {
      const b = $id(id); if (b) b.disabled = disable;
    });
  };

  $id('wd-test').onclick = async () => {
    readWebdavInputs(); savePassFromInput();
    wdStatus.textContent = '连接测试中…';
    wdBtnState(true);
    try {
      await webdavBackup.testConnection();
      wdStatus.textContent = '✓ 连接成功：凭据有效、目录可写。（浏览器跨域限制下若仍受 CORS 拦截，将在自动备份时提示）';
    } catch (e) {
      wdStatus.textContent = '✗ 连接失败：' + (e && e.message ? e.message : e) + '（若为 CORS/网络问题，网页可能无法直连网盘，可改用「导出」手动备份）';
    }
    wdBtnState(false); updatePassBtn();
  };

  $id('wd-backup').onclick = async () => {
    readWebdavInputs(); savePassFromInput();
    wdStatus.textContent = '上传中…';
    wdBtnState(true);
    const r = await manualWebdavBackup();
    wdStatus.textContent = r.ok
      ? '✓ 已备份成功（' + (r.size / 1024).toFixed(1) + ' KB）' + wdLast()
      : '✗ 备份失败：' + r.error + '（若为 CORS/网络问题，网页可能无法直连网盘，可改用「导出」手动备份）';
    wdBtnState(false); updatePassBtn();
  };

  $id('wd-restore').onclick = async () => {
    readWebdavInputs(); savePassFromInput();
    try {
      await manualWebdavRestore();
    } catch (e) {
      wdStatus.textContent = '✗ 恢复失败：' + (e && e.message ? e.message : e);
    }
    updatePassBtn();
  };

  $id('wd-clear-pass').onclick = () => {
    webdavBackup.setPass('');
    $id('wd-pass').value = '';
    updatePassBtn();
    wdStatus.textContent = '已清除保存的应用密码。';
  };

  const wdEnabled = $id('wd-enabled');
  wdEnabled.onchange = () => {
    state.settings.webdav = state.settings.webdav || {};
    state.settings.webdav.enabled = wdEnabled.checked;
    // 启用自动备份时读取当前输入（测试连接/备份时会读取；此处避免未配置就上传）
    if (wdEnabled.checked) { readWebdavInputs(); savePassFromInput(); }
    saveState();
  };

  /* ---- 云备份（Gitee 仓库）面板 ---- */
  const gStatus = $id('g-status');
  const gLast = () => {
    const st = state.settings.gitee || {};
    if (st.lastBackupAt) {
      return '上次备份成功：' + new Date(st.lastBackupAt).toLocaleString() +
        (st.lastError ? '；上次失败：' + st.lastError : '');
    }
    if (st.lastError) return '上次备份失败：' + st.lastError;
    return '';
  };
  gStatus.textContent = gLast();

  const readGiteeInputs = () => {
    const st = state.settings.gitee || (state.settings.gitee = {});
    st.owner = $id('g-owner').value.trim();
    st.repo = $id('g-repo').value.trim();
    st.path = $id('g-path').value.trim() || 'ecocal-backup.json';
  };
  const saveTokenFromInput = () => {
    const v = $id('g-token').value.trim();
    if (v) giteeBackup.setToken(v);
  };
  const updateTokenBtn = () => {
    const btn = $id('g-clear-token');
    if (btn) btn.style.display = giteeTokenSet() ? '' : 'none';
  };

  const gBtnState = (disable) => {
    ['g-test', 'g-backup', 'g-restore'].forEach(id => {
      const b = $id(id); if (b) b.disabled = disable;
    });
  };

  $id('g-test').onclick = async () => {
    readGiteeInputs(); saveTokenFromInput();
    gStatus.textContent = '连接测试中…';
    gBtnState(true);
    try {
      const info = await giteeBackup.testConnection();
      gStatus.textContent = '✓ 连接成功：' + (info || '凭据有效、仓库可写。');
    } catch (e) {
      gStatus.textContent = '✗ 连接失败：' + (e && e.message ? e.message : e);
    }
    gBtnState(false); updateTokenBtn();
  };

  $id('g-backup').onclick = async () => {
    readGiteeInputs(); saveTokenFromInput();
    gStatus.textContent = '上传中…';
    gBtnState(true);
    const r = await manualGiteeBackup();
    gStatus.textContent = r.ok
      ? '✓ 已备份成功（' + (r.size / 1024).toFixed(1) + ' KB）' + gLast()
      : '✗ 备份失败：' + r.error;
    gBtnState(false); updateTokenBtn();
  };

  $id('g-restore').onclick = async () => {
    readGiteeInputs(); saveTokenFromInput();
    try {
      await manualGiteeRestore();
    } catch (e) {
      gStatus.textContent = '✗ 恢复失败：' + (e && e.message ? e.message : e);
    }
    updateTokenBtn();
  };

  $id('g-clear-token').onclick = () => {
    giteeBackup.setToken('');
    $id('g-token').value = '';
    updateTokenBtn();
    gStatus.textContent = '已清除保存的私人令牌。';
  };

  const gEnabled = $id('g-enabled');
  gEnabled.onchange = () => {
    state.settings.gitee = state.settings.gitee || {};
    state.settings.gitee.enabled = gEnabled.checked;
    if (gEnabled.checked) { readGiteeInputs(); saveTokenFromInput(); }
    saveState();
  };

  /* ---- 备份提醒（未备份 > N 天提醒手动备份） ---- */
  const remEnabled = $id('rem-enabled');
  const remDays = $id('rem-days');
  if (remEnabled) {
    remEnabled.checked = !!(state.settings.backupReminder || {}).enabled;
    remEnabled.onchange = () => {
      state.settings.backupReminder = state.settings.backupReminder || {};
      state.settings.backupReminder.enabled = remEnabled.checked;
      saveState();
    };
  }
  if (remDays) {
    remDays.value = (state.settings.backupReminder && state.settings.backupReminder.days) || 7;
    remDays.oninput = () => {
      const v = parseInt(remDays.value, 10);
      if (isFinite(v) && v > 0) {
        state.settings.backupReminder = state.settings.backupReminder || {};
        state.settings.backupReminder.days = v;
        saveState();
      }
    };
  }

  /* ---- 设置页 Tab 切换：仅切换可见性（隐藏面板仍在 DOM 中，保存时照常读取） ---- */
  const setTabs = document.querySelectorAll('.set-tab');
  setTabs.forEach(tab => {
    tab.onclick = () => {
      const target = tab.dataset.tab;
      setTabs.forEach(t => { t.classList.toggle('on', t === tab); });
      document.querySelectorAll('.set-pane').forEach(p => { p.style.display = p.dataset.tab === target ? '' : 'none'; });
    };
  });

  modalOnOk = () => {
    const base = $id('s-base').value;
    const oldBase = state.settings.baseCurrency;
    const oldRates = Object.assign({}, state.settings.rates);

    // 云备份面板输入回写（url/user/dir/pass + gitee owner/repo/path/token；enabled 已由 onchange 即时保存）
    readWebdavInputs(); savePassFromInput();
    readGiteeInputs(); saveTokenFromInput();

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
    // 安全（PIN 锁）设置：勾选启用 → 立即用当前输入的 PIN 启用并加锁（开始生效）
    const pinToggle = $id('s-pin-toggle');
    if (pinToggle) {
      if (pinToggle.checked) {
        const pin = ($id('s-pin').value || '').replace(/\s/g, '');
        const resetCode = $id('s-pin-reset').value.trim();
        if (!/^\d{4,6}$/.test(pin)) { alert('请设置 4~6 位数字 PIN。'); return; }
        if (!resetCode) { alert('请设置「重置口令」，忘记 PIN 时可凭它解锁。'); return; }
        setPin(pin, resetCode);
        pinLock(); // 立即加锁：保存后需重新输入才能看到数据
        alert('PIN 锁已启用（即时生效）：请记住重置口令「' + resetCode + '」。');
      } else if (pinEnabled()) {
        // 取消勾选：必须先取消当前锁定（输入当前 PIN）才能关闭
        const cur = prompt('关闭 PIN 锁需先验证当前 PIN：');
        if (checkPin(cur)) { clearPin(); }
        else { alert('PIN 不正确，已保留当前 PIN 锁。'); pinToggle.checked = true; }
      }
    }
    saveState(); renderAll(); closeModal();
    // 若刚启用了 PIN 锁（modalOnOk 内已 pinLock），关闭保存后再显示遮罩以确保数据不可见
    if (pinEnabled()) pinLock();
  };
}

/* ---------------- 云备份（WebDAV） ---------------- */
/** 是否已保存过应用密码（供设置面板显示「清除密码」按钮） */
function webdavPwdSet() { return !!webdavBackup.getPass(); }
/**
 * 云备份后端：把数据实时备份到支持 WebDAV 的网盘（如坚果云）。
 * 每次有改动（saveState）后节流上传；也可在设置面板手动备份/恢复。
 * 注：网页跨域写 WebDAV 受浏览器 CORS 限制，坚果云实测不返回 CORS 头，
 * 若被浏览器拦截，会提示并引导使用「导出 + 手动保存」兜底。
 */
const webdavBackup = {
  // 应用密码独立存储：不进 state（避免出现在备份/导出内容中）
  getPass() {
    try { return window.localStorage.getItem('ecocal.webdav.pass') || ''; } catch (e) { return ''; }
  },
  setPass(v) {
    try {
      if (v) window.localStorage.setItem('ecocal.webdav.pass', v);
      else window.localStorage.removeItem('ecocal.webdav.pass');
    } catch (e) { /* 隐私模式等场景忽略 */ }
  },

  // 当前 WebDAV 基础配置（从 settings 读取，避免每次传参）
  get cfg() {
    const c = state.settings.webdav || {};
    return { ...c, pass: this.getPass() };
  },

  // 规范化目录：去首尾空白与斜杠、防穿越、防非法字符
  normDir(dir) {
    let d = String(dir == null ? '' : dir).trim()
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .split('/').filter(s => s !== '' && s !== '.' && s !== '..')
      .join('/');
    return d;
  },

  /** 远程文件完整路径（如 EcoCal/ecocal-backup.json） */
  remotePath() {
    const dir = this.normDir(this.cfg.dir);
    // 注：默认扩展名是 .json（EcoCal 备份标准格式）。部分 WebDAV 服务（如中国科技云·数据胶囊
    // Zotero 专用端点）只放行 Zotero 附件格式（.zip）；如需兼容可自行在目录里建 .zip 文件名，
    // 但标准备份文件名保持 ecocal-backup.json，与本机导出格式一致。
    return (dir ? dir + '/' : '') + 'ecocal-backup.json';
  },
  /** 基础配置校验；返回错误信息或 null */
  validate() {
    const c = this.cfg;
    if (!c.url) return '未填写 WebDAV 地址';
    if (!c.user || !c.pass) return '未填写 WebDAV 用户名与应用密码';
    const m = /^https?:\/\/([^/?#]+)/i.exec(String(c.url).trim());
    if (!m) return 'WebDAV 地址必须以 http(s):// 开头';
    const host = m[1].split('@').pop().split(':')[0]; // 去 userinfo 与端口
    if (!host || host.indexOf('.') < 0) return 'WebDAV 地址缺少有效主机名';
    return null;
  },

  /** Basic 认证头 */
  authHeader() {
    const c = this.cfg;
    return 'Basic ' + btoa(unescape(encodeURIComponent(c.user + ':' + c.pass)));
  },

  /** 统一超时（毫秒） */
  _timeout: 15000,

  /**
   * 发送 WebDAV 请求（fetch）。
   * method: PROPFIND/PUT/GET/MKCOL/DELETE 等
   */
  async request(method, path, body, headers) {
    const cfg = this.cfg;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeout);
    const h = Object.assign({
      Authorization: this.authHeader(),
      // Zotero 兼容 User-Agent：中国科技云·数据胶囊等 Zotero 专用 WebDAV 端点
      // 会检查 UA 里是否含 "Zotero/"（否则 403 "Client type mismatch"）。浏览器
      // 允许自定义该请求头，仅用于 WebDAV 请求，不影响页面其它 fetch。
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Zotero/7.0.18',
    }, headers || {});
    const opts = {
      method,
      headers: h,
      signal: ctrl.signal,
    };
    if (body != null) opts.body = body;
    if (method === 'PROPFIND') opts.headers.Depth = '1';
    try {
      const resp = await fetch(cfg.url.replace(/\/+$/, '') + (path ? '/' + path.replace(/^\/+/, '') : ''), opts);
      return resp;
    } finally {
      clearTimeout(timer);
    }
  },

  /** PUT 上传数据（覆盖式） */
  async put(text) {
    const resp = await this.request('PUT', this.remotePath(), text, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    if (resp.status === 201 || resp.status === 204 || resp.status === 200) return true;
    throw new Error('上传失败（HTTP ' + resp.status + '）' + (resp.status === 401 ? '：用户名或应用密码不正确' : ''));
  },

  /** GET 下载数据；404 → null */
  async get() {
    const resp = await this.request('GET', this.remotePath());
    if (resp.status === 404) return null;
    if (resp.status !== 200) throw new Error('下载失败（HTTP ' + resp.status + '）');
    return resp.text();
  },

  /**
   * 确保目录存在（递归 MKCOL，宽容模式）。
   * 不同 WebDAV 服务对「目录已存在 / 不允许建目录」的响应五花八门：
   *   201 = 新建成功；204/200 = 幂等成功；405/409/412 = 已存在或结构冲突；
   *   403 = 服务端禁止创建集合（如 Zotero 专用 WebDAV 只允许在既有目录内写文件）；
   *   301/302 = 部分服务器目录尾斜杠跳转。
   * 这些都不影响后续「按路径直接 PUT 文件」的能力，一律放行；
   * 真正的写权限由 testConnection 的探针 PUT/DELETE 判定。
   */
  async ensureDir(dir) {
    if (!dir) return;
    const parts = dir.split('/');
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      const resp = await this.request('MKCOL', cur);
      const s = resp.status;
      if (s !== 201 && s !== 204 && s !== 200 && s !== 301 && s !== 302
          && s !== 405 && s !== 409 && s !== 412 && s !== 403) {
        throw new Error('创建目录失败（HTTP ' + s + '）');
      }
    }
  },

  /** 验证连接与凭据：目录可容错创建，随后以「探针 PUT/DELETE」判定真实写权限 */
  async testConnection() {
    const err = this.validate();
    if (err) throw new Error(err);
    const dir = this.normDir(this.cfg.dir);
    if (dir) {
      // 目录创建失败（403/405 等）不阻断：写权限最终由探针 PUT 判定
      try { await this.ensureDir(dir); } catch (e) { /* 忽略：交给探针验证 */ }
    }
    // 探针：先按配置目录，失败则回退根路径（Zotero 类 WebDAV 常只开放根写入）
    const tryProbe = async (probePath) => {
      const putResp = await this.request('PUT', probePath, 'ok');
      if (putResp.status !== 201 && putResp.status !== 204 && putResp.status !== 200) return false;
      await this.request('DELETE', probePath);
      return true;
    };
    const probePath = this.remotePath().replace(/ecocal-backup\.json$/, '.ecocal-probe');
    if (await tryProbe(probePath)) return true;
    if (probePath !== '.ecocal-probe' && await tryProbe('.ecocal-probe')) {      // 配置目录不可写、根可写：自动将云端目录改为根，保证后续备份/恢复走同一可写路径
      state.settings.webdav.dir = '';
      saveState();
      return true;
    }
    throw new Error('写测试失败（HTTP 403/405）：配置目录与 WebDAV 根路径均不可写，请检查账号权限或换一个可写目录');
  },

  /** 全量备份：生成精简 payload 并 PUT（覆盖式） */
  async backup() {
    await this.testConnection();
    const text = buildCloudPayload();
    await this.put(text);
    return text;
  },

  /** 恢复：下载云端数据 → 校验 → 返回解析后的数据（不自动应用） */
  async fetchRemote() {
    const err = this.validate();
    if (err) throw new Error(err);
    const text = await this.get();
    if (text == null || !text.trim()) throw new Error('云端还没有备份文件（可先点「立即备份」）。');
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('云端备份内容不是有效 JSON：' + e.message); }
    if (!data || !data.app || !Array.isArray(data.assets) || !Array.isArray(data.valuations)) {
      throw new Error('云端备份内容不是有效的 EcoCal 备份（缺少 app/assets/valuations）。');
    }
    return data;
  },
};

/* ---------------- 云备份调度（节流 + 退避 + 可见性同步） ---------------- */
/**
 * 自动备份（云）统一调度，WebDAV 与 Gitee 共用：
 * - 尾部防抖（trailing debounce）：每次 saveState 重置计时器，连续改动合并，
 *   停止改动 delay 毫秒后才上传一次（默认 60s——比旧 10s 更省配额与 commit 历史）；
 * - 失败重试退避：按 30s → 2min → 10min 指数增长，成功后复位；失败无需等下次改动即自动重试；
 * - 切后台/切页立即同步：监听 visibilitychange / pagehide，防抖窗口内有待传任务时立即上传。
 */
const AUTO_BACKUP_DELAY = 60000;        // 停止改动后等待上传的防抖窗口（60 秒）
const BACKOFF_STEPS_MS = [30000, 120000, 600000]; // 失败重试退避（30s → 2min → 10min，末档后保持 10min）

/** 统一调度初始参数（WebDAV / Gitee 各一套） */
function backupGateInit(conf) {
  return { conf, pending: null, retryTimer: null, retryIndex: -1 };
}
let webdavGate = backupGateInit({
  enabled: () => !!(state.settings.webdav || {}).enabled,
  validate: () => webdavBackup.validate(),
  doBackup: () => webdavBackup.backup(),
  sectionKey: 'webdav',
});
let giteeGate = backupGateInit({
  enabled: () => !!(state.settings.gitee || {}).enabled,
  validate: () => giteeBackup.validate(),
  doBackup: () => giteeBackup.backup(),
  sectionKey: 'gitee',
});

/** 数据改动后调用：登记待备份文本并重置防抖计时 */
function gateDirty(gate, payloadFn) {
  if (!gate.conf.enabled()) return;
  const err = gate.conf.validate();
  if (err) return; // 未配置完整时静默跳过
  if (gate.retryTimer) { clearTimeout(gate.retryTimer); gate.retryTimer = null; gate.retryIndex = -1; }
  if (gate.pending) clearTimeout(gate.pending.timer);
  gate.pending = {
    text: payloadFn(state), // 快照（含 base/backed 指纹），保证上传的是最新一次改动
    timer: setTimeout(() => {
      gate.pending = null;
      runBackupOnce(gate);
    }, AUTO_BACKUP_DELAY),
  };
}

/** 有待传改动（防抖窗口内）且数据已变化：立即同步，不必等满 60s */
function gateFlush() {
  if (webdavGate.pending && webdavGate.conf.enabled()) {
    clearTimeout(webdavGate.pending.timer); webdavGate.pending = null; runBackupOnce(webdavGate);
  }
  if (giteeGate.pending && giteeGate.conf.enabled()) {
    clearTimeout(giteeGate.pending.timer); giteeGate.pending = null; runBackupOnce(giteeGate);
  }
}

/** 执行一次备份：成功记录时间并清零退避；失败按退避计时器自动重试 */
function runBackupOnce(gate) {
  gate.conf.doBackup().then(() => {
    const section = gate.conf.sectionKey;
    const nowIso = new Date().toISOString();
    // 后台状态更新不触发再次备份（直接写 localStorage 原始 JSON）
    const raw = window.localStorage.getItem(STORAGE_KEY);
    try {
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.settings && section && d.settings[section]) {
          d.settings[section].lastBackupAt = nowIso;
          d.settings[section].lastError = null;
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
        }
      }
    } catch (e) { /* 忽略 */ }
    gate.retryIndex = -1;
  }).catch(err2 => {
    const msg = String(err2 && err2.message ? err2.message : err2);
    const section = gate.conf.sectionKey;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    try {
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.settings && section && d.settings[section]) {
          d.settings[section].lastError = msg;
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
        }
      }
    } catch (e) { /* 忽略 */ }
    // 指数退避重试：失败后 30s→2min→10min 自动再试，无需等下次改动
    const step = BACKOFF_STEPS_MS[Math.min(gate.retryIndex + 1, BACKOFF_STEPS_MS.length - 1)];
    gate.retryIndex++;
    if (gate.retryTimer) clearTimeout(gate.retryTimer);
    gate.retryTimer = setTimeout(() => { gate.retryTimer = null; runBackupOnce(gate); }, step);
  });
}

/** saveState 后调用：WebDAV 与 Gitee 都登记一次待备份 */
function saveGate() {
  gateDirty(webdavGate, () => buildCloudPayload());
  gateDirty(giteeGate, () => buildCloudPayload());
}

/**
 * 多设备冲突规避：仅当真实数据（本地 resources 指纹）有改动时才登记待备份。
 * localStorage 里备份时间/错误等**后台元数据**的更新（不写 state）不会触发上传，
 * 由 saveState() 直接调用的 saveGate() 对**所有** saveState 生效（含汇率/行情刷新）。
 * 注意：本函数由 saveState() 统一先调用（旧签名），当前实现总登记，以兼容既有语义。
 */
function saveGateReal() {
  gateDirty(webdavGate, () => buildCloudPayload());
  gateDirty(giteeGate, () => buildCloudPayload());
}

/** 清空所有挂起的自动备份计时器（测试收尾 / 手动禁用时避免残留定时器） */
function clearBackupTimers() {
  const clear = (gate) => {
    if (gate.pending) { clearTimeout(gate.pending.timer); gate.pending = null; }
    if (gate.retryTimer) { clearTimeout(gate.retryTimer); gate.retryTimer = null; }
    gate.retryIndex = -1;
  };
  clear(webdavGate);
  clear(giteeGate);
}

/** 页面可见性变化 / 卸载：有待传改动时立即同步（防抖窗口内不需要等满 60s） */
function bindBackupFlush() {
  try {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') gateFlush(); });
    window.addEventListener('pagehide', gateFlush);
  } catch (e) { /* 无 DOM 环境（单元测试）跳过 */ }
}

/* ---------------- 备份提醒（未备份 > N 天提醒手动备份） ---------------- */
/** 计算最近一次成功备份时间；没有任何成功备份记录时返回 null */
function lastBackupTime() {
  let latest = null;
  [state.settings.webdav, state.settings.gitee].forEach(s => {
    if (s && s.lastBackupAt) {
      const t = new Date(s.lastBackupAt).getTime();
      if (isFinite(t) && (latest == null || t > latest)) latest = t;
    }
  });
  return latest;
}/** 当前「自动备份」是否至少有一个目标已启用（webdav 或 gitee） */
function anyAutoBackupEnabled() {
  return !!((state.settings.webdav && state.settings.webdav.enabled) ||
    (state.settings.gitee && state.settings.gitee.enabled));
}
/** 是否需要提醒手动备份：启用提醒且（未配置自动备份 或 自动备份连续失败）时，若超过 N 天未成功备份 → 提醒 */
function needsBackupReminder() {
  const rem = state.settings.backupReminder || {};
  if (!rem.enabled) return false;
  const days = Number(rem.days);
  if (!(days > 0)) return false;
  if (anyAutoBackupEnabled()) return false; // 有自动备份兜底 → 不打扰
  const last = lastBackupTime();
  if (last == null) return true; // 从未成功备份过 → 提醒
  const elapsedDays = (Date.now() - last) / 86400000;
  return elapsedDays >= days;
}
/** 每天在打开页面时检查一次：「未备份 N 天」时提醒手动备份 */
function initBackupReminders() {
  try {
    const shownKey = 'ecocal.backup-reminder.' + todayStr(); // 每天只提醒一次
    if (window.localStorage.getItem(shownKey)) return;
    if (!needsBackupReminder()) return;
    window.localStorage.setItem(shownKey, '1'); // 先标记，避免重复弹窗
    confirmAction('备份提醒',
      '您已超过 <b>' + (state.settings.backupReminder || {}).days + ' 天</b>没有成功备份数据。' +
      '数据仅保存在本机浏览器，建议尽快手动备份（设置 → 备份 → 立即备份，或用「导出」保存一份）。', 
      () => {
        openExportModal(); // 点「去备份」直接打开导出面板（含 Excel / JSON 下载 / 复制）
      }, '去备份');
  } catch (e) { /* 无 DOM / localStorage 异常时静默 */ }
}

/** 立即备份（面板按钮用，返回是否成功） */
async function manualWebdavBackup() {
  try {
    const text = await webdavBackup.backup();
    state.settings.webdav.lastBackupAt = new Date().toISOString();
    state.settings.webdav.lastError = null;
    saveState(); // 持久化备份时间
    return { ok: true, size: text.length };
  } catch (e) {
    state.settings.webdav.lastError = String(e && e.message ? e.message : e);
    saveState();
    return { ok: false, error: state.settings.webdav.lastError };
  }
}

/** 恢复：下载云端 → 覆盖本地（恢复前先自动快照本地数据防误覆盖） */
async function manualWebdavRestore() {
  const data = await webdavBackup.fetchRemote(); // 失败直接抛给调用方
  closeModal();
  const snapshot = buildExportPayload();
  confirmAction('从云端恢复',
    '将从云端备份恢复数据并<b>覆盖当前全部本地数据</b>。' +
    '恢复前会自动把当前数据以「导出」文件形式下载一份到本机，如需撤销可重新导入该文件。确定继续吗？',
    () => {
      try { downloadJSON(snapshot); } catch (e) { /* 快照下载失败不阻断恢复 */ }
      applyPayload(data);
      renderAll();
      alert('已从云端恢复成功。');
    }, '恢复');
}

/* ---------------- 云备份（Gitee 仓库） ---------------- */
/** 是否已保存过私人令牌（供设置面板显示「清除令牌」按钮） */
function giteeTokenSet() { return !!giteeBackup.getToken(); }
/**
 * 云备份后端：把数据实时备份到 Gitee 仓库（contents API）。
 * Gitee API 实测（2026-10）：/api/v5/* 预检 200、Access-Control-Allow-Origin:*、
 * Allow-Methods 含 PUT/POST/DELETE、Allow-Headers 含 authorization → 网页跨域直连可行，
 * 无 Zotero 等 UA 门槛。国内 gitee.com 直连快（实测 254–403ms）。
 * 每次有改动（saveState）后节流上传；也可在设置面板手动备份/恢复。
 *
 * 思路：私有仓库内保存单文件 ecocal-backup.json（UTF-8 JSON 文本，base64 编码后
 * 通过 contents API 提交）。首次 POST 新建，之后 GET 读回 sha → PUT 更新（覆盖式）。
 */
const giteeBackup = {
  /** 私人令牌独立存储：不进 state（避免出现在备份/导出内容中） */
  getToken() {
    try { return window.localStorage.getItem('ecocal.gitee.token') || ''; } catch (e) { return ''; }
  },
  setToken(v) {
    try {
      if (v) window.localStorage.setItem('ecocal.gitee.token', v);
      else window.localStorage.removeItem('ecocal.gitee.token');
    } catch (e) { /* 隐私模式等场景忽略 */ }
  },

  /** 当前 Gitee 配置（从 settings 读取，令牌单独合并） */
  get cfg() {
    const c = state.settings.gitee || {};
    return { ...c, token: this.getToken() };
  },

  /** 仓库内文件路径（默认根目录 ecocal-backup.json，存储格式回到 .json） */
  get path() {
    const p = String(this.cfg.path || '').trim().replace(/^\/+/, '');
    return p || 'ecocal-backup.json';
  },
  /** 基础配置校验；返回错误信息或 null */
  validate() {
    const c = this.cfg;
    if (!c.owner) return '未填写 Gitee 用户名 / 组织';
    if (!c.repo) return '未填写 Gitee 仓库名';
    if (/[^A-Za-z0-9_.-]/.test(c.owner) || /[^A-Za-z0-9_.-]/.test(c.repo)) return '用户名 / 仓库名只能包含字母、数字、点、下划线、连字符';
    if (!c.token) return '未填写 Gitee 私人令牌';
    return null;
  },

  /** 统一超时（毫秒），Gitee API 国内直连一般 <1s */
  _timeout: 15000,

  /** 发送 Gitee API 请求（fetch）；bodyObj → form body，queryObj → URL query */
  async api(path, method, bodyObj, queryObj) {
    const cfg = this.cfg;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this._timeout);
    const build = (obj) => {
      const f = new URLSearchParams();
      if (obj) Object.keys(obj).forEach(k => { if (obj[k] != null) f.set(k, obj[k]); });
      return f.toString(); // 无 '?' 前缀
    };
    const bodyStr = build(bodyObj);
    const queryStr = build(queryObj);
    const opts = {
      method: method || 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    };
    if (method && method !== 'GET' && bodyObj) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      opts.body = bodyStr; // Gitee 用 form 传参（access_token 等）
    }
    try {
      const url = 'https://gitee.com/api/v5' + path + (queryStr ? '?' + queryStr : '');
      const resp = await fetch(url, opts);
      let text = '';
      try { text = await resp.text(); } catch (e) { /* 无 body */ }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
      return { ok: resp.status >= 200 && resp.status < 300, status: resp.status, data, text };
    } finally {
      clearTimeout(timer);
    }
  },

  /** GET 当前文件信息：{ sha, content } / null（不存在）；404 → null */
  async fetchMeta() {
    const c = this.cfg;
    const r = await this.api('/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
      '/contents/' + encodeURIComponent(this.path).replace(/%2F/g, '/'), 'GET', null, { access_token: c.token });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(r.data && r.data.message ? r.data.message : ('读取仓库文件失败（HTTP ' + r.status + '）'));
    return r.data || null;
  },

  /** 保存全量 JSON 文本到仓库（存在则 PUT 更新，否则 POST 新建） */
  async saveText(text) {
    const c = this.cfg;
    const content = btoa(unescape(encodeURIComponent(text))); // UTF-8 → base64（Gitee 要求 base64 内容）
    const meta = await this.fetchMeta();
    const body = { access_token: c.token, content, message: 'EcoCal 云备份' };
    let r;
    if (meta && meta.sha) {
      body.sha = meta.sha;
      r = await this.api('/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
        '/contents/' + encodeURIComponent(this.path).replace(/%2F/g, '/'), 'PUT', body);
    } else {
      r = await this.api('/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo) +
        '/contents/' + encodeURIComponent(this.path).replace(/%2F/g, '/'), 'POST', body);
    }
    if (!r.ok || !r.data || !r.data.content) {
      throw new Error('上传失败：' + (r.data && r.data.message ? r.data.message : ('HTTP ' + r.status)));
    }
    return true;
  },

  /** GET 读回并解析（返回 JSON 数据或 null） */
  async fetchRemote() {
    const meta = await this.fetchMeta();
    if (!meta) throw new Error('云端还没有备份文件（可先点「立即备份」）。');
    if (!meta.content) throw new Error('云端备份内容为空。');
    let text = '';
    try {
      // Gitee 返回 base64 的 content（可能含 \n 换行）
      const b64 = String(meta.content).replace(/\s+/g, '');
      text = decodeURIComponent(escape(atob(b64)));
    } catch (e) {
      throw new Error('云端备份不是有效 base64：' + e.message);
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('云端备份内容不是有效 JSON：' + e.message); }
    if (!data || !data.app || !Array.isArray(data.assets) || !Array.isArray(data.valuations)) {
      throw new Error('云端备份内容不是有效的 EcoCal 备份（缺少 app/assets/valuations）。');
    }
    return data;
  },

  /** 测试连接：校验令牌 + 确认仓库可读（顺带确认仓库存在） */
  async testConnection() {
    const err = this.validate();
    if (err) throw new Error(err);
    const c = this.cfg;
    // 1) 用户身份（令牌有效）
    const u = await this.api('/user', 'GET', null, { access_token: c.token });
    if (!u.ok) throw new Error('令牌无效或被拒绝：' + (u.data && u.data.message ? u.data.message : ('HTTP ' + u.status)));
    // 2) 仓库存在性（GET contents 或仓库详情）
    const repo = await this.api('/repos/' + encodeURIComponent(c.owner) + '/' + encodeURIComponent(c.repo), 'GET', null, { access_token: c.token });
    if (!repo.ok || !repo.data) {
      throw new Error('仓库不存在或无权访问：' + (repo.data && repo.data.message ? repo.data.message : ('HTTP ' + repo.status)));
    }
    return (u.data && u.data.name ? u.data.name : u.data && u.data.login) + ' → ' + c.owner + '/' + c.repo;
  },

  /** 全量备份：生成精简 payload 并保存到仓库（覆盖式） */
  async backup() {
    const err = this.validate();
    if (err) throw new Error(err);
    const text = buildCloudPayload();
    await this.saveText(text);
    return text;
  },
};

/** 立即备份（面板按钮用，返回是否成功） */
async function manualGiteeBackup() {
  try {
    const text = await giteeBackup.backup();
    state.settings.gitee.lastBackupAt = new Date().toISOString();
    state.settings.gitee.lastError = null;
    saveState(); // 持久化备份时间
    return { ok: true, size: text.length };
  } catch (e) {
    state.settings.gitee.lastError = String(e && e.message ? e.message : e);
    saveState();
    return { ok: false, error: state.settings.gitee.lastError };
  }
}

/** 恢复：下载云端 → 覆盖本地（恢复前先自动快照本地数据防误覆盖） */
async function manualGiteeRestore() {
  const data = await giteeBackup.fetchRemote(); // 失败直接抛给调用方
  closeModal();
  const snapshot = buildExportPayload();
  confirmAction('从云端恢复',
    '将从 Gitee 仓库备份恢复数据并<b>覆盖当前全部本地数据</b>。' +
    '恢复前会自动把当前数据以「导出」文件形式下载一份到本机，如需撤销可重新导入该文件。确定继续吗？',
    () => {
      try { downloadJSON(snapshot); } catch (e) { /* 快照下载失败不阻断恢复 */ }
      applyPayload(data);
      renderAll();
      alert('已从云端恢复成功。');
    }, '恢复');
}

/* ---------------- 导出 / 导入（手机友好：剪贴板 + 粘贴） ---------------- */
/** 生成完整备份 JSON 字符串 */
function buildExportPayload() {
  return JSON.stringify({ app: 'EcoCal', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

/**
 * 云备份精简载荷：与「导出」不同，云备份**不包含可联网重取/可重算的部分**，
 * 减小体积、降低备份噪音（汇率/行情每次联网刷新都会变，不应因此产生一次备份）：
 * - settings.rates（汇率表）：可联网重取，且会自动获取 → 不备份；
 * - settings.quotes / settings.kline（行情缓存）：联网查询结果，可重取 → 不备份；
 * - settings.ratesUpdatedAt / ratesSource / autoFetchRates / autoQuote：行情相关设置 → 不备份；
 * - settings.webdav / gitee 的 lastBackupAt / lastError（备份历史）→ 不备份；
 * loadState/applyPayload 对以上缺失字段取 DEFAULT_SETTINGS 或保留本地现值，兼容旧备份。
 */
function buildCloudPayload() {
  const s = JSON.parse(JSON.stringify(state.settings));
  // 行情/汇率相关：不随云备份走（可联网重取；每次刷新都会变，不应触发一次备份）
  const volatileKeys = ['rates', 'ratesUpdatedAt', 'ratesSource', 'autoFetchRates', 'autoQuote', 'quotes', 'kline'];
  volatileKeys.forEach(k => { delete s[k]; });
  // 备份历史不回传（避免把别处的时间/错误记录搬来搬去）
  if (s.webdav) { delete s.webdav.lastBackupAt; delete s.webdav.lastError; }
  if (s.gitee) { delete s.gitee.lastBackupAt; delete s.gitee.lastError; }
  const cloud = {
    app: 'EcoCal', version: 2,
    exportedAt: new Date().toISOString(),
    assets: state.assets,
    valuations: state.valuations,
    trades: state.trades,
    settings: s,
  };
  return JSON.stringify(cloud, null, 2);
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
  const html = '<div class="hint" style="margin-bottom:10px">三种方式任选：<b>下载 Excel</b> 便于对账/分享；<b>下载 .json</b> 是完整备份（可再导入）；<b>复制</b>可粘贴到备忘录/云盘（推荐手机使用）。</div>' +
    '<div style="display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<button type="button" id="exp-xlsx" class="btn btn-primary">⬇ 下载 .xlsx（Excel）</button>' +
      '<button type="button" id="exp-download" class="btn btn-ghost">⬇ 下载 .json 文件</button>' +
      '<button type="button" id="exp-copy" class="btn btn-ghost">📋 复制备份内容</button>' +
    '</div>' +
    '<div class="hint" id="exp-status" style="margin-bottom:6px"></div>' +
    '<textarea id="exp-text" readonly rows="10" spellcheck="false" ' +
      'style="width:100%;font-size:11px;font-family:ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:10px;padding:10px;box-sizing:border-box;background:#fafafa;color:var(--ink-2)">' + esc(payload) + '</textarea>';
  openModal('导出备份', html, null, null);
  $id('modal-ok').classList.add('hidden'); // 导出面板用面板内按钮，不需要底部保存
  $id('exp-xlsx').onclick = () => downloadXlsx();
  $id('exp-download').onclick = () => downloadJSON(payload);
  $id('exp-copy').onclick = () => copyText(payload, $id('exp-status'));
}

/* ---------------- 导出 Excel（.xlsx，无第三方依赖） ---------------- */
/**
 * 生成 Excel 工作簿（xlsx = OOXML + ZIP 容器，纯手写）：
 * - sharedStrings.xml：全部文本去重后集中存放（UTF-8）
 * - 三个工作表：持仓汇总 / 交易流水 / 按资产统计
 * 不引入任何第三方库，在浏览器 Blob 中直接生成、下载。
 */
function buildXlsxExcel() {
  const st = Calc.statistics(state.assets, state.trades, state.settings, {
    liabilities: state.settings.liabilities, singleAssetCap: state.settings.singleAssetCap,
  });
  const base = st.base;

  // 1) 收集三张表的行数据（预格式化字符串，便于 sharedStrings 去重）
  const sheets = [];

  // —— Sheet 1：持仓汇总 ——
  const holdRows = [['资产名称', '类别', '币种', '持仓数量', '成本', '现价/汇率', '市值', '浮动盈亏', '已实现盈亏', '总盈亏', '持有天数', '年化（单利）', '占比']];
  (st.detail || []).forEach(r => {
    const pos = r.pos;
    const annual = (pos.cost > 0 && pos.float != null && pos.days > 0)
      ? ((pos.float / pos.cost) * 365 / pos.days * 100) : null;
    holdRows.push([
      r.asset.name,
      (r.asset.subCategory || categoryLabel(r.asset.category)),
      r.asset.currency,
      pos.qty, pos.cost, r.asset.lastPrice != null ? r.asset.lastPrice : '',
      pos.marketValue != null ? pos.marketValue : '',
      pos.float, pos.realized, pos.totalProfit, pos.days,
      annual != null ? (Math.round(annual * 100) / 100) : '',
      r.sharePct != null ? (Math.round(r.sharePct * 10000) / 100) : '',
    ]);
  });
  sheets.push({ name: '持仓汇总', rows: holdRows, digits: [3, 4, 5, 6, 7, 8, 9, 10, 12] });

  // —— Sheet 2：交易流水 ——
  const tradeRows = [['资产', '方向', '日期', '数量', '单价', '金额', '手续费', '备注', '录入方式']];
  const modeLabel = m => ({ qty: '份数×单价', amount: '总金额', exchange: '兑换' }[m] || m || '');
  [...state.trades].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0)).forEach(t => {
    const a = state.assets.find(a => a.id === t.assetId);
    tradeRows.push([
      a ? a.name : t.assetId,
      t.type === 'buy' ? '买入' : '卖出',
      t.date, t.quantity, t.price, t.quantity * t.price, t.fee || 0,
      t.note || '', modeLabel(t.mode),
    ]);
  });
  sheets.push({ name: '交易流水', rows: tradeRows, digits: [3, 4, 5, 6] });

  // —— Sheet 3：按资产统计 ——
  const statRows = [['资产', '类别', '币种', '市值（基准币种）', '成本（基准币种）', '浮动盈亏', '已实现', '总盈亏', '收益率', '年化（单利）', '持有天数', '占比']];
  (st.detail || []).forEach(r => {
    const pos = r.pos;
    const annual = (pos.cost > 0 && pos.float != null && pos.days > 0)
      ? ((pos.float / pos.cost) * 365 / pos.days * 100) : null;
    statRows.push([
      r.asset.name, (r.asset.subCategory || categoryLabel(r.asset.category)), r.asset.currency,
      r.baseValue != null ? r.baseValue : '', r.baseCost != null ? r.baseCost : '',
      r.baseFloat, r.baseRealized, r.baseFloat + r.baseRealized,
      r.floatRate != null ? (Math.round(r.floatRate * 10000) / 100) : '',
      annual != null ? (Math.round(annual * 100) / 100) : '',
      pos.days,
      r.sharePct != null ? (Math.round(r.sharePct * 10000) / 100) : '',
    ]);
  });
  sheets.push({ name: '按资产统计', rows: statRows, digits: [3, 4, 5, 6, 7, 8, 10] });

  // 2) 生成 sharedStrings（全部单元格文本去重）
  const strMap = new Map();
  const strOrder = [];
  const siIndex = cell => {
    const key = String(cell);
    if (!strMap.has(key)) { strMap.set(key, strOrder.length); strOrder.push(key); }
    return strMap.get(key);
  };
  sheets.forEach(sh => sh.rows.forEach(row => row.forEach(c => siIndex(c))));

  let ssXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' +
    (sheets.reduce((n, sh) => n + sh.rows.length * sh.rows[0].length, 0)) + '" uniqueCount="' + strOrder.length + '">';
  strOrder.forEach(s => { ssXml += '<si><t>' + xmlEsc(s) + '</t></si>'; });
  ssXml += '</sst>';

  // 3) 生成各工作表 XML
  const sheetXml = (sh) => {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>';
    sh.rows.forEach((row, ri) => {
      xml += '<row r="' + (ri + 1) + '">';
      row.forEach((cell, ci) => {
        const ref = colName(ci) + (ri + 1);
        xml += '<c r="' + ref + '" t="s"><v>' + siIndex(cell) + '</v></c>';
      });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  };
  const sheetFiles = sheets.map(sh => ({ name: sh.name, data: sheetXml(sh) }));

  // 4) ZI关于（OOXML 需要 [Content_Types], _rels, worksheet rels, workbook + sst）
  const parts = [];
  const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>';
  parts.push({ name: '[Content_Types].xml', data: CT });
  parts.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>' });
  parts.push({ name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
    '</Relationships>' });
  parts.push({ name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets>' +
    sheetFiles.map((f, i) => '<sheet name="' + f.name + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
    '</sheets></workbook>' });
  parts.push({ name: 'xl/sharedStrings.xml', data: ssXml });
  sheetFiles.forEach((f, i) => parts.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: f.data }));

  return zipBuild(parts);
}

/** ZIP（无压缩 STORE）写入为 Uint8Array */
function zipBuild(parts) {
  const enc = new TextEncoder();
  const chunks = [];
  const entries = [];
  let size = 0; // 累计的本地文件区总长度
  parts.forEach(p => {
    const bytes = enc.encode(p.data);
    const crc = crc32(bytes);
    chunks.push(localFileHeader(p.name, bytes.length, crc));
    chunks.push(bytes);
    // 该条目的本地头偏移 = 此前已累计的长度
    entries.push({ name: p.name, size: bytes.length, crc, offset: size });
    size += 30 + enc.encode(p.name).length + bytes.length;
  });
  // 中央目录：每个条目先记自己的偏移，再拼进中央目录
  const cdChunks = [];
  entries.forEach(e => {
    const cd = centralDirEntry(e.name, e.size, e.crc, e.offset);
    cdChunks.push(cd);
  });
  const centralSize = cdChunks.reduce((s, c) => s + c.length, 0);
  const centralOffset = size;
  cdChunks.forEach(c => chunks.push(c));
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true); dv.setUint16(6, 0, true);
  dv.setUint16(8, entries.length, true); dv.setUint16(10, entries.length, true);
  dv.setUint32(12, centralSize, true); dv.setUint32(16, centralOffset, true);
  chunks.push(eocd);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  chunks.forEach(c => { out.set(c, off); off += c.length; });
  return out;
}
function localFileHeader(name, size, crc) {
  const nb = new TextEncoder().encode(name);
  const h = new Uint8Array(30 + nb.length);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x04034b50, true);   // local file header signature
  dv.setUint16(4, 20, true);           // version needed
  dv.setUint16(6, 0x0800, true);       // flags: UTF-8
  dv.setUint16(8, 0, true);            // method: store
  dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
  dv.setUint32(14, crc, true);
  dv.setUint32(18, size, true); dv.setUint32(22, size, true);
  dv.setUint16(26, nb.length, true); dv.setUint16(28, 0, true);
  h.set(nb, 30);
  return h;
}
function centralDirEntry(name, size, crc, offset) {
  const nb = new TextEncoder().encode(name);
  const e = new Uint8Array(46 + nb.length);
  const dv = new DataView(e.buffer);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
  dv.setUint16(8, 0x0800, true);
  dv.setUint16(10, 0, true); dv.setUint16(12, 0, true); dv.setUint16(14, 0, true);
  dv.setUint32(16, crc, true);
  dv.setUint32(20, size, true); dv.setUint32(24, size, true);
  dv.setUint16(28, nb.length, true); dv.setUint16(30, 0, true);
  dv.setUint16(32, 0, true); dv.setUint16(34, 0, true); dv.setUint16(36, 0, true);
  dv.setUint32(38, 0, true);
  dv.setUint32(42, offset, true);
  e.set(nb, 46);
  return e;
}
/** CRC32（ZIP 用，无第三方依赖） */
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function colName(i) {
  let s = '';
  i++;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function numberOfRows(rows) { return rows.length; }
/** 触发浏览器下载 .xlsx 文件 */
function downloadXlsx() {
  const bytes = buildXlsxExcel();
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ecocal-export-' + todayStr() + '.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function categoryLabel(cat) {
  return ({ stock: '股票', fund: '基金', bond: '债券', deposit: '存款', wealth: '理财', insurance: '保险',
    fx: '外币', commodity: '商品', crypto: '数字货币', other: '其他' })[cat] || cat;
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
  // 汇率兼容：旧备份 / 精简云备份可能不带 rates；缺省时**保留本地已有汇率**
  // （避免恢复后马上联网重取造成的汇率闪变与市场价跳变）
  if (data.settings && data.settings.rates) state.settings.rates = data.settings.rates;
  else state.settings.rates = state.settings.rates || {};
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

/* ---------------- 撤销（Undo）支持 ---------------- */
/**
 * 删除/清空属于破坏性操作：在确认执行后保留一份快照，页面底部显示「撤销」提示条，
 * 点击可在本会话内恢复被删除的数据（刷新页面后不可恢复，避免误导）。
 * 只存最近 1 次删除快照（内存，不落盘）。
 */
let undoSnapshot = null;   // { label, assets, trades, valuations, settings }
let undoToastEl = null;

function undoWrap(label, fn) {
  confirmAction('确认' + label, label + '，此操作可撤销（本次会话内）。确定继续吗？', () => {
    // 先快照再执行（执行内部会 saveState/renderAll）
    undoSnapshot = {
      label,
      assets: JSON.parse(JSON.stringify(state.assets)),
      trades: JSON.parse(JSON.stringify(state.trades)),
      valuations: JSON.parse(JSON.stringify(state.valuations)),
      settings: JSON.parse(JSON.stringify(state.settings)),
    };
    fn();
    showUndoToast(label);
  }, label);
}

function showUndoToast(label) {
  const old = undoToastEl;
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const bar = document.createElement('div');
  bar.className = 'undo-toast';
  bar.innerHTML = '<span>' + label + '（本次会话可撤销）</span>' +
    '<button type="button" class="btn btn-mini" id="undo-btn">撤销</button>';
  if (document.body && document.body.appendChild) document.body.appendChild(bar);
  undoToastEl = bar;
  // 撤销按钮：优先用文档级查询（测试桩 createElement 无 querySelector），失败再回退查询
  let btn = null;
  try { btn = (bar.querySelector ? bar.querySelector('#undo-btn') : null) || document.getElementById('undo-btn'); }
  catch (e) { btn = document.getElementById('undo-btn'); }
  if (btn) {
    btn.onclick = () => {
      undoApply();
      if (bar.parentNode) bar.parentNode.removeChild(bar);
      undoToastEl = null;
    };
  }
  // 10 秒后自动消失
  setTimeout(() => {
    if (undoToastEl === bar && bar.parentNode) {
      bar.parentNode.removeChild(bar);
      undoToastEl = null;
    }
  }, 10000);
}

/** 应用撤销：恢复最近一次删除/清空的快照；返回被应用的快照（无则 null） */
function undoApply() {
  if (!undoSnapshot) return null;
  const applied = undoSnapshot;
  state.assets = undoSnapshot.assets;
  state.trades = undoSnapshot.trades;
  state.valuations = undoSnapshot.valuations;
  state.settings = undoSnapshot.settings;
  undoSnapshot = null;
  saveState(); renderAll();
  return applied;
}

function clearAll() {
  undoWrap('清空全部数据', () => {
    state.assets = [];
    state.trades = [];
    state.valuations = [];
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveState(); renderAll();
  });
}

/* ---------------- 启动 PIN 锁（安全） ---------------- */
/**
 * PIN 锁设计：
 * - PIN 绝不进 state / 备份文件 / 导出；本地只存「哈希」与重置冷却，专用键：
 *     ecocal.pin.hash —— 摘要（防直接查看 localStorage 得知明文）
 *     ecocal.pin.cooldown —— 忘记 PIN 逃生门的冷却截止（未设置则为 0）
 *   「设置 → 安全」开启后立即用当前输入设置 PIN，此后启动 / 切回前台需解锁。
 * - 解锁遮罩 #pin-lock 用固定定位铺满视口，z-index 高于所有内容（含模态框），
 *   解锁前即使页面已被渲染也不可见（遮罩不透）
 * - 忘记 PIN 逃生门：进入「安全 → 忘记 PIN」输入一个「重置口令」（安装/设置 PIN 时
 *   由用户填写的自定义英文口令），正确后清除 PIN 并重新进入设置；防止误锁无法进入。
 */
const PIN_HASH_KEY = 'ecocal.pin.hash';
const PIN_COOLDOWN_KEY = 'ecocal.pin.cooldown';
/* 非加密摘要（浏览器无 WebCrypto 的 file:// 环境可用）：SHA-256 仅示意，本地仅作混淆 */
function pinHash(pin) {
  let h = 5381;
  const salt = 'EcoCal::' + pin;
  for (let i = 0; i < salt.length; i++) { h = ((h << 5) + h + salt.charCodeAt(i)) | 0; }
  return 'h' + (h >>> 0).toString(36);
}
function pinEnabled() { return !!state.settings.pinEnabled && !!localStorage.getItem(PIN_HASH_KEY); }
function setPin(pin, resetCode) {
  localStorage.setItem(PIN_HASH_KEY, pinHash(pin));
  localStorage.setItem(PIN_COOLDOWN_KEY, String(Date.now() + 30 * 60 * 1000)); // 重置冷却 30 分钟
  state.settings.pinEnabled = true;
  state.settings.pinResetCode = resetCode; // 仅本地解密用，不进备份/导出
  saveState();
}
function clearPin() {
  localStorage.removeItem(PIN_HASH_KEY);
  localStorage.removeItem(PIN_COOLDOWN_KEY);
  state.settings.pinEnabled = false;
  delete state.settings.pinResetCode;
  saveState();
}
function checkPin(pin) { return !!pin && pinHash(pin) === localStorage.getItem(PIN_HASH_KEY); }
function pinLocked() { return pinEnabled() && !sessionStorage.getItem('ecocal.pin.unlocked'); }
function pinLock() { sessionStorage.removeItem('ecocal.pin.unlocked'); const ov = $id('pin-lock'); if (ov) ov.classList.remove('hidden'); }
function pinUnlock() {
  sessionStorage.setItem('ecocal.pin.unlocked', '1');
  const ov = $id('pin-lock'); if (ov) ov.classList.add('hidden');
}

/** 设置「安全」段（PIN 锁）——插入「数据管理」段之前 */
function securityHTML() {
  const on = pinEnabled();
  return '<div style="margin-top:24px;padding-top:14px;border-top:1px solid var(--line)">' +
    '<div class="field" style="margin-bottom:8px"><label>安全（启动 PIN 锁）</label></div>' +
    (on
      ? '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center">' +
          '<input type="checkbox" id="s-pin-toggle" checked> 已开启启动 PIN 锁（启动与切回前台需输入 PIN）</label>' +
        '<div class="hint" style="margin-top:6px">修改 PIN：取消勾选后输入新 PIN 保存即可重置。</div>'
      : '<label style="font-size:12px;color:var(--ink-2);display:inline-flex;gap:6px;align-items:center">' +
          '<input type="checkbox" id="s-pin-toggle"> 启用启动 PIN 锁（启动与切回前台需输入 PIN）</label>') +
    '<div id="s-pin-setup" style="margin-top:8px">' +
      '<div class="field"><label>PIN（4~6 位数字）</label>' +
      '<input id="s-pin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" placeholder="如 123456"></div>' +
      '<div class="field"><label>重置口令（忘记 PIN 时用于解除锁定，请记牢）</label>' +
      '<input id="s-pin-reset" type="text" autocomplete="off" placeholder="如 my-reset-word"></div>' +
      '<div class="hint">PIN 只保存在本机浏览器；不会进入备份文件 / 导出内容。忘记 PIN 时在启动遮罩点「忘记 PIN」输入重置口令即可解锁。</div>' +
    '</div>' +
  '</div>';
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

  // ---- 启动 PIN 锁：遮罩交互 ----
  const pinUnlockBtn = $id('pin-unlock-btn');
  if (pinUnlockBtn) {
    pinUnlockBtn.onclick = () => {
      const pin = ($id('pin-input').value || '').replace(/\s/g, '');
      const errEl = $id('pin-err');
      if (checkPin(pin)) { errEl.textContent = ''; pinUnlock(); }
      else { errEl.textContent = 'PIN 不正确，请重试。'; }
      $id('pin-input').value = '';
    };
    $id('pin-input').onkeydown = (e) => { if (e.key === 'Enter') pinUnlockBtn.onclick(); };
    $id('pin-forgot-btn').onclick = () => {
      const resetCode = (state.settings.pinResetCode || '').trim();
      if (!resetCode) { $id('pin-err').textContent = '本设备未设置重置口令，无法通过忘记 PIN 解锁。'; return; }
      const answer = prompt('请输入设置 PIN 时填写的「重置口令」，正确后清除 PIN 锁：');
      if (answer !== null && String(answer).trim() === resetCode) {
        clearPin();
        $id('pin-err').textContent = '';
        $id('pin-input').value = '';
        pinUnlock();
        alert('PIN 锁已清除，请到「设置 → 安全」重新设置。');
      } else if (answer !== null) {
        $id('pin-err').textContent = '重置口令不正确。';
      }
    };
    // 切回前台（浏览器切后台再回来 / 锁屏）自动重新上锁
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        sessionStorage.removeItem('ecocal.pin.unlocked');
      } else if (pinEnabled() && !sessionStorage.getItem('ecocal.pin.unlocked')) {
        $id('pin-input').value = '';
        $id('pin-err').textContent = '';
        const ov = $id('pin-lock'); if (ov) ov.classList.remove('hidden');
      }
    });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', () => sessionStorage.removeItem('ecocal.pin.unlocked'));
    }
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
        undoWrap('删除交易记录', () => {
          state.trades = state.trades.filter(x => x.id !== t.id);
          saveState(); renderAll();
        });
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
        undoWrap('删除产品', () => {
          state.assets = state.assets.filter(a => a.id !== asset.id);
          state.trades = state.trades.filter(t => t.assetId !== asset.id);
          expanded.delete(asset.id);
          saveState(); renderAll();
        });
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
  + '<li><b>维护当前市值</b>：股票点「✎ 现价」填当前股价（或「⟳ 刷新行情」联网获取）；基金/存款/外币等点「✎ 市值」直接填<b>当前持仓总金额</b>，系统自动折算单位价值。手动录入的数值会原样保存（不做四舍五入），显示保留更多小数，避免资产价值被悄无声息地改掉。</li>'
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
  // 云备份：页面切后台/关闭时立即同步未上传的改动（防抖窗口内不等满 60s）
  bindBackupFlush();
  // 备份提醒：每天最多一次（未配置自动备份或自动备份连续失败，超过 N 天未成功备份时提醒）
  initBackupReminders();
  // 启动 PIN 锁：已启用时显示遮罩（login 前不可见数据）
  if (pinEnabled()) pinLock();
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
  openSettings, openAssetForm, openTradeForm, openHelp, settingsHTML,
  submitTrade, submitAsset,
  renderAll, renderList,
  switchTab, setTrendMode,
  openExportModal, openImportModal, importPayloadText, applyPayload, buildExportPayload, buildCloudPayload,
  migrateToTrades, migrateToV6, fxRateFromCache, daysAgoStr,
  normalizeSymbol, symbolToCurrency, fetchQuote, fetchKline, fetchStockInfo,
  refreshQuoteForAsset, refreshAllQuotes, manualPriceline,
  webdavBackup, manualWebdavBackup, manualWebdavRestore,
  giteeBackup, manualGiteeBackup, manualGiteeRestore,
  saveGate, saveGateReal, gateFlush, runBackupOnce, clearBackupTimers,
  // 备份提醒（供测试/调试）
  initBackupReminders, needsBackupReminder, lastBackupTime, anyAutoBackupEnabled,
  // PIN 锁（供测试/调试）
  pinHash, pinEnabled, setPin, clearPin, checkPin, pinLock, pinUnlock, pinLocked, securityHTML,
  // 撤销（供测试/调试）
  undoWrap, undoApply, undoSnapshot,
  // 导出 Excel（供测试/调试）
  buildXlsxExcel, downloadXlsx,
};

})();
