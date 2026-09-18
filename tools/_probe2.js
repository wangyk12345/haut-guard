/** 临时诊断: 找出 capturePage 失败的确切条件 */
"use strict";
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "src", "renderer", "index.html");
const PRELOAD = path.join(__dirname, "preview-preload.js");
const OUT = [];
const log = (m) => { OUT.push(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function flush() {
  try { fs.writeFileSync(path.join(ROOT, "docs", "ui", "_probe2.log"), OUT.join("\n") + "\n"); } catch {}
  try { process.stdout.write(OUT.join("\n") + "\n"); } catch {}
}
process.on("exit", () => flush());

const CASES = [
  { id: "A-420-nobd-showinactive", size: [420, 660], backdrop: false, showFn: "showInactive" },
  { id: "B-472-nobd-showinactive", size: [472, 712], backdrop: false, showFn: "showInactive" },
  { id: "C-420-bd-showinactive", size: [420, 660], backdrop: true, showFn: "showInactive" },
  { id: "D-472-bd-showinactive", size: [472, 712], backdrop: true, showFn: "showInactive" },
  { id: "E-472-bd-show", size: [472, 712], backdrop: true, showFn: "show" },
  { id: "F-472-bd-show-rectless", size: [472, 712], backdrop: true, showFn: "show", rectless: true },
];

app.whenReady().then(async () => {
  for (const c of CASES) {
    log(`\n=== ${c.id} ===`);
    const win = new BrowserWindow({
      width: c.size[0], height: c.size[1], show: false, frame: false,
      transparent: true, backgroundColor: "#00000000", hasShadow: false,
      resizable: false, skipTaskbar: true,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("render-process-gone", (_e, d) => log(`  render-gone ${d && d.reason}`));
    win.showInactive();
    win.setContentSize(c.size[0], c.size[1]);
    log(`  content=${win.getContentSize().join("x")} visible=${win.isVisible()}`);

    await win.loadURL(`${pathToFileURL(INDEX).href}#scenario=online&theme=dark`);
    await sleep(1400);

    if (c.backdrop) {
      const ok = await win.webContents.executeJavaScript(`(() => {
        document.documentElement.style.width = '${c.size[0]}px';
        document.documentElement.style.height = '${c.size[1]}px';
        document.body.style.position = 'absolute';
        document.body.style.top = '26px';
        document.body.style.left = '26px';
        const bd = document.createElement('div');
        bd.id = 'preview-backdrop';
        bd.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;background:linear-gradient(150deg,#1b2233,#121826 45%,#0d1220);';
        document.body.appendChild(bd);
        return true;
      })()`).catch((e) => "ERR " + e.message);
      log("  backdrop inserted: " + ok);
      await sleep(300);
    }

    if (c.showFn === "show") { win.show(); win.focus(); }
    await sleep(260);

    const rect = c.rectless ? undefined : { x: 0, y: 0, width: c.size[0], height: c.size[1] };
    for (let i = 1; i <= 3; i++) {
      try {
        const img = await win.webContents.capturePage(rect);
        const empty = img.isEmpty();
        log(`  try${i}: ${JSON.stringify(img.getSize())} empty=${empty}`);
        if (!empty) {
          fs.writeFileSync(path.join(ROOT, "docs", "ui", `_probe2-${c.id}.png`), img.toPNG());
          break;
        }
      } catch (e) {
        log(`  try${i}: ERR ${e.message}`);
      }
      await sleep(400);
    }

    try { await win.loadURL("about:blank"); } catch {}
    await sleep(200);
  }
  log("\nPROBE DONE");
  app.exit(0);
}).catch((e) => { log("fatal " + e.stack); app.exit(3); });

setTimeout(() => { log("TIMEOUT"); app.exit(2); }, 120000);
