/**
 * store.js —— 配置与账号存储。
 *
 * 与 Electron 解耦: safeStorage(DPAPI) 由调用方注入, 因此本模块可以在
 * 纯 Node 下被测试。
 *
 * 安全约定:
 *   - 账号密码**只**以 safeStorage 加密后的 base64 落盘。加密不可用时
 *     不写入密码(hasPassword 为 false), 并在日志里告警, 绝不退化成明文。
 *   - 学号不属于机密, 明文保存以便界面回显(与原版行为一致)。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** 默认配置。 */
const DEFAULT_CONFIG = {
  gateway: "172.16.154.130",
  portalPort: 69,
  statusPort: 80,
  autoLogin: false,
  autoLaunch: false,
  remember: true,
  autoReconnect: true,
  startMinimized: false,
  pollInterval: 30,
  theme: "dark",
  // 默认用"真透明"窗口: 圆角由 CSS 负责, 玻璃效果完全可控。
  // acrylic / mica 是 Win11 的系统级模糊, 但它按**整个窗口矩形**绘制,
  // 会在 CSS 圆角之外露出直角背板, 因此不提供切换(见 main.js 的 supportedMaterials)。
  material: "transparent",
  // 主题色: 影响强调色(按钮/状态环/开关高亮/图标)与窗口氛围光斑
  accent: "cyan",
  // 窗口按钮风格: mac = 左上角红黄绿交通灯; windows = 右上角 ─ ✕
  chromeStyle: "mac",
  passwordAlgo: "srun3",
  // 真机实测: 本网关只接受 "{SRBX1}" + srun 字母表的 info, 且 password 必须带 {MD5} 标记
  infoFormat: "srbx1",
  lastUsername: "",
};

const THEMES = new Set(["dark", "light", "system"]);
const MATERIALS = new Set(["acrylic", "mica", "transparent"]);
const PASSWORD_ALGOS = new Set(["srun3", "srbx1"]);
const INFO_FORMATS = new Set(["srun3", "srbx1", "none"]);
/** 可选主题色(渲染层按这个名字取调色板, 这里只做白名单校验)。 */
const ACCENTS = new Set(["cyan", "blue", "violet", "green", "amber", "pink", "red"]);
/** 窗口按钮风格。 */
const CHROME_STYLES = new Set(["mac", "windows"]);

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 端口的取值规则与轮询间隔不同: 越界视为"填错了", 直接回退默认值,
 * 而不是收敛到 1 或 65535 这种看起来合法、实际不可用的端口。
 */
