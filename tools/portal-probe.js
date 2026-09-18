/**
 * portal-probe.js —— 用学校自己的网页版登录一次, 抓取它真正发送的请求参数。
 *
 * 为什么需要它: 静态分析(portal.js / all.min.js)已经确认了算法, 但请求里到底填了
 * 哪些值只有真实一次登录才能看到。这个脚本在 Electron 里打开网关页面、填表、点登录,
 * 并通过 webRequest 把发往 /cgi-bin/srun_portal 的真实 URL 抓下来。
 *
 * 密码通过环境变量传入, 不写文件、不进日志; 抓到的 URL 里密码是哈希/密文, 没有明文。
 *
 * 用法: node_modules\electron\dist\electron.exe tools\portal-probe.js
 *       (账号从 HAUT_PROBE_USER / HAUT_PROBE_PASS 读)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

const PORTAL = process.env.HAUT_PORTAL_URL || "http://172.16.154.130/";
const USER = process.env.HAUT_PROBE_USER || "";
const PASS = process.env.HAUT_PROBE_PASS || "";
const OUT = process.env.HAUT_PROBE_OUT || path.join(__dirname, "..", "docs", "ui", "portal-probe.json");
const WAIT_MS = Number(process.env.HAUT_PROBE_WAIT || 12000);

const captured = [];

function redactUrl(url) {
  // 只把明显是明文密码的参数打掉; info/password 本身已是哈希/密文
  return url.replace(/([?&](?:pass|pwd)=)[^&]*/gi, "$1<已隐去>");
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!USER || !PASS) {
    process.stderr.write("缺少 HAUT_PROBE_USER / HAUT_PROBE_PASS\n");
    app.exit(2);
    return;
  }

  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    const url = details.url || "";
    if (url.indexOf("srun_portal") >= 0 || url.indexOf("get_challenge") >= 0) {
      captured.push({ method: details.method, url: redactUrl(url) });
    }
    callback({});
  });

  const win = new BrowserWindow({
    width: 900,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });

  const result = { portal: PORTAL, steps: [], captured: [], pageMessages: [] };
  const step = (m) => {
    result.steps.push(m);
    process.stdout.write(`  ${m}\n`);
  };

  try {
    step(`打开网关页面 ${PORTAL}`);
    await win.loadURL(PORTAL);
    await new Promise((r) => setTimeout(r, 1500));

    // 页面是否真的加载了 srun 插件
    const env = await win.webContents.executeJavaScript(`
      (function(){
        return {
          hasJquery: typeof jQuery !== 'undefined',
          hasLogin: typeof jQuery !== 'undefined' && typeof jQuery.Login === 'function',
          hasLogout: typeof jQuery !== 'undefined' && typeof jQuery.Logout === 'function',
          authIp: (typeof portal !== 'undefined' && portal) ? (portal.AuthIP || '') : '(无 portal)',
          authIp6: (typeof portal !== 'undefined' && portal) ? (portal.AuthIP6 || '') : '',
          userIp: (document.getElementById('user_ip')||{}).value || '',
          acid: (document.getElementById('ac_id')||{}).value || '',
          hostname: location.hostname,
          protocol: location.protocol
        };
      })()
    `);
    step(`页面环境: ${JSON.stringify(env)}`);

    // 挂钩 jQuery 的 $.get, 记录 URL 与**响应**(但不记录请求 data ——
    // 登录请求的 data 里有明文密码, 绝不能落盘)。
    step("挂钩 $.get 以记录请求 URL 与响应");
    await win.webContents.executeJavaScript(`
      (function(){
        window.__captured = [];
        var orig = jQuery.get;
        jQuery.get = function(url, data, success, dataType){
          var wrapped = function(resp, status, xhr){
            var text = (typeof resp === 'string') ? resp : JSON.stringify(resp);
            window.__captured.push({ url: String(url), resp: String(text).slice(0, 3000) });
            if (typeof success === 'function') { success(resp, status, xhr); }
          };
          return orig.call(jQuery, url, data, wrapped, dataType);
        };
        return true;
      })()
    `);

    // 再挂钩 JSON.stringify: 门户的 info() 是 "{SRBX1}"+base64(xEncode(json(d), k)),
    // 其中 json() 就是 JSON.stringify。抓到它就能看到门户**加密前的明文**。
    // 明文里有密码 —— 记录时立刻打码, 不落盘。
    await win.webContents.executeJavaScript(`
      (function(){
        window.__jsonCalls = [];
        var orig = JSON.stringify;
        JSON.stringify = function(value){
          try {
            if (value && typeof value === 'object' && value.enc_ver !== undefined && value.username !== undefined) {
              var copy = {};
              for (var k in value) { copy[k] = (k === 'password') ? '<已隐去>' : value[k]; }
              window.__jsonCalls.push(copy);
            }
          } catch (e) { /* 忽略 */ }
          return orig.apply(JSON, arguments);
        };
        return true;
      })()
    `);

    // 直接调用门户自己的 $.Login, 绕过"已在线就跳成功页"的分支,
    // 这样才看得到真正的登录请求与网关的真实响应。
    step("直接调用门户的 $.Login 发起认证");
    const loginResult = await win.webContents.executeJavaScript(`
      new Promise(function(resolve){
        var host = location.protocol + "//" + ((typeof portal !== 'undefined' && portal && portal.AuthIP) || location.hostname);
        var params = {
          username: ${JSON.stringify(USER)},
          domain: "",
          password: ${JSON.stringify(PASS)},
          ac_id: (document.getElementById('ac_id')||{}).value || "1",
          ip: (document.getElementById('user_ip')||{}).value || "",
          double_stack: 0
        };
        var done = false;
        var timer = setTimeout(function(){ if(!done){ done = true; resolve({timeout:true, host:host, params:{ac_id:params.ac_id, ip:params.ip}}); } }, 10000);
        jQuery.Login(host, params, function(resp){
          if (done) return;
          done = true; clearTimeout(timer);
          resolve({ host: host, resp: resp, params: { ac_id: params.ac_id, ip: params.ip, username: params.username } });
        });
      })
    `);
    step(`$.Login 返回: ${JSON.stringify(loginResult)}`);
    result.loginResult = loginResult;

    // 取回被挂钩记录下来的请求与响应(不含请求 data)
    const hooked = await win.webContents.executeJavaScript("window.__captured || []");
    result.hooked = hooked || [];
    for (const h of result.hooked) {
      step(`挂钩记录: ${h.url.slice(0, 120)}…`);
    }

    // 门户加密前的明文 JSON(密码已打码)
    const jsonCalls = await win.webContents.executeJavaScript("window.__jsonCalls || []");
    result.infoPlaintext = jsonCalls;
    for (const j of jsonCalls) {
      step(`门户加密的 JSON 明文: ${JSON.stringify(j)}`);
    }

    await new Promise((r) => setTimeout(r, 1500));
  } catch (err) {
    step(`异常: ${err.message}`);
  }

  result.captured = captured;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");

  process.stdout.write(`\n=== 抓到的关键请求 (${captured.length} 条) ===\n`);
  for (const c of captured) {
    process.stdout.write(`[${c.method}] ${c.url}\n\n`);
  }
  process.stdout.write(`完整结果已写入 ${OUT}\n`);

  win.destroy();
  app.exit(captured.some((c) => c.url.indexOf("action=login") >= 0) ? 0 : 3);
});
