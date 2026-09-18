/**
 * seed-account.js —— 用 DPAPI 加密写入一个账号 + 配置, 供真实应用联调。
 *
 * 为什么需要它: 应用要求密码以 safeStorage(DPAPI) 密文存储, 外部脚本无法生成这种密文。
 * 这个工具在 Electron 里运行, 用**应用自己的** safeStorage 加密后写入, 于是应用启动后
 * 走的完全是正常路径(解密 -> 登录), 不需要在应用里加入任何测试专用代码。
 *
 * 密码只从环境变量 HAUT_PASS 读, 不打印、不写入除 accounts.json 密文字段以外的任何地方。
 *
 * 用法: node_modules\electron\dist\electron.exe tools\seed-account.js <username> [reset]
 *   env: HAUT_PASS=<密码>   HAUT_GATEWAY / HAUT_PORTAL_PORT / HAUT_STATUS_PORT / HAUT_POLL
 *        HAUT_NO_AUTOLOGIN=1  只存账号不自动登录
 *   reset: 清空已有账号
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, safeStorage } = require("electron");

const username = process.argv[2] || process.env.HAUT_USER || "";
const password = process.env.HAUT_PASS || "";
const doReset = process.argv.includes("reset");

// 直接跑脚本时 Electron 的应用名是 "Electron", userData 会落到 %APPDATA%\Electron,
// 与应用实际使用的 %APPDATA%\HAUT Guard 不是同一个目录。这里显式对齐。
app.setName("HAUT Guard");
app.setPath("userData", path.join(app.getPath("appData"), "HAUT Guard"));

app.whenReady().then(() => {
  if (!username) {
    process.stderr.write("缺少账号(第一个参数或 HAUT_USER)\n");
    app.exit(2);
    return;
  }
  const dir = app.getPath("userData");
  fs.mkdirSync(dir, { recursive: true });

  const accountsFile = path.join(dir, "accounts.json");
  const configFile = path.join(dir, "config.json");

  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  if (!encryptionAvailable) {
    process.stderr.write("系统凭据加密不可用, 无法安全写入密码\n");
    app.exit(3);
    return;
  }

  const secret = password ? safeStorage.encryptString(password).toString("base64") : "";
  const id = crypto.randomBytes(8).toString("hex");

  let existing = { activeId: null, accounts: [] };
  if (!doReset && fs.existsSync(accountsFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(accountsFile, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      existing = { activeId: null, accounts: [] };
    }
  }
  const accounts = (existing.accounts || []).filter((a) => a.username !== username);
  accounts.push({
    id,
    username,
    label: "我的账号",
    secret,
    autoLogin: !process.env.HAUT_NO_AUTOLOGIN,
    lastUsed: Date.now(),
  });

  fs.writeFileSync(accountsFile, JSON.stringify({ activeId: id, accounts }, null, 2), "utf8");

  /* 配置: **先读现有 config.json 再合并覆盖**。
     以前这里是硬编码一整个对象, 会把新增字段 (accent / chromeStyle 等) 全部丢掉 ——
     写完 config.json 后应用的配色/窗口按钮风格就被打回默认值, 很难查到是这个工具干的。 */
  let currentConfig = {};
  if (!doReset && fs.existsSync(configFile)) {
    try {
      currentConfig = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
      if (!currentConfig || typeof currentConfig !== "object" || Array.isArray(currentConfig)) currentConfig = {};
    } catch {
      currentConfig = {};
    }
  }
  const config = {
    ...currentConfig,
    gateway: process.env.HAUT_GATEWAY || "172.16.154.130",
    portalPort: Number(process.env.HAUT_PORTAL_PORT || 69),
    statusPort: Number(process.env.HAUT_STATUS_PORT || 80),
    autoLogin: !process.env.HAUT_NO_AUTOLOGIN,
    autoLaunch: false,
    remember: true,
    autoReconnect: true,
    startMinimized: false,
    pollInterval: Number(process.env.HAUT_POLL || 5),
    theme: "dark",
    material: "transparent",
    passwordAlgo: "srun3",
    infoFormat: "srbx1",
    lastUsername: username,
  };
  // 兜底: 老配置文件里没有的新字段也要有值, 避免应用读到 undefined
  if (!config.accent) config.accent = "cyan";
  if (!config.chromeStyle) config.chromeStyle = "mac";
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");

  process.stdout.write(
    `已写入账号(密码已用 DPAPI 加密, 长度 ${secret.length} 字符): ${username}\n` +
      `账号文件 ${accountsFile}\n` +
      `配置文件 ${configFile} (在原配置基础上合并, 保留 accent=${config.accent} chromeStyle=${config.chromeStyle})\n` +
      `autoLogin=${config.autoLogin} autoReconnect=${config.autoReconnect}` +
      ` infoFormat=${config.infoFormat} portal=${config.gateway}:${config.portalPort}\n`
  );
  app.exit(0);
});