function portOr(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function sanitizeGateway(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return DEFAULT_CONFIG.gateway;
  if (!/^[A-Za-z0-9._:\-/]+$/.test(text)) return DEFAULT_CONFIG.gateway;
  return text.slice(0, 200);
}

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

/** 原子写: 先写临时文件再 rename, 避免断电/崩溃留下半截 JSON。 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 读 JSON 文件。
 *
 * 必须容忍 UTF-8 BOM: Windows 记事本「另存为 UTF-8」会写入 BOM, 而 JSON.parse
 * 遇到 BOM 会直接抛错 —— 那样用户手工改过的配置/账号会被静默丢弃并回退默认值,
 * 是个很难排查的坑(这个 bug 就是联调时真实撞到的)。
 */
function readJsonFile(file) {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

class Store {
  /**
   * @param {{dir: string, safeStorage?: any, logger?: any}} options
   */
  constructor(options = {}) {
    this.dir = options.dir;
    this.safeStorage = options.safeStorage || null;
    this.logger = options.logger || null;
    this.configFile = path.join(this.dir, "config.json");
    this.accountsFile = path.join(this.dir, "accounts.json");
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* ignore */
    }
    this._config = this._loadConfig();
    this._data = this._loadAccounts();
  }

  // ------------------------------------------------------------ 加密

  get encryptionAvailable() {
    try {
      return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  _encrypt(plain) {
    if (!plain || !this.encryptionAvailable) return "";
    try {
      return this.safeStorage.encryptString(plain).toString("base64");
    } catch (err) {
      this._log("warn", `凭据加密失败: ${err.message}`);
      return "";
    }
  }

  _decrypt(encoded) {
    if (!encoded || !this.encryptionAvailable) return "";
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch (err) {
      this._log("warn", `凭据解密失败(可能换了系统账户或机器): ${err.message}`);
      return "";
    }
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === "function") this.logger[level](message);
  }

  // ------------------------------------------------------------ 读写

  _loadConfig() {
    let raw = {};
    try {
      raw = readJsonFile(this.configFile);
    } catch {
      raw = {};
    }
    return this._normalize({ ...DEFAULT_CONFIG, ...raw });
  }

  _loadAccounts() {
    let raw = { activeId: null, accounts: [] };
    try {
      const parsed = readJsonFile(this.accountsFile);
      if (parsed && Array.isArray(parsed.accounts)) raw = parsed;
    } catch {
      /* 首次运行 */
    }
    const accounts = raw.accounts
      .filter((a) => a && typeof a.username === "string" && a.username.trim())
      .map((a) => ({
        id: typeof a.id === "string" && a.id ? a.id : newId(),
        username: String(a.username).trim(),
        label: typeof a.label === "string" ? a.label : "",
        secret: typeof a.secret === "string" ? a.secret : "",
        autoLogin: !!a.autoLogin,
        lastUsed: Number(a.lastUsed) || 0,
      }));
    const activeId = accounts.some((a) => a.id === raw.activeId)
      ? raw.activeId
      : accounts.length
        ? accounts[accounts.length - 1].id
        : null;
    return { activeId, accounts };
  }

  _normalize(config) {
    return {
      gateway: sanitizeGateway(config.gateway),
      portalPort: portOr(config.portalPort, DEFAULT_CONFIG.portalPort),
      statusPort: portOr(config.statusPort, DEFAULT_CONFIG.statusPort),
      autoLogin: !!config.autoLogin,
      autoLaunch: !!config.autoLaunch,
      remember: !!config.remember,
      autoReconnect: !!config.autoReconnect,
      startMinimized: !!config.startMinimized,
      pollInterval: clampInt(config.pollInterval, 5, 600, DEFAULT_CONFIG.pollInterval),
      theme: THEMES.has(config.theme) ? config.theme : DEFAULT_CONFIG.theme,
      material: MATERIALS.has(config.material) ? config.material : DEFAULT_CONFIG.material,
      accent: ACCENTS.has(config.accent) ? config.accent : DEFAULT_CONFIG.accent,
      chromeStyle: CHROME_STYLES.has(config.chromeStyle)
        ? config.chromeStyle
        : DEFAULT_CONFIG.chromeStyle,
      passwordAlgo: PASSWORD_ALGOS.has(config.passwordAlgo)
        ? config.passwordAlgo
        : DEFAULT_CONFIG.passwordAlgo,
      infoFormat: INFO_FORMATS.has(config.infoFormat)
        ? config.infoFormat
        : DEFAULT_CONFIG.infoFormat,
      lastUsername: String(config.lastUsername || "").slice(0, 64),
    };
  }

  _saveConfig() {
    try {
      writeJsonAtomic(this.configFile, this._config);
    } catch (err) {
      this._log("error", `保存配置失败: ${err.message}`);
    }
  }

  _saveAccounts() {
    try {
      writeJsonAtomic(this.accountsFile, this._data);
    } catch (err) {
      this._log("error", `保存账号失败: ${err.message}`);
    }
  }

  // ------------------------------------------------------------ 配置

  get config() {
    return { ...this._config };
  }

  /** 局部更新配置, 返回更新后的完整配置。 */
  updateConfig(patch = {}) {
    this._config = this._normalize({ ...this._config, ...patch });
    this._saveConfig();
    this._log("info", `配置已更新: ${Object.keys(patch).join(", ") || "(无字段)"}`);
    return this.config;
  }

  /** 恢复默认配置(保留账号)。 */
  resetConfig() {
    this._config = { ...DEFAULT_CONFIG, lastUsername: this._config.lastUsername };
    this._saveConfig();
    this._log("info", "配置已恢复默认");
    return this.config;
  }

  // ------------------------------------------------------------ 账号

  /** 对外暴露的账号列表(不含密文)。 */
  accounts() {
    return this._data.accounts.map((a) => ({
      id: a.id,
      username: a.username,
      label: a.label,
      hasPassword: !!a.secret && this.encryptionAvailable,
      autoLogin: a.autoLogin,
      lastUsed: a.lastUsed,
    }));
  }

  get activeAccountId() {
    return this._data.activeId;
  }

  get activeAccount() {
    return this._data.accounts.find((a) => a.id === this._data.activeId) || null;
  }

  findById(id) {
    return this._data.accounts.find((a) => a.id === id) || null;
  }

  findByUsername(username) {
    const user = String(username || "").trim();
    return this._data.accounts.find((a) => a.username === user) || null;
  }

  /**
   * 新增或更新账号。
   * @param {{id?: string, username: string, label?: string, password?: string, autoLogin?: boolean}} input
   * @returns {{ok: boolean, message: string, id?: string}}
   */
  saveAccount(input = {}) {
    const username = String(input.username || "").trim();
    if (!username) return { ok: false, message: "请填写学号" };
    const password = typeof input.password === "string" ? input.password : "";

    let account = input.id ? this.findById(input.id) : null;
    if (!account) account = this.findByUsername(username);

    if (!account) {
      account = {
        id: newId(),
        username,
        label: String(input.label || "").trim(),
        secret: "",
        autoLogin: false,
        lastUsed: Date.now(),
      };
      this._data.accounts.push(account);
    }

    account.username = username;
    if (input.label !== undefined) account.label = String(input.label || "").trim();
    if (input.autoLogin !== undefined) {
      // 同一时刻只允许一个账号被标记为自动登录, 避免启动时反复切换
      if (input.autoLogin) {
        for (const a of this._data.accounts) a.autoLogin = false;
      }
      account.autoLogin = !!input.autoLogin;
    }
    if (password) {
      const secret = this._encrypt(password);
      if (!secret) {
        return {
          ok: false,
          message: "系统凭据加密不可用，无法安全保存密码",
          id: account.id,
        };
      }
      account.secret = secret;
    }
    if (!account.secret && !password) {
      // 允许只保存学号(不记住密码)
    }
    this._data.activeId = account.id;
    this._config.lastUsername = username;
    this._saveConfig();
    this._saveAccounts();
    this._log("info", `账号已保存: ${username}${password ? "(含密码)" : ""}`);
    return { ok: true, message: password ? "账号与密码已保存" : "账号已保存", id: account.id };
  }

  removeAccount(id) {
    const idx = this._data.accounts.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false, message: "账号不存在" };
    const [removed] = this._data.accounts.splice(idx, 1);
    if (this._data.activeId === id) {
      this._data.activeId = this._data.accounts.length
        ? this._data.accounts[this._data.accounts.length - 1].id
        : null;
    }
    this._saveAccounts();
    this._log("info", `账号已删除: ${removed.username}`);
    return { ok: true, message: "账号已删除" };
  }

  selectAccount(id) {
    const account = this.findById(id);
    if (!account) return { ok: false, message: "账号不存在" };
    this._data.activeId = id;
    account.lastUsed = Date.now();
    this._config.lastUsername = account.username;
    this._saveConfig();
    this._saveAccounts();
    return { ok: true, message: "已切换账号", activeAccountId: id };
  }

  /** 仅用于填入输入框, 需要界面显式索取。 */
  revealPassword(id) {
    const account = this.findById(id);
    if (!account) return { error: "账号不存在" };
    if (!account.secret) return { password: "", error: "该账号未保存密码" };
    const password = this._decrypt(account.secret);
    if (!password) return { error: "密码解密失败" };
    return { password };
  }

  /** 内部使用: 取明文密码用于登录。 */
  getPassword(id) {
    const account = this.findById(id);
    if (!account || !account.secret) return "";
    return this._decrypt(account.secret);
  }

  /** 标记账号最近使用时间。 */
  touch(id) {
    const account = this.findById(id);
    if (!account) return;
    account.lastUsed = Date.now();
    this._saveAccounts();
  }

  /** 把"记住密码"开关作用于某账号: 关闭时清除已保存的密文。 */
  forgetPassword(id) {
    const account = this.findById(id);
    if (!account) return;
    account.secret = "";
    this._saveAccounts();
    this._log("info", `已清除保存的密码: ${account.username}`);
  }
}

module.exports = { Store, DEFAULT_CONFIG };
