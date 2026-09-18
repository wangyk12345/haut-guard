/**
 * chart.js —— 速率曲线 (Canvas 2D)。
 *
 * 特性:
 *  - 保留最近 N 个采样点 (默认 60), 新点从右侧推入, 左侧自动滚出;
 *  - Catmull-Rom 转三次贝塞尔, 得到平滑折线;
 *  - 下载/上传双曲线 + 竖向渐变填充 + 线体发光;
 *  - 用 requestAnimationFrame 做数值追赶 (render 动画), 视觉上像水波一样流动;
 *  - 自适应 devicePixelRatio 与容器尺寸 (ResizeObserver);
 *  - 配色取自 CSS 变量, 主题切换时重新取色。
 */

const UP = 2.15;   // 归一化上限倍数 (越小曲线越饱满, 2.1 左右峰值约占卡片 2/3 高)
const FLOOR = 0.08; // 归一化下限 (保证零流量时也有一条贴底直线)

/** '#38c9f0' -> 'rgba(56,201,240,a)' */
function hexToRgba(hex, a) {
  const h = String(hex || "").trim().replace("#", "");
  if (h.length !== 3 && h.length !== 6) return `rgba(120,180,255,${a})`;
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return `rgba(120,180,255,${a})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function readVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

/**
 * 创建曲线实例。
 * @param {HTMLCanvasElement} canvas
 * @param {{max?: number, height?: number}} [options]
 */
export function createChart(canvas, options = {}) {
  const max = Math.max(8, options.max || 60);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // 极端情况下拿不到上下文: 退化为空实现, 不影响其余界面
    return { push() {}, reset() {}, redraw() {}, destroy() {} };
  }

  /** 目标值 (字节/秒) */
  const target = { down: [], up: [] };
  /** 当前渲染值, 用于追赶动画 */
  const value = { down: [], up: [] };
  const render = { down: [], up: [] };

  let peak = 512 * 1024;
  let raf = 0;
  let dirty = true;
  let cssW = 0;
  let cssH = options.height || 68;

  const theme = { down: "#38c9f0", up: "#34e0b4", grid: "rgba(160,190,230,.14)", text: "rgba(190,208,236,.45)" };

  function refreshTheme() {
    theme.down = readVar("--chart-down", "#38c9f0");
    theme.up = readVar("--chart-up", "#34e0b4");
    theme.grid = readVar("--chart-grid", "rgba(160,190,230,.14)");
    theme.text = readVar("--tx-4", "rgba(190,208,236,.45)");
    dirty = true;
  }

  function syncSize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height || cssH));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cssW = w;
    cssH = h;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dirty = true;
  }

  /** 把一串字节/秒映射成 0..1 的归一化高度 */
  function normalize(list, scale) {
    return list.map((v) => {
      const n = v / scale;
      return Math.max(FLOOR, Math.min(1, n));
    });
  }

  /** Catmull-Rom -> 贝塞尔, 生成平滑路径 */
  function tracePath(pts, w, h, pad) {
    const innerH = h - pad.t - pad.b;
    const y = (n) => pad.t + innerH * (1 - n);
    const n = pts.length;
    if (n === 0) return;
    if (n === 1) {
      ctx.moveTo(0, y(pts[0]));
      ctx.lineTo(w, y(pts[0]));
      return;
    }
    const stepX = w / (n - 1);
    ctx.moveTo(0, y(pts[0]));
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] !== undefined ? pts[i - 1] : pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] !== undefined ? pts[i + 2] : p2;
      const x1 = i * stepX;
      const x2 = (i + 1) * stepX;
      // 张力 0.5 的标准 Catmull-Rom 控制点
      const c1 = y(p1 + (p2 - p0) / 6);
      const c2 = y(p2 - (p3 - p1) / 6);
      ctx.bezierCurveTo(x1 + stepX / 3, c1, x2 - stepX / 3, c2, x2, y(p2));
    }
  }

  function drawLine(pts, stroke, fillTop, width) {
    const pad = { t: 5, b: 4 };
    const w = cssW;
    const h = cssH;
    if (pts.length === 0) return;

    // 渐变填充
    ctx.beginPath();
    tracePath(pts, w, h, pad);
    ctx.lineTo(w, h - pad.b + 3);
    ctx.lineTo(0, h - pad.b + 3);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, pad.t, 0, h);
    g.addColorStop(0, fillTop);
    g.addColorStop(1, hexToRgba(stroke, 0));
    ctx.fillStyle = g;
    ctx.fill();

    // 曲线本体 + 外发光
    ctx.save();
    ctx.beginPath();
    tracePath(pts, w, h, pad);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = hexToRgba(stroke, 0.7);
    ctx.shadowBlur = 6;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width || 1.7;
    ctx.stroke();
    ctx.restore();

    // 末端光点
    const lastN = pts[pts.length - 1];
    if (lastN !== undefined) {
      const y = h - (h - pad.t - pad.b) * lastN - pad.b;
      const px = w - 1.2;
      const dot = ctx.createRadialGradient(px, y, 0, px, y, 6);
      dot.addColorStop(0, hexToRgba(stroke, 0.95));
      dot.addColorStop(1, hexToRgba(stroke, 0));
      ctx.beginPath();
      ctx.arc(px, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = dot;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, y, 1.9, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function paint() {
    if (!cssW || !cssH) return;
    ctx.clearRect(0, 0, cssW, cssH);

    // 背景基线网格: 3 条极淡横线
    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
      const y = Math.round((cssH - 9) * (i / 3)) + 4 + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(cssW, y);
      ctx.stroke();
    }
    ctx.restore();

    const scale = Math.max(peak * UP, 64 * 1024);
    const d = normalize(render.down, scale);
    const u = normalize(render.up, scale);
    // 先画上行(细/淡), 再画下行(粗/亮), 两条线都清晰可辨
    drawLine(u, theme.up, hexToRgba(theme.up, 0.18), 1.4);
    drawLine(d, theme.down, hexToRgba(theme.down, 0.28), 1.8);
  }

  /** 数值追赶: 每帧把 render 拉向 value, 视觉上像液体流动 */
  function step() {
    raf = 0;
    let moving = false;
    for (const key of ["down", "up"]) {
      const v = value[key];
      const r = render[key];
      while (r.length < v.length) r.push(v[r.length]);
      if (r.length > v.length) r.splice(v.length);
      for (let i = 0; i < v.length; i++) {
        const diff = v[i] - r[i];
        if (Math.abs(diff) > 0.0008) {
          r[i] += diff * (key === "down" ? 0.26 : 0.3);
          moving = true;
        } else {
          r[i] = v[i];
        }
      }
    }
    paint();
    if (moving) schedule();
    else dirty = false;
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(step);
  }

  function recomputePeak() {
    let p = 0;
    for (const v of target.down) if (v > p) p = v;
    for (const v of target.up) if (v > p) p = v;
    // 缓慢收敛, 避免峰值抖动导致曲线整体跳动
    peak = Math.max(64 * 1024, peak * 0.82 + p * 0.18);
  }

  function rebuild() {
    recomputePeak();
    value.down = target.down.slice();
    value.up = target.up.slice();
    dirty = true;
    schedule();
  }

  const onResize = () => { syncSize(); paint(); };

  let ro = null;
  if (typeof ResizeObserver === "function") {
    ro = new ResizeObserver(onResize);
    ro.observe(canvas);
  } else {
    window.addEventListener("resize", onResize);
  }

  syncSize();
  refreshTheme();
  paint();

  return {
    /**
     * 推入一个采样点。
     * @param {number} down 字节/秒
     * @param {number} up 字节/秒
     */
    push(down, up) {
      target.down.push(Math.max(0, Number(down) || 0));
      target.up.push(Math.max(0, Number(up) || 0));
      while (target.down.length > max) target.down.shift();
      while (target.up.length > max) target.up.shift();
      rebuild();
    },
    /** 清空全部采样 */
    reset() {
      target.down.length = 0;
      target.up.length = 0;
      value.down.length = 0;
      value.up.length = 0;
      render.down.length = 0;
      render.up.length = 0;
      peak = 512 * 1024;
      paint();
    },
    /** 主题变化后重新取色并重绘 */
    redraw() {
      refreshTheme();
      syncSize();
      paint();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", onResize);
    },
  };
}
