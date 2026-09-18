/**
 * main.js —— Electron 主进程。
 *
 * 职责: 窗口与窗口材质、系统托盘、开机自启、配置与凭据存储的 IPC 出口、
 *       把 Monitor 的状态推送给渲染层。
 *
 * 渲染层只能通过 preload.js 暴露的 `window.haut` 与本进程通信
 * (contextIsolation 开启, nodeIntegration 关闭, 不开启 sandbox 是因为
 *  preload 需要 require electron 的 ipcRenderer/contextBridge)。
 */
"use strict";

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  shell,
  safeStorage,
} = require("electron");

const { Logger } = require("./logger");
const { Store } = require("./store");
const { Monitor } = require("./monitor");
const { runDiagnostics } = require("./diag");

const IS_DEV = process.argv.includes("--dev");
const START_HIDDEN_ARG = process.argv.includes("--hidden");
/**
 * 窗口比"面板"大一圈, 这圈透明边距专门用来放 CSS 投影。
 *
 * 为什么需要它: 透明窗口 + CSS 圆角时, 圆角之外是完全透明的 —— 背后是什么就露出
 * 什么。如果背后恰好是个白色窗口, 四个角看起来就是"白角", 像是样式没生效。
 * 留出边距并给面板加投影之后, 窗口读起来才像一张悬浮的卡片(和 macOS 窗口一样)。
 */
const WINDOW_MARGIN = 16;
const PANEL_WIDTH = 420;
const PANEL_HEIGHT = 660;
const WINDOW_WIDTH = PANEL_WIDTH + WINDOW_MARGIN * 2;
const WINDOW_HEIGHT = PANEL_HEIGHT + WINDOW_MARGIN * 2;

// ---- 测试用开关: --capture=<路径> [--capture-exit] [--capture-delay=<毫秒>]
// 给自动化联调用。为什么需要它: 系统级截图(截屏)在窗口被其它窗口遮挡时会截到
// 别的内容, 而 webContents.capturePage() 直接取本窗口渲染结果, 不受遮挡影响。
const CAPTURE_ARG = process.argv.find((arg) => arg.startsWith("--capture="));
const CAPTURE_PATH = CAPTURE_ARG ? CAPTURE_ARG.slice("--capture=".length) : "";
const CAPTURE_EXIT = process.argv.includes("--capture-exit");
const CAPTURE_DELAY_MS =
  Number((process.argv.find((arg) => arg.startsWith("--capture-delay=")) || "").split("=")[1]) ||
  4000;

/** @type {Logger} */ let logger;
/** @type {Store} */ let store;
/** @type {Monitor} */ let monitor;
/** @type {BrowserWindow|null} */ let win = null;
/** @type {Tray|null} */ let tray = null;
let currentMaterial = "transparent";
let isQuitting = false;

// ---------------------------------------------------------------- 单实例

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow();
  });
  app.setAppUserModelId("com.hautguard.app");
  app.whenReady().then(bootstrap).catch((err) => {
    // 启动阶段出错也要留下痕迹, 否则用户只看到"闪一下就没了"
    try {
      fs.appendFileSync(
        path.join(os.tmpdir(), "haut-guard-boot-error.log"),
        `${new Date().toISOString()} ${err && err.stack ? err.stack : err}\n`,
        "utf8"
      );
    } catch {
      /* ignore */
    }
    app.quit();
  });
}

// ---------------------------------------------------------------- 资源

/** 运行时图标放在 src/assets 下(打包后仍然可读), build/ 只给安装包用。 */
function assetPath(name) {
  return path.join(__dirname, "..", "assets", name);
}

// ---------------------------------------------------------------- 窗口材质

/**
 * 支持的窗口背景材质。
 *
 * ⚠️ 只支持 "transparent"。原因: 本窗口是 `transparent: true` + `frame: false` 创建的,
 * 圆角完全由 CSS 负责; 而 acrylic/mica 是 DWM 按**整个窗口矩形**绘制的系统材质, 两者
 * 互斥 ——
 *   - 强行设置材质会让 Chromium 离开"分层窗口/逐像素透明"路径, 四个圆角外立刻变成
 *     纯白(就是用户反馈过的"四角发白");
 *   - 即使能显示, 材质也会铺满窗口矩形, 在 CSS 圆角之外露出直角背板。
 * 所以界面上不再提供材质切换, 这里也把可选值收成只有"透明", 任何越界请求都回退为透明。
 */
