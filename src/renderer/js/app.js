/**
 * app.js —— HAUT Guard 渲染层界面逻辑。
 *
 * 职责:
 *  - 通过 window.haut (或预览环境下的 mock.js) 读写状态;
 *  - 把快照渲染成界面 (状态环 / 指标卡 / 表单 / 开关 / 按钮);
 *  - 处理交互 (登录、注销、账号增删切换、面板、Toast、指针高光);
 *  - 不做任何网络/协议/文件操作, 全部交给主进程。
 */

import { createChart } from "./chart.js";

/* =========================================================================
   0. 桥接层
   ========================================================================= */

let bridge = window.haut || null;
let isPreview = false;

if (!bridge) {
  try {
    const mod = await import("./mock.js");
    bridge = mod.createMockBridge();
    isPreview = true;
  } catch (err) {
    // 预览桩都加载失败: 打印一次错误并给出安全兜底, 避免整页白屏
    console.error("[HAUT Guard] 无法初始化 IPC 桥接:", err);
    bridge = null;
    isPreview = false;
  }
}

if (!bridge) {
  // 兜底空桥: 让界面仍可渲染, 只是所有操作提示不可用
  const off = () => () => {};
  bridge = {
    getSnapshot: async () => ({
      conn: { state: "error", online: false, userName: "", ip: "", sumBytes: 0, sumSeconds: 0, addTime: 0, gatewayVer: "", message: "渲染层未能连接主进程", lastChecked: 0, reconnecting: false, nextRetryIn: 0 },
      rate: { down: 0, up: 0, total: 0 },
      config: { gateway: "-", portalPort: 0, statusPort: 0, autoLogin: false, autoLaunch: false, remember: false, autoReconnect: false, startMinimized: false, pollInterval: 5, theme: "dark", material: "acrylic", accent: "cyan", chromeStyle: "mac", passwordAlgo: "srun3", infoFormat: "srun3" },
      accounts: [], activeAccountId: null,
      app: { version: "-", electron: "-", node: "-", chrome: "-", platform: "-" },
      material: { current: "acrylic", supported: ["acrylic", "mica", "transparent"] },
      logs: { path: "" },
    }),
    auth: { login: async () => ({ ok: false, message: "桥接不可用" }), logout: async () => ({ ok: false, message: "桥接不可用" }), refresh: async () => ({ ok: false, message: "桥接不可用" }) },
    accounts: { list: async () => [], save: async () => ({ ok: false, message: "桥接不可用" }), remove: async () => ({ ok: false, message: "桥接不可用" }), select: async () => ({ ok: false, message: "桥接不可用" }), reveal: async () => ({ error: "桥接不可用" }) },
    config: { update: async (p) => p, reset: async () => ({ ok: false }) },
    diag: { run: async () => ({ ok: false, items: [] }) },
    logs: { read: async () => ({ path: "", lines: [] }), clear: async () => ({ ok: false }), openFolder: async () => ({ ok: false }) },
    app: { info: async () => ({}), setMaterial: async () => ({ ok: false }), quit: async () => ({}) },
    win: { minimize: async () => ({}), close: async () => ({}), hide: async () => ({}), beginDrag: () => {} },
    on: off,
  };
}

/* =========================================================================
   1. 通用工具
   ========================================================================= */

const $ = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/**
 * 空值安全的文本写入。
 * 渲染层每秒都会刷状态, 任何一处 id 没在 HTML 里落地都会变成
 * "每帧一次 Uncaught TypeError" 的崩溃链, 因此所有写入统一走这里。
 * @returns {boolean} 是否写入成功
 */
function setText(node, text) {
  if (!node) return false;
  const next = text === null || text === undefined ? "" : String(text);
  if (node.textContent !== next) node.textContent = next;
  return true;
}

/** 切换 hidden 属性 (带空值保护) */
function setHidden(node, hidden) {
  if (!node) return false;
  if (node.hidden !== !!hidden) node.hidden = !!hidden;
  return true;
}

/** 切换 class (带空值保护) */
function setOn(node, cls, on) {
  if (!node || !node.classList) return false;
  node.classList.toggle(cls, !!on);
  return true;
}

const UNITS = [
  { base: 1024 ** 4, suffix: "TB" },
  { base: 1024 ** 3, suffix: "GB" },
  { base: 1024 ** 2, suffix: "MB" },
  { base: 1024, suffix: "KB" },
  { base: 1, suffix: "B" },
];

