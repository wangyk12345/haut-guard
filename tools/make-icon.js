/**
 * make-icon.js —— 用 Electron 自身渲染矢量图标, 再手工封装成 ICO。
 *
 * 为什么要这么绕: 项目不允许引入图像处理依赖(canvas/sharp), 而 Windows 的
 * .ico 需要多尺寸。做法是用一个**离屏** BrowserWindow 渲染 SVG, capturePage()
 * 拿到 1024px PNG, 再用 nativeImage.resize() 生成各尺寸, 最后按 ICO 规范
 * (Vista+ 支持 PNG 压缩条目) 拼装容器。
 *
 * 两个图标(应用/托盘)画在同一张 2048x1024 画布上再裁剪: 实测连续创建两个
 * 离屏窗口时, 第二个窗口加载 data URL 会 ERR_FAILED。
 *
 * 用法: node_modules\electron\dist\electron.exe tools\make-icon.js
 * 产物: build/icon.ico  build/icon.png  src/assets/icon.png  src/assets/tray.png
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, nativeImage } = require("electron");

const ROOT = path.join(__dirname, "..");
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TILE = 1024;

/** 应用图标: 玻璃质感圆角方块 + 白色盾牌 + 网络信号。 */
function appIconSvg() {
  return `
  <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" stop-color="#6FD3FF"/>
        <stop offset="0.45" stop-color="#2E9BFF"/>
        <stop offset="1" stop-color="#0A5BE0"/>
      </linearGradient>
      <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/>
        <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.08"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="shield" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="1" stop-color="#DCEBFF"/>
      </linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.1" r="0.9">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.5"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>

    <rect x="32" y="32" width="960" height="960" rx="232" fill="url(#bg)"/>
    <rect x="32" y="32" width="960" height="960" rx="232" fill="url(#glow)"/>
    <rect x="32" y="32" width="960" height="960" rx="232" fill="url(#sheen)"/>
    <rect x="60" y="44" width="904" height="10" rx="5" fill="#ffffff" opacity="0.55"/>
    <rect x="33.5" y="33.5" width="957" height="957" rx="230.5" fill="none"
          stroke="#ffffff" stroke-opacity="0.5" stroke-width="3"/>

    <path d="M512 168 L806 280 V512 C806 690 682 820 512 884 C342 820 218 690 218 512 V280 Z"
          fill="url(#shield)" fill-opacity="0.96"/>
    <path d="M512 168 L806 280 V512 C806 690 682 820 512 884 C342 820 218 690 218 512 V280 Z"
          fill="none" stroke="#ffffff" stroke-opacity="0.9" stroke-width="14" stroke-linejoin="round"/>
    <path d="M512 200 L776 302 V512 C776 668 666 786 512 848 C358 786 248 668 248 512 V302 Z"
          fill="none" stroke="#1E7BE8" stroke-opacity="0.22" stroke-width="8" stroke-linejoin="round"/>

    <g stroke="#1E7BE8" stroke-width="30" stroke-linecap="round" fill="none" opacity="0.92">
      <path d="M392 470 A170 170 0 0 1 632 470"/>
      <path d="M440 540 A100 100 0 0 1 584 540"/>
    </g>
    <circle cx="512" cy="628" r="42" fill="#1E7BE8"/>
    <circle cx="512" cy="628" r="42" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="8"/>
  </svg>`;
}

/** 托盘图标: 小尺寸下必须更粗更简, 否则糊成一团。 */
function trayIconSvg() {
  return `
  <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stop-color="#7FDBFF"/>
        <stop offset="1" stop-color="#1E7BE8"/>
      </linearGradient>
    </defs>
    <path d="M128 18 L226 58 V128 C226 186 184 228 128 244 C72 228 30 186 30 128 V58 Z"
          fill="url(#tg)"/>
    <path d="M128 18 L226 58 V128 C226 186 184 228 128 244 C72 228 30 186 30 128 V58 Z"
          fill="none" stroke="#ffffff" stroke-opacity="0.85" stroke-width="12" stroke-linejoin="round"/>
    <g stroke="#ffffff" stroke-width="20" stroke-linecap="round" fill="none">
      <path d="M82 114 A64 64 0 0 1 174 114"/>
    </g>
    <circle cx="128" cy="174" r="22" fill="#ffffff"/>
  </svg>`;
}