function supportedMaterials() {
  return ["transparent"];
}

/**
 * 应用窗口背景材质。
 *
 * ⚠️ 这里有个真机踩到的坑: **透明窗口绝不能调用 setBackgroundMaterial("none")**。
 * 在 Windows 上, 一旦给窗口设置过系统背景材质(哪怕是 "none"), Chromium 就会从
 * "分层窗口 + 每像素透明"切换到不透明合成路径, 页面里 CSS 圆角之外的那一圈就变成
 * 纯白 —— 现象就是"应用四个角是白色的"。透明窗口什么都不设才是真透明。
 *
 * 因此: 只有在确实要 acrylic/mica 时才调用; 从材质切回透明时来不及撤销(需要重建窗口),
 * 这时保留 "none" 调用以保证切回来的语义正确, 但会在日志里提示重启。
 */
function applyMaterial(target, material, options = {}) {
  if (!target || target.isDestroyed()) return "transparent";
  const { hadMaterial = false } = options;

  if (material === "transparent" || !supportedMaterials().includes(material)) {
    if (hadMaterial) {
      // 之前设过材质, 必须显式清掉(代价是这一轮圆角可能发白, 重启后恢复)
      try {
        target.setBackgroundMaterial("none");
      } catch {
        /* 老系统不支持, 忽略 */
      }
      logger.warn("已从系统材质切回透明窗口；圆角可能发白，重启应用后恢复");
    }
    return "transparent";
  }
  try {
    target.setBackgroundMaterial(material);
    return material;
  } catch (err) {
    logger.warn(`窗口材质 ${material} 设置失败, 回退为透明: ${err.message}`);
    return "transparent";
  }
}

// ---------------------------------------------------------------- 窗口

function createWindow() {
  win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    maxWidth: WINDOW_WIDTH,
    maxHeight: WINDOW_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    resizable: false,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    show: false,
    title: "HAUT Guard",
    icon: assetPath("icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  currentMaterial = applyMaterial(win, store.config.material);

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  if (CAPTURE_PATH) scheduleCapture();

  win.once("ready-to-show", () => {
    if (START_HIDDEN_ARG || store.config.startMinimized) {
      logger.info("按配置启动时隐藏到托盘");
    } else {
      win.show();
    }
  });

  // 关闭按钮 = 收进托盘(与原版客户端的托盘行为一致), 真正退出走托盘菜单
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    win = null;
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`渲染进程异常: ${JSON.stringify(details)}`);
  });

  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    logger.error(`界面加载失败 (${code} ${desc}) ${url}`);
  });

  // 把界面里的 console 也收进日志, 便于用户反馈问题时定位
  win.webContents.on("console-message", (...args) => {
    let level = 0;
    let message = "";
    let line = 0;
    let source = "";
    if (args.length === 1 && args[0] && typeof args[0] === "object" && "message" in args[0]) {
      const d = args[0];
      level = typeof d.level === "number" ? d.level : { verbose: 0, debug: 1, info: 2, warning: 3, error: 4 }[d.level] || 0;
      message = d.message;
      line = d.lineNumber;
      source = d.sourceId;
    } else {
      const [, lvl, msg, ln, src] = args;
      level = typeof lvl === "number" ? lvl : 0;
      message = msg;
      line = ln;
      source = src;
    }
    if (IS_DEV) process.stdout.write(`[界面:${level}] ${message} (${source}:${line})\n`);
    if (level >= 4) logger.error(`[界面] ${message} (${source}:${line})`);
    else if (level >= 3) logger.warn(`[界面] ${message} (${source}:${line})`);
  });

  if (IS_DEV) win.webContents.openDevTools({ mode: "detach" });
}

