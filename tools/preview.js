/**
 * preview.js —— 渲染层预览 / 截图 harness。
 *
 * 用法 (在 hautguard-app 目录下):
 *   node_modules\electron\dist\electron.exe tools\preview.js --all
 *   node_modules\electron\dist\electron.exe tools\preview.js --scenario=online --theme=light
 *   node_modules\electron\dist\electron.exe tools\preview.js --list
 *
 * 行为:
 *   1. 每个场景独立开一个 420 宽的窗口: 无边框、transparent:true、backgroundColor:'#00000000';
 *   2. 用 tools/preview-preload.js 注入 mock 版 window.haut;
 *   3. 加载 src/renderer/index.html#scenario=xxx&theme=yyy;
 *   4. did-finish-load 后再等 ~1200ms 让动画/曲线落定, 用 capturePage() 存 PNG 到 docs/ui;
 *   5. 把渲染层 console 的 error/warning 原文打印到终端 (同时写入 docs/ui/_preview.log);
 *   6. 有任何致命错误 (加载失败 / 渲染进程崩溃 / 截图失败 / console error) 时退出码非 0。
 *
 * 关于截图尺寸 (重要):
 *   默认截图 = **真实 452x692 视口** (capturePage 带 rect), 与用户实际看到的一致,
 *   因此任何被底部操作栏遮挡 / 溢出的内容都会如实暴露出来。
 *   --with-backdrop 额外输出一张「窗口贴在壁纸上」的合成图 (472x712), 仅用来看玻璃质感,
 *   它不代表视口, 不要用它判断是否溢出。
 *   --full 额外输出滚动区全部内容的长图, 仅用于诊断布局总高度。
 *
 * 附加参数:
 *   --out=<dir>            截图输出目录 (默认 docs/ui)
 *   --wait=<ms>            额外等待时间 (默认 1200)
 *   --captures=<n>         每个场景连续截图张数 (默认 1)
 *   --theme=<dark|light>   覆盖所有场景的主题
 *   --full                 额外输出整页长图 (文件名带 -full)
 *   --with-backdrop        额外输出带合成底板的质感图 (文件名带 -bd)
 *   --no-offscreen         改用可见窗口截图 (默认走 offscreen 渲染, 更稳定)
 *   --native               保留物理像素尺寸 (525x825)
 *   --allow-console-error  仅打印 console 错误, 不影响退出码
 *   --keep-open            全部截完后保持窗口打开 (调试用)
 *   --zoom                 额外输出"开关条特写"(2x 放大裁剪, 与参考图对比用)
 *                          (--all 默认开启; 见 ZOOM_OF_SCENE)
 *
 * 断言 (任一不满足即退出码非 0):
 *   1. 视口必须是 452x692 逻辑像素;
 *   2. 场景必须真的生效 (window.__preview.scenario 与目标一致);
 *   3. 渲染层零异常 (任何 error 级输出, 或以 Uncaught 开头的输出);
 *   4. app.js 的 dom 映射里每个 id 都能在 index.html 里找到;
 *   5. 首屏关键路径完整可见: 学号框 / 密码框整体位于底部操作栏之上, 主按钮可见;
 *   6. 有账号时, 账号按钮不得显示「未添加账号」;
 *   7. 开关条 (胶囊玻璃) 结构完整: 4 个 role=switch 条目 + 各自的高亮胶囊 .sw__hi,
 *      且 MIX_SCENES 里"开/关"两种状态必须同时存在 (证明两种外观都渲染出来了)。
 */

"use strict";

/* 关掉 Electron 自带的开发模式安全警告 (那条 CSP 提示与本渲染层无关:
   index.html 已经声明了 default-src 'none' 的严格 CSP, 且未使用 eval)。 */
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = "1";

const { app, BrowserWindow, Menu, session, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/* --------------------------------------------------------------- 路径 */

const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "src", "renderer", "index.html");
const PRELOAD = path.join(__dirname, "preview-preload.js");

/* 合成底板: 故意做成"高细节壁纸" (细网格 + 硬边色块 + 文字),
   这样 -bd 图才能看出玻璃到底是"透明"还是"磨砂":
   磨砂会把网格糊掉, 不透明会把色块盖掉。纯渐变底板是看不出区别的。 */
const DETAIL_LAYER =
  "repeating-linear-gradient(0deg, rgba(255,255,255,.42) 0 1px, transparent 1px 26px)," +
  "repeating-linear-gradient(90deg, rgba(255,255,255,.42) 0 1px, transparent 1px 26px)," +
  "radial-gradient(circle at 16% 18%, #ff5f7e 0 84px, transparent 86px)," +
  "radial-gradient(circle at 84% 26%, #ffc86b 0 66px, transparent 68px)," +
  "radial-gradient(circle at 26% 74%, #34e0b4 0 74px, transparent 76px)," +
  "radial-gradient(circle at 78% 82%, #7c8cff 0 92px, transparent 94px)";

const BACKDROPS = {
  dark: DETAIL_LAYER + ", linear-gradient(150deg,#243b6b 0%,#16203a 45%,#0b1220 100%)",
  light: DETAIL_LAYER.replace(/\.42/g, ".55") + ", linear-gradient(150deg,#e7eefb 0%,#f3f7ff 45%,#dfe8f7 100%)",
};
const PAD = 26; // 底板模式下窗口四周额外留出的边距 (逻辑像素)

/* --------------------------------------------------------------- 参数 */

function parseArgs(argv) {
  const opts = {
    all: false, list: false, scenarios: [], theme: "", out: "", wait: 1200,
    captures: 1, allowConsoleError: false, keepOpen: false, native: false,
    full: false, backdrop: false, offscreen: true, zoom: false, contrast: true,
  };
  argv.forEach((raw) => {
    const a = String(raw);
    if (a === "--all") opts.all = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--keep-open") opts.keepOpen = true;
    else if (a === "--native") opts.native = true;
    else if (a === "--full") opts.full = true;
    else if (a === "--zoom") opts.zoom = true;
    else if (a === "--no-contrast") opts.contrast = false;
    else if (a === "--with-backdrop") opts.backdrop = true;
    else if (a === "--no-offscreen") opts.offscreen = false;
    else if (a === "--allow-console-error") opts.allowConsoleError = true;
    else if (a.startsWith("--scenario=")) opts.scenarios.push(a.slice(11));
    else if (a.startsWith("--theme=")) opts.theme = a.slice(8);
    else if (a.startsWith("--out=")) opts.out = a.slice(6);
    else if (a.startsWith("--wait=")) opts.wait = Math.max(0, Number(a.slice(7)) || 0);
    else if (a.startsWith("--captures=")) opts.captures = Math.max(1, Number(a.slice(11)) || 1);
  });
  return opts;
}

/* --------------------------------------------------------------- 场景表 */

const SCENARIOS = [
  { name: "offline", theme: "dark", file: "01-offline-dark.png", desc: "离线 (无历史数据)" },
  // 连接中: mock 在 2.6s 后才转为在线, 因此这个场景要等久一点才能截到「连接中」
  { name: "connecting", theme: "dark", file: "02-connecting-dark.png", desc: "连接中", wait: 1700 },
  { name: "online", theme: "dark", file: "03-online-dark.png", desc: "在线 (本次流量/时长/速率/曲线)" },
  { name: "login-fail", theme: "dark", file: "04-login-fail-dark.png", desc: "登录失败 E2531" },
  { name: "reconnecting", theme: "dark", file: "05-reconnecting-dark.png", desc: "自动重连倒计时" },
  { name: "accounts", theme: "dark", file: "06-accounts-dark.png", desc: "账号下拉展开", allowMenuOpen: true },
  { name: "settings", theme: "light", file: "07-settings-light.png", desc: "设置面板" },
  { name: "logs", theme: "dark", file: "08-logs-dark.png", desc: "日志面板" },
  { name: "light", theme: "light", file: "09-online-light.png", desc: "浅色主题在线态" },
  { name: "first-run", theme: "dark", file: "10-first-run-dark.png", desc: "首次运行 (无账号引导)", allowMenuOpen: true },
  // 已保存密码但本地无法解密: 密码框应保持空 + placeholder 提示重输, 且不弹错误
  { name: "pass-lost", theme: "dark", file: "11-pass-lost-dark.png", desc: "凭据不可解密 (密码框静默降级)" },
  // 选中「旧版（排障用）」协议: 该行下方必须出现"本网关实测不支持"的风险警告
  { name: "settings-legacy", theme: "light", file: "12-settings-legacy-light.png", desc: "设置面板 · 旧版协议 (风险警告)" },

  /* ---- 第二轮需求: 窗口按钮风格 / 主题色 ---- */
  { name: "chrome-windows", theme: "dark", file: "15-chrome-windows-dark.png", desc: "Windows 窗口按钮 (右上角 ─ / ✕)", chrome: "windows" },
  { name: "accent-violet", theme: "dark", file: "16-accent-violet-dark.png", desc: "主题色 · 紫罗兰", accent: "violet" },
  { name: "accent-green", theme: "light", file: "17-accent-green-light.png", desc: "主题色 · 绿色 (浅色主题)", accent: "green" },
  { name: "accent-pink", theme: "dark", file: "18-accent-pink-dark.png", desc: "主题色 · 粉色", accent: "pink" },
  { name: "accent-amber", theme: "dark", file: "19-accent-amber-dark.png", desc: "主题色 · 琥珀金", accent: "amber" },
  { name: "settings-accent", theme: "light", file: "20-settings-accent-light.png", desc: "设置面板 · 主题色板 (点击切换自检)", accent: "blue", accentSwitchTest: true },

  /* ---- 第三轮: 「记住密码」是破坏性操作 (主进程会立刻删除已存密码) ----
     rememberTest: ask = 只点一次看确认条; confirm = 点确认; cancel = 点取消;
                   sheet = 在设置面板里点并确认 (顺带验两个开关同步) */
  { name: "remember-confirm", theme: "dark", file: "30-remember-confirm-dark.png", desc: "关闭记住密码 · 确认提示", rememberTest: "ask" },
  { name: "remember-off", theme: "dark", file: "31-remember-off-dark.png", desc: "关闭记住密码 · 已确认", rememberTest: "confirm" },
  { name: "remember-cancel", theme: "light", file: "32-remember-cancel-light.png", desc: "关闭记住密码 · 已取消", rememberTest: "cancel" },
  { name: "sheet-remember", theme: "light", file: "33-sheet-remember-light.png", desc: "设置面板 · 记住密码确认 + 单次写入", rememberTest: "sheet" },
  { name: "sheet-remember-ask", theme: "light", file: "34-sheet-remember-confirm-light.png", desc: "设置面板 · 关闭记住密码确认行", rememberTest: "sheet-ask" },
];

/**
 * 密码框期望状态 (断言用):
 *   dots    = 一进界面就是点状 (type=password 且 value 非空, 明文不落到别处)
 *   missing = 取不回明文 -> 空值 + placeholder 提示重新输入
 *   empty   = 没有已保存密码 -> 空值 + 默认 placeholder
 */
const PASS_EXPECT = {
  offline: "dots", connecting: "dots", online: "dots", "login-fail": "dots",
  reconnecting: "dots", accounts: "dots", settings: "dots", logs: "dots",
  light: "dots", "first-run": "empty", "pass-lost": "missing",
  "settings-legacy": "dots",
  "chrome-windows": "dots", "accent-violet": "dots", "accent-green": "dots",
  "accent-pink": "dots", "accent-amber": "dots", "settings-accent": "dots",
  "remember-confirm": "dots", "remember-off": "dots", "remember-cancel": "dots",
  "sheet-remember": "dots", "sheet-remember-ask": "dots",
};

/** 打开设置面板的场景 (协议控件自检) */
const SETTINGS_SCENES = ["settings", "settings-legacy", "settings-accent", "sheet-remember", "sheet-remember-ask"];
/** 场景名 -> 为了截图需要重新打开的面板 */
const SHEET_OF_SCENE = { settings: "settings", "settings-legacy": "settings", logs: "logs" };

/**
 * 主题色预设的期望值 (与 glass.css 的分组一一对应), 用于断言"切换后 CSS 变量确实变了"。
 * dark = html[data-accent=x], light = html[data-theme=light][data-accent=x]
 */
const ACCENT_HEX = {
  dark: {
    cyan: "#38c9f0", blue: "#4b8dff", violet: "#a98bff", green: "#3fd9a4",
    amber: "#ffc86b", pink: "#ff8fb8", red: "#ff6b81",
  },
  light: {
    cyan: "#0d7fa8", blue: "#1f5fd0", violet: "#6d3fd4", green: "#0f8a6c",
    amber: "#a4690a", pink: "#c93b78", red: "#c62f4c",
  },
};

/**
 * 特写图 (放大裁剪): 场景 -> [{file, sel, scale, pad}]
 *   - 13/14 开关条 (2x), 21/22 底部玻璃入口 (3x), 23 Windows 标题栏 (3x),
 *     24 主题色板 (3x)
 */
const ZOOM_OF_SCENE = {
  offline: [
    { file: "13-switchbar-zoom.png", sel: "#switchBar", scale: 2, pad: 12 },
    { file: "21-footer-zoom.png", sel: "#foot", scale: 3, pad: 12 },
  ],
  light: [
    { file: "14-switchbar-zoom-light.png", sel: "#switchBar", scale: 2, pad: 12 },
    { file: "22-footer-zoom-light.png", sel: "#foot", scale: 3, pad: 12 },
  ],
  "chrome-windows": [
    { file: "23-titlebar-zoom-windows.png", sel: "#titlebar", scale: 3, pad: 6 },
  ],
  "accent-violet": [
    { file: "27-switchbar-zoom-violet.png", sel: "#switchBar", scale: 2, pad: 12 },
  ],
  "settings-accent": [
    { file: "24-accent-picker-zoom.png", sel: "#sheetBody .swatches", scale: 3, pad: 14 },
  ],
};