/** 字节 -> 人类可读 (两位小数, 自动降级到整数) */
function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 B";
  for (const u of UNITS) {
    if (n >= u.base) {
      const v = n / u.base;
      return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${u.suffix}`;
    }
  }
  return "0 B";
}

/** 速率 (字节/秒) -> "820.42 KB/s" */
function humanRate(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  if (n <= 0) return "0 KB/s";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB/s`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB/s`;
  return `${(n / 1024).toFixed(2)} KB/s`;
}

/** 秒 -> "x 天 x 小时 x 分" / "x 小时 x 分" / "x 分 x 秒" */
function humanDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (d > 0) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${ss} 秒`;
  return `${ss} 秒`;
}

/** 毫秒时间戳 -> "14:32:07" */
function clockOf(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 相对时间 -> "12 秒前" / "3 分钟前" */
function agoOf(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 1500) return "刚刚";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 按字节安全创建 SVG 图标 */
function icon(markup, cls) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<svg viewBox="0 0 20 20"${cls ? ` class="${cls}"` : ""}>${markup}</svg>`;
  return wrap.firstElementChild;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 数字滚动/淡入: 首次直接赋值, 之后按 rAF 平滑过渡 */
function makeCounter(node) {
  let shown = 0;
  let raf = 0;
  let started = false;
  const fmt = (v) => node.dataset.fmt === "rate" ? humanRate(v)
    : node.dataset.fmt === "time" ? humanDuration(v)
      : humanBytes(v);

  function paint(v) {
    node.textContent = fmt(v);
  }

  return function set(targetValue) {
    const tv = Math.max(0, Number(targetValue) || 0);
    if (!started) {
      started = true;
      shown = tv;
      paint(shown);
      node.classList.add("is-bump");
      setTimeout(() => node.classList.remove("is-bump"), 460);
      return;
    }
    if (reduceMotion.matches) {
      shown = tv;
      paint(shown);
      return;
    }
    if (Math.abs(tv - shown) < 1) { shown = tv; paint(shown); return; }
    if (raf) cancelAnimationFrame(raf);
    const from = shown;
    const t0 = performance.now();
    const dur = 520;
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      // easeOutCubic
      const e = 1 - Math.pow(1 - k, 3);
      shown = from + (tv - from) * e;
      paint(shown);
      raf = k < 1 ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  };
}

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * 读取 location.hash 里的预览参数: #scenario=online&theme=light
 * (mock.js 是 CommonJS/UMD 单一数据源, 无法提供 ESM 具名导出, 故此处自备一份)
 */
function readHash() {
  const out = { scenario: "", theme: "" };
  try {
    let raw = String(location.hash || "");
    if (raw.charAt(0) === "#") raw = raw.slice(1);
    if (!raw) return out;
    raw.split("&").forEach((pair) => {
      if (!pair) return;
      const i = pair.indexOf("=");
      const key = i < 0 ? pair : pair.slice(0, i);
      const val = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1));
      if (key === "scenario") out.scenario = val;
      else if (key === "theme") out.theme = val;
    });
  } catch { /* hash 不可用时按默认处理 */ }
  return out;
}

/* =========================================================================
   2. DOM 引用 & 局部状态
   ========================================================================= */

const dom = {
  html: document.documentElement,
  hero: $("hero"),
  stateLabel: $("stateLabel"),
  stateUser: $("stateUser"),
  heroChipText: $("heroChipText"),
  heroHint: $("heroHint"),
  notice: $("notice"),
  noticeMsg: $("noticeMsg"),
  metricFlow: $("metricFlow"),
  metricTime: $("metricTime"),
  subTotal: $("subTotal"),
  subTotalBytes: $("subTotalBytes"),
  subDuration: $("subDuration"),
  subTotalSeconds: $("subTotalSeconds"),
  subBalance: $("subBalance"),
  subBalanceValue: $("subBalanceValue"),
  subBalanceSep: $("subBalanceSep"),
  legendDown: $("legendDown"),
  legendUp: $("legendUp"),
  chart: $("chart"),
  chartEmpty: $("chartEmpty"),
  acctButton: $("acctButton"),
  acctAvatar: $("acctAvatar"),
  acctName: $("acctName"),
  acctSub: $("acctSub"),
  acctMenu: $("acctMenu"),
  acctList: $("acctList"),
  acctAdd: $("acctAdd"),
  acctRemove: $("acctRemove"),
  acctMenuAdd: $("acctMenuAdd"),
  inputUser: $("inputUser"),
  inputPass: $("inputPass"),
  clearUser: $("clearUser"),
  eyePass: $("eyePass"),
  fieldUser: $("fieldUser"),
  fieldPass: $("fieldPass"),
  fieldHint: $("fieldHint"),
  swRemember: $("swRemember"),
  swAuto: $("swAuto"),
  swReconnect: $("swReconnect"),
  swAutoLaunch: $("swAutoLaunch"),
  mainBtn: $("mainBtn"),
  mainLabel: $("mainLabel"),
  scrim: $("scrim"),
  sheet: $("sheet"),
  sheetTitle: $("sheetTitle"),
  sheetBody: $("sheetBody"),
  sheetFoot: $("sheetFoot"),
  sheetClose: $("sheetClose"),
  toasts: $("toasts"),
  mockBadge: $("mockBadge"),
  scroll: $("scroll"),
  themeToggle: $("themeToggle"),
  rememberConfirm: $("rememberConfirm"),
  rememberConfirmOk: $("rememberConfirmOk"),
  rememberCancel: $("rememberCancel"),
  foot: $("foot"),
};

/** 最近一次快照的可读视图 */
const view = {
  conn: { state: "offline", online: false, userName: "", ip: "", message: "", lastChecked: 0, reconnecting: false, nextRetryIn: 0, sessionBytes: 0, sessionSeconds: 0, bytesIn: 0, bytesOut: 0, sumBytes: 0, sumSeconds: 0, balance: null, gatewayVer: "" },
  rate: { down: 0, up: 0, total: 0 },
  config: {},
  accounts: [],
  activeAccountId: null,
  app: {},
  material: { current: "acrylic", supported: [] },
  logs: { path: "" },
};

/** 界面瞬时状态 */
const ui = {
  busy: false,
  menuOpen: false,
  sheet: "",
  passVisible: false,
  revealed: false,
  inlineError: "",
  userDirty: false,
  /** 用户手动改过密码框 -> 不再用本地保存的密码覆盖它 */
  passDirty: false,
  previewTheme: "",
  /** 设置面板里的「记住密码」开关按钮 (面板不随快照重渲染, 需要单独同步) */
  sheetRememberBtn: null,
};

/**
 * 启动自检: 找出 app.js 引用但 HTML 里缺失的 id。
 * 这类问题在真实运行中会退化成「每秒一次 Uncaught TypeError」, 必须在
 * 预览阶段就暴露出来 (preview.js 会把这条 error 当成致命错误)。
 */
function auditDomIds() {
  const missing = Object.keys(dom).filter((k) => k !== "html" && !dom[k]);
  if (missing.length) {
    console.error(`[HAUT Guard] index.html 缺少以下 id, 界面相关功能会失效: ${missing.join(", ")}`);
  }
  return missing;
}

/** 供预览 harness 做 id 集合差集自查 (见 tools/preview.js) */
try {
  if (typeof window !== "undefined") {
    window.__domKeys = Object.keys(dom);
    window.__view = view;      // 只读快照视图, 便于 harness 自检
  }
} catch { /* 忽略 */ }

const chart = createChart(dom.chart, { max: 60, height: 42 });
const setFlow = makeCounter(dom.metricFlow);
const setTime = makeCounter(dom.metricTime);

/** 最近一次 toast 内容, 用于抑制「自身操作 + 主进程推送」造成的重复提示 */
let lastToast = { key: "", at: 0, node: null };

/* =========================================================================
   3. Toast
   ========================================================================= */

const TOAST_KINDS = ["success", "error", "info", "warning"];

function pushToast(kind, message, opts = {}) {
  const type = TOAST_KINDS.includes(kind) ? kind : "info";
  const text = String(message || "").trim();
  if (!text) return;

  const key = `${type}:${text}`;
  const now = Date.now();
  if (!opts.force && lastToast.key === key && now - lastToast.at < 1600) return;
  lastToast = { key, at: now, node: null };

  const node = el("div", `toast toast--${type}`);
  node.appendChild(el("span", "toast__dot"));
  node.appendChild(el("span", "toast__msg", text));
  dom.toasts.appendChild(node);

  while (dom.toasts.children.length > 3) dom.toasts.removeChild(dom.toasts.firstElementChild);

  const close = () => {
    if (!node.isConnected) return;
    node.classList.add("is-out");
    setTimeout(() => node.remove(), reduceMotion.matches ? 20 : 240);
  };
  node.addEventListener("click", close);
  const life = type === "error" ? 5200 : 3200;
  setTimeout(close, life);
}

/* =========================================================================
   4. 主题 / 材质
   ========================================================================= */

function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(pref) {
  const next = resolveTheme(ui.previewTheme || pref);
  if (dom.html.dataset.theme !== next) {
    dom.html.dataset.theme = next;
    // 等 CSS 变量生效后再重绘曲线
    requestAnimationFrame(() => chart.redraw());
  }
  try { localStorage.setItem("haut.theme", pref || "system"); } catch { /* 忽略隐私模式报错 */ }
}

/* -------------------------------------------------------------------------
   主题色 (data-accent) / 窗口按钮风格 (data-chrome)
   两者都只切 <html> 上的 data 属性, 具体配色与布局全在 CSS 里分组定义。
   ------------------------------------------------------------------------- */

/** 主题色白名单 (与 src/main/store.js 的 accent 白名单一致) */
const ACCENTS = [
  { value: "cyan", label: "青蓝" },
  { value: "blue", label: "蓝色" },
  { value: "violet", label: "紫罗兰" },
  { value: "green", label: "绿色" },
  { value: "amber", label: "琥珀金" },
  { value: "pink", label: "粉色" },
  { value: "red", label: "红色" },
];

function accentOf(cfg) {
  const v = String((cfg || view.config || {}).accent || "cyan");
  return ACCENTS.some((a) => a.value === v) ? v : "cyan";
}

function accentLabel(v) {
  const hit = ACCENTS.find((a) => a.value === v);
  return hit ? hit.label : "青蓝";
}

function applyAccent(name) {
  const next = ACCENTS.some((a) => a.value === name) ? name : "cyan";
  if (dom.html.dataset.accent !== next) dom.html.dataset.accent = next;
}

/** 窗口按钮风格: mac = 左上角红黄绿 (默认, 升级后观感不变); windows = 右上角 ─ / ✕ */
function chromeOf(cfg) {
  const v = String((cfg || view.config || {}).chromeStyle || "mac");
  return v === "windows" ? "windows" : "mac";
}

function applyChrome(name) {
  const next = name === "windows" ? "windows" : "mac";
  if (dom.html.dataset.chrome !== next) dom.html.dataset.chrome = next;
}

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if ((view.config.theme || "system") === "system") applyTheme("system");
});

/* =========================================================================
   5. 指针跟随高光
   ========================================================================= */

function bindPointerGlow(root = document) {
  root.querySelectorAll("[data-tilt]").forEach((card) => {
    if (card.dataset.glowBound === "1") return;
    card.dataset.glowBound = "1";
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
      card.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
    });
    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--mx", "50%");
      card.style.setProperty("--my", "0%");
    });
  });
}

/* =========================================================================
   6. 渲染: 状态环 / 指标 / 曲线
   ========================================================================= */

const STATE_LABEL = { offline: "未连接", connecting: "连接中", online: "已连接", error: "连接异常" };

function renderHero() {
  const c = view.conn || {};
  const state = c.reconnecting && !c.online ? "connecting" : (c.state || "offline");
  if (dom.hero && dom.hero.dataset) dom.hero.dataset.state = state;
  setText(dom.stateLabel, STATE_LABEL[state] || "未连接");

  // 环中心: 在线时显示账号, 离线时显示最近一次查询时间
  if (state === "online") {
    setText(dom.stateUser, c.userName || "已认证");
  } else if (c.lastChecked) {
    setText(dom.stateUser, `查询于 ${clockOf(c.lastChecked)}`);
  } else {
    setText(dom.stateUser, "");
  }

  // 状态胶囊
  if (c.reconnecting && !c.online) {
    const n = Math.max(0, Number(c.nextRetryIn) || 0);
    setText(dom.heroChipText, n > 0 ? `将在 ${n} 秒后重试` : "正在重试…");
  } else if (state === "online") {
    setText(dom.heroChipText, c.ip ? `在线 · ${c.ip}` : "在线");
  } else if (state === "connecting") {
    setText(dom.heroChipText, "正在提交认证");
  } else if (state === "error") {
    setText(dom.heroChipText, "认证未通过");
  } else {
    setText(dom.heroChipText, c.lastChecked ? "等待连接" : "尚未连接");
  }

  // 状态胶囊下方小字: 网关版本 / 未连接引导
  const bits = [];
  if (c.gatewayVer) bits.push(c.gatewayVer);
  if (state === "offline" && !c.reconnecting) bits.push("点击下方按钮开始认证");
  setText(dom.heroHint, bits.join(" · "));
  setOn(dom.heroHint, "is-hidden", bits.length === 0);

  // 顶部内联错误: 仅在有明确错误信息且处于错误态时展示
  if (ui.inlineError && state === "error") {
    setText(dom.noticeMsg, ui.inlineError);
    setHidden(dom.notice, false);
  } else if (state !== "error") {
    setHidden(dom.notice, true);
  }
}

/** 本次会话 + 账号累计 + 余额 */
function renderMetrics() {
  const c = view.conn || {};
  const online = !!c.online;

  // 「本次流量」「在线时长」= 本次会话 (sessionBytes / sessionSeconds)。
  // 但它们**不能**只靠状态快照更新: 网关的状态接口几分钟才刷新一次计数(实测下载 21MB
  // 那两个字段都纹丝不动), 而状态轮询本身也是 5 秒一次 —— 所以这两个数字交给每秒的
  // tickLiveMetrics() 推进, 快照只负责在离线时归零。
  if (!online) {
    setFlow(0);
    setTime(0);
  } else {
    tickLiveMetrics();
  }

  // 累计流量 / 累计时长: 账号级累计值, 离线也保留展示
  const sumBytes = Number(c.sumBytes) || 0;
  const sumSec = Number(c.sumSeconds) || 0;
  setText(dom.subTotalBytes, sumBytes > 0 ? humanBytes(sumBytes) : "--");
  setText(dom.subTotalSeconds, sumSec > 0 ? humanDuration(sumSec) : "--");

  // 余额: balance === null / undefined 表示网关未提供 -> 整项隐藏 (不显示 "null 元")
  const hasBalance = c.balance !== null && c.balance !== undefined && Number.isFinite(Number(c.balance));
  setHidden(dom.subBalance, !hasBalance);
  setHidden(dom.subBalanceSep, !hasBalance);
  if (hasBalance) {
    setText(dom.subBalanceValue, `${Number(c.balance).toFixed(2)} 元`);
    setOn(dom.subBalance, "is-accent", true);
  }

  renderLegend();
}

/* ---------------------------------------------------------------- 实时指标推进
   「本次流量」「在线时长」要做到"每秒都在动"。但这两个值的来源都不支持:
     - 在线时长: 网关的 keepalive_time 与状态快照一样是分钟级刷新的;
     - 本次流量: 网关的计数字段几乎不刷新(实测下载 21MB 都不动)。
   所以在这里本地推进:
     - 在线时长 = 当前时间 - 会话开始时间(addTime), 纯本地时钟, 每秒跳一格;
     - 本次流量 = max(主进程累加值, 本地按最近速率外推的值), 只增不减。
   主进程的 sessionBytes 已经是"网关基准 + 本机网卡增量", 这里再按速率把
   "距离上一拍的时间"补进去, 于是数字每秒平滑上涨, 又不会和主进程的统计打架。
   ---------------------------------------------------------------- */
const liveMetric = { bytes: 0, at: 0, addTime: 0 };
/** 与主进程 statusFromJson 保持一致的合理性上限(30 天)。 */
const MAX_PLAUSIBLE_SESSION_SECONDS = 30 * 86400;

function tickLiveMetrics() {
  const c = view.conn || {};
  const now = Date.now();
  if (!c.online) {
    liveMetric.bytes = 0;
    liveMetric.at = 0;
    liveMetric.addTime = 0;
    setFlow(0);
    setTime(0);
    return;
  }

  // 换了会话(重新登录 / 切账号): 以主进程给的值重新起步
  const addTime = Number(c.addTime) || 0;
  if (addTime && addTime !== liveMetric.addTime) {
    liveMetric.addTime = addTime;
    liveMetric.bytes = Number(c.sessionBytes) || 0;
    liveMetric.at = now;
  }

  // 主进程的累加值是下限(它每 3 秒随本机网卡采样更新一次)
  const base = Number(c.sessionBytes) || 0;
  if (base > liveMetric.bytes) {
    liveMetric.bytes = base;
    liveMetric.at = now;
  }

  // 按最近一次速率补齐"距离上一拍的时间", 让数字持续增长
  const elapsed = liveMetric.at ? (now - liveMetric.at) / 1000 : 0;
  const rate = Number((view.rate && view.rate.total) || 0);
  if (rate > 0 && elapsed > 0) liveMetric.bytes += rate * elapsed;
  liveMetric.at = now;
  setFlow(liveMetric.bytes);

  // 在线时长: 本地时钟, 每秒跳一次
  const localSec = addTime > 0 ? Math.floor(now / 1000 - addTime) : 0;
  if (localSec > 0 && localSec <= MAX_PLAUSIBLE_SESSION_SECONDS) setTime(localSec);
  else setTime(Number(c.sessionSeconds) || 0);
}

setInterval(tickLiveMetrics, 1000);

/** 下载/上传速率标签 (down / up 是各自独立的真实速率) */
function renderLegend() {
  const c = view.conn || {};
  const r = view.rate || {};
  const online = !!c.online;
  setText(dom.legendDown, `下载 ${humanRate(online ? r.down : 0)}`);
  setText(dom.legendUp, `上传 ${humanRate(online ? r.up : 0)}`);
}

function renderMainButton() {
  const c = view.conn || {};
  const state = c.state || "offline";
  const reconnecting = !!c.reconnecting && !c.online;

  let label = "连接校园网";
  let danger = false;
  let busy = false;

  if (ui.busy) {
    busy = true;
    label = state === "online" ? "断开中…" : "连接中…";
  } else if (state === "online") {
    label = "断开连接";
    danger = true;
  } else if (reconnecting) {
    label = "取消自动重连";
  } else if (state === "connecting") {
    busy = true;
    label = "连接中…";
  } else if (state === "error") {
    label = "重新连接";
  }

  setText(dom.mainLabel, label);
  setOn(dom.mainBtn, "is-busy", busy);
  setOn(dom.mainBtn, "is-danger", danger && !busy);
  if (dom.mainBtn) dom.mainBtn.disabled = busy;
}

/* =========================================================================
   7. 渲染: 账号区
   ========================================================================= */

function activeAccount() {
  const list = view.accounts || [];
  const id = view.activeAccountId;
  if (!id) return list[0] || null;
  return list.find((a) => a.id === id) || list[0] || null;
}

/**
 * 账号序号 (从 1 开始, 按当前列表顺序实时计算)。
 * 头像不再取用户名首字符: 学号 (如 2310121042) 的首字符恒为 2, 删掉第一个账号后
 * 新账号头像还是显示 "2", 看起来像没更新。序号才是用户真正想看到的信息。
 */
function ordinalOf(acc) {
  const list = view.accounts || [];
  const i = list.indexOf(acc);
  return i >= 0 ? i + 1 : 0;
}

/* --------------------------- 密码框回填 (点状) --------------------------- */

const PASS_PLACEHOLDER = "请输入密码";
const PASS_PLACEHOLDER_MISSING = "本地凭据不可用，请重新输入密码";

/** 密码框 placeholder: 正常 / 提示重新输入 */
function setPassPlaceholder(missing) {
  if (!dom.inputPass) return;
  const next = missing ? PASS_PLACEHOLDER_MISSING : PASS_PLACEHOLDER;
  if (dom.inputPass.placeholder !== next) dom.inputPass.placeholder = next;
}

/** 眼睛按钮复位为「未显示」: 切账号 / 登录成功后回到点状, 避免明文留在屏幕上 */
function resetPassVisibility() {
  if (!dom.inputPass || !dom.eyePass) return;
  dom.inputPass.type = "password";
  dom.eyePass.classList.remove("is-on");
  dom.eyePass.title = "显示密码";
  dom.eyePass.setAttribute("aria-label", "显示密码");
}

/** 同一个账号的 reveal 请求只发一次 (快照每次推送都会调 renderAccounts) */
let passFill = { id: "", promise: null };
/** 已经尝试过且失败的账号 id: 避免每 5 秒的快照推送反复重试 reveal */
let passFailedFor = "";

/**
 * 把「已保存的密码」以点状回填到密码框。
 *
 * 要点:
 *  - 一进界面密码框就应该是点状, 而不是空着像没填过 (保持 type="password");
 *  - 明文只写进 input.value, 不写 console / 日志 / DOM 属性 / dataset;
 *  - 主进程取不回明文 (例如换了 Windows 账户导致 DPAPI 解不开) 时静默处理:
 *    保持空值 + placeholder 提示重新输入, 绝不弹错误;
 *  - 用户手动输入过的内容永远不覆盖。
 */
async function refreshPasswordField() {
  if (!dom.inputPass) return;
  const acc = activeAccount();
  const remember = !!(view.config || {}).remember;
  const want = !!(acc && acc.hasPassword && remember);

  if (!want) {
    // 当前没有「可回填的已保存密码」: 清掉此前回填的明文, 但不动用户输入的内容
    passFailedFor = "";
    if (!ui.passDirty) {
      ui.revealed = false;
      setPassPlaceholder(false);
      if (dom.inputPass.value) dom.inputPass.value = "";
    }
    return;
  }

  if (ui.passDirty) return;                 // 用户已手动输入, 不覆盖
  if (dom.inputPass.value) {                // 本地已有明文, 保持点状即可
    ui.revealed = true;
    setPassPlaceholder(false);
    return;
  }
  if (passFailedFor === acc.id) { setPassPlaceholder(true); return; }
  if (passFill.id === acc.id && passFill.promise) return passFill.promise;

  const run = (async () => {
    try {
      const r = await bridge.accounts.reveal(acc.id);
      // 期间用户输入了内容 / 切换了账号 -> 丢弃这次结果
      if (ui.passDirty) return;
      const stillActive = (activeAccount() || {}).id === acc.id;
      if (!stillActive) return;
      if (r && r.password) {
        dom.inputPass.value = r.password;
        ui.revealed = true;
        passFailedFor = "";
        setPassPlaceholder(false);
      } else {
        ui.revealed = false;
        passFailedFor = acc.id;
        setPassPlaceholder(true);
      }
    } catch {
      // 解密失败等: 静默, 只在输入框 placeholder 上提示
      ui.revealed = false;
      passFailedFor = acc.id;
      setPassPlaceholder(true);
    }
  })();
  passFill = { id: acc.id, promise: run };
  try { await run; } finally { if (passFill.promise === run) passFill = { id: "", promise: null }; }
}

function renderAccounts() {
  const list = view.accounts || [];
  const acc = activeAccount();
  const empty = !acc;

  setText(dom.acctAvatar, empty ? "＋" : String(ordinalOf(acc)));
  setOn(dom.acctAvatar, "select__avatar--empty", empty);
  setText(dom.acctName, empty ? "未添加账号" : (acc.label || acc.username));
  setText(dom.acctSub, empty
    ? "点击右侧 + 添加"
    : (acc.hasPassword ? `已保存密码 · ${acc.username}` : `未保存密码 · ${acc.username}`));

  if (dom.acctButton) dom.acctButton.disabled = empty && list.length <= 1;
  if (dom.acctRemove) dom.acctRemove.disabled = empty;

  // 表单自动填充 (用户手动改过就不再覆盖)
  if (!ui.userDirty && dom.inputUser) {
    const next = empty ? "" : (acc.username || "");
    if (dom.inputUser.value !== next) dom.inputUser.value = next;
  }
  syncClearButton();

  // 密码框: 已保存密码 -> 立刻回填成点状; 没有 -> 保持空
  refreshPasswordField();

  if (ui.menuOpen) renderAccountMenu();
}

function renderAccountMenu() {
  if (!dom.acctList) return;
  const list = view.accounts || [];
  const activeId = view.activeAccountId;
  dom.acctList.textContent = "";

  if (list.length === 0) {
    const tip = el("div", "acctmenu__empty");
    tip.textContent = "还没有保存任何账号，点击下方「添加账号」开始使用";
    dom.acctList.appendChild(tip);
    return;
  }

  list.forEach((acc, index) => {
    const row = el("div", "acctrow" + (acc.id === activeId ? " is-active" : ""));
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", acc.id === activeId ? "true" : "false");

    // 头像 = 账号在当前列表中的序号 (删除/新增后立即重排)
    const av = el("span", "acctrow__avatar", String(index + 1));
    av.title = `第 ${index + 1} 个账号`;
    row.appendChild(av);

    const body = el("div", "acctrow__body");
    body.appendChild(el("span", "acctrow__name", acc.label || acc.username));
    const meta = `${acc.username}${acc.hasPassword ? " · 已存密码" : ""}${acc.lastUsed ? ` · ${agoOf(acc.lastUsed)}` : ""}`;
    body.appendChild(el("span", "acctrow__meta", meta));
    row.appendChild(body);

    if (acc.id === activeId) {
      row.appendChild(icon('<path d="M4 10.4l4 4 8-8.4"/>', "acctrow__check"));
    }

    const del = el("button", "acctrow__del");
    del.type = "button";
    del.title = "删除该账号";
    del.setAttribute("aria-label", `删除账号 ${acc.username}`);
    del.appendChild(icon('<path d="M3.6 5.4h10.8M7.2 5.4V3.9h3.6v1.5M5.2 5.4l.7 8.1h6.2l.7-8.1"/>'));
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAccount(acc.id, acc.label || acc.username);
    });
    row.appendChild(del);

    row.addEventListener("click", () => selectAccount(acc.id));
    dom.acctList.appendChild(row);
  });
}

function setMenuOpen(open) {
  ui.menuOpen = !!open;
  setHidden(dom.acctMenu, !ui.menuOpen);
  if (dom.acctButton) dom.acctButton.setAttribute("aria-expanded", ui.menuOpen ? "true" : "false");
  // 展开时给滚动区留出底部空间, 并把列表滚进视野, 避免被底部操作栏压住
  const stack = document.querySelector(".stack");
  if (stack) stack.classList.toggle("has-menu", ui.menuOpen);
  if (ui.menuOpen) {
    renderAccountMenu();
    // 展开后把列表滚动到视野内 (底部操作栏会遮住约 90px, 留 78px 余量即可,
    // 过多会把状态环推出屏幕)
    requestAnimationFrame(() => {
      const scroller = dom.scroll || document.querySelector(".scroll");
      const menu = dom.acctMenu;
      if (!scroller || !menu) return;
      const need = menu.getBoundingClientRect().bottom + 78 - scroller.getBoundingClientRect().bottom;
      if (need > 0) scroller.scrollTop += need;
    });
  }
}

function syncClearButton() {
  if (!dom.inputUser) return;
  const has = dom.inputUser.value.length > 0;
  setOn(dom.clearUser, "is-on", has);
  if (dom.clearUser) dom.clearUser.style.opacity = has ? "1" : "";
}

/* =========================================================================
   8. 渲染: 开关组
   ========================================================================= */

function setSwitch(node, on, disabled) {
  if (!node) return;
  node.setAttribute("aria-checked", on ? "true" : "false");
  node.disabled = !!disabled;
}

function renderSwitches() {
  const cfg = view.config || {};
  const acc = activeAccount();
  // remember 由 syncRememberSwitches 统一同步 (主界面 + 设置面板两个开关一起跟)
  syncRememberSwitches();
  setSwitch(dom.swAuto, !!(acc ? acc.autoLogin : cfg.autoLogin), !acc);
  setSwitch(dom.swReconnect, !!cfg.autoReconnect);
  setSwitch(dom.swAutoLaunch, !!cfg.autoLaunch);
}

/* =========================================================================
   9. 整体渲染
   ========================================================================= */

function renderAll() {
  renderHero();
  renderMetrics();
  renderAccounts();
  renderSwitches();
  renderMainButton();
  // 每次快照都对齐一次主题色 / 窗口按钮风格 (setter 内部做了变更判断, 不会反复写属性)
  applyAccent(accentOf());
  applyChrome(chromeOf());
}

/* =========================================================================
   10. 交互: 连接 / 断开
   ========================================================================= */

function inlineError(msg, field) {
  ui.inlineError = msg || "";
  setText(dom.fieldHint, ui.inlineError);
  setOn(dom.fieldHint, "is-on", !!ui.inlineError);
  if (dom.noticeMsg && ui.inlineError) setText(dom.noticeMsg, ui.inlineError);
  setHidden(dom.notice, !ui.inlineError || (view.conn || {}).state !== "error");
  if (field) {
    field.classList.add("is-error");
    setTimeout(() => field.classList.remove("is-error"), 420);
  }
}

async function onMainAction() {
  const c = view.conn || {};
  if (ui.busy) return;

  if (c.state === "online") {
    ui.busy = true;
    renderMainButton();
    try {
      const r = await bridge.auth.logout();
      pushToast(r && r.ok ? "success" : "error", (r && r.message) || "已断开");
      chart.reset();
      setHidden(dom.chartEmpty, false);
    } catch (err) {
      pushToast("error", `断开失败：${err && err.message ? err.message : err}`);
    } finally {
      ui.busy = false;
      renderMainButton();
    }
    return;
  }

  if (c.reconnecting) {
    // 取消自动重连: 关闭开关即可让主进程停止重试
    try {
      const cfg = await bridge.config.update({ autoReconnect: false });
      if (cfg) view.config = cfg;
      pushToast("info", "已取消自动重连");
      renderSwitches();
    } catch (err) {
      pushToast("error", "取消自动重连失败");
    }
    return;
  }

  const username = dom.inputUser.value.trim();
  const password = dom.inputPass.value;
  const acc = activeAccount();

  if (!username && !acc) {
    inlineError("请先添加一个账号", dom.fieldUser);
    setMenuOpen(true);
    pushToast("warning", "请先添加账号");
    return;
  }
  if (!username) {
    inlineError("请输入学号 / 账号", dom.fieldUser);
    dom.inputUser.focus();
    return;
  }
  if (!password && !(acc && acc.hasPassword)) {
    inlineError("请输入密码", dom.fieldPass);
    dom.inputPass.focus();
    return;
  }

  inlineError("");
  ui.busy = true;
  renderMainButton();

  try {
    const payload = { username, accountId: acc ? acc.id : undefined };
    if (password) payload.password = password;
    // 输入框学号与当前账号不一致时, 顺手把账号存下来, 免得下次还得手填
    if (!acc || acc.username !== username) {
      try {
        const saved = await bridge.accounts.save({ id: acc ? acc.id : undefined, username, password: password || undefined });
        if (saved && saved.ok && saved.accounts) {
          view.accounts = saved.accounts;
          const matched = saved.accounts.find((a) => a.username === username);
          if (matched) view.activeAccountId = matched.id;
        }
      } catch { /* 保存失败不阻断登录 */ }
    }

    const r = await bridge.auth.login(payload);
    if (r && r.ok) {
      pushToast("success", r.alreadyOnline ? "该账号已在线" : "已连接校园网");
      inlineError("");
      // 登录成功: 眼睛复位为点状; 已保存密码 -> 继续点状, 未保存 -> 清空
      resetPassVisibility();
      ui.passDirty = false;
      ui.revealed = true;
      await refreshPasswordField();
    } else {
      const code = r && r.code ? ` (${r.code})` : "";
      const msg = (r && r.message) || "认证失败";
      inlineError(`认证失败：${msg}${code}`, dom.fieldPass);
      pushToast("error", `认证失败：${msg}${code}`);
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    inlineError(`认证异常：${msg}`, dom.fieldPass);
    pushToast("error", `认证异常：${msg}`);
  } finally {
    ui.busy = false;
    renderMainButton();
  }
}

/* =========================================================================
   11. 交互: 账号
   ========================================================================= */

async function selectAccount(id) {
  if (!id) return;
  try {
    const r = await bridge.accounts.select(id);
    if (r && r.ok) {
      view.activeAccountId = r.activeAccountId || id;
      const acc = activeAccount();
      if (acc) {
        dom.inputUser.value = acc.username || "";
        dom.inputPass.value = "";
        ui.userDirty = false;
        ui.passDirty = false;
        ui.revealed = false;
        passFailedFor = "";
        resetPassVisibility();
        setPassPlaceholder(false);
      }
      inlineError("");
      setMenuOpen(false);
      renderAll();
      pushToast("info", `已切换到 ${acc ? (acc.label || acc.username) : id}`);
    } else {
      pushToast("error", (r && r.message) || "切换失败");
    }
  } catch (err) {
    pushToast("error", "切换账号失败");
  }
}

async function removeAccount(id, name) {
  try {
    const r = await bridge.accounts.remove(id);
    if (r && r.ok) {
      pushToast("success", `已删除账号 ${name}`);
      setMenuOpen(false);
      await refreshSnapshot();
    } else {
      pushToast("error", (r && r.message) || "删除失败");
    }
  } catch (err) {
    pushToast("error", "删除账号失败");
  }
}

function onAddAccount() {
  // 清空表单进入「新增」状态: 已有账号不会被改动, 提交时才落库
  setMenuOpen(false);
  dom.inputUser.value = "";
  dom.inputPass.value = "";
  resetPassVisibility();
  setPassPlaceholder(false);
  ui.userDirty = true;
  ui.passDirty = false;
  ui.revealed = false;
  passFailedFor = "";
  inlineError("");
  dom.inputUser.focus();
  pushToast("info", "请输入学号与密码，点击「连接校园网」即可保存并登录");
}

async function onEyeToggle() {
  const showing = dom.inputPass.type === "text";
  if (showing) {
    // 再点一次: 回到点状
    dom.inputPass.type = "password";
    dom.eyePass.classList.remove("is-on");
    dom.eyePass.title = "显示密码";
    dom.eyePass.setAttribute("aria-label", "显示密码");
    return;
  }
  dom.inputPass.type = "text";
  dom.eyePass.classList.add("is-on");
  dom.eyePass.title = "隐藏密码";
  dom.eyePass.setAttribute("aria-label", "隐藏密码");

  // 本地没有明文时, 向主进程索取一次; 失败静默 (只改 placeholder, 不弹错误)
  const acc = activeAccount();
  if (!dom.inputPass.value && acc && acc.hasPassword) {
    try {
      const r = await bridge.accounts.reveal(acc.id);
      if (r && r.password) {
        dom.inputPass.value = r.password;
        ui.revealed = true;
        passFailedFor = "";
        setPassPlaceholder(false);
      } else {
        ui.revealed = false;
        passFailedFor = acc.id;
        setPassPlaceholder(true);
      }
    } catch {
      ui.revealed = false;
      passFailedFor = acc.id;
      setPassPlaceholder(true);
    }
  }
}

/* =========================================================================
   12. 交互: 开关
   ========================================================================= */

async function updateConfig(patch, okMessage) {
  try {
    const cfg = await bridge.config.update(patch);
    if (cfg && typeof cfg === "object") view.config = cfg;
    // 主题色 / 窗口按钮风格是"立即生效"的 <html> 属性, 与其他配置一起落盘
    applyAccent(accentOf(cfg || view.config));
    applyChrome(chromeOf(cfg || view.config));
    if (okMessage) pushToast("success", okMessage);
    renderSwitches();
    return cfg;
  } catch (err) {
    pushToast("error", "设置保存失败");
    return null;
  }
}

async function onToggleRemember() {
  // 关闭 = 破坏性操作 (主进程会立刻删除所有已保存的密码, 不可恢复), 必须先确认;
  // 打开则直接生效。
  const cur = !!(view.config || {}).remember;
  if (cur) { openRememberConfirm(); return; }
  await applyRemember(true, "已开启记住密码");
}

/**
 * 「记住密码」的唯一写入路径。
 *
 * 为什么必须只走这里:
 *  - 主界面开关与设置面板里还有一个同名的「记住密码」开关, 两个入口如果各自直接
 *    updateConfig, 一旦它们显示的状态不同步 (面板不会随快照重渲染), 就会一个把
 *    remember 写成 false(触发主进程删除全部已保存密码)、另一个又写回 true —— 用户
 *    在真机上看到的正是这种成对写入, 结果是"开关还显示开着, 密码已经被删光"。
 *  - rememberBusy 保证一次只允许一个在途写操作, 连点/连击不会产生第二次写入。
 */
let rememberBusy = false;

async function applyRemember(next, okMessage) {
  if (rememberBusy) return null;
  // 幂等: 配置已经是目标值就不再写第二次。
  // (主界面与面板两个入口 + 连点确认都可能在同一秒内触发, 重复写 remember 是有害的:
  //  真机日志里正是 false/true 成对写入把"已保存的密码"删掉又把开关写回"开"。)
  if (!!(view.config || {}).remember === !!next) return null;
  rememberBusy = true;
  try {
    const cfg = await updateConfig({ remember: next }, okMessage);
    if (!cfg) return null;
    if (next) {
      passFailedFor = "";   // 重新开启后允许再试一次 reveal
      // 尽量挽回: 密码框里若已有内容(用户刚输入 / 刚 reveal 出来), 立刻存回去
      const acc = activeAccount();
      if (acc && dom.inputPass && dom.inputPass.value) {
        try { await bridge.accounts.save({ id: acc.id, username: acc.username, password: dom.inputPass.value }); } catch { /* 忽略 */ }
      }
    } else {
      // 关闭记住密码 -> 清空密码框, 回到「无密码」状态
      ui.revealed = false;
      ui.passDirty = false;
      if (dom.inputPass) dom.inputPass.value = "";
      setPassPlaceholder(false);
    }
    syncRememberSwitches();
    await refreshSnapshot();
    return cfg;
  } finally {
    rememberBusy = false;
  }
}

/** 两个「记住密码」开关 + 确认条, 一律从 view.config.remember 渲染, 保证同步 */
function syncRememberSwitches() {
  const on = !!(view.config || {}).remember;
  setSwitch(dom.swRemember, on);
  const sheetBtn = ui.sheetRememberBtn;
  if (sheetBtn && sheetBtn.isConnected) {
    sheetBtn.setAttribute("aria-checked", on ? "true" : "false");
  }
  // 配置已经不是"开"了, 确认条就没有意义了 (例如在别处已经确认关闭)
  if (!on) closeRememberConfirm();
}

/* ---- 主界面: 关闭「记住密码」前的行内确认条 ---- */

let rememberConfirmOpen = false;
let rememberConfirmTimer = 0;

function openRememberConfirm() {
  const bar = dom.rememberConfirm;
  if (!bar || rememberConfirmOpen) return;
  rememberConfirmOpen = true;
  clearTimeout(rememberConfirmTimer);
  setHidden(bar, false);
  requestAnimationFrame(() => {
    bar.classList.add("is-in");
    // 确认条在开关条下方, 滚进视野, 免得用户看不到
    try { bar.scrollIntoView({ block: "nearest" }); } catch { /* 忽略 */ }
  });
}

function closeRememberConfirm() {
  const bar = dom.rememberConfirm;
  if (!bar || !rememberConfirmOpen) return;
  rememberConfirmOpen = false;
  bar.classList.remove("is-in");
  clearTimeout(rememberConfirmTimer);
  rememberConfirmTimer = setTimeout(() => { if (!rememberConfirmOpen) setHidden(bar, true); }, 240);
}

/** 确认关闭: 真正写配置 (文案说清后果: 密码已从本机删除) */
async function onRememberConfirmOk() {
  const bar = dom.rememberConfirm;
  // 确认条收起有 240ms 动画, 期间按钮还在 DOM 里: 连点必须只写一次
  if (bar && bar.dataset.busy === "1") return;
  if (bar) bar.dataset.busy = "1";
  closeRememberConfirm();
  await applyRemember(false, "已关闭记住密码，已从本机删除保存的密码");
  if (bar) delete bar.dataset.busy;
}

/** 取消: 开关回到「开」, 不写任何配置 */
function onRememberCancel() {
  closeRememberConfirm();
  syncRememberSwitches();
}

/** 设置面板里「记住密码」那一行下方的同款确认行 */
function showSheetRememberConfirm(row, revert) {
  if (!row || !row.isConnected) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains("confirmrow")) return;   // 已经开着

  const box = el("div", "confirmrow");
  box.setAttribute("role", "alertdialog");
  const ico = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ico.setAttribute("viewBox", "0 0 20 20");
  ico.setAttribute("aria-hidden", "true");
  ico.setAttribute("class", "confirmbar__ico");
  const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p1.setAttribute("d", "M10 2.6 18.4 17H1.6L10 2.6Z");
  const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p2.setAttribute("d", "M10 7.6v4.1M10 14.2v.1");
  ico.appendChild(p1); ico.appendChild(p2);

  const text = el("span", "confirmbar__text", "关闭后将从本机删除已保存的密码，且不可恢复");
  const ok = el("button", "confirmbar__btn confirmbar__btn--danger", "确认关闭");
  ok.type = "button";
  const cancel = el("button", "confirmbar__btn", "取消");
  cancel.type = "button";

  const remove = () => { if (box.isConnected) box.remove(); };
  ok.addEventListener("click", async () => {
    remove();
    await applyRemember(false, "已关闭记住密码，已从本机删除保存的密码");
  });
  cancel.addEventListener("click", () => {
    remove();
    if (typeof revert === "function") revert();   // 开关弹回"开"
    syncRememberSwitches();
  });

  box.appendChild(ico); box.appendChild(text); box.appendChild(ok); box.appendChild(cancel);
  row.after(box);
  try { box.scrollIntoView({ block: "nearest" }); } catch { /* 忽略 */ }
}

async function onToggleAuto() {
  const acc = activeAccount();
  const next = !(acc ? acc.autoLogin : (view.config || {}).autoLogin);
  if (acc) {
    try {
      const r = await bridge.accounts.save({ id: acc.id, username: acc.username, autoLogin: next });
      if (r && r.ok) {
        if (r.accounts) view.accounts = r.accounts;
        pushToast("success", next ? "已开启该账号的自动登录" : "已关闭该账号的自动登录");
      } else {
        pushToast("error", (r && r.message) || "保存失败");
      }
    } catch { pushToast("error", "保存失败"); }
  } else {
    await updateConfig({ autoLogin: next }, next ? "已开启自动登录" : "已关闭自动登录");
  }
  await refreshSnapshot();
}

/* =========================================================================
   13. 面板 (Sheet)
   ========================================================================= */

function openSheet(name) {
  ui.sheet = name;
  const titles = { settings: "设置", logs: "运行日志", diag: "网络诊断", about: "关于 HAUT Guard" };
  setText(dom.sheetTitle, titles[name] || "面板");
  setHidden(dom.sheetFoot, true);
  setText(dom.sheetFoot, "");
  setText(dom.sheetBody, "");
  setHidden(dom.scrim, false);
  setHidden(dom.sheet, false);
  // 触发过渡
  requestAnimationFrame(() => {
    setOn(dom.scrim, "is-in", true);
    setOn(dom.sheet, "is-in", true);
  });
  if (name === "settings") renderSettingsSheet();
  else if (name === "logs") renderLogsSheet();
  else if (name === "diag") renderDiagSheet();
  else if (name === "about") renderAboutSheet();
}

function closeSheet() {
  if (!ui.sheet) return;
  ui.sheet = "";
  setOn(dom.scrim, "is-in", false);
  setOn(dom.sheet, "is-in", false);
  const done = () => {
    setHidden(dom.scrim, true);
    setHidden(dom.sheet, true);
    setText(dom.sheetBody, "");
    setHidden(dom.sheetFoot, true);
    setText(dom.sheetFoot, "");
  };
  if (reduceMotion.matches) done();
  else setTimeout(done, 340);
}

/** 生成一行开关 (面板内)。onChange(next, revert, btn): revert() 可把开关恢复原状 */
function sheetSwitch(label, desc, on, onChange) {
  const row = el("div", "row");
  const box = el("span", "row__label");
  box.appendChild(el("b", null, label));
  if (desc) box.appendChild(el("i", null, desc));
  row.appendChild(box);

  const btn = el("button", "switch");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  btn.setAttribute("aria-checked", on ? "true" : "false");
  btn.appendChild(el("span"));
  btn.addEventListener("click", async () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    btn.setAttribute("aria-checked", next ? "true" : "false");
    // 破坏性开关可以先弹确认再写配置: 取消时用 revert() 让开关回到原位
    const revert = () => btn.setAttribute("aria-checked", next ? "false" : "true");
    await onChange(next, revert, btn);
  });
  const ctrl = el("span", "row__ctrl");
  ctrl.appendChild(btn);
  row.appendChild(ctrl);
  return row;
}

/**
 * 登录协议 = 「密码摘要方式 + info 报文格式」的唯一有效组合表。
 * 两个选项的 passwordAlgo 都固定为 srun3 —— 这样 UI 再也不可能构造出坏组合
 * (srbx1 是"对空串取 hmac", 会让网关回 E2553 密码错误, 看起来像密码错, 极难排查)。
 * 只留 infoFormat 的差异, 给将来学校换固件留一个排障开关。
 */
const LOGIN_VARIANTS = [
  {
    value: "standard", label: "标准（推荐）",
    passwordAlgo: "srun3", infoFormat: "srbx1",
    risk: "",
  },
  {
    value: "legacy", label: "旧版（排障用）",
    passwordAlgo: "srun3", infoFormat: "srun3",
    risk: "本网关实测不支持旧版协议，选错会导致登录失败",
  },
];

/** 配置里的组合是否有效 */
function loginVariantValid(cfg) {
  const alg = String((cfg && cfg.passwordAlgo) || "");
  const fmt = String((cfg && cfg.infoFormat) || "");
  return LOGIN_VARIANTS.some((v) => v.passwordAlgo === alg && v.infoFormat === fmt);
}

/** 由配置反推当前应显示的选项; 无效组合按「标准」显示 (并在面板里给出提示) */
function loginVariantOf(cfg) {
  const alg = String((cfg && cfg.passwordAlgo) || "srun3");
  const fmt = String((cfg && cfg.infoFormat) || "srun3");
  const hit = LOGIN_VARIANTS.find((v) => v.passwordAlgo === alg && v.infoFormat === fmt);
  return hit ? hit.value : "standard";
}

/** 生成一行分段选择 */
function sheetSeg(options, current, onChange) {
  const seg = el("div", "seg");
  options.forEach((opt) => {
    const b = el("button", opt.value === current ? "is-on" : null, opt.label);
    b.type = "button";
    b.addEventListener("click", async () => {
      if (b.classList.contains("is-on")) return;
      seg.querySelectorAll("button").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      await onChange(opt.value, opt.label);
    });
    seg.appendChild(b);
  });
  return seg;
}

/** 生成一行主题色板 (7 个圆形色块, 选中项有描边 + 对勾) */
function sheetSwatches(current, onChange) {
  const box = el("div", "swatches");
  ACCENTS.forEach((a) => {
    const b = el("button", a.value === current ? "swatch is-on" : "swatch");
    b.type = "button";
    b.dataset.accent = a.value;
    b.title = a.label;
    b.setAttribute("aria-label", `主题色 ${a.label}`);
    b.setAttribute("aria-pressed", a.value === current ? "true" : "false");
    b.addEventListener("click", async () => {
      if (b.classList.contains("is-on")) return;
      box.querySelectorAll(".swatch").forEach((x) => {
        x.classList.remove("is-on");
        x.setAttribute("aria-pressed", "false");
      });
      b.classList.add("is-on");
      b.setAttribute("aria-pressed", "true");
      await onChange(a.value, a.label);
    });
    box.appendChild(b);
  });
  return box;
}

/** 生成一行数字输入 */
function sheetNumber(current, min, max, step, onChange) {
  const input = el("input", "pinput pinput--num");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(current);
  const commit = debounce(async () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = current;
    v = Math.min(max, Math.max(min, Math.round(v)));
    input.value = String(v);
    await onChange(v);
  }, 420);
  input.addEventListener("input", commit);
  input.addEventListener("blur", () => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) v = current;
    v = Math.min(max, Math.max(min, Math.round(v)));
    input.value = String(v);
  });
  return input;
}

function group(title) {
  const g = el("div", "group");
  if (title) g.appendChild(el("div", "group__title", title));
  return g;
}

function rowWrap(node) {
  const r = el("div", "row");
  const ctrl = el("span", "row__ctrl");
  ctrl.appendChild(node);
  r.appendChild(ctrl);
  return r;
}

function labeledRow(label, desc, control) {
  const r = el("div", "row");
  const box = el("span", "row__label");
  box.appendChild(el("b", null, label));
  if (desc) box.appendChild(el("i", null, desc));
  r.appendChild(box);
  const ctrl = el("span", "row__ctrl");
  ctrl.appendChild(control);
  r.appendChild(ctrl);
  return r;
}

/* ---------------------------- 设置面板 ---------------------------- */

function renderSettingsSheet() {
  const cfg = view.config || {};
  const body = dom.sheetBody;

  /* 网络 */
  const gNet = group("网络");
  const gw = el("input", "pinput");
  gw.type = "text";
  gw.value = cfg.gateway || "";
  gw.spellcheck = false;
  gw.addEventListener("change", () => {
    const v = gw.value.trim();
    if (!v) { gw.value = cfg.gateway || ""; pushToast("warning", "网关地址不能为空"); return; }
    if (!/^[0-9a-zA-Z.\-:]+$/.test(v)) { gw.value = cfg.gateway || ""; pushToast("warning", "网关地址格式不正确"); return; }
    updateConfig({ gateway: v }, "网关地址已保存");
  });
  gNet.appendChild(labeledRow("网关地址", "认证服务器 IP 或域名", gw));
  gNet.appendChild(labeledRow("Portal 端口", "认证报文端口", sheetNumber(cfg.portalPort, 1, 65535, 1, (v) => updateConfig({ portalPort: v }, "Portal 端口已保存"))));
  gNet.appendChild(labeledRow("Status 端口", "状态查询端口", sheetNumber(cfg.statusPort, 1, 65535, 1, (v) => updateConfig({ statusPort: v }, "Status 端口已保存"))));
  body.appendChild(gNet);

  /* 行为 */
  const gBehavior = group("行为");
  gBehavior.appendChild(labeledRow("轮询间隔", "在线状态检查周期 (秒)", sheetNumber(cfg.pollInterval, 2, 600, 1, (v) => updateConfig({ pollInterval: v }, "轮询间隔已保存"))));
  gBehavior.appendChild(sheetSwitch("自动登录", "启动后使用默认账号连接", !!cfg.autoLogin, (v) => updateConfig({ autoLogin: v }, v ? "已开启自动登录" : "已关闭自动登录")));
  gBehavior.appendChild(sheetSwitch("断线自动重连", "检测到掉线后自动重试", !!cfg.autoReconnect, (v) => updateConfig({ autoReconnect: v }, v ? "已开启自动重连" : "已关闭自动重连")));
  gBehavior.appendChild(sheetSwitch("开机自启", "随系统启动并最小化到托盘", !!cfg.autoLaunch, (v) => updateConfig({ autoLaunch: v }, v ? "已开启开机自启" : "已关闭开机自启")));
  /* 记住密码: 面板里的这个开关与主界面那个是同一条配置。
     关闭同样是破坏性操作 -> 先在该行下面滑出确认行, 确认后才写; 取消则开关弹回"开"。
     写入统一走 applyRemember() (带在途守卫), 不再各自直接 updateConfig。 */
  const rememberRow = sheetSwitch("记住密码", "使用系统加密保存凭据", !!cfg.remember, async (v, revert, btn) => {
    if (v) {
      await applyRemember(true, "已开启记住密码");
      return;
    }
    // 关闭需要先确认: 开关先弹回"开"(与真实配置一致), 由确认行决定是否真的关。
    // 不在这里做"乐观翻转" —— 面板不会随快照重渲染, 乐观状态会和配置打架。
    if (typeof revert === "function") revert();
    showSheetRememberConfirm(btn ? btn.closest(".row") : null, revert);
  });
  ui.sheetRememberBtn = rememberRow.querySelector(".switch");
  gBehavior.appendChild(rememberRow);
  gBehavior.appendChild(sheetSwitch("启动时最小化", "启动后仅显示托盘图标", !!cfg.startMinimized, (v) => updateConfig({ startMinimized: v }, v ? "已开启启动最小化" : "已关闭启动最小化")));
  body.appendChild(gBehavior);

  /* 外观 */
  const gAppearance = group("外观");
  const themeSeg = sheetSeg(
    [{ value: "dark", label: "深色" }, { value: "light", label: "浅色" }, { value: "system", label: "跟随系统" }],
    cfg.theme || "system",
    async (v, label) => {
      updateConfig({ theme: v }, `外观已切换为${label}`);
      ui.previewTheme = "";
      applyTheme(v);
    },
  );
  gAppearance.appendChild(labeledRow("界面主题", "深浅色外观", themeSeg));

  /* 主题色: 7 种预设, 只改强调色 + 窗口氛围光斑 (玻璃的灰白层次不染色) */
  const accentName = accentOf(cfg);
  const swatches = sheetSwatches(accentName, async (v, label) => {
    applyAccent(v);   // 先落到 <html> 上, 让点击即时可见
    updateConfig({ accent: v }, `主题色已切换为${label}`);
  });
  gAppearance.appendChild(labeledRow("主题色", `${accentLabel(accentName)}（强调色与氛围光）`, swatches));

  /* 窗口按钮风格: Mac = 左上角红黄绿; Windows = 右上角 最小化/关闭 */
  const chromeSeg = sheetSeg(
    [{ value: "mac", label: "Mac" }, { value: "windows", label: "Windows" }],
    chromeOf(cfg),
    async (v, label) => {
      applyChrome(v);
      updateConfig({ chromeStyle: v }, `窗口按钮已切换为 ${label} 风格`);
    },
  );
  gAppearance.appendChild(labeledRow("窗口按钮", "标题栏按钮位置", chromeSeg));

  /* 窗口材质不再提供切换: 本窗口是"透明窗口 + CSS 圆角", 而 acrylic/云母是 DWM 按
     整个窗口矩形绘制的系统材质, 两者互斥 —— 一旦设置材质, 圆角之外会立刻变成纯白
     (就是"四个角发白"的成因), 即便显示出来也会在 CSS 圆角外露出直角背板。
     主进程侧 supportedMaterials() 同样只返回 transparent。 */

  /* 登录协议: 只暴露"实测可用"的整组组合。
     原先 passwordAlgo / infoFormat 是两个独立开关, 可以选出
     passwordAlgo=srbx1 + infoFormat=srun3 这种坏组合 (对空串取 hmac), 网关直接回
     E2553 "Password is error", 看起来像密码错, 极难排查。合并后 passwordAlgo 恒为 srun3。 */
  const loginSeg = sheetSeg(
    LOGIN_VARIANTS.map((v) => ({ value: v.value, label: v.label })),
    loginVariantOf(cfg),
    async (v, label) => {
      const variant = LOGIN_VARIANTS.find((x) => x.value === v) || LOGIN_VARIANTS[0];
      await updateConfig(
        { passwordAlgo: variant.passwordAlgo, infoFormat: variant.infoFormat },
        `登录协议已切换为${label}`,
      );
      if (!ui.sheet) return;
      renderSettingsSheet();   // 重建面板: 让"不支持旧版"的警告随选项即时出现/消失
    },
  );
  gAppearance.appendChild(labeledRow("登录协议", "本网关实测可用", loginSeg));

  // 选中「旧版（排障用）」时把风险讲清楚, 避免误选
  const pickedVariant = LOGIN_VARIANTS.find((v) => v.value === loginVariantOf(cfg));
  if (pickedVariant && pickedVariant.risk) {
    const warn = el("div", "hintline hintline--warn");
    warn.innerHTML = `<span>${pickedVariant.risk}</span>`;
    gAppearance.appendChild(warn);
  }

  if (!loginVariantValid(cfg)) {
    const bad = el("div", "hintline hintline--warn");
    bad.innerHTML = `<span>当前保存的组合无效（登录必然失败），已按 <b>标准（推荐）</b> 显示；点一下即可修正。</span>`;
    gAppearance.appendChild(bad);
  }
  body.appendChild(gAppearance);

  /* 高级 */
  const gAdv = group("高级");
  const reset = el("button", "btn btn--danger", "恢复默认设置");
  reset.type = "button";
  reset.addEventListener("click", async () => {
    try {
      const r = await bridge.config.reset();
      if (r && r.ok) {
        view.config = r.config || view.config;
        pushToast("success", "已恢复默认设置");
        applyTheme(view.config.theme);
        applyAccent(accentOf(view.config));
        applyChrome(chromeOf(view.config));
        renderSettingsSheet();
        renderSwitches();
      } else {
        pushToast("error", "恢复默认失败");
      }
    } catch { pushToast("error", "恢复默认失败"); }
  });
  const cfgPath = el("div", "hintcard");
  cfgPath.innerHTML = `<span>配置文件与账号存储位置由主进程管理，凭据经 Windows DPAPI 加密，不会以明文落盘。</span>`;
  gAdv.appendChild(cfgPath);
  gAdv.appendChild(rowWrap(reset));

  // 底部小灰字: 密码明明正确却报错时, 先回来看这一行
  const protoTip = el("div", "hintline");
  protoTip.innerHTML = `<span>若提示密码错误，请先确认此处为 <b>标准（推荐）</b>。</span>`;
  gAdv.appendChild(protoTip);

  body.appendChild(gAdv);

  dom.sheetFoot.hidden = true;
}

/* ---------------------------- 日志面板 ---------------------------- */

function levelTag(level) {
  const lv = String(level || "info").toLowerCase();
  if (lv.startsWith("err") || lv === "error") return "error";
  if (lv.startsWith("warn")) return "warn";
  return "info";
}

/** 解析 "2024-06-01 12:00:00 [INFO] message" 之类的行 */
function parseLogLine(line) {
  const text = String(line || "");
  let ts = "";
  let level = "info";
  let msg = text;
  const m = text.match(/^\[?([\d]{2}:[\d]{2}:[\d]{2}(?:[.,]\d+)?|[-\d :T]{10,25}?)\]?\s*\[?(INFO|WARN|WARNING|ERROR|DEBUG|TRACE|FATAL)\]?\s*(.*)$/i);
  if (m) {
    ts = m[1].trim();
    level = levelTag(m[2]);
    msg = m[3];
  }
  return { ts, level, msg };
}

async function renderLogsSheet() {
  const body = dom.sheetBody;
  const bar = el("div", "logbar");
  const path = el("span", "logbar__path", view.logs.path || "未知路径");
  path.title = view.logs.path || "";
  bar.appendChild(path);

  const mkBtn = (label, fn) => {
    const b = el("button", "btn", label);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  };
  bar.appendChild(mkBtn("刷新", () => renderLogsSheet()));
  bar.appendChild(mkBtn("清空", async () => {
    try {
      const r = await bridge.logs.clear();
      pushToast(r && r.ok ? "success" : "error", r && r.ok ? "日志已清空" : "清空失败");
      renderLogsSheet();
    } catch { pushToast("error", "清空日志失败"); }
  }));
  bar.appendChild(mkBtn("打开目录", async () => {
    try { await bridge.logs.openFolder(); } catch { pushToast("error", "打开目录失败"); }
  }));
  body.appendChild(bar);

  const box = el("div", "logs");
  box.appendChild(el("div", "logs__empty", "正在读取…"));
  body.appendChild(box);

  try {
    const r = await bridge.logs.read(300);
    if (r && r.path) {
      view.logs.path = r.path;
      path.textContent = r.path;
      path.title = r.path;
    }
    const lines = (r && r.lines) || [];
    box.textContent = "";
    if (!lines.length) {
      box.appendChild(el("div", "logs__empty", "暂无日志记录"));
      return;
    }
    const frag = document.createDocumentFragment();
    lines.forEach((line) => {
      const p = parseLogLine(line);
      const row = el("div", `logline logline--${p.level}`);
      row.appendChild(el("span", "logline__ts", p.ts || "--:--:--"));
      row.appendChild(el("span", "logline__lv", p.level === "warn" ? "WARN" : p.level.toUpperCase()));
      row.appendChild(el("span", "logline__msg", p.msg));
      frag.appendChild(row);
    });
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  } catch (err) {
    box.textContent = "";
    box.appendChild(el("div", "logs__empty", "读取日志失败"));
  }
}

/* ---------------------------- 诊断面板 ---------------------------- */

async function renderDiagSheet() {
  const body = dom.sheetBody;
  const box = el("div", "diag");
  box.appendChild(el("div", "logs__empty", "正在运行诊断…"));
  body.appendChild(box);

  try {
    const r = await bridge.diag.run();
    const items = (r && r.items) || [];
    box.textContent = "";
    if (!items.length) {
      box.appendChild(el("div", "logs__empty", "没有诊断结果"));
      return;
    }
    items.forEach((it, i) => {
      const ok = !!it.ok;
      const row = el("div", `diag__row ${ok ? "is-ok" : "is-bad"}`);
      row.style.animationDelay = `${i * 45}ms`;
      const mark = el("span", "diag__mark");
      mark.appendChild(icon(ok
        ? '<path d="M5 10.6l3.2 3.2 6.8-7.2"/>'
        : '<path d="M7 7l6 6M13 7l-6 6"/>'));
      const mkSvg = mark.querySelector("svg");
      if (mkSvg) mkSvg.setAttribute("viewBox", "0 0 20 20");
      row.appendChild(mark);

      const b = el("div", "diag__body");
      b.appendChild(el("span", "diag__name", it.name || "未命名检查"));
      b.appendChild(el("span", "diag__detail", it.detail || ""));
      row.appendChild(b);
      row.appendChild(el("span", "diag__ms", Number.isFinite(it.ms) ? `${it.ms}ms` : ""));
      box.appendChild(row);
    });

    const okCount = items.filter((x) => x.ok).length;
    const card = el("div", "hintcard");
    card.style.marginTop = "10px";
    card.innerHTML = `<span>共 ${items.length} 项检查，<b>${okCount} 项通过</b>${okCount === items.length ? "，网络环境正常。" : "，未通过项未认证时可能属于正常现象。"}</span>`;
    body.appendChild(card);

    const again = el("button", "btn btn--grow", "重新诊断");
    again.type = "button";
    again.style.marginTop = "10px";
    again.addEventListener("click", () => {
      dom.sheetBody.textContent = "";
      renderDiagSheet();
    });
    body.appendChild(rowWrap(again));
  } catch (err) {
    box.textContent = "";
    box.appendChild(el("div", "logs__empty", "诊断执行失败"));
  }
}

/* ---------------------------- 关于面板 ---------------------------- */

async function renderAboutSheet() {
  const body = dom.sheetBody;
  let info = view.app || {};
  try {
    const r = await bridge.app.info();
    if (r && typeof r === "object") info = Object.assign({}, info, r);
  } catch { /* 用快照里的信息兜底 */ }

  const hero = el("div", "hintcard");
  hero.style.flexDirection = "column";
  hero.style.gap = "3px";
  hero.innerHTML = `<b style="font-size:13px">HAUT Guard</b><span>深澜 SRun 校园网认证客户端 · 液态玻璃界面</span>`;
  body.appendChild(hero);

  const kv = el("div", "kv");
  kv.style.marginTop = "12px";
  const rows = [
    ["应用版本", info.version || view.app.version || "-"],
    ["Electron", info.electron || view.app.electron || "-"],
    ["Node.js", info.node || view.app.node || "-"],
    ["Chromium", info.chrome || view.app.chrome || "-"],
    ["运行平台", info.platform || view.app.platform || "-"],
    ["窗口材质", view.config.material || info.material || "-"],
    ["认证网关", `${view.config.gateway || "-"}:${view.config.portalPort || "-"}`],
    ["日志文件", view.logs.path || "-"],
  ];
  rows.forEach(([k, v]) => {
    const r = el("div", "kv__row");
    r.appendChild(el("span", "kv__k", k));
    const val = el("span", "kv__v", String(v));
    val.title = String(v);
    r.appendChild(val);
    kv.appendChild(r);
  });
  body.appendChild(kv);

  const tip = el("div", "hintcard");
  tip.style.marginTop = "12px";
  tip.innerHTML = `<span>界面渲染层不直接访问网络与磁盘，全部能力经 <b>window.haut</b> 由主进程代理。</span>`;
  body.appendChild(tip);

  const quit = el("button", "btn btn--danger btn--grow", "退出 HAUT Guard");
  quit.type = "button";
  quit.style.marginTop = "12px";
  quit.addEventListener("click", () => { bridge.app.quit(); });
  body.appendChild(rowWrap(quit));
}

/* =========================================================================
   14. 快照刷新
   ========================================================================= */

function applySnapshot(snap) {
  if (!snap || typeof snap !== "object") return;
  if (snap.conn) view.conn = snap.conn;
  if (snap.rate) view.rate = snap.rate;
  if (snap.config) view.config = snap.config;
  if (Array.isArray(snap.accounts)) view.accounts = snap.accounts;
  if ("activeAccountId" in snap) view.activeAccountId = snap.activeAccountId;
  if (snap.app) view.app = snap.app;
  if (snap.material) view.material = snap.material;
  if (snap.logs) view.logs = snap.logs;
  renderAll();
}

async function refreshSnapshot() {
  try {
    const snap = await bridge.getSnapshot();
    applySnapshot(snap);
    return snap;
  } catch (err) {
    console.error("[HAUT Guard] 获取快照失败:", err);
    return null;
  }
}

/* =========================================================================
   15. 事件绑定
   ========================================================================= */

function bindEvents() {
  /* 标题栏 */
  document.querySelectorAll("[data-win]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.win;
      if (act === "close") bridge.win.close();
      else if (act === "minimize") bridge.win.minimize();
      else bridge.win.hide();
    });
  });

  dom.themeToggle.addEventListener("click", async () => {
    const current = resolveTheme(ui.previewTheme || (view.config || {}).theme || "system");
    const next = current === "dark" ? "light" : "dark";
    ui.previewTheme = next;
    applyTheme(next);
    pushToast("info", next === "dark" ? "已切换为深色外观" : "已切换为浅色外观");
    try { await bridge.config.update({ theme: next }); } catch { /* 预览/失败时忽略 */ }
  });

  /* 主按钮 */
  dom.mainBtn.addEventListener("click", onMainAction);

  /* 账号 */
  dom.acctButton.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenuOpen(!ui.menuOpen);
  });
  dom.acctAdd.addEventListener("click", onAddAccount);
  dom.acctMenuAdd.addEventListener("click", onAddAccount);
  dom.acctRemove.addEventListener("click", () => {
    const acc = activeAccount();
    if (!acc) { pushToast("warning", "当前没有可删除的账号"); return; }
    removeAccount(acc.id, acc.label || acc.username);
  });

  /* 输入 */
  dom.inputUser.addEventListener("input", () => {
    ui.userDirty = true;
    syncClearButton();
  });
  dom.inputUser.addEventListener("focus", () => dom.fieldUser.classList.add("is-focus"));
  dom.inputUser.addEventListener("blur", () => dom.fieldUser.classList.remove("is-focus"));
  dom.inputUser.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onMainAction(); }
  });
  dom.clearUser.addEventListener("click", () => {
    dom.inputUser.value = "";
    ui.userDirty = true;
    syncClearButton();
    dom.inputUser.focus();
  });
  dom.inputPass.addEventListener("focus", () => dom.fieldPass.classList.add("is-focus"));
  dom.inputPass.addEventListener("blur", () => dom.fieldPass.classList.remove("is-focus"));
  dom.inputPass.addEventListener("input", () => {
    ui.passDirty = true;
    if (ui.inlineError) inlineError("");
  });
  dom.inputPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); onMainAction(); }
  });
  dom.eyePass.addEventListener("click", onEyeToggle);

  /* 开关 */
  dom.swRemember.addEventListener("click", onToggleRemember);
  /* 「记住密码」关闭确认条 (行内, 不用原生 confirm 弹窗) */
  if (dom.rememberConfirmOk) dom.rememberConfirmOk.addEventListener("click", onRememberConfirmOk);
  if (dom.rememberCancel) dom.rememberCancel.addEventListener("click", onRememberCancel);
  dom.swAuto.addEventListener("click", onToggleAuto);
  dom.swReconnect.addEventListener("click", () => {
    const next = !(view.config || {}).autoReconnect;
    updateConfig({ autoReconnect: next }, next ? "已开启断线自动重连" : "已关闭断线自动重连");
  });
  dom.swAutoLaunch.addEventListener("click", () => {
    const next = !(view.config || {}).autoLaunch;
    updateConfig({ autoLaunch: next }, next ? "已开启开机自启" : "已关闭开机自启");
  });

  /* 底部面板入口 */
  dom.foot.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-sheet]");
    if (!btn) return;
    openSheet(btn.dataset.sheet);
  });

  /* 面板关闭 */
  dom.sheetClose.addEventListener("click", closeSheet);
  dom.scrim.addEventListener("click", closeSheet);

  /* 通知关闭 */
  $("noticeClose").addEventListener("click", () => {
    ui.inlineError = "";
    dom.notice.hidden = true;
    dom.fieldHint.classList.remove("is-on");
  });

  /* 全局: Esc 关闭 / 点击空白收起账号菜单 */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (ui.sheet) { closeSheet(); return; }
    if (ui.menuOpen) { setMenuOpen(false); return; }
  });
  document.addEventListener("click", (e) => {
    if (!ui.menuOpen) return;
    if (e.target.closest("#acctMenu") || e.target.closest("#acctButton") || e.target.closest("#acctAdd")) return;
    setMenuOpen(false);
  });

  /* 标题栏空白处双击 = 最小化 (Windows 习惯) */
  $("titlebar").addEventListener("dblclick", (e) => {
    if (e.target.closest("button")) return;
    bridge.win.minimize();
  });

  /* 定时刷新相对时间/查询时间等弱实时字段 */
  setInterval(() => {
    if (ui.sheet === "logs") return;
    renderHero();
  }, 1000);
}

/* =========================================================================
   16. 推送订阅
   ========================================================================= */

function bindPush() {
  const offs = [];
  const safeOn = (channel, handler) => {
    try {
      const off = bridge.on(channel, handler);
      if (typeof off === "function") offs.push(off);
    } catch (err) {
      console.warn(`[HAUT Guard] 订阅 ${channel} 失败:`, err && err.message);
    }
  };

  safeOn("state", (snap) => applySnapshot(snap));

  safeOn("rate", (p) => {
    if (!p) return;
    const down = Number(p.down) || 0;
    const up = Number(p.up) || 0;
    view.rate = { down, up, total: down + up };
    renderLegend();
    chart.push(down, up);
    setHidden(dom.chartEmpty, true);
  });

  safeOn("log", () => { /* 日志面板按需拉取, 这里只保持订阅以适配主进程实现 */ });

  safeOn("toast", (p) => {
    if (!p) return;
    pushToast(p.kind, p.message);
  });

  return () => offs.forEach((off) => { try { off(); } catch { /* 忽略 */ } });
}

/* =========================================================================
   17. 启动
   ========================================================================= */

async function bootstrap() {
  /* 首屏主题: 路由参数(预览) > localStorage > 默认深色 */
  const hash = readHash();
  if (hash.theme === "light" || hash.theme === "dark") ui.previewTheme = hash.theme;

  let stored = "dark";
  try { stored = localStorage.getItem("haut.theme") || "dark"; } catch { /* 忽略 */ }
  applyTheme(ui.previewTheme || stored);

  if (isPreview) {
    setHidden(dom.mockBadge, false);
  }

  bindPointerGlow();
  bindEvents();
  bindPush();

  // 先做 id 落地自查, 缺失会直接以 console.error 报出 (预览 harness 视为致命)
  auditDomIds();

  const snap = await refreshSnapshot();

  // 首屏就把「已保存的密码」回填成点状 (type 保持 password), 不要显示成空框
  await refreshPasswordField();

  /* 预览场景的界面摆位 */
  const intent = (typeof window !== "undefined" && window.__hautIntent) || (bridge && bridge.__intent) || null;
  if (intent) {
    if (intent.inlineError) inlineError(intent.inlineError);
    if (intent.openAccountMenu) setMenuOpen(true);
    if (intent.openSheet) openSheet(intent.openSheet);
  }

  /* 真实环境: 记住的密码不回填, 但把用户上次的账号展示出来 */
  if (snap && snap.config && snap.config.theme) {
    if (!ui.previewTheme) applyTheme(snap.config.theme);
  }

  // 让首屏动画落定后重绘一次曲线, 确保尺寸测量准确
  requestAnimationFrame(() => chart.redraw());
  window.addEventListener("load", () => chart.redraw());
  setTimeout(() => chart.redraw(), 400);

  if (!isPreview) {
    // 真实环境首次启动且没有任何账号时, 主动展开菜单引导添加
    if (!view.accounts.length) setMenuOpen(true);
  }
}

bootstrap().catch((err) => {
  console.error("[HAUT Guard] 界面初始化失败:", err);
});
