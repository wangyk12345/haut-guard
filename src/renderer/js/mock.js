/**
 * mock.js —— 预览用假数据桩。
 *
 * 仅当 `window.haut` 不存在时启用 (真实环境由 src/main/preload.js 注入)。
 * 用 `location.hash` 里的 `scenario` 决定初始快照形态, `theme` 决定配色:
 *   index.html#scenario=online&theme=light
 *
 * 本文件同时兼容 ES module (`import { createMockBridge }`) 与 CommonJS
 * (`require`, 供 tools/preview-preload.js 在 preload 里注入), 保持单一数据源。
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.__hautMock = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- 工具 */

  /** 解析 location.hash -> { scenario, theme } */
  function parseHash() {
    var out = { scenario: "offline", theme: "" };
    try {
      var raw = (typeof location !== "undefined" && location.hash) ? String(location.hash) : "";
      if (raw.charAt(0) === "#") raw = raw.slice(1);
      if (!raw) return out;
      raw.split("&").forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf("=");
        var k = i < 0 ? pair : pair.slice(0, i);
        var v = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1));
        if (k === "scenario") out.scenario = v;
        else if (k === "theme") out.theme = v;
      });
    } catch (e) { /* 忽略: hash 不可用时走默认场景 */ }
    return out;
  }

  var BOOT = Date.now();

  function p2(n) { return n < 10 ? "0" + n : String(n); }

  /** 生成 "HH:MM:SS" 形式的日志时间戳 */
  function stamp(offsetSec) {
    var d = new Date(BOOT + offsetSec * 1000);
    return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
  }

  /* ------------------------------------------------------- 场景初始状态 */

  var ACC_PRIMARY = {
    id: "acc-1", username: "2310121042", label: "我的校园网",
    hasPassword: true, autoLogin: true, lastUsed: BOOT - 3600e3,
  };
  var ACC_SECOND = {
    id: "acc-2", username: "2310121088", label: "室友-张",
    hasPassword: true, autoLogin: false, lastUsed: BOOT - 86400e3 * 5,
  };
  var ACC_THIRD = {
    id: "acc-3", username: "2023110107", label: "实验室工位",
    hasPassword: false, autoLogin: false, lastUsed: BOOT - 86400e3 * 21,
  };

  /** 默认配置 (与主进程 store 的默认值保持一致) */
  function baseConfig() {
    return {
      gateway: "172.16.154.130",
      portalPort: 69,
      statusPort: 80,
      autoLogin: true,
      autoLaunch: false,
      remember: true,
      autoReconnect: true,
      startMinimized: false,
      pollInterval: 5,
      theme: "dark",
      material: "acrylic",
      // 主题色 (强调色 + 氛围光斑) 与窗口按钮风格: 与主进程 store 的默认值一致
      accent: "cyan",
      chromeStyle: "mac",
      passwordAlgo: "srun3",
      // 真机实测本网关可用组合: srun3 + srbx1 (「标准」); 旧组合 srun3+srun3 为「旧版客户端」
      infoFormat: "srbx1",
    };
  }

  /** 默认 (离线 / 从未查询) 连接态 */
  function baseConn() {
    return {
      state: "offline", online: false,
      userName: "", ip: "",
      // 本次会话 (界面「本次流量」「在线时长」用这两个)
      sessionBytes: 0, sessionSeconds: 0,
      bytesIn: 0, bytesOut: 0,
      // 账号累计 (次要位置展示)
      sumBytes: 0, sumSeconds: 0,
      balance: null,
      addTime: 0, keepaliveTime: 0,
      gatewayVer: "",
      message: "", lastChecked: 0,
      reconnecting: false, nextRetryIn: 0,
    };
  }

  function onlineConn(extra) {
    var conn = baseConn();
    conn.state = "online";
    conn.online = true;
    conn.userName = "2310121042";
    conn.ip = "10.24.118.77";
    // 本次会话: ~354 MB, 47 分 29 秒
    conn.bytesIn = 320253309;
    conn.bytesOut = 51417663;
    conn.sessionBytes = conn.bytesIn + conn.bytesOut;
    conn.sessionSeconds = 2849;
    // 账号累计: 123.24 GB / 7 天 10 小时
    conn.sumBytes = 132329343471;
    conn.sumSeconds = 644217;
    conn.balance = 20;
    conn.addTime = BOOT - conn.sessionSeconds * 1000;
    conn.keepaliveTime = Date.now();
    conn.gatewayVer = "SRun3K · 1.1.4";
    conn.message = "认证成功, 已获得网络访问权限";
    conn.lastChecked = BOOT - 2000;
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) conn[k] = extra[k];
    return conn;
  }

  /**
   * 依据场景构造初始 { conn, accounts, activeAccountId, config }。
   * 10 个场景: offline / connecting / online / login-fail / reconnecting /
   *           accounts / settings / logs / light / first-run
   * 另有 pass-lost: 已保存密码但本地无法解密 (验证密码框的静默降级)。
   */
  function makeScenario(name) {
    var conn = baseConn();
    var accounts = [ACC_PRIMARY, ACC_SECOND, ACC_THIRD];
    var active = "acc-1";
    var config = baseConfig();
    /** 由 app.js 读取的一次性界面意图 */
    var intent = { openAccountMenu: false, openSheet: "", inlineError: "", showNotice: false, scrollTo: "" };

    switch (name) {
      case "connecting":
        conn.state = "connecting";
        conn.message = "正在向网关提交认证请求…";
        conn.lastChecked = BOOT - 400;
        break;

      case "online":
        conn = onlineConn();
        break;

      case "light":
        conn = onlineConn();
        config.theme = "light";
        break;

      case "login-fail":
        conn.state = "error";
        conn.message = "账号或密码错误，请检查后重试 (E2531)";
        conn.lastChecked = BOOT - 1200;
        intent.inlineError = "认证失败：账号或密码错误 (E2531)";
        intent.showNotice = true;
        break;

      case "reconnecting":
        conn.state = "offline";
        conn.reconnecting = true;
        conn.nextRetryIn = 18;
        conn.message = "网络连接已断开，正在自动重连…";
        conn.lastChecked = BOOT - 6000;
        conn.gatewayVer = "SRun3K · 1.1.4";
        break;

      case "accounts":
        intent.openAccountMenu = true;
        conn.lastChecked = BOOT - 3000;
        conn.message = "上次查询：当前离线";
        break;

      case "settings":
        intent.openSheet = "settings";
        config.theme = "light";
        conn = onlineConn();
        break;

      case "settings-legacy":
        // 「旧版（排障用）」协议: 设置面板该行下方应出现"本网关实测不支持"的风险警告
        intent.openSheet = "settings";
        config.theme = "light";
        config.infoFormat = "srun3";
        conn = onlineConn();
        break;

      case "logs":
        intent.openSheet = "logs";
        conn.state = "error";
        conn.message = "认证被拒绝：IP 已被其他账号占用 (E2532)";
        conn.lastChecked = BOOT - 900;
        intent.inlineError = "认证失败：IP 已被其他账号占用 (E2532)";
        break;

      case "first-run":
        accounts = [];
        active = null;
        config.autoLogin = false;
        config.remember = false;
        conn.message = "";
        intent.openAccountMenu = false;
        break;

      case "pass-lost":
        // 账号标记为「已保存密码」, 但主进程取不回明文 (换了系统账户 / DPAPI 解不开)。
        // 期望: 密码框保持空 + placeholder 提示重新输入, 且不弹任何错误。
        config.remember = true;
        conn.lastChecked = BOOT - 1500;
        conn.message = "上次查询：当前离线";
        break;

      /* ---------- 新增: 窗口按钮风格 ---------- */
      case "chrome-windows":
        // Windows 模式: 右上角 最小化 ─ / 关闭 ✕, 左上角不再显示红黄绿
        config.chromeStyle = "windows";
        conn.lastChecked = BOOT - 1200;
        conn.message = "上次查询：当前离线";
        break;

      /* ---------- 新增: 主题色预设 ---------- */
      case "accent-violet":
        // 离线态: 主按钮是"强调色渐变"(在线时它变成红色的断开键), 更能看出主题色换了
        config.accent = "violet";
        conn.message = "";
        conn.lastChecked = 0;
        break;

      case "accent-pink":
        config.accent = "pink";
        conn = onlineConn();
        break;

      case "accent-green":
        config.accent = "green";
        config.theme = "light";
        conn = onlineConn();
        break;

      case "accent-amber":
        config.accent = "amber";
        conn = onlineConn();
        break;

      /* 设置面板里的色板: 由 harness 依次点击色块验证"切换后 CSS 变量确实变化"。
         起始色特意不是 cyan (否则点第一个色块等于没切换, 测不出"变化")。 */
      case "settings-accent":
        intent.openSheet = "settings";
        config.theme = "light";
        config.accent = "blue";
        conn = onlineConn();
        break;

      /* 第三轮: 「记住密码」破坏性操作 —— 面板里那个开关的同款确认流程 */
      case "sheet-remember":
      case "sheet-remember-ask":
        intent.openSheet = "settings";
        conn = onlineConn();
        break;

      case "offline":
      default:
        conn.message = "";
        conn.lastChecked = 0;
        /* 开关条视觉自检: 刻意造出"两开两关"的混合状态 —— 记住密码/自动登录 开
           (active 账号 acc-1 的 autoLogin 为 true), 断线重连/开机自启 关。
           这样 01-offline-dark 与开关条特写图能直接证明"开"与"关"两种外观的差别。 */
        config.autoReconnect = false;
        config.autoLaunch = false;
        break;
    }

    return { conn: conn, accounts: accounts, activeAccountId: active, config: config, intent: intent };
  }

  /* ------------------------------------------------------------ 日志样本 */

  var LOG_SAMPLES = [
    [-42, "info", "HAUT Guard 启动, 版本 1.0.0"],
    [-41, "info", "配置已载入: 网关 172.16.154.130:69, 轮询 5s"],
    [-40, "info", "账号存储已解锁, 共 2 个账号"],
    [-33, "info", "开始查询在线状态 (GET /cgi-bin/rad_user_info)"],
    [-32, "info", "网关响应 200, 当前未认证"],
    [-28, "info", "提交认证: 用户名 2310121042, 算法 srun3"],
    [-27, "info", "回调 callback 已收到, 解析 JSON 成功"],
    [-26, "info", "认证成功, 会话已建立, 分配 IP 10.24.118.77"],
    [-24, "info", "开始流量统计, 采样间隔 5s"],
    [-12, "warn", "状态轮询耗时偏高: 1842ms (阈值 1500ms)"],
    [-6, "warn", "网关返回心跳超时, 准备重试 (第 1 次)"],
    [-3, "error", "认证被拒绝: IP 已被其他账号占用 (E2532)"],
    [-1, "info", "进入自动重连倒计时, 18 秒后重试"],
  ];

  function makeLogs() {
    return LOG_SAMPLES.map(function (row) {
      return { ts: stamp(row[0]), level: row[1], message: row[2] };
    });
  }

  function makeLogTexts() {
    return LOG_SAMPLES.map(function (row) {
      return "[" + stamp(row[0]) + "] [" + row[1].toUpperCase() + "] " + row[2];
    });
  }

  /* --------------------------------------------------------- bridge 实现 */

  function createMockBridge() {
    var hash = parseHash();
    var scenario = hash.scenario || "offline";
    var initial = makeScenario(scenario);

    var state = {
      conn: initial.conn,
      accounts: initial.accounts,
      activeAccountId: initial.activeAccountId,
      config: initial.config,
      rate: { down: 0, up: 0, total: 0 },
      logs: makeLogs(),
    };

    /** 预览用的明文密码表 (真实环境由主进程 DPAPI 加密保存) */
    var PASSWORDS = { "acc-1": "haut@2024", "acc-2": "zhang@1234" };

    /** pass-lost 场景: 账号元数据说"有密码", 但解密一定失败, 用来验证静默降级 */
    var REVEAL_FAILS = scenario === "pass-lost" ? { "acc-1": true } : {};

    var listeners = { state: [], rate: [], log: [], toast: [] };
    var timers = [];
    var paused = false;
    var logsCleared = false;

    /** 桥接层收到的写操作 (预览自检: "点一次开关是不是只写了一次 remember") */
    var CALLS = { configUpdate: [], accountsSave: [], forget: [] };

    function later(fn, ms) {
      var id = setTimeout(function () {
        timers = timers.filter(function (t) { return t !== id; });
        if (!paused) fn();
      }, ms);
      timers.push(id);
      return id;
    }

    function repeat(fn, ms) {
      var id = setInterval(function () { if (!paused) fn(); }, ms);
      timers.push(id);
      return id;
    }

    function emit(channel, payload) {
      (listeners[channel] || []).slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { /* 单个订阅者异常不影响其它订阅者 */ }
      });
    }

    function snapshot() {
      return {
        conn: JSON.parse(JSON.stringify(state.conn)),
        rate: {
          down: state.rate.down,
          up: state.rate.up,
          total: state.rate.total,
        },
        config: JSON.parse(JSON.stringify(state.config)),
        accounts: JSON.parse(JSON.stringify(state.accounts)),
        activeAccountId: state.activeAccountId,
        app: {
          version: "1.0.0",
          electron: "44.4.2",
          node: "22.20.0",
          chrome: "142.0.7444.52",
          platform: "win32",
        },
        material: { current: state.config.material, supported: ["acrylic", "mica", "transparent"] },
        logs: { path: "C:\\Users\\WYK\\AppData\\Roaming\\haut-guard\\logs\\haut-guard.log" },
      };
    }

    function pushState() { emit("state", snapshot()); }

    function toast(kind, message) { emit("toast", { kind: kind, message: message }); }

    function findAccount(id) {
      for (var i = 0; i < state.accounts.length; i++) {
        if (state.accounts[i].id === id) return state.accounts[i];
      }
      return null;
    }

    function addLog(level, message) {
      var row = { ts: stamp((Date.now() - BOOT) / 1000), level: level, message: message };
      state.logs.push(row);
      if (state.logs.length > 400) state.logs.splice(0, state.logs.length - 400);
      emit("log", row);
    }

    /* ---- 速率模拟: 每 5 秒推一次, 数值随机波动 ---- */
    var phase = Math.random() * 6.28;
    function tickRate() {
      if (!state.conn.online) {
        state.rate = { down: 0, up: 0, total: 0 };
        emit("rate", { t: Date.now(), down: 0, up: 0 });
        return;
      }
      phase += 0.55 + Math.random() * 0.5;
      var base = scenario === "online" || scenario === "settings" || scenario === "light" ? 780 * 1024 : 420 * 1024;
      var down = Math.max(0, base * (0.62 + 0.46 * Math.sin(phase)) + (Math.random() - 0.42) * 190 * 1024);
      var up = Math.max(0, down * (0.10 + Math.random() * 0.16) + Math.random() * 22 * 1024);
      state.rate = { down: down, up: up, total: down + up };
      // 本次会话与账号累计同步增长, 让「本次流量/在线时长/累计」都活起来
      state.conn.bytesIn += down * 5;
      state.conn.bytesOut += up * 5;
      state.conn.sessionBytes = state.conn.bytesIn + state.conn.bytesOut;
      state.conn.sessionSeconds += 5;
      state.conn.sumBytes += (down + up) * 5;
      state.conn.sumSeconds += 5;
      emit("rate", { t: Date.now(), down: down, up: up });
    }

    /* ---- 在线场景: 回放 60 点历史, 让曲线在截图前成形 ---- */
    function replayHistory() {
      if (!state.conn.online) return;
      var TOTAL = 60;
      var emitPoint = function (i) {
        if (i >= TOTAL) { tickRate(); return; }
        var a = i * 0.46;
        var base = 620 * 1024;
        var down = Math.max(24 * 1024, base * (0.58 + 0.44 * Math.sin(a)) + (Math.sin(i * 2.7) * 130 * 1024) + Math.random() * 90 * 1024);
        var up = Math.max(6 * 1024, down * (0.12 + 0.10 * Math.abs(Math.sin(i * 0.7))) + Math.random() * 20 * 1024);
        state.rate = { down: down, up: up, total: down + up };
        emit("rate", { t: BOOT - (TOTAL - i) * 1000, down: down, up: up });
        later(function () { emitPoint(i + 1); }, 105);
      };
      emitPoint(0);
    }

    /* ---- 重连倒计时 ---- */
    if (state.conn.reconnecting) {
      repeat(function () {
        if (!state.conn.reconnecting) return;
        state.conn.nextRetryIn = Math.max(0, state.conn.nextRetryIn - 1);
        if (state.conn.nextRetryIn === 0) {
          state.conn.reconnecting = false;
          state.conn.state = "connecting";
          state.conn.message = "正在向网关提交认证请求…";
        }
        pushState();
      }, 1000);
    }

    if (state.conn.state === "connecting") {
      later(function () {
        state.conn = onlineConn();
        // 刚连上: 本次会话从零开始, 账号累计保留
        state.conn.bytesIn = 18 * 1024 * 1024;
        state.conn.bytesOut = 2 * 1024 * 1024;
        state.conn.sessionBytes = state.conn.bytesIn + state.conn.bytesOut;
        state.conn.sessionSeconds = 42;
        state.conn.addTime = Date.now() - 42000;
        pushState();
        addLog("info", "认证成功, 会话已建立");
        toast("success", "已连接校园网");
        replayHistory();
      }, 2600);
    }

    /* ---- 状态轮询 (模拟主进程 5 秒一次的推送) ---- */
    repeat(function () {
      if (state.conn.online) {
        state.conn.sessionSeconds = Math.max(0, Math.floor((Date.now() - state.conn.addTime) / 1000));
        state.conn.keepaliveTime = Date.now();
        state.conn.lastChecked = Date.now();
        pushState();
      }
    }, 5000);

    later(function () { tickRate(); }, 260);
    repeat(tickRate, 5000);
    if (state.conn.online) replayHistory();

    /* ------------------------------------------------------------ API */

    var api = {
      /* 预览专用: 让 app.js 知道该摆出哪种界面形态 */
      __mock: true,
      __scenario: scenario,
      __intent: initial.intent,

      getSnapshot: function () {
        return new Promise(function (res) { later(function () { res(snapshot()); }, 60); });
      },

      auth: {
        login: function (payload) {
          payload = payload || {};
          return new Promise(function (res) {
            state.conn.state = "connecting";
            state.conn.message = "正在向网关提交认证请求…";
            state.conn.reconnecting = false;
            pushState();
            later(function () {
              var acc = findAccount(state.activeAccountId);
              var user = payload.username || (acc && acc.username) || "";
              // 固定规则: 密码为 "error" 或学号以 0 结尾时报 E2531, 便于演示失败态
              if (payload.password === "error") {
                state.conn.state = "error";
                state.conn.online = false;
                state.conn.message = "账号或密码错误，请检查后重试 (E2531)";
                state.conn.lastChecked = Date.now();
                pushState();
                addLog("error", "认证被拒绝: 账号或密码错误 (E2531)");
                toast("error", "认证失败：账号或密码错误 (E2531)");
                res({ ok: false, code: "E2531", message: "账号或密码错误，请检查后重试" });
                return;
              }
              state.conn = onlineConn({ userName: user || "2310121042" });
              // 新会话: 本次流量/时长从零开始, 账号累计保留
              state.conn.bytesIn = 0;
              state.conn.bytesOut = 0;
              state.conn.sessionBytes = 0;
              state.conn.sessionSeconds = 0;
              state.conn.addTime = Date.now();
              pushState();
              addLog("info", "认证成功, 会话已建立");
              toast("success", "已连接校园网");
              replayHistory();
              res({ ok: true, message: "连接成功" });
            }, 900);
          });
        },

        logout: function () {
          return new Promise(function (res) {
            later(function () {
              state.conn.online = false;
              state.conn.state = "offline";
              state.conn.userName = "";
              state.conn.ip = "";
              // 本次会话清零, 账号累计保留 (与真实网关行为一致)
              state.conn.bytesIn = 0;
              state.conn.bytesOut = 0;
              state.conn.sessionBytes = 0;
              state.conn.sessionSeconds = 0;
              state.conn.addTime = 0;
              state.conn.message = "已断开连接";
              state.conn.lastChecked = Date.now();
              state.rate = { down: 0, up: 0, total: 0 };
              pushState();
              addLog("info", "注销成功, 已断开连接");
              toast("success", "已断开连接");
              res({ ok: true, message: "已断开" });
            }, 420);
          });
        },

        refresh: function () {
          return new Promise(function (res) {
            later(function () {
              state.conn.lastChecked = Date.now();
              if (!state.conn.online) state.conn.message = "当前未认证, 网关可访问";
              pushState();
              toast("info", state.conn.online ? "已在线" : "当前离线");
              res({ ok: true, message: state.conn.online ? "在线" : "离线" });
            }, 380);
          });
        },
      },

      accounts: {
        list: function () {
          return new Promise(function (res) { later(function () { res(JSON.parse(JSON.stringify(state.accounts))); }, 40); });
        },

        save: function (input) {
          input = input || {};
          return new Promise(function (res) {
            later(function () {
              var username = String(input.username || "").trim();
              if (!username) { res({ ok: false, message: "学号不能为空" }); return; }
              var target = input.id ? findAccount(input.id) : null;
              if (target) {
                target.username = username;
                if (input.label !== undefined) target.label = input.label;
                if (input.autoLogin !== undefined) target.autoLogin = !!input.autoLogin;
                if (input.password) target.hasPassword = true;
              } else {
                target = {
                  id: "acc-" + Date.now().toString(36),
                  username: username,
                  label: input.label || "",
                  hasPassword: !!input.password,
                  autoLogin: !!input.autoLogin,
                  lastUsed: Date.now(),
                };
                state.accounts.push(target);
              }
              if (input.password) PASSWORDS[target.id] = input.password;
              if (!state.activeAccountId) state.activeAccountId = target.id;
              pushState();
              addLog("info", "账号已保存: " + username);
              toast("success", "账号已保存");
              res({ ok: true, message: "已保存", accounts: JSON.parse(JSON.stringify(state.accounts)) });
            }, 260);
          });
        },

        remove: function (id) {
          return new Promise(function (res) {
            later(function () {
              var before = state.accounts.length;
              state.accounts = state.accounts.filter(function (a) { return a.id !== id; });
              if (state.accounts.length === before) { res({ ok: false, message: "账号不存在" }); return; }
              if (state.activeAccountId === id) {
                state.activeAccountId = state.accounts.length ? state.accounts[0].id : null;
              }
              pushState();
              toast("success", "账号已删除");
              res({ ok: true, message: "已删除" });
            }, 220);
          });
        },

        select: function (id) {
          return new Promise(function (res) {
            later(function () {
              if (!findAccount(id)) { res({ ok: false, message: "账号不存在" }); return; }
              state.activeAccountId = id;
              var acc = findAccount(id);
              acc.lastUsed = Date.now();
              pushState();
              res({ ok: true, message: "已切换", activeAccountId: id });
            }, 160);
          });
        },

        reveal: function (id) {
          return new Promise(function (res) {
            later(function () {
              if (REVEAL_FAILS[id]) { res({ error: "本地凭据无法解密，请重新输入密码" }); return; }
              if (PASSWORDS[id]) { res({ password: PASSWORDS[id] }); return; }
              res({ error: "本地未保存该账号的明文密码" });
            }, 300);
          });
        },
      },

      config: {
        update: function (patch) {
          // 预览自检用: 记录每一次 config.update(补丁原文 + 时间), 用来断言"点一次只写一次"
          try { CALLS.configUpdate.push({ patch: JSON.parse(JSON.stringify(patch || {})), at: Date.now() }); } catch (e) { /* 忽略 */ }
          return new Promise(function (res) {
            later(function () {
              var beforeRemember = !!state.config.remember;
              if (patch) for (var k in patch) {
                if (Object.prototype.hasOwnProperty.call(patch, k)) state.config[k] = patch[k];
              }
              // 与 src/main/main.js 的 config:update 对齐: 关掉"记住密码"会**立刻销毁**已存密码,
              // 且不可恢复。预览里照样模拟, 这样自检能证明"取消时不会误删"。
              if (patch && patch.remember === false && beforeRemember) {
                PASSWORDS = {};
                state.accounts.forEach(function (a) { a.hasPassword = false; });
                CALLS.forget.push({ at: Date.now(), cleared: state.accounts.length });
              }
              pushState();
              res(JSON.parse(JSON.stringify(state.config)));
            }, 180);
          });
        },
        reset: function () {
          return new Promise(function (res) {
            later(function () {
              state.config = baseConfig();
              pushState();
              toast("info", "设置已恢复默认");
              res({ ok: true, config: JSON.parse(JSON.stringify(state.config)) });
            }, 200);
          });
        },
      },

      diag: {
        run: function () {
          return new Promise(function (res) {
            later(function () {
              var items = [
                { name: "网关可达性", ok: true, detail: "172.16.154.130 应答, 往返 12ms", ms: 12 },
                { name: "Portal 端口 (69)", ok: true, detail: "TCP 69 已开放", ms: 8 },
                { name: "Status 端口 (80)", ok: true, detail: "HTTP 200, 网关版本 SRun3K 1.1.4", ms: 46 },
                { name: "本机网络接口", ok: true, detail: "以太网 10.24.118.77 / 24, 网关 10.24.118.1", ms: 3 },
                { name: "凭据存储", ok: true, detail: "DPAPI 加解密自检通过", ms: 21 },
                { name: "DNS 解析", ok: false, detail: "www.baidu.com 解析超时 (未认证时属正常)", ms: 2000 },
              ];
              pushState();
              res({ ok: items.every(function (i) { return i.ok; }), items: items });
            }, 700);
          });
        },
      },

      logs: {
        read: function (lines) {
          return new Promise(function (res) {
            later(function () {
              var all = logsCleared ? [] : makeLogTexts();
              var n = lines || 300;
              res({ path: snapshot().logs.path, lines: all.slice(Math.max(0, all.length - n)) });
            }, 260);
          });
        },
        clear: function () {
          return new Promise(function (res) {
            later(function () {
              state.logs = [];
              logsCleared = true;
              toast("success", "日志已清空");
              res({ ok: true });
            }, 200);
          });
        },
        openFolder: function () {
          return new Promise(function (res) {
            later(function () { toast("info", "已在文件管理器中打开日志目录"); res({ ok: true }); }, 150);
          });
        },
      },

      app: {
        info: function () {
          return new Promise(function (res) {
            later(function () {
              var s = snapshot();
              res({
                version: s.app.version, electron: s.app.electron, node: s.app.node,
                chrome: s.app.chrome, platform: s.app.platform,
                material: state.config.material, materialSupported: true,
              });
            }, 120);
          });
        },
        setMaterial: function (material) {
          return new Promise(function (res) {
            later(function () {
              state.config.material = material;
              pushState();
              res({ ok: true, material: material });
            }, 200);
          });
        },
        quit: function () { return Promise.resolve({ ok: true }); },
      },

      win: {
        minimize: function () { return Promise.resolve({ ok: true }); },
        close: function () { return Promise.resolve({ ok: true }); },
        hide: function () { return Promise.resolve({ ok: true }); },
        beginDrag: function () { /* 预览无需拖动 */ },
      },

      /** 订阅推送, 返回取消订阅函数 */
      on: function (channel, handler) {
        if (!listeners[channel]) throw new Error("未知的推送频道: " + channel);
        if (typeof handler !== "function") throw new Error("handler 必须是函数");
        listeners[channel].push(handler);
        return function () {
          listeners[channel] = listeners[channel].filter(function (fn) { return fn !== handler; });
        };
      },

      /** 预览专用: 冻结/恢复所有模拟定时器, 便于截图时画面稳定 */
      __pause: function (v) {
        paused = !!v;
        if (!paused) return;
        timers.forEach(function (id) { clearTimeout(id); clearInterval(id); });
        timers = [];
      },

      /** 预览自检专用: 桥接层收到的所有写操作 (config.update / accounts.save ...) */
      __calls: function () {
        return JSON.parse(JSON.stringify(CALLS));
      },
      __resetCalls: function () {
        CALLS.configUpdate = [];
        CALLS.accountsSave = [];
        CALLS.forget = [];
      },
    };

    // 暴露给 app.js 用于场景化界面摆位 (仅预览存在)
    try {
      if (typeof window !== "undefined") {
        window.__hautScenario = scenario;
        window.__hautIntent = initial.intent;
        window.__hautMockPause = api.__pause;
      }
    } catch (e) { /* 忽略 */ }

    return api;
  }

  return { createMockBridge: createMockBridge, parseHash: parseHash };
});