/**
 * 测试用: 等界面渲染稳定后截图存盘(见文件顶部 --capture 说明)。
 * 只在启动参数显式要求时执行, 正常使用不会有任何影响。
 */
function scheduleCapture() {
  setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const image = await win.webContents.capturePage();
      const target = path.resolve(CAPTURE_PATH);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      logger.info(`界面截图已保存: ${target} (${image.getSize().width}x${image.getSize().height})`);
    } catch (err) {
      logger.error(`界面截图失败: ${err.message}`);
    }
    if (CAPTURE_EXIT) {
      isQuitting = true;
      app.quit();
    }
  }, CAPTURE_DELAY_MS);
}

function showWindow() {  if (!win || win.isDestroyed()) {
    createWindow();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    win.show();
    return;
  }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else showWindow();
}

// ---------------------------------------------------------------- 托盘

function trayImage() {
  const file = assetPath("tray.png");
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    logger.warn(`托盘图标缺失或不可读: ${file}`);
  }
  return image;
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (err) {
    logger.error(`托盘创建失败: ${err.message}`);
    tray = null;
    return;
  }
  tray.setToolTip("HAUT Guard");
  tray.on("click", toggleWindow);
  refreshTrayMenu();
}

function statusLabel() {
  const c = monitor.conn;
  if (c.state === "online") return `已连接 · ${c.userName || ""} ${c.ip || ""}`.trim();
  if (c.state === "connecting") return "连接中…";
  if (c.reconnecting) return `等待重连（${c.nextRetryIn}s）`;
  if (c.state === "error") return `异常 · ${c.message || "未知错误"}`;
  return "未连接";
}

function refreshTrayMenu() {
  if (!tray) return;
  const online = monitor.conn.online;
  const busy = monitor.conn.state === "connecting";
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `状态：${statusLabel()}`, enabled: false },
      { type: "separator" },
      {
        label: online ? "断开连接" : "连接校园网",
        enabled: !busy,
        click: () => {
          if (online) monitor.logout();
          else quickLogin();
        },
      },
      { label: "显示主界面", click: showWindow },
      { type: "separator" },
      {
        label: "开机自启",
        type: "checkbox",
        checked: !!store.config.autoLaunch,
        click: (item) => setAutoLaunch(item.checked),
      },
      {
        label: "断线自动重连",
        type: "checkbox",
        checked: !!store.config.autoReconnect,
        click: (item) => {
          store.updateConfig({ autoReconnect: item.checked });
          pushState();
        },
      },
      { type: "separator" },
      { label: "打开日志目录", click: () => shell.openPath(path.dirname(logger.filePath)) },
      {
        label: "退出 HAUT Guard",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

/** 用已保存的凭据快速连接(托盘菜单用)。 */
async function quickLogin() {
  const account = store.activeAccount || store.findByUsername(store.config.lastUsername);
  if (!account) {
    showWindow();
    return;
  }
  const password = store.getPassword(account.id);
  if (!password) {
    showWindow();
    return;
  }
  await monitor.login({ username: account.username, password, accountId: account.id });
}

// ---------------------------------------------------------------- 开机自启

/** 登录项在注册表里的值名。不指定的话 Electron 会用 AppUserModelID
 *  (com.hautguard.app), 任务管理器的"启动"列表里就会显示成那个, 很不专业。 */
const AUTO_LAUNCH_NAME = "HAUT Guard";

/**
 * 把开机自启状态写入系统登录项(HKCU\...\Run)。
 *
 * 注意这是"幂等同步"而不是"只在开启时才写": 启动时也会调用一次, 这样用户手工改过
 * config.json、或旧版本留下过自启项时, 注册表都会被纠正回配置的真实状态。
 */
function applyAutoLaunch(enabled, options = {}) {
  const { silent = false } = options;
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!enabled,
        name: AUTO_LAUNCH_NAME,
        path: process.execPath,
        args: ["--hidden"],
      });
      logger.info(`开机自启登录项已${enabled ? "写入" : "移除"}`);
    } catch (err) {
      logger.error(`设置开机自启失败: ${err.message}`);
    }
  } else if (!silent) {
    logger.warn("开发模式下不写入开机自启注册项（仅保存配置）");
  }
  return !!enabled;
}