/** 一张 2048x1024 的画布, 左半是应用图标, 右半是托盘图标。 */
function sheetHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;width:${TILE * 2}px;height:${TILE}px;overflow:hidden}
  .tile{position:absolute;top:0;width:${TILE}px;height:${TILE}px}
  .tile svg{display:block;width:${TILE}px;height:${TILE}px}
  #a{left:0}
  #b{left:${TILE}px}
</style></head><body>
  <div class="tile" id="a">${appIconSvg()}</div>
  <div class="tile" id="b">${trayIconSvg()}</div>
</body></html>`;
}

/** 把 [{size, buf}] 按 ICO 规范拼装。 */
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + 16 * count;
  for (const { size, buf } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // 调色板数
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.buf)]);
}

/** 离屏渲染整张画布并截图。 */
async function renderSheet() {
  const win = new BrowserWindow({
    width: TILE * 2,
    height: TILE,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    show: false,
    skipTaskbar: true,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  const firstPaint = new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    win.webContents.on("paint", done);
    setTimeout(done, 8000);
  });

  try {
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(sheetHtml()));
    await firstPaint;
    // 留一点时间让渐变与圆角完成光栅化
    await new Promise((r) => setTimeout(r, 800));
    const sheet = await win.webContents.capturePage();
    const size = sheet.getSize();
    if (size.width < TILE * 2) {
      throw new Error(`画布尺寸异常: ${size.width}x${size.height}`);
    }
    return {
      app: sheet.crop({ x: 0, y: 0, width: TILE, height: TILE }),
      tray: sheet.crop({ x: TILE, y: 0, width: TILE, height: TILE }),
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function main() {
  const assetsDir = path.join(ROOT, "src", "assets");
  const buildDir = path.join(ROOT, "build");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  const { app: appIcon, tray: trayIcon } = await renderSheet();
  if (appIcon.isEmpty() || trayIcon.isEmpty()) {
    throw new Error("渲染结果为空图像");
  }

  // 应用图标
  fs.writeFileSync(path.join(buildDir, "icon.png"), appIcon.toPNG());
  fs.writeFileSync(
    path.join(assetsDir, "icon.png"),
    appIcon.resize({ width: 256, height: 256, quality: "best" }).toPNG()
  );
  const icoImages = ICON_SIZES.map((size) => ({
    size,
    buf: appIcon.resize({ width: size, height: size, quality: "best" }).toPNG(),
  }));
  fs.writeFileSync(path.join(buildDir, "icon.ico"), buildIco(icoImages));

  // 托盘图标(单独设计的小尺寸版本)。托盘在 Windows 上按 16px 逻辑像素显示,
  // 这里给 32px 让系统在 200% 缩放下也清晰。
  fs.writeFileSync(
    path.join(assetsDir, "tray.png"),
    trayIcon.resize({ width: 32, height: 32, quality: "best" }).toPNG()
  );

  const lines = [
    "图标已生成:",
    `  build/icon.png        ${fs.statSync(path.join(buildDir, "icon.png")).size} bytes (1024x1024)`,
    `  build/icon.ico        ${fs.statSync(path.join(buildDir, "icon.ico")).size} bytes (${ICON_SIZES.join("/")})`,
    `  src/assets/icon.png   ${fs.statSync(path.join(assetsDir, "icon.png")).size} bytes (256x256)`,
    `  src/assets/tray.png   ${fs.statSync(path.join(assetsDir, "tray.png")).size} bytes (32x32)`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

app.disableHardwareAcceleration();
app.whenReady().then(() =>
  main().then(
    () => app.exit(0),
    (err) => {
      process.stderr.write(`生成图标失败: ${err && err.stack ? err.stack : err}\n`);
      app.exit(1);
    }
  )
);