/** 探针里要回传矩形的位置 (供上面的放大裁剪使用) */
const ZOOM_SELECTORS = ["#switchBar", "#foot", "#titlebar", "#sheetBody .swatches"];

/**
 * 对比度自检 (WCAG 2.x relative luminance ratio), 直接在截图像素上量:
 *   bg = 元素框内出现最多的颜色 (文字只占少数像素)
 *   fg = 与 bg 亮度差最大的、出现 >=2 像素的颜色 (抗锯齿不会比文字本色更极端)
 * 每项 = [选择器, 名称, 达标线 target, 硬底线 floor, 是否"软目标"]
 *   - floor 省略 = 与 target 相同 (硬指标)
 *   - soft=true: 没到 target 会在日志里列成 FAIL, 但不影响退出码 (仅 floor 决定)
 *     用途: "强调色文字压在透明玻璃上"这类**物理上不可能**在所有壁纸下都达标的项
 *     (强调色自身亮度接近浅色壁纸时必然糊), 需要如实打印而不是假装达标。
 */
const CONTRAST_TARGETS = [
  [".titlebar__name", "标题栏名称", 3.0],
  [".hero__state", "状态大字", 3.0],
  [".hero__user", "状态下小字", 3.0],
  [".hero__hint", "状态提示", 3.0],
  [".pill__text", "状态胶囊", 3.0],
  [".metric__label", "指标标签", 4.5],
  [".metric__value", "指标数值", 4.5],
  [".subbar__item i", "累计条标签", 4.5],
  [".subbar__item b", "累计条数值", 4.5],
  [".spark__title", "卡片标题", 4.5],
  [".spark__sub", "卡片副标题", 3.0],
  [".spark__legend span", "图例文字", 3.0],
  [".field__label", "表单标签", 4.5],
  [".select__name", "账号名", 4.5],
  [".select__sub", "账号副标题", 3.0],
  [".sw[aria-checked=\"false\"] .sw__text", "开关文字(关)", 4.5, 2.2],
  [".sw[aria-checked=\"true\"] .sw__text", "开关文字(开·强调色)", 4.5, 1.4, true],
  [".foot button", "底部入口", 4.5],
  [".primary__label", "主按钮文字", 2.5],
  [".group__title", "面板分组标题", 3.0],
  [".row__label b", "面板行标题", 4.5],
  [".row__label i", "面板行说明", 3.0],
  [".hintline", "面板提示行", 3.0],
  [".logline__msg", "日志正文", 4.5],
  [".seg button", "分段按钮", 3.0],
];

/** 亮色/暗色"极限壁纸"压力测试: 只给这两个场景额外拍两张纯色底板图 */
const CONTRAST_PROBE_SCENES = { offline: ["#ffffff", "#000000"], light: ["#ffffff", "#000000"] };

/**
 * 透明度均匀性取样点 (视口坐标)。分两类:
 *   strict=1 —— 面板底色区域 (标题栏 / 开关条外侧 / 底部操作区 / 左右边距 / 顶边):
 *               这些地方只应有 `--arena-base` 一层, 彼此最大差必须 ≤ 8/255。
 *               谁再给某个区域单独加底色, 这里立刻报警。
 *   strict=0 —— 卡片之间的 6px 缝隙: 那里必然被卡片自己的投影压暗 (设计上的"悬浮感"),
 *               不属于"分区底色", 只断言"壁纸仍然透得过来"(≥20/255)并如实打印。
 */
const UNIFORMITY_POINTS = [
  [110, 38, "标题栏左", 1],
  [350, 38, "标题栏右", 1],
  [226, 26, "面板顶边", 1],
  [20, 300, "面板左边距", 1],
  [432, 300, "面板右边距", 1],
  [20, 545, "开关条外侧·左", 1],
  [432, 545, "开关条外侧·右", 1],
  [226, 672, "底部入口下方", 1],
  [226, 230, "卡片缝隙·状态卡/累计条", 0],
  [226, 356, "卡片缝隙·曲线/表单", 0],
  [226, 511, "卡片缝隙·表单/开关条", 0],
  [226, 639, "主按钮与底部入口之间", 0],
];

/** 面板圆角: 边距 16px, 圆角 22px ⇒ 圆角弧心 (38,38) / (414,38) / (38,654) / (414,654) */
const CORNER_R = 22;
const CORNER_PAD = 16;
/** 透明度均匀性容差: 各取样点"壁纸透过率"的最大最小差 (0-255 亮度单位) */
const UNIFORMITY_TOL = 8;
/** 圆角/边距与"只留面板"参照图的最大允许亮度差 */
const CORNER_TOL = 6;

/**
 * 量一个 7x7 patch 的"感知亮度" (0-255)。
 * 用 **sRGB 空间** 的加权亮度而不是线性亮度: 两张纯色底板图相减得到的差值
 * 就是"有多少壁纸透过来"(alpha), 在 sRGB 空间里两者是线性关系, 数字直观且
 * 可以直接和 8/255 这样的容差比。
 */
function patchLum(bitmap, imgW, imgH, cx, cy, r) {
  let sum = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= imgH) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= imgW) continue;
      const i = (y * imgW + x) * 4;
      const b = bitmap[i], g = bitmap[i + 1], rr = bitmap[i + 2];
      sum += 0.2126 * rr + 0.7152 * g + 0.0722 * b;
      n++;
    }
  }
  return n ? sum / n : null;
}

/**
 * 透明度均匀性: 同一批取样点在"纯白底板"和"纯黑底板"两张图里各量一次,
 * 差值 (L白 - L黑) 就是该点"能透出多少壁纸", 也就是局部透明度。
 * 这样量出来与氛围光斑/面板自身颜色无关, 只反映透明度是否一致。
 */
function analyzeUniformity(imgWhite, imgBlack, points, logFn) {
  const a = imgWhite.toBitmap(), b = imgBlack.toBitmap();
  const sa = imgWhite.getSize(), sb = imgBlack.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) {
    logFn("  ! 透明度均匀性: 两张探针图尺寸不一致, 跳过");
    return { fail: 0, delta: null };
  }
  const rows = [];
  points.forEach(([x, y, label, strict]) => {
    const lw = patchLum(a, sa.width, sa.height, x, y, 3);
    const lb = patchLum(b, sa.width, sb.height, x, y, 3);
    if (lw === null || lb === null) return;
    rows.push({ label, x, y, strict: strict !== 0, t: lw - lb, lw, lb });
  });
  if (!rows.length) return { fail: 0, delta: null };
  const hard = rows.filter((r) => r.strict).map((r) => r.t);
  const soft = rows.filter((r) => !r.strict).map((r) => r.t);
  const min = Math.min(...hard), max = Math.max(...hard);
  const delta = max - min;
  const bad = delta > UNIFORMITY_TOL;
  const softMin = soft.length ? Math.min(...soft) : null;
  const softBad = softMin !== null && softMin < 20;
  logFn(`  透明度均匀性: 面板底色 ${hard.length} 点 · 透过率 ${min.toFixed(1)}~${max.toFixed(1)}/255 · 最大差 ${delta.toFixed(1)} (容差 ${UNIFORMITY_TOL})` +
    (bad ? "  <== 不均匀" : "  OK") +
    (softMin === null ? "" : ` · 卡片缝隙/按钮投影区 ${soft.length} 点 · 最低 ${softMin.toFixed(1)}/255 (≥20 即可, 那是卡片自己的投影)`));
  rows.forEach((r) => {
    logFn(`    ${r.label.padEnd(22)} (${String(r.x).padStart(3)},${String(r.y).padStart(3)})  透过率 ${r.t.toFixed(1).padStart(5)}  (白${r.lw.toFixed(1)} / 黑${r.lb.toFixed(1)})${r.strict ? "" : "  [投影区]"}`);
  });
  return { fail: (bad || softBad) ? 1 : 0, delta, rows };
}

/**
 * 顶部圆角无残留 (对应"上边两个角多出来一块方形"的反馈):
 * 做法是拿一张"只留面板底色"的参照图 (把 .aura 之外的所有 body 子元素全部隐藏) 做对比 ——
 * 圆角切掉的那块、以及四周 16px 边距, 除了面板自己的投影之外不该有任何东西,
 * 所以"正常渲染"和"只留面板"在这块区域必须逐点一致。谁再往标题栏/某个区域加底色,
 * 只要它伸到圆角外面, 这里立刻会出现差值。
 */
function analyzeCorners(img, imgRef, logFn) {
  const a = img.toBitmap(), b = imgRef.toBitmap();
  const sa = img.getSize(), sb = imgRef.getSize();
  if (sa.width !== sb.width || sa.height !== sb.height) {
    logFn("  ! 圆角自检: 参照图尺寸不一致, 跳过");
    return { fail: 0, worst: null };
  }
  const W = sa.width, H = sa.height;
  const diag = 1 / Math.SQRT2;
  const pts = [];
  for (let r = CORNER_R + 4; r <= 46; r += 3) pts.push(r);
  const centers = {
    TL: [CORNER_PAD + CORNER_R, CORNER_PAD + CORNER_R],
    TR: [W - CORNER_PAD - CORNER_R, CORNER_PAD + CORNER_R],
  };
  let worst = 0, worstAt = "";
  const detail = [];
  Object.keys(centers).forEach((k) => {
    const [cx, cy] = centers[k];
    const sx = k === "TL" ? -1 : 1;
    pts.forEach((r) => {
      const px = Math.round(cx + sx * r * diag);
      const py = Math.round(cy - r * diag);
      const va = patchLum(a, W, H, px, py, 1);
      const vb = patchLum(b, W, H, px, py, 1);
      if (va === null || vb === null) return;
      const d = Math.abs(va - vb);
      detail.push(`${k}(${px},${py}) Δ${d.toFixed(1)}`);
      if (d > worst) { worst = d; worstAt = `${k} (${px},${py})`; }
    });
  });
  // 顺带覆盖四条边距: 面板投影之外也不该有东西
  const edge = [[8, 60, "上边距左"], [W - 8, 60, "上边距右"], [8, H - 60, "下边距左"], [W - 8, H - 60, "下边距右"]];
  edge.forEach(([x, y, label]) => {
    const va = patchLum(a, W, H, x, y, 2);
    const vb = patchLum(b, W, H, x, y, 2);
    if (va === null || vb === null) return;
    const d = Math.abs(va - vb);
    detail.push(`${label} Δ${d.toFixed(1)}`);
    if (d > worst) { worst = d; worstAt = label; }
  });
  const fail = worst > CORNER_TOL;
  logFn(`  顶部圆角/边距无残留: ${detail.length} 个采样点 · 与"只留面板底色"参照图的最大亮度差 ${worst.toFixed(1)} (${worstAt}, 容差 ${CORNER_TOL})`);
  logFn(`    ${detail.join("  ")}`);
  return { fail: fail ? 1 : 0, worst, worstAt };
}

/** 只留面板底色 (.aura), 隐藏其余所有 body 子元素 —— 圆角/边距比对的参照 */function panelOnlyScript(on) {
  return `(() => {
    let s = document.getElementById('preview-panelonly');
    if (${on ? "true" : "false"}) {
      if (!s) {
        s = document.createElement('style');
        s.id = 'preview-panelonly';
        s.textContent = 'body > *:not(.aura):not(#preview-flat){visibility:hidden !important}';
        document.head.appendChild(s);
      }
    } else if (s) { s.remove(); }
    return true;
  })()`;
}

/** 临时隐藏氛围光斑 (测透明度时必须去掉这层装饰色, 否则量到的是光斑不是透明度) */
function blobHideScript(on) {
  return on
    ? `(() => { let s = document.getElementById('preview-noblob');
        if (!s) { s = document.createElement('style'); s.id = 'preview-noblob';
          s.textContent = '.aura__blob{display:none !important}'; document.head.appendChild(s); }
        return true; })()`
    : `(() => { const s = document.getElementById('preview-noblob'); if (s) s.remove(); return true; })()`;
}


/** 上一版(改造前)的文字色: 只在"对比度提升对照"里临时灌回 <html>, 用来量提升幅度 */
const OLD_TEXT_VARS = {
  dark: "--tx-1:rgba(244,248,255,.97);--tx-2:rgba(214,226,246,.78);" +
    "--tx-3:rgba(192,208,234,.58);--tx-4:rgba(176,194,224,.48);" +
    "--tx-shadow:0 1px 1px rgba(2,6,16,.30);--card-shade:transparent;" +
    "--bar-shade:transparent;--titlebar-shade:transparent;--well:rgba(9,13,25,.30);",
  light: "--tx-1:rgba(17,26,45,.96);--tx-2:rgba(34,48,74,.80);" +
    "--tx-3:rgba(52,68,96,.62);--tx-4:rgba(74,92,122,.52);" +
    "--tx-shadow:0 1px 0 rgba(255,255,255,.62);--card-shade:transparent;" +
    "--bar-shade:transparent;--titlebar-shade:transparent;--well:rgba(255,255,255,.44);",
};