/** 更新配置并同步登录项, 返回更新后的配置。 */
function setAutoLaunch(enabled, options = {}) {
  const config = store.updateConfig({ autoLaunch: !!enabled });
  applyAutoLaunch(config.autoLaunch, options);
  return config;
}

// ---------------------------------------------------------------- 状态推送

function snapshot() {
  return {
    conn: monitor.conn,
    rate: monitor.rate,
    config: store.config,
    accounts: store.accounts(),
    activeAccountId: store.activeAccountId,
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
    },
    material: { current: currentMaterial, supported: supportedMaterials() },
    logs: { path: logger.filePath },
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function pushState() {
  send("state", snapshot());
}

function wireMonitor() {
  monitor.on("change", () => {
    pushState();
    refreshTrayMenu();
    if (tray) tray.setToolTip(`HAUT Guard · ${statusLabel()}`);
  });
  monitor.on("rate", (sample) => send("rate", sample));
  monitor.on("notice", ({ kind, message }) => send("toast", { kind, message }));
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle("app:snapshot", () => snapshot());

  ipcMain.handle("auth:login", async (_event, payload = {}) => {
    let account = payload.accountId ? store.findById(payload.accountId) : null;
    if (!account) account = store.activeAccount;
    const username = String(
      payload.username || (account && account.username) || store.config.lastUsername || ""
    ).trim();
    let password = String(payload.password || "");
    if (!password && account && account.username === username) {
      password = store.getPassword(account.id);
    }

    if (username) {
      // 学号本身不是机密, 总是记住: 这样即使不保存密码, 注销与自动重连也找得到人
      store.updateConfig({ lastUsername: username });
      if (store.config.remember && password) {
        const saved = store.saveAccount({
          id: account && account.username === username ? account.id : undefined,
          username,
          password,
        });
        if (!saved.ok) logger.warn(`保存账号失败: ${saved.message}`);
      } else if (account) {
        store.touch(account.id);
      }
    }

    const result = await monitor.login({
      username,
      password,
      accountId: account && account.username === username ? account.id : null,
    });
    pushState();
    return result;
  });

  ipcMain.handle("auth:logout", async () => {
    const result = await monitor.logout();
    pushState();
    return result;
  });

  ipcMain.handle("auth:refresh", async () => {
    const snap = await monitor.refresh();
    pushState();
    const c = snap.conn;
    return { ok: true, message: c.online ? `在线：${c.userName} ${c.ip}` : c.message || "当前未连接" };
  });

  ipcMain.handle("accounts:list", () => store.accounts());

  ipcMain.handle("accounts:save", (_event, input = {}) => {
    const result = store.saveAccount(input);
    pushState();
    // 一并返回最新账号列表, 省掉渲染层再发一次 accounts:list
    return { ...result, accounts: store.accounts(), activeAccountId: store.activeAccountId };
  });

  ipcMain.handle("accounts:remove", (_event, { id } = {}) => {
    const result = store.removeAccount(id);
    pushState();
    return { ...result, accounts: store.accounts(), activeAccountId: store.activeAccountId };
  });

  ipcMain.handle("accounts:select", (_event, { id } = {}) => {
    const result = store.selectAccount(id);
    pushState();
    return { ...result, accounts: store.accounts(), activeAccountId: store.activeAccountId };
  });

  ipcMain.handle("accounts:reveal", (_event, { id } = {}) => store.revealPassword(id));

  ipcMain.handle("config:update", (_event, patch = {}) => {
    const before = store.config;
    let config = store.updateConfig(patch);
    if (patch.remember === false && before.remember) {
      for (const account of store.accounts()) store.forgetPassword(account.id);
      logger.info("已关闭「记住密码」，所有已保存的密码已清除");
    }
    if (patch.autoLaunch !== undefined && patch.autoLaunch !== before.autoLaunch) {
      config = setAutoLaunch(patch.autoLaunch);
    }
    if (patch.material !== undefined && patch.material !== before.material) {
      currentMaterial = applyMaterial(win, config.material, {
        hadMaterial: currentMaterial !== "transparent",
      });
    }
    if (patch.pollInterval !== undefined) monitor.onConfigChanged();
    pushState();
    return config;
  });

  ipcMain.handle("config:reset", () => {
    const config = store.resetConfig();
    currentMaterial = applyMaterial(win, config.material, {
      hadMaterial: currentMaterial !== "transparent",
    });
    setAutoLaunch(config.autoLaunch, { silent: true });
    monitor.onConfigChanged();
    pushState();
    return { ok: true, config };
  });

  ipcMain.handle("diag:run", () =>
    runDiagnostics({ config: store.config, store, logger })
  );

  ipcMain.handle("logs:read", (_event, { lines } = {}) => ({
    path: logger.filePath,
    lines: logger.read(lines || 300),
  }));

  ipcMain.handle("logs:clear", () => {
    const ok = logger.clear();
    logger.info("日志已清空");
    return { ok };
  });

  ipcMain.handle("logs:open", async () => {
    const dir = path.dirname(logger.filePath);
    const error = await shell.openPath(dir);
    return { ok: !error, error };
  });

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    material: currentMaterial,
    materialSupported: supportedMaterials(),
  }));

  ipcMain.handle("app:set-material", (_event, { material } = {}) => {
    store.updateConfig({ material });
    currentMaterial = applyMaterial(win, material, {
      hadMaterial: currentMaterial !== "transparent",
    });
    pushState();
    return { ok: true, material: currentMaterial };
  });

  ipcMain.handle("app:quit", () => {
    isQuitting = true;
    app.quit();
    return { ok: true };
  });

  ipcMain.handle("win:minimize", () => {
    if (win && !win.isDestroyed()) win.minimize();
    return { ok: true };
  });

  ipcMain.handle("win:close", () => {
    if (win && !win.isDestroyed()) win.hide();
    return { ok: true };
  });

  ipcMain.handle("win:hide", () => {
    if (win && !win.isDestroyed()) win.hide();
    return { ok: true };
  });

  // 标题栏拖拽由 CSS 的 -webkit-app-region: drag 负责, 这里保留一个空实现
  // 以便渲染层在拖拽失效时有兜底通道。
  ipcMain.on("win:begin-drag", () => {
    /* no-op */
  });
}

