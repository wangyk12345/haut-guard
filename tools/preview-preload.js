/**
 * preview-preload.js —— 预览专用 preload。
 *
 * 把 src/renderer/js/mock.js 的假数据桥接直接注入成 window.haut,
 * 预览环境完全不需要主进程 (src/main 下的文件一行都不用碰)。
 *
 * 与 src/main/preload.js 暴露的接口保持同形; 额外暴露一个 __preview 标记,
 * 便于截图 harness 自检场景是否真的生效。
 */
"use strict";

const { contextBridge } = require("electron");
const path = require("node:path");

// mock.js 是 UMD: preload 里 require 到的是同一份实现 (单一数据源)
const mockPath = path.join(__dirname, "..", "src", "renderer", "js", "mock.js");
const { createMockBridge } = require(mockPath);

/* 场景名从命令行取 (preload 执行时 location 还是 about:blank, 读 hash 拿不到)。
   harness 用 `--haut-scenario=<name>` 传递。 */
let scenario = "offline";
let theme = "";
try {
  process.argv.forEach((a) => {
    if (a.startsWith("--haut-scenario=")) scenario = a.slice("--haut-scenario=".length);
    else if (a.startsWith("--haut-theme=")) theme = a.slice("--haut-theme=".length);
  });
} catch (err) {
  console.warn("[preview-preload] 解析场景参数失败:", err && err.message);
}

const api = createMockBridge();

contextBridge.exposeInMainWorld("haut", api);

let intent = null;
try { intent = api.__intent || null; } catch { intent = null; }

contextBridge.exposeInMainWorld("__preview", {
  scenario,
  theme,
  intent,
  pause: typeof api.__pause === "function" ? api.__pause : () => {},
});