/** 这些场景里必须同时存在"开"和"关"的开关 (mock 已刻意造出混合状态) */
const MIX_SCENES = ["offline", "light"];

/* --------------------------------------------------------------- 日志 */

const LINES = [];
const consoleLog = [];
let fatal = false;

/** 渲染层异常计数: level>=3 的 console error, 或任何以 Uncaught 开头的输出 */
let exceptionCount = 0;

function isException(entry) {
  return entry.level >= 3 || /^\s*Uncaught\b/i.test(entry.message) ||
    /Uncaught\s+(TypeError|ReferenceError|SyntaxError|RangeError|Error)/i.test(entry.message);
}

function log(line) {
  LINES.push(String(line));
}

function flushLog() {
  const text = LINES.join("\n") + "\n";
  try { process.stdout.write(text); } catch { /* stdout 已关闭时忽略 */ }
  try {
    fs.mkdirSync(path.join(ROOT, "docs", "ui"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "docs", "ui", "_preview.log"), text, "utf8");
  } catch { /* 忽略 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把位图裁到 (w, h) 逻辑像素。offscreen 渲染会多出 1px 边框, 裁掉后
 * 得到的 PNG 尺寸与真实视口严格一致, 便于逐张比对。
 * @param {Electron.NativeImage} image
 */
function cropTo(image, w, h) {
  try {
    const img = image.crop({ x: 0, y: 0, width: w, height: h });
    if (img && !img.isEmpty()) return img;
  } catch { /* 尺寸已一致时 crop 会抛错, 忽略 */ }
  return image;
}

/**
 * capturePage() 在无边框透明窗口上偶发 "Current display surface not available for capture"
 * (窗口尚未被合成器绘制)。这里换几种方式重试, 尽量拿到有效位图。
 */
async function grabWithRetry(win, rect, logFn) {
  const plans = [
    { label: "rect", rect },
    { label: "full", rect: undefined },
    { label: "full+invalidate", rect: undefined, invalidate: true },
    { label: "rect+invalidate", rect, invalidate: true },
    { label: "rect", rect },
    { label: "full", rect: undefined },
  ];
  for (const plan of plans) {
    if (plan.invalidate) {
      try { win.webContents.invalidate(); } catch { /* 忽略 */ }
      await sleep(500);
    }
    try {
      const img = await win.webContents.capturePage(plan.rect);
      if (img && !img.isEmpty()) return img;
    } catch (err) {
      logFn(`    capturePage(${plan.label}) 失败: ${err && err.message}`);
    }
    await sleep(400);
  }
  return null;
}

/** 对比度取样框的采集脚本 (进探针时用一次; 每张测量图前再采一次, 保证矩形与当前 DOM 一致) */
function contrastCollectScript() {
  return `(() => {
    const out = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    ${JSON.stringify(CONTRAST_TARGETS)}.forEach((t) => {
      const el = document.querySelector(t[0]);
      if (!el) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (Number(cs.opacity) < 0.5) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      // 裁切自检: 把框裁到所有"会裁切的祖先"(滚动容器 / overflow hidden)里
      let vis = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflow === 'visible' && pcs.overflowX === 'visible' && pcs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        vis = {
          left: Math.max(vis.left, pr.left), top: Math.max(vis.top, pr.top),
          right: Math.min(vis.right, pr.right), bottom: Math.min(vis.bottom, pr.bottom),
        };
      }
      const vw2 = vis.right - vis.left, vh2 = vis.bottom - vis.top;
      if (vw2 < 4 || vh2 < 4) return;
      // 只量"完整可见"的元素: 被滚掉一半的文字框里可能一个笔画都没有 (量出来是噪声)
      if ((vw2 * vh2) / (r.width * r.height) < 0.985) return;
      if (vis.left < 0 || vis.top < 0 || vis.right > vw || vis.bottom > vh) return;
      // 遮挡自检: 取可见框中心点, 命中它的必须是它自己或它的祖先/后代
      const cx = Math.min(vw - 1, Math.max(0, vis.left + vw2 / 2));
      const cy = Math.min(vh - 1, Math.max(0, vis.top + vh2 / 2));
      const hit = document.elementFromPoint(cx, cy);
      if (!hit) return;
      if (!(el === hit || el.contains(hit) || hit.contains(el))) return;
      out.push({
        sel: t[0], label: t[1], target: t[2],
        floor: t[3] === undefined ? t[2] : t[3],
        soft: !!t[4],
        color: cs.color,
        rect: [Math.round(vis.left), Math.round(vis.top), Math.round(vw2), Math.round(vh2)],
      });
    });
    return out;
  })()`;
}

function levelBadge(level) {
  if (level >= 3) return "ERROR";
  if (level === 2) return "WARN ";
  return "LOG  ";
}

/**
 * 取当前视口截图 (452x692)。
 * offscreen 渲染优先用 paint 事件攒下的最后一帧 (最稳), 否则退回 capturePage。
 */
async function grabViewport(win, frames, opts) {
  if (opts.offscreen && frames && frames.length) return frames[frames.length - 1];
  try {
    const img = await win.webContents.capturePage();
    if (img && !img.isEmpty()) return img;
  } catch { /* 忽略, 下面再试一次 */ }
  return grabWithRetry(win, { x: 0, y: 0, width: 452, height: 692 }, () => {});
}

/** 纯色底板 (对比度极限压力测试用): 只在 z-index:-1 插一层满窗纯色, 尺寸不变。
 *  同时在最顶端放一条 3px 洋红标定线: 位图方向自检靠它, 100% 确定, 不靠亮度猜。 */
function flatBackdropScript(action, color) {
  if (action === "on") {
    return `(() => {
      let bd = document.getElementById('preview-flat');
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'preview-flat';
        bd.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background:${color};';
        document.body.appendChild(bd);
      } else {
        bd.style.background = '${color}';
      }
      let mk = document.getElementById('preview-orient');
      if (!mk) {
        mk = document.createElement('div');
        mk.id = 'preview-orient';
        mk.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:3px;' +
          'background:rgb(255,0,255);z-index:2147483647;pointer-events:none;';
        document.body.appendChild(mk);
      }
      return true;
    })()`;
  }
  return `(() => {
    const bd = document.getElementById('preview-flat');
    if (bd) bd.remove();
    const mk = document.getElementById('preview-orient');
    if (mk) mk.remove();
    return true;
  })()`;
}

/* ---------------------------------------------- 「记住密码」破坏性操作自检 --------
   背景(真机日志): 用户点一次「记住密码」, 出现成对写入 ——
     配置已更新: remember                         (false: 主进程立刻删光已保存密码)
     已关闭「记住密码」，所有已保存的密码已清除
     配置已更新: remember                         (0.5s 后又写回 true, 开关最后显示"开")
   结果"开关是开的、密码却没了"。这里把两个入口都点一次, 直接数桥接层收到的写入。 */

const REMEMBER_STATE_JS = `(() => {
  const calls = (window.haut && window.haut.__calls) ? window.haut.__calls() : { configUpdate: [], forget: [] };
  const rem = calls.configUpdate.filter((c) => Object.prototype.hasOwnProperty.call(c.patch, 'remember'));
  const bar = document.getElementById('rememberConfirm');
  const sheetRow = Array.from(document.querySelectorAll('#sheetBody .row')).find((r) => {
    const b = r.querySelector('.row__label b');
    return b && b.textContent === '记住密码';
  });
  const sheetSw = sheetRow ? sheetRow.querySelector('.switch') : null;
  const pass = document.getElementById('inputPass');
  return {
    rememberWrites: rem.map((c) => c.patch.remember),
    writeKeys: calls.configUpdate.map((c) => Object.keys(c.patch).join('+')),
    forgot: (calls.forget || []).length,
    mainSw: document.getElementById('swRemember').getAttribute('aria-checked'),
    barShown: !!(bar && !bar.hidden),
    barText: bar ? String(bar.textContent || '').replace(/\\s+/g, ' ').trim() : '',
    sheetSw: sheetSw ? sheetSw.getAttribute('aria-checked') : null,
    sheetConfirmShown: !!document.querySelector('#sheetBody .confirmrow'),
    passLen: pass && pass.value ? String(pass.value).length : 0,
    toasts: Array.from(document.querySelectorAll('#toasts .toast__msg')).map((n) => n.textContent),
  };
})()`;

async function runRememberTest(win, scenario, log) {
  const mode = scenario.rememberTest;
  const js = (code) => win.webContents.executeJavaScript(code).catch(() => null);
  const state = () => js(REMEMBER_STATE_JS);
  const click = async (sel, wait) => {
    const ok = await js(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.click(); return true; })()`);
    await sleep(wait || 700);
    return ok;
  };
  const note = (line) => log(`  ${line}`);

  /* 场景里两个入口的路径 (面板里必须按"记住密码"那一行找, 不能取第一个 .switch) */
  const isSheet = mode === "sheet" || mode === "sheet-ask";
  const clickRemember = () => js(isSheet
    ? `(() => {
        const row = Array.from(document.querySelectorAll('#sheetBody .row')).find((r) => {
          const b = r.querySelector('.row__label b');
          return b && b.textContent === '记住密码';
        });
        const sw = row ? row.querySelector('.switch') : null;
        if (!sw) return false;
        sw.click(); return true;
      })()`
    : `(() => { const n = document.getElementById('swRemember'); if (!n) return false; n.click(); return true; })()`);

  await js("window.haut && window.haut.__resetCalls && window.haut.__resetCalls()");
  await sleep(120);

  if (!(await clickRemember())) {
    log(`  x 找不到${isSheet ? "设置面板里的「记住密码」开关" : "主界面「记住密码」开关"}`);
    fatal = true;
    return;
  }
  await sleep(700);

  const s1 = await state();
  if (!s1) { log("  x 记住密码自检读不到页面状态"); fatal = true; return; }
  const src = isSheet ? "设置面板" : "主界面";
  note(`记住密码自检[${src}·${mode}] 点 1 次开关后: remember 写入 ${s1.rememberWrites.length} 次 ` +
    `[${s1.rememberWrites.join(", ")}] · 已删密码 ${s1.forgot} 次 · 主界面开关=${s1.mainSw}` +
    `${isSheet ? ` · 面板开关=${s1.sheetSw}` : ""} · 确认条=${s1.barShown || s1.sheetConfirmShown ? "显示" : "隐藏"}`);
  note(`  确认条文案: ${(isSheet ? "" : s1.barText)}${isSheet ? "(面板内行)" : ""}`);

  /* 关闭是破坏性操作: 点开关本身绝不能直接写 remember */
  if (s1.rememberWrites.length !== 0) {
    log(`  x 点一次开关就写了 ${s1.rememberWrites.length} 次 remember (期望 0: 必须先确认)`);
    fatal = true;
  }
  if (s1.forgot !== 0) {
    log("  x 还没确认就把已保存的密码删掉了");
    fatal = true;
  }
  if (isSheet ? !s1.sheetConfirmShown : !s1.barShown) {
    log("  x 关闭「记住密码」没有出现确认提示");
    fatal = true;
  }
  if (!isSheet && s1.barText.indexOf("不可恢复") < 0) {
    log(`  x 确认提示没有说清后果: "${s1.barText}"`);
    fatal = true;
  }

  if (mode === "ask" || mode === "sheet-ask") {
    /* 连点回归: 老版本一次点击就会直接写配置, 连点/面板与主界面各点一下就会成对写入
       (false 先删光密码, true 再写回来)。这里连点 3 次, 要求仍然 0 次写入、确认条不重复。 */
    await clickRemember();
    await sleep(220);
    await clickRemember();
    await sleep(600);
    const s2 = await state();
    const dup = await js(`document.querySelectorAll('#rememberConfirm').length`);
    note(`  连点 3 次后: remember 写入 ${s2.rememberWrites.length} 次 · 确认条数量 ${dup} · 主界面开关=${s2.mainSw}` +
      `${isSheet ? ` · 面板确认行=${s2.sheetConfirmShown ? "显示" : "隐藏"}` : ""}`);
    if (s2.rememberWrites.length !== 0) {
      log(`  x 连点产生了额外写入 (${s2.rememberWrites.join(", ")}) —— 破坏性操作必须先确认`);
      fatal = true;
    }
    if (dup !== 1) { log(`  x 确认条重复渲染 (${dup} 个)`); fatal = true; }
    if (isSheet && !s2.sheetConfirmShown) { log("  x 面板里的确认行消失了"); fatal = true; }
    return;
  }

  if (mode === "cancel") {
    await js(`(() => { const n = document.getElementById('rememberCancel'); if (n) n.click(); return true; })()`);
    await sleep(700);
    const s2 = await state();
    note(`  点「取消」后: remember 写入 ${s2.rememberWrites.length} 次 · 已删密码 ${s2.forgot} 次 · ` +
      `主界面开关=${s2.mainSw} · 确认条=${s2.barShown ? "仍显示" : "已收起"} · 密码框字符数=${s2.passLen}`);
    if (s2.rememberWrites.length !== 0) {
      log(`  x 取消后仍然写了 remember (${s2.rememberWrites.join(", ")})`);
      fatal = true;
    }
    if (s2.forgot !== 0) { log("  x 取消后密码被删除了"); fatal = true; }
    if (s2.mainSw !== "true") { log(`  x 取消后开关没有回到"开" (aria-checked=${s2.mainSw})`); fatal = true; }
    if (s2.barShown) { log("  x 取消后确认条没有收起"); fatal = true; }
    if (!(s2.passLen > 0)) { log("  x 取消后密码框被清空了"); fatal = true; }
    return;
  }

  /* confirm / sheet: 点确认 -> 此时才允许写配置 */
  const okSel = isSheet ? "#sheetBody .confirmrow .confirmbar__btn--danger" : "#rememberConfirmOk";
  const ok = await click(okSel, 900);
  if (!ok) { log(`  x 找不到确认按钮 ${okSel}`); fatal = true; return; }
  const s3 = await state();
  note(`  点「确认关闭」后: remember 写入 ${s3.rememberWrites.length} 次 [${s3.rememberWrites.join(", ")}] · ` +
    `已删密码 ${s3.forgot} 次 · 主界面开关=${s3.mainSw} · 确认条=${s3.barShown || s3.sheetConfirmShown ? "仍显示" : "已收起"} · 密码框字符数=${s3.passLen}`);
  note(`  toast: ${JSON.stringify(s3.toasts)}`);
  if (s3.rememberWrites.length !== 1) {
    log(`  x 确认后 remember 应恰好写 1 次, 实际 ${s3.rememberWrites.length} 次 [${s3.rememberWrites.join(", ")}]`);
    fatal = true;
  } else if (s3.rememberWrites[0] !== false) {
    log(`  x 确认后写的是 ${s3.rememberWrites[0]}, 期望 false`);
    fatal = true;
  }
  if (s3.forgot < 1) { log("  x 确认关闭后没有清除已保存的密码 (主进程行为未生效)"); fatal = true; }
  if (s3.mainSw !== "false") { log(`  x 确认后主界面开关不是"关" (aria-checked=${s3.mainSw})`); fatal = true; }
  if (s3.barShown || s3.sheetConfirmShown) { log("  x 确认后确认条没有收起"); fatal = true; }
  if (s3.passLen !== 0) { log("  x 确认后密码框没有清空"); fatal = true; }
  if (!s3.toasts.some((t) => t.indexOf("已从本机删除保存的密码") >= 0)) {
    log(`  x toast 没有说明"密码已删除": ${JSON.stringify(s3.toasts)}`);
    fatal = true;
  }
  if (isSheet && s3.sheetSw !== "false") {
    log(`  x 面板开关没有跟随 (aria-checked=${s3.sheetSw})`);
    fatal = true;
  }

  /* 连点确认: 在途守卫必须挡住第二次写入 (老版本连点会产生成对写入) */
  await click(okSel, 700);
  const s3b = await state();
  if (s3b.rememberWrites.length !== 1) {
    log(`  x 连点「确认关闭」产生了额外写入: 共 ${s3b.rememberWrites.length} 次 [${s3b.rememberWrites.join(", ")}]`);
    fatal = true;
  } else {
    note("  连点「确认关闭」后仍是 1 次写入 (在途守卫生效)");
  }

  /* 两个开关必须同步: 从设置面板关掉后, 主界面那个也必须是"关"; 反之亦然 */
  if (!isSheet) {
    await js(`(() => { const b = document.querySelector('button[data-sheet="settings"]'); if (b) b.click(); return true; })()`);
    await sleep(800);
    const s4 = await state();
    note(`  打开设置面板复核同步: 面板里的「记住密码」开关=${s4.sheetSw} (期望 false)`);
    if (s4.sheetSw !== "false") {
      log("  x 两个「记住密码」开关不同步 (面板里的那个没跟上配置)");
      fatal = true;
    }
    await js(`(() => { const c = document.getElementById('sheetClose'); if (c) c.click(); return true; })()`);
    await sleep(700);
  }
}


/* ----------------------------------------------------- 对比度自检 (WCAG) ----------
   直接在截图位图上量像素, 不是读 CSS 值:
     bg = 元素框里出现最多的颜色 (文字像素只占少数)
     fg = 与 bg 亮度差最远、且出现 >= 2 像素的颜色 (抗锯齿不会比文字本色更极端)
   这样"灰字压花背景"这类问题会如实反映成一个很低的对比度数字。 */

function srgbChannel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function relLum(rgb) {
  return 0.2126 * srgbChannel(rgb[0]) + 0.7152 * srgbChannel(rgb[1]) + 0.0722 * srgbChannel(rgb[2]);
}
function contrastRatio(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function parseCssColor(str) {
  const m = /rgba?\(([^)]+)\)/.exec(String(str));
  if (!m) return null;
  const p = m[1].split(",").map((s) => parseFloat(s));
  if (p.length < 3 || p.some((v) => !Number.isFinite(v))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function hexOf(rgb) {
  return "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/**
 * 位图方向自检: 靠纯色底板上那条 3px 洋红标定线。它本来就在窗口最顶端,
 * 如果读出来落在下半部分, 说明 toBitmap() 是自下而上, 后续取样要翻 y。
 */
function detectFlipY(bitmap, imgW, imgH) {
  let sumY = 0, n = 0;
  for (let y = 0; y < imgH; y++) {
    for (let x = 0; x < imgW; x += 2) {
      const i = (y * imgW + x) * 4;
      if (bitmap[i] > 200 && bitmap[i + 1] < 90 && bitmap[i + 2] > 200) { sumY += y; n++; }
    }
  }
  if (n < 20) return { marker: 0, flip: false, meanY: null };
  const meanY = sumY / n;
  return { marker: n, meanY: Math.round(meanY), flip: meanY > imgH / 2 };
}

/**
 * 量一个元素的对比度。
 *   fg = 取样框内与底色亮度差最远的、出现 >= 2 像素的颜色 (抗锯齿不会比文字本色更极端)
 *   bg = 取样框"外圈"(四周各扩 4px 后挖掉内框)里出现最多的颜色 —— 用外圈是为了
 *        避开"文字很密、占了框内多数像素"的元素 (例如主按钮上的白字)。
 */
function measureContrast(bitmap, imgW, imgH, item, offX, offY, flipY) {
  const rx = item.rect[0] + offX;
  const ry = item.rect[1] + offY;
  const rw = item.rect[2], rh = item.rect[3];
  const x0 = Math.max(0, rx), x1 = Math.min(imgW, rx + rw);
  const ay0 = Math.max(0, ry), ay1 = Math.min(imgH, ry + rh);
  if (x1 - x0 < 2 || ay1 - ay0 < 2) return null;

  const PADP = 4;
  const bx0 = Math.max(0, x0 - PADP), bx1 = Math.min(imgW, x1 + PADP);
  const by0 = Math.max(0, ay0 - PADP), by1 = Math.min(imgH, ay1 + PADP);

  const rowOf = (y) => (flipY ? (imgH - 1 - y) : y);
  const histAll = new Map();
  const histRing = new Map();
  const bump = (map, row, x) => {
    const i = (row * imgW + x) * 4;
    const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let e = map.get(key);
    if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; map.set(key, e); }
    e.n++; e.r += r; e.g += g; e.b += b;
  };
  for (let y = by0; y < by1; y++) {
    const row = rowOf(y);
    for (let x = bx0; x < bx1; x++) {
      bump(histAll, row, x);
      const inInner = (x >= x0 && x < x1 && y >= ay0 && y < ay1);
      if (!inInner) bump(histRing, row, x);
    }
  }
  const modeOf = (map) => {
    let m = null;
    for (const e of map.values()) if (!m || e.n > m.n) m = e;
    return m ? [m.r / m.n, m.g / m.n, m.b / m.n] : null;
  };
  let ringN = 0;
  for (const e of histRing.values()) ringN += e.n;
  let bg = null;
  if (ringN >= 30) bg = modeOf(histRing);
  if (!bg) {
    // 外圈太薄 (元素紧贴其他控件) 时退回: 排除"最亮桶"后的众数
    const sorted = Array.from(histAll.values()).sort((a, b) => b.n - a.n);
    const m = sorted.length > 1 ? sorted[1] : sorted[0];
    bg = m ? [m.r / m.n, m.g / m.n, m.b / m.n] : [0, 0, 0];
  }
  const bgL = relLum(bg);
  const cc = parseCssColor(item.color) || { r: 255, g: 255, b: 255 };
  const lightText = relLum([cc.r, cc.g, cc.b]) >= bgL;
  let fg = null, fgL = null;
  for (const e of histAll.values()) {
    if (e.n < 2) continue;
    const c = [e.r / e.n, e.g / e.n, e.b / e.n];
    const l = relLum(c);
    if (!fg) { fg = c; fgL = l; continue; }
    if (lightText ? l > fgL : l < fgL) { fg = c; fgL = l; }
  }
  if (!fg) { fg = bg; fgL = bgL; }
  return { ratio: contrastRatio(fg, bg), fg, bg, lightText };
}

/**
 * 对一张不透明截图跑一遍对比度自检。
 * @param {{floor?: number, strict?: boolean}} opt
 *   floor  = 全局硬底线 (低于它一律算致命)
 *   strict = true 时"没到 target"也算致命; false 时只在日志里列 FAIL (极限壁纸压力测试用)
 */
function analyzeContrast(image, items, offX, offY, tag, logFn, verbose, opt) {
  const o = opt || {};
  const gFloor = o.floor || 0;
  const strict = o.strict !== false;
  let bitmap, size;
  try {
    bitmap = image.toBitmap();
    size = image.getSize();
  } catch (err) {
    logFn(`  ! 对比度自检取位图失败 (${tag}): ${err && err.message}`);
    return { results: [], fail: 0, min: null };
  }
  const imgW = size.width, imgH = size.height;
  const flip = detectFlipY(bitmap, imgW, imgH);
  const results = [];
  items.forEach((it) => {
    const m = measureContrast(bitmap, imgW, imgH, it, offX, offY, flip.flip);
    if (m) results.push(Object.assign({}, it, m));
  });
  if (!results.length) return { results: [], fail: 0, min: null };

  let fail = 0;      // 致命 (低于硬底线, 或严格模式下低于 target)
  let miss = 0;      // 未达 WCAG 目标 (含软目标)
  let min = null;
  results.forEach((r) => {
    const hard = o.ignoreItemFloor ? gFloor : Math.max(r.floor === undefined ? r.target : r.floor, gFloor);
    const belowFloor = r.ratio < hard;
    const belowTarget = r.ratio < r.target;
    const bad = belowFloor || (strict && belowTarget && !r.soft);
    if (belowTarget) miss++;
    if (bad) fail++;
    if (!min || r.ratio < min.ratio) min = r;
    if (verbose || belowTarget) {
      const mark = bad ? "FAIL" : (belowTarget ? "FAIL" : "PASS");
      const why = bad ? "  <== 致命" : (belowTarget ? `  <== 未达目标(底线 ${hard.toFixed(1)}, 软目标${r.soft ? "" : "无"})` : "");
      logFn(`    ${mark} ${r.sel.padEnd(30)} ${r.ratio.toFixed(2)}:1 (目标 ${r.target.toFixed(1)}) ` +
        `fg ${hexOf(r.fg)} / bg ${hexOf(r.bg)} ${r.lightText ? "浅字" : "深字"}${why}`);
    }
  });
  logFn(`  对比度[${tag}]: 检查 ${results.length} 项 · 最低 ${min.ratio.toFixed(2)}:1 (${min.sel})` +
    ` · 未达目标 ${miss} 项 · 致命 ${fail} 项${strict ? "" : " (压力测试: 只按硬底线判致命)"}` +
    `${flip.marker ? "" : " · 无标定线(单向取样)"}${flip.flip ? " · 位图上下翻转(已校正)" : ""}`);
  return { results, fail, miss, min };
}

/** 在页面里插入 / 移除合成底板, 并把 body 下移 PAD 像素 */function backdropScript(action, theme, panelH) {
  const pad = PAD;
  const h = panelH || 692;
  if (action === "on") {
    return `(() => {
      const doc = document.documentElement;
      doc.style.width = '${452 + pad * 2}px';
      doc.style.height = '${h + pad * 2}px';
      document.body.style.position = 'absolute';
      document.body.style.top = '${pad}px';
      document.body.style.left = '${pad}px';
      let bd = document.getElementById('preview-backdrop');
      if (!bd) {
        bd = document.createElement('div');
        bd.id = 'preview-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;' +
          'background:${BACKDROPS[theme] || BACKDROPS.dark};';
        document.body.appendChild(bd);
      }
      return true;
    })()`;
  }
  return `(() => {
    const bd = document.getElementById('preview-backdrop');
    if (bd) bd.remove();
    document.documentElement.style.width = '';
    document.documentElement.style.height = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    return true;
  })()`;
}

/* --------------------------------------------------------------- 窗口 */

function createWindow(scenario, offscreen) {
  const win = new BrowserWindow({
    // 无边框窗口的客户区会比设定值大 1px (Chromium/Windows), 这里补偿
    width: 451,
    height: 691,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: "HAUT Guard Preview",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
      zoomFactor: 1,
      // offscreen 渲染: 不依赖窗口合成器, capturePage 永远拿得到帧 (可见窗口在
      // Windows 上偶发 "Current display surface not available for capture")
      offscreen: !!offscreen,
      // preload 里读不到 hash, 用命令行参数把场景传给 preview-preload
      additionalArguments: [
        `--haut-scenario=${scenario.name}`,
        `--haut-theme=${scenario.theme}`,
      ],
    },
  });

  if (offscreen) {
    win.webContents.setFrameRate(30);
    // offscreen 窗口也要对齐视口尺寸, 否则会停在构造尺寸上(实测会差 32px)
    win.setContentSize(452, 692);
  } else {
    win.setMenuBarVisibility(false);
    win.showInactive();
    win.setContentSize(452, 692);
  }
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.webContents.on("console-message", (event) => {
    const level = typeof event.level === "number" ? event.level : 0;
    const entry = {
      level,
      message: String(event.message === undefined ? "" : event.message),
      source: event.sourceId || "",
      line: event.lineNumber || 0,
    };
    consoleLog.push(entry);
    if (isException(entry)) exceptionCount++;
    // 异常无论如何都要打出来 (Chromium 有时把 Uncaught 归到 LOG 级)
    if (level >= 2 || isException(entry)) {
      const loc = entry.source ? ` (${path.basename(entry.source)}:${entry.line})` : "";
      log(`    [${isException(entry) ? "EXCEPTION" : levelBadge(level)}] ${entry.message}${loc}`);
    }
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    log(`  x 渲染进程结束: reason=${details && details.reason} exitCode=${details && details.exitCode}`);
    if (!details || details.reason !== "clean-exit") fatal = true;
  });
  win.webContents.on("unresponsive", () => { log("  x 渲染进程无响应"); fatal = true; });
  win.webContents.on("preload-error", (_e, preloadPath, error) => {
    log(`  x preload 出错: ${preloadPath} -> ${error && error.message}`);
    fatal = true;
  });

  return win;
}

/* --------------------------------------------------------------- 单场景 */

async function captureScenario(scenario, opts, outDir) {
  const url = `${pathToFileURL(INDEX).href}#scenario=${encodeURIComponent(scenario.name)}&theme=${scenario.theme}`;
  const before = consoleLog.length;
  const appW = 452;
  const appH = 692;

  log(`\n> [${scenario.name}] ${scenario.desc}  (theme=${scenario.theme})`);

  const win = createWindow(scenario, opts.offscreen);

  /* offscreen 模式下用 paint 事件收集帧, 这是最可靠的取图方式 */
  const frames = [];
  if (opts.offscreen) {
    win.webContents.on("paint", (_e, _dirty, image) => {
      if (image && !image.isEmpty()) {
        frames.push(image);
        if (frames.length > 6) frames.shift();
      }
    });
  }

  if (!opts.offscreen) win.setContentSize(appW, appH);
  await sleep(60);

  const loaded = new Promise((resolve) => {
    win.webContents.once("did-finish-load", () => resolve(true));
    win.webContents.once("did-fail-load", (_e, code, desc, validatedURL) => {
      log(`  x 页面加载失败: ${code} ${desc} ${validatedURL}`);
      fatal = true;
      resolve(false);
    });
  });

  win.loadURL(url).catch((err) => {
    log(`  x loadURL 抛错: ${err && err.message}`);
    fatal = true;
  });

  if (!(await loaded)) { win.destroy(); await sleep(300); return null; }
  log("  - did-finish-load");

  /* 冻结氛围光斑动画: 光斑本来 26~38s 漂移一圈, 会让"同一元素在不同场景/不同时刻"的
     背景像素完全不同 (对比度自检就没法复现了)。截图 harness 需要可复现的像素。 */
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.aura__blob').forEach((b) => { b.style.animation = 'none'; });
    return true;
  })()`).catch(() => {});

  await sleep(scenario.wait !== undefined ? scenario.wait : opts.wait);

  // 尺寸 + 场景 + 布局自检 (必须在窗口仍是 420x660 时读取)
  const probe = await win.webContents.executeJavaScript(`(() => {
    const s = document.querySelector('.scroll');
    const hero = document.getElementById('hero');
    const label = document.getElementById('stateLabel');
    const stack = document.querySelector('.stack');
    const parts = {};
    document.querySelectorAll('.stack > *').forEach((n) => {
      const k = n.id || String(n.className).split(' ')[0];
      parts[k] = Math.round(n.getBoundingClientRect().height);
    });
    return {
      w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
      scrollH: s ? s.scrollHeight : 0, clientH: s ? s.clientHeight : 0,
      stackH: stack ? Math.round(stack.getBoundingClientRect().height) : 0,
      parts,
      boxes: (() => {
        const o = {};
        ['.scroll', '.hero', '.metrics', '.spark', '.spark__canvas', '.spark__empty',
         '.form', '.switches', '.primary', '.foot', '.titlebar'].forEach((sel) => {
          const n = document.querySelector(sel);
          if (!n) return;
          const r = n.getBoundingClientRect();
          o[sel] = [Math.round(r.top), Math.round(r.height)];
        });
        return o;
      })(),
      // 账号区渲染自检: 有账号时不应显示「未添加账号」; 头像必须是列表序号
      accounts: {
        count: (window.__view && window.__view.accounts) ? window.__view.accounts.length : -1,
        activeId: (window.__view && window.__view.activeAccountId) || null,
        avatar: (document.getElementById('acctAvatar') || {}).textContent,
        avatarWanted: (() => {
          const v = window.__view || {};
          const list = v.accounts || [];
          const i = list.findIndex((a) => a.id === v.activeAccountId);
          if (list.length === 0) return '＋';
          return String(i >= 0 ? i + 1 : 1);
        })(),
        rows: Array.from(document.querySelectorAll('#acctList .acctrow__avatar')).map((n) => n.textContent),
        name: (document.getElementById('acctName') || {}).textContent,
        sub: (document.getElementById('acctSub') || {}).textContent,
      },
      // 密码框自检: 只看 type / 长度 / placeholder, 绝不打印明文
      pass: (() => {
        const p = document.getElementById('inputPass');
        if (!p) return null;
        return { type: p.type, len: String(p.value || '').length, placeholder: p.placeholder };
      })(),
      // 特写图要用的元素矩形 (视口坐标, 与截图 1:1)
      zoomRects: (() => {
        const out = {};
        ${JSON.stringify(ZOOM_SELECTORS)}.forEach((sel) => {
          const n = document.querySelector(sel);
          if (!n) { out[sel] = null; return; }
          const r = n.getBoundingClientRect();
          out[sel] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
        });
        return out;
      })(),
      // 对比度自检的取样框 (共享脚本, 见 contrastCollectScript)
      contrast: ${contrastCollectScript()},
      // 主题色自检: <html> 上的属性 + 实际生效的 CSS 变量 + 色板选中项
      accent: (() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          attr: document.documentElement.dataset.accent || '',
          accent: cs.getPropertyValue('--accent').trim(),
          accent2: cs.getPropertyValue('--accent-2').trim(),
          glow: cs.getPropertyValue('--accent-glow').trim(),
          blob1: cs.getPropertyValue('--blob-1').trim(),
          blob2: cs.getPropertyValue('--blob-2').trim(),
          swatchOn: Array.from(document.querySelectorAll('.swatch.is-on')).map((n) => n.dataset.accent),
          swatchCount: document.querySelectorAll('.swatch').length,
          lightDot: (() => {
            const d = document.querySelector('.titlebar__dot');
            return d ? getComputedStyle(d).backgroundColor : '';
          })(),
          // 强调色是否真的落到了"开启态开关"与主按钮上 (不能只改变量名不落地)
          // 开启态的文字/图标用 --accent-ink(强调色的"当文字"变体), 填充/发光仍是 --accent
          ink: cs.getPropertyValue('--accent-ink').trim(),
          swOnColor: (() => {
            const n = document.querySelector('.sw[aria-checked="true"]');
            return n ? getComputedStyle(n).color : '';
          })(),
          swOnGlow: (() => {
            const n = document.querySelector('.sw[aria-checked="true"] .sw__hi');
            return n ? getComputedStyle(n).boxShadow.slice(-64) : '';
          })(),
          primaryBg: (() => {
            const n = document.getElementById('mainBtn');
            return n ? getComputedStyle(n).backgroundImage.slice(0, 96) : '';
          })(),
        };
      })(),
      // 窗口按钮风格自检
      chrome: (() => {
        const lights = document.querySelector('.lights');
        const ctl = document.querySelector('.wincontrols');
        const btn = document.querySelector('#mainBtn');
        return {
          attr: document.documentElement.dataset.chrome || '',
          lightsShown: !!(lights && lights.offsetParent !== null),
          controlsShown: !!(ctl && ctl.offsetParent !== null),
          buttons: ctl ? Array.from(ctl.querySelectorAll('button')).map((b) => b.dataset.win) : [],
          drag: getComputedStyle(document.getElementById('titlebar')).webkitAppRegion,
          noDrag: ctl ? getComputedStyle(ctl).webkitAppRegion : '',
          primaryVisible: !!(btn && btn.getBoundingClientRect().height > 0),
        };
      })(),
      // 首屏关键路径可见性: 学号框 / 密码框必须完整位于底部操作栏之上
      critical: (() => {
        const bar = document.getElementById('actionbar');
        const user = document.getElementById('fieldUser');
        const pass = document.getElementById('fieldPass');
        const primary = document.getElementById('mainBtn');
        const menu = document.getElementById('acctMenu');
        if (!bar || !user || !pass || !primary) return null;
        const barTop = Math.round(bar.getBoundingClientRect().top);
        const uR = user.getBoundingClientRect();
        const pR = pass.getBoundingClientRect();
        const mR = primary.getBoundingClientRect();
        // 下拉列表"可达性": 还可以往下滚多少, 滚到底后列表底是否落在操作栏之上
        const scrollNode = document.getElementById('scroll');
        const scrollable = scrollNode ? (scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop) : 0;
        const menuBottomNow = (menu && !menu.hidden) ? Math.round(menu.getBoundingClientRect().bottom) : null;
        return {
          barTop,
          viewportH: window.innerHeight,
          userBottom: Math.round(uR.bottom),
          passBottom: Math.round(pR.bottom),
          menuBottom: menuBottomNow,
          scrollable: Math.round(scrollable),
          menuReachable: menuBottomNow === null ? null : (menuBottomNow - scrollable) <= barTop + 1,
          userVisible: uR.bottom <= barTop + 1 && uR.top >= 0,
          passVisible: pR.bottom <= barTop + 1 && pR.top >= 0,
          primaryVisible: mR.top >= 0 && mR.bottom <= window.innerHeight + 1 && mR.height > 0,
        };
      })(),
      // 开关条自检: 结构 (role/aria/高亮层) + 开/关数量 + 高亮胶囊几何
      switchbar: (() => {
        const bar = document.getElementById('switchBar');
        if (!bar) return null;
        const items = Array.from(bar.querySelectorAll('.sw'));
        const br = bar.getBoundingClientRect();
        const rows = items.map((n) => {
          const r = n.getBoundingClientRect();
          const pill = n.querySelector('.sw__hi');
          const pr = pill ? pill.getBoundingClientRect() : null;
          const ico = n.querySelector('.sw__ico');
          const ir = ico ? ico.getBoundingClientRect() : null;
          const txt = n.querySelector('.sw__text');
          const tr = txt ? txt.getBoundingClientRect() : null;
          const cs = pill ? getComputedStyle(pill) : null;
          return {
            id: n.id,
            role: n.getAttribute('role'),
            checked: n.getAttribute('aria-checked'),
            disabled: !!n.disabled,
            hasPill: !!pill,
            pillOpacity: cs ? Number(cs.opacity) : null,
            // 胶囊距容器内壁的缩进 (左/上), 以及胶囊尺寸
            insetLeft: pr ? Math.round(pr.left - br.left) : null,
            insetTop: pr ? Math.round(pr.top - br.top) : null,
            pillW: pr ? Math.round(pr.width) : null,
            pillH: pr ? Math.round(pr.height) : null,
            icoSize: ir ? [Math.round(ir.width), Math.round(ir.height)] : null,
            gapIcoText: (ir && tr) ? Math.round(tr.top - ir.bottom) : null,
          };
        });
        const cs = getComputedStyle(bar);
        return {
          barRadius: cs.borderRadius,
          barH: Math.round(br.height),
          barTop: Math.round(br.top),
          barLeft: Math.round(br.left),
          barW: Math.round(br.width),
          onCount: rows.filter((r) => r.checked === 'true').length,
          offCount: rows.filter((r) => r.checked === 'false').length,
          rows,
        };
      })(),
      state: hero && hero.dataset ? hero.dataset.state : '',
      label: label ? label.textContent : '',
      scenario: (window.__preview && window.__preview.scenario) || ''
    };
  })()`).catch((err) => {
    log(`  ! 尺寸探测失败: ${err && err.message}`);
    return null;
  });

  /* 设置面板协议自检: 只能有一个「登录协议」组合控件, 且不得再暴露原始字段名/坏组合 */
  if (SETTINGS_SCENES.includes(scenario.name)) {
    const proto = await win.webContents.executeJavaScript(`(() => {
      const rows = Array.from(document.querySelectorAll('#sheetBody .row'));
      const row = rows.find((r) => {
        const b = r.querySelector('.row__label b');
        return b && b.textContent === '登录协议';
      });
      const seg = row ? row.querySelector('.seg') : null;
      const on = seg ? seg.querySelector('button.is-on') : null;
      const body = (document.getElementById('sheetBody') || {}).innerText || '';
      return {
        found: !!row,
        options: seg ? Array.from(seg.querySelectorAll('button')).map((b) => b.textContent) : [],
        selected: on ? on.textContent : null,
        leaksRaw: /密码算法|流量信息格式|\\bsrun3\\b|\\bsrbx1\\b/.test(body),
        rowText: row ? row.textContent : '',
        tips: Array.from(document.querySelectorAll('#sheetBody .hintline')).map((n) => n.textContent),
      };
    })()`).catch(() => null);
    if (proto) {
      log(`  登录协议控件: options=[${proto.options.join(", ")}] 选中="${proto.selected}"`);
      log(`  面板提示行: ${JSON.stringify(proto.tips)}`);
      if (!proto.found || proto.options.length !== 2) {
        log("  x 设置面板缺少合并后的「登录协议」控件");
        fatal = true;
      } else if (!proto.selected) {
        log("  x 「登录协议」没有选中项");
        fatal = true;
      } else if (proto.leaksRaw) {
        log("  x 设置面板仍在暴露 passwordAlgo / infoFormat 原始字段或已废弃取值");
        fatal = true;
      } else if (proto.rowText.indexOf("本网关实测可用") < 0) {
        log("  x 「登录协议」未标明本网关实测可用");
        fatal = true;
      } else if (!proto.tips.some((t) => t.indexOf("标准（推荐）") >= 0)) {
        log("  x 设置面板底部缺少「若提示密码错误，请先确认此处为标准」的灰字提示");
        fatal = true;
      }
      const wantsRisk = scenario.name === "settings-legacy";
      const hasRisk = proto.tips.some((t) => t.indexOf("不支持旧版协议") >= 0);
      if (wantsRisk && !hasRisk) {
        log("  x 选中「旧版（排障用）」时缺少「本网关实测不支持旧版协议」的风险警告");
        fatal = true;
      }
      if (!wantsRisk && hasRisk) {
        log("  x 「标准（推荐）」下不应出现旧版协议的风险警告");
        fatal = true;
      }
      if (wantsRisk && String(proto.selected).indexOf("旧版") < 0) {
        log(`  x 旧版协议场景未选中「旧版（排障用）」: ${proto.selected}`);
        fatal = true;
      }
    }
  }

  /* 附加面板验证: 打开诊断/关于面板, 确认渲染无异常 (不在 10 个必需场景内) */
  if (probe && (scenario.name === "settings" || scenario.name === "logs")) {
    for (const sheet of ["diag", "about"]) {
      await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('button[data-sheet="${sheet}"]');
        if (btn) btn.click();
        return true;
      })()`).catch(() => {});
      await sleep(1100);
      const r = await win.webContents.executeJavaScript(`(() => {
        const body = document.getElementById('sheetBody');
        if (!body) return 'no-body';
        const txt = (body.innerText || '').replace(/\\n/g, ' | ').trim();
        return txt ? txt.slice(0, 150) : '(面板内容为空!)';
      })()`).catch((err) => `ERR ${err && err.message}`);
      log(`  附加面板 ${sheet}: ${r}`);
      if (typeof r === "string" && r.indexOf("面板内容为空") >= 0) {
        log(`  x 面板 ${sheet} 渲染为空`);
        fatal = true;
      }
    }
    // 关闭面板, 恢复场景原有画面
    await win.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('sheetClose');
      if (c) c.click();
      return true;
    })()`).catch(() => {});
    await sleep(420);
  }

  /* 场景本身要展示某个面板时: 上面为了验证 diag/about 把面板关掉了,
     这里重新打开 (并滚到内容底部), 让截图真正反映该面板的样子。 */
  if (SHEET_OF_SCENE[scenario.name]) {
    await win.webContents.executeJavaScript(`(() => {
      const c = document.getElementById('sheetClose');
      if (c) c.click();
      return true;
    })()`).catch(() => {});
    // 必须等过 closeSheet 的 340ms 收尾定时器, 否则它会把刚重新打开的面板又藏起来
    await sleep(700);
    await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('button[data-sheet="${SHEET_OF_SCENE[scenario.name]}"]');
      if (btn) btn.click();
      return true;
    })()`).catch(() => {});
    await sleep(820);
    if (SETTINGS_SCENES.includes(scenario.name)) {
      await win.webContents.executeJavaScript(`(() => {
        const body = document.getElementById('sheetBody');
        if (body) body.scrollTop = body.scrollHeight;
        return true;
      })()`).catch(() => {});
      await sleep(420);
    }
  }

  /* id 落地自查: app.js 的 dom 映射里每个 key 都必须能在 HTML 里找到对应 id。
     这类不匹配会在真实运行中退化成「每秒一次 Uncaught TypeError」。 */
  const idAudit = await win.webContents.executeJavaScript(`(() => {
    const missing = [];
    const all = new Set(Array.from(document.querySelectorAll('[id]')).map((n) => n.id));
    // 由 app.js 暴露的 dom 映射 key 列表 (见 window.__domKeys)
    const keys = (window.__domKeys && window.__domKeys.length) ? window.__domKeys : [];
    keys.forEach((k) => { if (k !== 'html' && !all.has(k)) missing.push(k); });
    return { missing, keyCount: keys.length, idCount: all.size };
  })()`).catch(() => null);
  if (idAudit) {
    if (idAudit.missing.length) {
      log(`  x id 落地自查失败: app.js 引用了 ${idAudit.missing.length} 个不存在的 id -> ${idAudit.missing.join(", ")}`);
      fatal = true;
    } else if (idAudit.keyCount) {
      log(`  id 自查通过: dom 映射 ${idAudit.keyCount} 个 key, HTML 共 ${idAudit.idCount} 个 id, 无缺失`);
    }
  }

  if (probe && (Math.abs(probe.w - 452) > 2 || Math.abs(probe.h - 692) > 2)) {
    log(`  ! 应用视口并非 452x692 (实际 ${probe.w}x${probe.h}, dpr=${probe.dpr})`);
    fatal = true;
  }
  if (probe) {
    log(`  状态自检: hero=${probe.state || "(空)"} label=${probe.label} scenario=${probe.scenario}`);
    const fold = probe.scrollH > probe.clientH
      ? `滚动区内容 ${probe.scrollH}px / 可视 ${probe.clientH}px -> 需滚动 ${probe.scrollH - probe.clientH}px`
      : "滚动区内容完全在可视范围内 (无需滚动)";
    log(`  ${fold}`);
    log(`  区块高度: ${JSON.stringify(probe.parts)} (stack=${probe.stackH})`);
    if (probe.accounts) {
      const a = probe.accounts;
      log(`  账号区: count=${a.count} activeId=${a.activeId} avatar="${a.avatar}" (期望 "${a.avatarWanted}") name="${a.name}" sub="${a.sub}"`);
      if (a.rows.length) log(`  下拉行头像: [${a.rows.join(", ")}]`);
      if (a.count > 0 && String(a.name).indexOf("未添加") >= 0) {
        log("  x 账号区渲染异常: 快照里有账号, 按钮却显示「未添加账号」");
        fatal = true;
      }
      // 头像必须是「账号序号」而不是用户名首字符
      if (/^\d+$/.test(String(a.avatarWanted)) && String(a.avatar) !== String(a.avatarWanted)) {
        log(`  x 账号头像不是序号: 实际 "${a.avatar}", 期望 "${a.avatarWanted}"`);
        fatal = true;
      }
      if (a.rows.length && a.rows.some((t, i) => String(t) !== String(i + 1))) {
        log(`  x 下拉头像序号不连续: [${a.rows.join(", ")}]`);
        fatal = true;
      }
    }
    if (probe.pass) {
      const p = probe.pass;
      const want = PASS_EXPECT[scenario.name];
      log(`  密码框: type=${p.type} 字符数=${p.len} placeholder="${p.placeholder}" (期望 ${want || "-"})`);
      if (want === "dots" && (p.type !== "password" || p.len === 0)) {
        log("  x 密码框未显示为点状 (期望 type=password 且有值)");
        fatal = true;
      }
      if (want === "missing" && (p.len !== 0 || p.placeholder.indexOf("重新输入") < 0)) {
        log("  x 凭据不可解密时未静默降级 (期望空值 + placeholder 提示重新输入)");
        fatal = true;
      }
      if (want === "empty" && (p.len !== 0 || p.placeholder.indexOf("重新输入") >= 0)) {
        log("  x 无已保存密码时密码框状态不对 (期望空值 + 默认 placeholder)");
        fatal = true;
      }
    }
    log(`  元素位置[top,height]: ${JSON.stringify(probe.boxes)}`);
    if (probe.scenario && probe.scenario !== scenario.name) {
      log(`  x 场景未生效! 期望 ${scenario.name}, 实际 ${probe.scenario}`);
      fatal = true;
    }
  }

  /* ---- 断言: 主题色 (data-accent -> --accent / 氛围光斑) ---- */
  if (probe && probe.accent) {
    const a = probe.accent;
    const want = scenario.accent || "cyan";
    const wantHex = (ACCENT_HEX[scenario.theme] || ACCENT_HEX.dark)[want];
    log(`  主题色: data-accent=${a.attr || "(空)"} --accent=${a.accent} --accent-2=${a.accent2} --accent-ink=${a.ink} 光斑1=${a.blob1}`);
    log(`    落地: 开启态开关色=${a.swOnColor} · 主按钮底=${a.primaryBg}`);
    log(`    色板: ${a.swatchCount} 个色块, 选中 [${a.swatchOn.join(", ") || "无"}]`);
    // 强调色必须真的落到开启态开关的图标/文字上 (不能只改 CSS 变量名)。
    // 文字用 ink 变体(压深/提亮到可读), 所以这里跟 --accent-ink 比, 而不是跟亮强调色比。
    const norm = (c) => {
      const s = String(c || "").trim();
      const m = /^#([0-9a-f]{6})$/i.exec(s);
      if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).join(",");
      const r = /rgba?\(([^)]+)\)/.exec(s);
      return r ? r[1].split(",").slice(0, 3).map((v) => Math.round(parseFloat(v))).join(",") : s;
    };
    if (a.swOnColor && norm(a.swOnColor) !== norm(a.ink)) {
      log(`  x 开启态开关没有跟随强调色 ink: 实际 ${a.swOnColor}, 期望 ${a.ink}`);
      fatal = true;
    }
    if (!a.ink) {
      log("  x 缺少 --accent-ink (强调色当文字用的可读变体)");
      fatal = true;
    }
    if (a.attr !== want) {
      log(`  x data-accent 未生效: 实际 "${a.attr}", 期望 "${want}"`);
      fatal = true;
    }
    if (String(a.accent).toLowerCase() !== String(wantHex).toLowerCase()) {
      log(`  x --accent 未随主题色变化: 实际 "${a.accent}", 期望 "${wantHex}" (${scenario.theme}/${want})`);
      fatal = true;
    }
    if (!a.blob1 || a.blob1 === "rgba(0, 0, 0, 0)") {
      log("  x 氛围光斑颜色未解析到 (--blob-1 为空)");
      fatal = true;
    }
    // 非默认主题色时, 光斑必须真的换了颜色 (不能只改强调色)
    if (want !== "cyan" && a.blob1.indexOf("56, 201, 240") >= 0) {
      log("  x 主题色已切换但氛围光斑仍是青蓝默认值");
      fatal = true;
    }
  }

  /* ---- 断言: 窗口按钮风格 (mac 交通灯 / windows 右上角 ─ ✕) ---- */
  if (probe && probe.chrome) {
    const c = probe.chrome;
    const wantChrome = scenario.chrome || "mac";
    log(`  窗口按钮: data-chrome=${c.attr || "(空)"} 交通灯=${c.lightsShown ? "显示" : "隐藏"} ` +
      `右上角按钮=${c.controlsShown ? `显示 [${c.buttons.join(", ")}]` : "隐藏"} ` +
      `标题栏拖动=${c.drag} 按钮区=${c.noDrag}`);
    if (c.attr !== wantChrome) {
      log(`  x data-chrome 未生效: 实际 "${c.attr}", 期望 "${wantChrome}"`);
      fatal = true;
    }
    if (c.drag !== "drag") {
      log(`  x 标题栏不是拖动区 (-webkit-app-region=${c.drag})`);
      fatal = true;
    }
    if (wantChrome === "windows") {
      if (c.lightsShown) { log("  x Windows 模式下左上角仍显示红黄绿交通灯"); fatal = true; }
      if (!c.controlsShown) { log("  x Windows 模式下右上角窗口按钮未显示"); fatal = true; }
      if (c.buttons.join(",") !== "minimize,close") {
        log(`  x Windows 窗口按钮不是 [最小化, 关闭]: [${c.buttons.join(", ")}]`);
        fatal = true;
      }
      if (c.noDrag !== "no-drag") { log("  x 窗口按钮区没有 no-drag (会拖动窗口)"); fatal = true; }
    } else {
      if (!c.lightsShown) { log("  x Mac 模式下交通灯未显示"); fatal = true; }
      if (c.controlsShown) { log("  x Mac 模式下不应显示 Windows 窗口按钮"); fatal = true; }
    }
  }

  /* ---- 主题色板: 依次点 7 个色块, 断言"切换后 CSS 变量确实变化"且写入配置 ---- */
  if (probe && scenario.accentSwitchTest) {
    const seq = ["cyan", "blue", "violet", "green", "amber", "pink", "red"];
    const table = [];
    let switched = 0;
    for (const name of seq) {
      const r = await win.webContents.executeJavaScript(`(async () => {
        const btn = document.querySelector('.swatch[data-accent="${name}"]');
        if (!btn) return { ok: false, reason: '缺少色块' };
        const before = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        btn.click();
        await new Promise((res) => setTimeout(res, 280));
        const after = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
        const on = document.querySelector('.swatch.is-on');
        return {
          ok: true, before, after,
          on: on ? on.dataset.accent : null,
          attr: document.documentElement.dataset.accent,
          saved: (window.__view && window.__view.config && window.__view.config.accent) || null,
          blob: getComputedStyle(document.documentElement).getPropertyValue('--blob-1').trim(),
          pressed: btn.getAttribute('aria-pressed'),
        };
      })()`).catch(() => null);
      if (!r || !r.ok) {
        log(`  x 主题色板点击自检失败: ${name} ${r ? r.reason : "脚本异常"}`);
        fatal = true;
        continue;
      }
      const wantHex = ACCENT_HEX.light[name];
      const changed = r.before !== r.after;
      if (changed) switched++;
      const good = changed && String(r.after).toLowerCase() === wantHex.toLowerCase() &&
        r.attr === name && r.on === name && r.saved === name;
      table.push(`    ${name.padEnd(7)} ${r.before} -> ${r.after} (期望 ${wantHex}) 选中=${r.on} 已保存=${r.saved} 光斑=${r.blob}${good ? "" : "  <== 不达标"}`);
      if (!good) {
        log(`  x 主题色切换异常 (${name}): attr=${r.attr} on=${r.on} saved=${r.saved} after=${r.after}`);
        fatal = true;
      }
    }
    // 收尾: 停在紫罗兰, 让截图里"选中项"是中间色而不是最右一格的红色
    await win.webContents.executeJavaScript(`(async () => {
      const btn = document.querySelector('.swatch[data-accent="violet"]');
      if (btn) btn.click();
      await new Promise((res) => setTimeout(res, 300));
      return true;
    })()`).catch(() => {});
    await sleep(360);
    log(`  主题色板自检: 7 个色块中 ${switched} 个真的改变了 --accent`);
    table.forEach((line) => log(line));
    if (switched !== 7) {
      log(`  x 主题色板切换未全部生效 (${switched}/7)`);
      fatal = true;
    }
  }

  /* ---- 「记住密码」破坏性操作: 确认流程 + "点一次只写一次" 自检 ---- */
  if (scenario.rememberTest) {
    await runRememberTest(win, scenario, log);
  }

  /* ---- 断言: 开关条 (液态玻璃胶囊) 的结构与开/关两种状态 ----
     结构不完整 -> 视觉必然塌掉; MIX_SCENES 要求同时出现"开"与"关",
     这样截图/特写图才能证明两种外观的差别。 */
  if (probe && probe.switchbar) {
    const sb = probe.switchbar;
    log(`  开关条: 高 ${sb.barH}px · 圆角 ${sb.barRadius} · 开 ${sb.onCount} / 关 ${sb.offCount}`);
    sb.rows.forEach((r) => {
      log(`    ${r.id}: role=${r.role} checked=${r.checked}${r.disabled ? " (disabled)" : ""} ` +
        `胶囊[${r.hasPill ? `opacity=${r.pillOpacity} ${r.pillW}x${r.pillH} 缩进左${r.insetLeft}/上${r.insetTop}` : "缺失"}] ` +
        `图标 ${r.icoSize ? r.icoSize.join("x") : "-"} 图标↔文字间距 ${r.gapIcoText}`);
    });
    if (sb.rows.length !== 4) {
      log(`  x 开关条条目数不是 4 (实际 ${sb.rows.length})`);
      fatal = true;
    }
    sb.rows.forEach((r) => {
      if (r.role !== "switch" || (r.checked !== "true" && r.checked !== "false")) {
        log(`  x 开关条目 ${r.id} 缺少 role=switch / aria-checked 语义`);
        fatal = true;
      }
      if (!r.hasPill) {
        log(`  x 开关条目 ${r.id} 缺少高亮胶囊 .sw__hi`);
        fatal = true;
      }
      if (r.icoSize && (r.icoSize[0] < 20 || r.icoSize[1] < 20)) {
        log(`  x 开关条目 ${r.id} 图标过小 (${r.icoSize.join("x")})`);
        fatal = true;
      }
    });
    // "开"的条目: 高亮胶囊必须真的可见; "关"的条目: 必须完全不可见 (否则读不出开关状态)
    sb.rows.forEach((r) => {
      if (!r.hasPill || r.pillOpacity === null) return;
      if (r.checked === "true" && r.pillOpacity < 0.95) {
        log(`  x 开关条目 ${r.id} 已打开但高亮胶囊不可见 (opacity=${r.pillOpacity})`);
        fatal = true;
      }
      if (r.checked === "false" && r.pillOpacity > 0.05) {
        log(`  x 开关条目 ${r.id} 已关闭但高亮胶囊仍可见 (opacity=${r.pillOpacity})`);
        fatal = true;
      }
    });
    if (MIX_SCENES.includes(scenario.name) && (sb.onCount === 0 || sb.offCount === 0)) {
      log(`  x 场景 ${scenario.name} 未同时呈现"开"和"关"两种开关外观 (开 ${sb.onCount} / 关 ${sb.offCount})`);
      fatal = true;
    }
  } else if (probe) {
    log("  x 找不到开关条 (#switchBar / .switches)");
    fatal = true;
  }

  /* ---- 断言: 首屏关键路径必须完整可见 (不被底部操作栏遮挡) ----
     例外: 场景本身要求「账号下拉展开」时, 下拉列表会把表单往下推, 这是用户主动
     交互的结果, 此时只要求主按钮可见 + 下拉列表本身没有被操作栏压住。 */
  if (probe && probe.critical) {
    const c = probe.critical;
    log(`  首屏可见性: 学号框底 ${c.userBottom} · 密码框底 ${c.passBottom} · 操作栏顶 ${c.barTop} · 视口高 ${c.viewportH}`);
    if (!c.primaryVisible) {
      log("  x 主按钮未在视口内可见");
      fatal = true;
    }
    if (scenario.allowMenuOpen) {
      log(`  下拉展开场景: 列表底 ${c.menuBottom} · 可滚动余量 ${c.scrollable} · 滚到底后列表底 ${c.menuBottom === null ? "-" : c.menuBottom - c.scrollable} / 操作栏顶 ${c.barTop}`);
      if (c.menuReachable === false) {
        log("  x 账号下拉列表无法滚动到操作栏之上 (会被底部操作栏遮挡)");
        fatal = true;
      }
    } else {
      if (!c.userVisible) {
        log(`  x 学号输入框未完整可见 (底部 ${c.userBottom} > 操作栏顶 ${c.barTop})`);
        fatal = true;
      }
      if (!c.passVisible) {
        log(`  x 密码输入框未完整可见 (底部 ${c.passBottom} > 操作栏顶 ${c.barTop})`);
        fatal = true;
      }
    }
  }

  /* 默认输出: 真实 452x692 视口 (窗口保持应用尺寸, 不放大) */
  if (!opts.offscreen) {
    win.setContentSize(appW, appH);
    await sleep(600);
  } else {
    await sleep(400);
  }
  const actualSize = opts.offscreen ? [appW, appH] : win.getContentSize();
  log(`  截图前视口: ${actualSize.join("x")} (期望 ${appW}x${appH})${opts.offscreen ? " · offscreen 渲染" : ` · visible=${win.isVisible()}`}`);
  if (!opts.offscreen && (actualSize[0] !== appW || actualSize[1] !== appH)) {
    log("  x 可见窗口视口尺寸不符, 无法保证 452x692");
    fatal = true;
  }

  const shots = [];
  const viewRect = opts.native ? undefined : { x: 0, y: 0, width: appW, height: appH };
  let viewShot = null;
  if (opts.offscreen) {
    viewShot = frames.length ? frames[frames.length - 1] : null;
    if (!viewShot) {
      try {
        const img = await win.webContents.capturePage();
        if (img && !img.isEmpty()) viewShot = img;
      } catch (err) {
        log(`    offscreen capturePage 失败: ${err && err.message}`);
      }
    }
  } else {
    viewShot = await grabWithRetry(win, viewRect, log);
  }
  if (!viewShot) {
    log("  x 视口截图失败 (452x692)");
    fatal = true;
  } else {
    const file = path.join(outDir, scenario.file);
    // offscreen 渲染会多出 1px 边框, 统一裁到精确的 452x692
    const cropped = cropTo(viewShot, appW, appH);
    fs.writeFileSync(file, cropped.toPNG());
    shots.push({ file, size: cropped.getSize(), kind: "viewport" });
    log(`  v ${path.relative(ROOT, file)}  ${cropped.getSize().width}x${cropped.getSize().height} (452x692 视口)`);

    /* 特写图: 从视口图里按 1:1 裁剪再放大 (不重新 capturePage, 避免合成器抖动),
       四周留 pad 余量。开关条/底部玻璃入口/Windows 标题栏/主题色板都用它。 */
    const zoomSpecs = opts.zoom ? (ZOOM_OF_SCENE[scenario.name] || []) : [];
    zoomSpecs.forEach((spec) => {
      const rect = probe && probe.zoomRects ? probe.zoomRects[spec.sel] : null;
      if (!rect || rect[2] < 4 || rect[3] < 4) {
        log(`  ! 特写跳过: 找不到 ${spec.sel}`);
        return;
      }
      const zx = Math.max(0, rect[0] - spec.pad);
      const zy = Math.max(0, rect[1] - spec.pad);
      const zw = Math.min(appW - zx, rect[2] + spec.pad * 2);
      const zh = Math.min(appH - zy, rect[3] + spec.pad * 2);
      try {
        let zimg = cropped.crop({ x: zx, y: zy, width: zw, height: zh });
        if (spec.scale !== 1) {
          zimg = zimg.resize({
            width: Math.round(zw * spec.scale),
            height: Math.round(zh * spec.scale),
            quality: "best",
          });
        }
        const zfile = path.join(outDir, spec.file);
        fs.writeFileSync(zfile, zimg.toPNG());
        shots.push({ file: zfile, size: zimg.getSize(), kind: "zoom" });
        log(`  v ${path.relative(ROOT, zfile)}  ${zimg.getSize().width}x${zimg.getSize().height} (特写 ${spec.scale}x · ${spec.sel} · 裁剪 ${zx},${zy} ${zw}x${zh})`);
      } catch (err) {
        log(`  ! 特写裁剪失败 (${spec.sel}): ${err && err.message}`);
      }
    });
  }

  /* ---- 对比度自检: 在"亮/暗极限壁纸"下再拍两张纯色底板图, 量真实像素对比度 ----
     最后一轮还会把"改造前的文字色"临时灌回 <html>, 再拍一张对比图,
     于是日志里能直接给出"哪个元素从多少提升到多少"的实测数字。 */
  const flatColors = opts.contrast === false ? null : CONTRAST_PROBE_SCENES[scenario.name];
  if (flatColors) {
    /* 先做"透明度均匀性 + 顶部圆角无残留"两项结构自检: 需要在纯色底板上、并且先把
       氛围光斑(装饰色)临时藏起来 —— 量的是"壁纸能透过多少", 不能被光斑干扰。 */
    const uniformShots = {};
    const blobbed = opts.contrast !== false;
    for (const color of ["#ffffff", "#000000"]) {
      await win.webContents.executeJavaScript(flatBackdropScript("on", color)).catch(() => {});
      await win.webContents.executeJavaScript(blobHideScript(true)).catch(() => {});
      await sleep(320);
      const img = await grabViewport(win, frames, opts);
      await win.webContents.executeJavaScript(blobHideScript(false)).catch(() => {});
      await win.webContents.executeJavaScript(flatBackdropScript("off")).catch(() => {});
      await sleep(120);
      if (!img) { log(`  ! 透明度探针截图失败 (${color})`); fatal = true; continue; }
      const clean = cropTo(img, appW, appH);
      uniformShots[color] = clean;
      const ufile = path.join(outDir, color === "#ffffff" ? `27-uniform-white-${scenario.name}.png` : `28-uniform-black-${scenario.name}.png`);
      try { fs.writeFileSync(ufile, clean.toPNG()); } catch { /* 忽略 */ }
    }
    if (uniformShots["#ffffff"] && uniformShots["#000000"]) {
      const uni = analyzeUniformity(uniformShots["#ffffff"], uniformShots["#000000"], UNIFORMITY_POINTS, log);
      if (uni.fail > 0) {
        log("  x 透明度均匀性不达标: 某块区域的背景透明度与别处不同 (是不是又给某个区域单独加了底色?)");
        fatal = true;
      }
      /* 圆角/边距: 再拍一张"只留面板底色"的参照图, 与正常渲染逐点比 */
      await win.webContents.executeJavaScript(flatBackdropScript("on", "#ffffff")).catch(() => {});
      await win.webContents.executeJavaScript(panelOnlyScript(true)).catch(() => {});
      await sleep(320);
      const refImg = await grabViewport(win, frames, opts);
      await win.webContents.executeJavaScript(panelOnlyScript(false)).catch(() => {});
      await win.webContents.executeJavaScript(flatBackdropScript("off")).catch(() => {});
      await sleep(140);
      if (refImg) {
        const cleanRef = cropTo(refImg, appW, appH);
        try {
          fs.writeFileSync(path.join(outDir, `29-panelonly-${scenario.name}.png`), cleanRef.toPNG());
        } catch { /* 忽略 */ }
        const corner = analyzeCorners(uniformShots["#ffffff"], cleanRef, log);
        if (corner.fail > 0) {
          log("  x 顶部圆角/边距有残留: 圆角切掉的那块被某个元素的色块盖住了");
          fatal = true;
        }
      } else {
        log("  ! 圆角参照图截图失败");
        fatal = true;
      }
    }
    void blobbed;
  }
  if (flatColors && probe && probe.contrast && probe.contrast.length) {
    let newWhiteRes = null;
    for (const color of flatColors) {
      const tag = color === "#ffffff" ? "纯白壁纸" : "纯黑壁纸";
      await win.webContents.executeJavaScript(flatBackdropScript("on", color)).catch(() => {});
      await sleep(340);
      const img = await grabViewport(win, frames, opts);
      if (!img) { log(`  ! 对比度探针截图失败 (${tag})`); fatal = true; continue; }
      const clean = cropTo(img, appW, appH);
      const name = color === "#ffffff" ? "25-contrast-white" : "26-contrast-black";
      const pfile = path.join(outDir, `${name}-${scenario.name}.png`);
      try { fs.writeFileSync(pfile, clean.toPNG()); } catch { /* 忽略 */ }
      // 纯色极限壁纸下, 透明玻璃物理上不可能达到 4.5:1 (深色主题压白墙时尤其),
      // 因此这里只按硬底线 (2.0) 判致命: 低于它说明字真的糊没了; 未达 4.5 的会逐条列成 FAIL。
      const res = analyzeContrast(clean, probe.contrast, 0, 0, tag, log, scenario.name === "offline",
        { strict: false, floor: 2.0, ignoreItemFloor: true });
      if (res.fail > 0) {
        log(`  x 对比度自检不达标 (${tag}): ${res.fail} 项低于 2.0 硬底线`);
        fatal = true;
      }
      if (color === "#ffffff") newWhiteRes = res;
      await win.webContents.executeJavaScript(flatBackdropScript("off")).catch(() => {});
      await sleep(180);
    }

    /* 改造前对照: 临时把上一版的文字色灌回去, 在同一张纯白壁纸下再量一次 */
    if (newWhiteRes && newWhiteRes.results.length) {
      const oldVars = OLD_TEXT_VARS[scenario.theme] || OLD_TEXT_VARS.dark;
      await win.webContents.executeJavaScript(flatBackdropScript("on", "#ffffff")).catch(() => {});
      await win.webContents.executeJavaScript(`(() => {
        const s = document.documentElement.style;
        ${JSON.stringify(oldVars)}.split(';').forEach((kv) => {
          const i = kv.indexOf(':');
          if (i > 0) s.setProperty(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
        });
        return true;
      })()`).catch(() => {});
      await sleep(360);
      const img = await grabViewport(win, frames, opts);
      if (img) {
        const clean = cropTo(img, appW, appH);
        const oldRes = analyzeContrast(clean, probe.contrast, 0, 0, "纯白壁纸·改造前文字色", () => {}, false,
          { strict: false, floor: 0, ignoreItemFloor: true });
        const map = new Map(oldRes.results.map((r) => [r.sel, r.ratio]));
        log("  对比度提升对照 (纯白壁纸 · 改造前 -> 改造后):");
        newWhiteRes.results.forEach((r) => {
          const before = map.get(r.sel);
          if (before === undefined) return;
          const delta = r.ratio - before;
          log(`    ${r.sel.padEnd(30)} ${before.toFixed(2)}:1 -> ${r.ratio.toFixed(2)}:1 ` +
            `(${delta >= 0 ? "+" : ""}${delta.toFixed(2)})${r.ratio >= r.target ? " 达标" : ""}`);
        });
      }
      await win.webContents.executeJavaScript(`(() => {
        const s = document.documentElement.style;
        ${JSON.stringify(OLD_TEXT_VARS[scenario.theme] || OLD_TEXT_VARS.dark)}.split(';').forEach((kv) => {
          const i = kv.indexOf(':');
          if (i > 0) s.removeProperty(kv.slice(0, i).trim());
        });
        return true;
      })()`).catch(() => {});
      await win.webContents.executeJavaScript(flatBackdropScript("off")).catch(() => {});
      await sleep(200);
    }
  }

  /* 可选: 滚动区整页长图, 用于诊断总高度 */
  if (opts.full) {
    const expand = await win.webContents.executeJavaScript(`(() => {
      const s = document.querySelector('.scroll');
      document.documentElement.style.height = 'auto';
      s.style.overflow = 'visible';
      s.style.height = 'auto';
      return Math.ceil(44 + s.scrollHeight + 12);
    })()`).catch(() => null);
    if (expand) {
      const h = expand % 2 === 0 ? expand : expand + 1;
      win.setContentSize(appW, h);
      await sleep(460);
      const img = await grabWithRetry(win, { x: 0, y: 0, width: appW, height: h }, log);
      if (img) {
        const file = path.join(outDir, scenario.file.replace(/\.png$/, "-full.png"));
        fs.writeFileSync(file, img.toPNG());
        shots.push({ file, size: img.getSize(), kind: "full" });
        log(`  v ${path.relative(ROOT, file)}  ${img.getSize().width}x${img.getSize().height} (整页长图)`);
      }
      win.setContentSize(appW, appH);
      await sleep(200);
    }
  }

  /* 可选: 合成底板质感图 (472x712, 仅看玻璃质感, 不代表视口) */
  if (opts.backdrop) {
    const panelH = appH;
    const totalH = panelH + PAD * 2;
    const winH = totalH % 2 === 0 ? totalH : totalH + 1;
    win.setContentSize(appW + PAD * 2, winH);
    await sleep(200);
    await win.webContents.executeJavaScript(backdropScript("on", scenario.theme, panelH)).catch(() => {});
    await sleep(420);
    const img = await grabWithRetry(win, { x: 0, y: 0, width: appW + PAD * 2, height: winH }, log);
    if (img) {
      const file = path.join(outDir, scenario.file.replace(/\.png$/, "-bd.png"));
      fs.writeFileSync(file, img.toPNG());
      shots.push({ file, size: img.getSize(), kind: "backdrop" });
      log(`  v ${path.relative(ROOT, file)}  ${img.getSize().width}x${img.getSize().height} (合成底板, 看质感)`);

      /* 对比度自检 (主口径): 这张图是"应用自己的氛围底 + 高细节壁纸"的真实合成,
         完全不含透明度, 直接量像素即可。
         判致命用硬底线 2.0 (低于它 = 字真的糊没了); 未达 WCAG 目标 (4.5/3.0) 的逐条列 FAIL。
         透明玻璃压在高饱和壁纸上物理上到不了 4.5:1, 这条在报告里如实说明。 */
      if (probe && probe.contrast && probe.contrast.length) {
        // 重新采一次取样框: 从进探针到现在可能已经过了 1~2 秒 (状态切换/toast 弹出),
        // 用旧矩形会把 toast 或别的元素当成文字来量。
        // 注意: 此刻 body 已经被 backdropScript 下移了 PAD 像素, 新采到的矩形里**已经含**
        // 这个偏移, 因此不能再加 PAD (旧矩形才需要加)。
        const freshRects = await win.webContents.executeJavaScript(contrastCollectScript()).catch(() => null);
        const useFresh = !!(freshRects && freshRects.length);
        const items = useFresh ? freshRects : probe.contrast;
        const off = useFresh ? 0 : PAD;
        const res = analyzeContrast(img, items, off, off, `${scenario.theme} 壁纸合成`, log,
          scenario.name === "offline" || scenario.name === "light",
          { strict: false, floor: 2.0, ignoreItemFloor: true });
        if (res.fail > 0) {
          log(`  x 对比度自检不达标 (${scenario.theme} 壁纸合成): ${res.fail} 项低于 2.0 硬底线`);
          fatal = true;
        }
      }
    }
    await win.webContents.executeJavaScript(backdropScript("off", scenario.theme, panelH)).catch(() => {});
    win.setContentSize(appW, appH);
    await sleep(180);
  }

  const fresh = consoleLog.slice(before);
  const errs = fresh.filter(isException);
  const warns = fresh.filter((c) => c.level === 2);
  log(fresh.length === 0
    ? "  console: 本场景无输出"
    : `  console: ${fresh.length} 条 (异常 ${errs.length} / warn ${warns.length})`);
  if (errs.length && !opts.allowConsoleError) fatal = true;

  /* 关键: 不能 destroy() 掉唯一的窗口, 否则事件循环清空, 进程会静默退出。
     改成导航到 about:blank 并保留窗口, 全部场景结束后统一关闭。 */
  try {
    await win.loadURL("about:blank");
  } catch { /* 忽略 */ }
  await sleep(220);

  return { shots, win };
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  log(`[preview] ${new Date().toISOString()} electron=${process.versions.electron} chrome=${process.versions.chrome}`);
  log(`[preview] 默认截图 = 真实 452x692 视口 (溢出/遮挡可见)${opts.full ? " + 额外输出整页长图" : ""}`);

  if (opts.list) {
    log("可用场景 (截图默认为真实 452x692 视口, 同时输出 -bd 质感图):");
    SCENARIOS.forEach((s) => log(`  ${s.name.padEnd(14)} theme=${s.theme.padEnd(5)} -> ${s.file}   ${s.desc}`));
    return 0;
  }

  if (!fs.existsSync(INDEX)) { log(`找不到渲染层入口: ${INDEX}`); return 1; }
  if (!fs.existsSync(PRELOAD)) { log(`找不到预览 preload: ${PRELOAD}`); return 1; }

  let targets;
  if (opts.scenarios.length) {
    targets = opts.scenarios.map((name) => {
      const found = SCENARIOS.find((s) => s.name === name);
      if (found) return opts.theme ? Object.assign({}, found, { theme: opts.theme }) : Object.assign({}, found);
      return { name, theme: opts.theme || "dark", file: `custom-${name}.png`, desc: "自定义场景" };
    });
  } else if (opts.all) {
    targets = SCENARIOS.map((s) => (opts.theme ? Object.assign({}, s, { theme: opts.theme }) : Object.assign({}, s)));
    // --all 额外输出合成底板质感图 + 开关条特写, 便于观察玻璃层次
    opts.backdrop = true;
    opts.zoom = true;
  } else {
    log("请指定场景: --all 或 --scenario=<名称> [--theme=dark|light] (用 --list 查看全部场景)");
    return 1;
  }

  const outDir = path.resolve(ROOT, opts.out || path.join("docs", "ui"));
  fs.mkdirSync(outDir, { recursive: true });

  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  log(`[preview] 屏幕缩放 ${screen.getPrimaryDisplay().scaleFactor}x · 场景数 ${targets.length}`);

  const done = [];
  const windows = [];
  for (let i = 0; i < targets.length; i++) {
    const scenario = targets[i];
    log(`\n[preview] 场景 ${i + 1}/${targets.length}`);
    try {
      const res = await captureScenario(scenario, opts, outDir);
      if (res) {
        done.push({ scenario, shots: res.shots });
        windows.push(res.win);
      }
    } catch (err) {
      log(`  x 场景执行异常: ${err && err.stack ? err.stack : err}`);
      fatal = true;
    }
  }

  log("\n" + "=".repeat(66));
  const errs = consoleLog.filter(isException);
  const warns = consoleLog.filter((c) => c.level === 2);
  const others = consoleLog.filter((c) => !isException(c) && c.level !== 2);
  log(`场景完成: ${done.length}/${targets.length}`);
  log(`渲染层零异常断言: ${exceptionCount === 0 ? "通过 (无 error / 无 Uncaught)" : `失败 (${exceptionCount} 条异常)`}`);
  log(`console 汇总: 共 ${consoleLog.length} 条 = 异常 ${errs.length} + warn ${warns.length} + 其他 ${others.length}`);
  if (others.length) {
    log("--- 其他消息原文 (Chromium/Electron 的 LOG 级输出, 非渲染层异常) ---");
    others.forEach((c) => log(`  [${levelBadge(c.level)}] ${c.message}${c.source ? ` (${c.source}:${c.line})` : ""}`));
  }
  if (errs.length) {
    log("--- 异常原文 (error 级 或 Uncaught) ---");
    errs.forEach((c) => log(`  ${c.message}${c.source ? ` (${c.source}:${c.line})` : ""}`));
  }
  if (warns.length) {
    log("--- console warn 原文 ---");
    warns.forEach((c) => log(`  ${c.message}${c.source ? ` (${c.source}:${c.line})` : ""}`));
  }
  if (!errs.length && !warns.length) log("渲染层 console 干净: 没有 error, 也没有 warning。");  log("输出目录: " + outDir);
  log("=".repeat(66));

  if (opts.keepOpen) {
    log("--keep-open 已开启, 请手动关闭预览窗口。");
    return 0;
  }

  const failed = fatal || done.length !== targets.length || exceptionCount > 0;
  log(failed ? "结果: 失败" : "结果: 成功");
  return failed ? 1 : 0;
}

/* 主进程兜底: 只记录, 让 main() 走完汇总流程 */
process.on("uncaughtException", (err) => {
  log("[preview] 未捕获异常: " + (err && err.stack ? err.stack : err));
  fatal = true;
});
process.on("unhandledRejection", (err) => {
  log("[preview] 未处理的 Promise 拒绝: " + (err && err.stack ? err.stack : err));
  fatal = true;
});
process.on("exit", (code) => {
  log(`[preview] 进程退出 code=${code}`);
  flushLog();
});

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (err) {
    log("[preview] 执行失败: " + (err && err.stack ? err.stack : err));
    code = 1;
  }
  log(`\n退出码: ${code}`);
  flushLog();
  app.exit(code);
}).catch((err) => {
  log("[preview] whenReady 失败: " + err);
  flushLog();
  app.exit(1);
});

/* 硬超时保护 */
setTimeout(() => {
  log("[preview] 硬超时, 强制退出");
  fatal = true;
  flushLog();
  app.exit(1);
}, 300000).unref?.();