// ---------------------------------------------------------------- 启动

async function bootstrap() {
  const userDataDir = app.getPath("userData");
  logger = new Logger({ dir: path.join(userDataDir, "logs") });
  logger.info(
    `=== HAUT Guard ${app.getVersion()} 启动 | Electron ${process.versions.electron} | ` +
      `${process.platform} ${os.release()} | 打包=${app.isPackaged} ===`
  );

  store = new Store({ dir: userDataDir, safeStorage, logger });
  if (!store.encryptionAvailable) {
    logger.warn("系统凭据加密不可用，密码将不会被保存");
  }

  monitor = new Monitor({ store, logger });
  wireMonitor();
  registerIpc();

  createWindow();
  createTray();

  // 启动时无条件同步一次登录项: 注册表必须跟随配置, 否则手工改过配置或旧版本
  // 留下的自启项会变成"幽灵自启"
  applyAutoLaunch(store.config.autoLaunch, { silent: true });

  logger.onEntry((entry) => send("log", entry));

  monitor.start();

  // 等界面就绪后再自动登录, 避免状态推送早于渲染层订阅
  if (store.config.autoLogin) {
    setTimeout(() => {
      monitor.maybeAutoLogin().catch((err) => logger.error(`自动登录异常: ${err.message}`));
    }, 2000);
  }

  app.on("activate", () => showWindow());
}

app.on("before-quit", () => {
  isQuitting = true;
  if (monitor) monitor.stop();
  if (logger) logger.info("=== HAUT Guard 退出 ===");
});

// 有托盘常驻, 关掉窗口不等于退出应用
app.on("window-all-closed", () => {
  /* 保持运行在托盘 */
});
