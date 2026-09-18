/**
 * compare-portal-request.js —— 把"门户真实登录请求"与"我的实现"逐字节对拍。
 *
 * 数据来源: tools/portal-probe.js 抓下来的 docs/ui/portal-probe.json
 *   - hooked[0]: get_challenge 的请求 URL 与响应(响应里有 token)
 *   - hooked[1]: srun_portal  的请求 URL(里面有 password / chksum / info)
 * 用**同一个 token** 让我的实现重算一遍, 逐字段比对, 找出第一个不同的字符。
 *
 * 密码从环境变量 HAUT_PASS 读(计算 hmac 需要明文); 不落盘、不打印。
 *
 * 用法: node tools/compare-portal-request.js [portalProbeJson]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

const file =
  process.argv[2] || path.join(__dirname, "..", "docs", "ui", "portal-probe.json");
const plainPassword = process.env.HAUT_PASS || "";

if (!fs.existsSync(file)) {
  process.stderr.write(`找不到 ${file}, 请先运行 tools/portal-probe.js\n`);
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(file, "utf8"));
const hooked = data.hooked || [];
const captured = data.captured || [];

// token 来自挂钩到的 get_challenge **响应**
const challengeEntry = hooked.find((h) => h.url.indexOf("get_challenge") >= 0);
// 带参数的登录 URL 来自 webRequest 记录($.get 的 data 在请求时才拼到 query 上,
// 所以挂钩记下的 url 没有参数)
const loginEntry = captured.find((c) => c.url.indexOf("action=login") >= 0);

if (!challengeEntry || !loginEntry) {
  process.stderr.write("抓取结果里缺少 get_challenge 响应或 action=login 请求\n");
  process.stderr.write(
    `  hooked: ${hooked.map((h) => h.url).join(" | ") || "(空)"}\n` +
      `  captured: ${captured.map((c) => c.url.slice(0, 60)).join(" | ") || "(空)"}\n`
  );
  process.exit(2);
}

/** 从 URL 里取查询参数。 */
function paramsOf(url) {
  const q = url.slice(url.indexOf("?") + 1);
  const out = {};
  for (const pair of q.split("&")) {
    const i = pair.indexOf("=");
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? "" : pair.slice(i + 1);
    out[k] = decodeURIComponent(v.replace(/\+/g, " "));
  }
  return out;
}

/** 从 JSONP 文本里抠出 JSON。 */
function jsonpBody(text) {
  const s = String(text);
  const a = s.indexOf("(");
  const b = s.lastIndexOf(")");
  return a >= 0 && b > a ? s.slice(a + 1, b) : s;
}

const challengeResp = JSON.parse(jsonpBody(challengeEntry.resp));
const token = challengeResp.challenge;
const p = paramsOf(loginEntry.url);

process.stdout.write("=== 门户真实请求 vs 我的实现 ===\n");
process.stdout.write(`token            ${token}\n`);
process.stdout.write(`username         ${p.username}\n`);
process.stdout.write(`ip               ${p.ip}\n`);
process.stdout.write(`ac_id            ${p.ac_id}\n`);
process.stdout.write(`n / type         ${p.n} / ${p.type}\n`);
process.stdout.write(`os / name        ${p.os} / ${p.name}\n`);
process.stdout.write(`double_stack     ${p.double_stack}\n`);
process.stdout.write(`password(门户)   ${p.password}\n`);
process.stdout.write(`info(门户)       ${p.info}\n`);
process.stdout.write(`chksum(门户)     ${p.chksum}\n\n`);

if (!plainPassword) {
  process.stdout.write("未提供 HAUT_PASS, 无法重算 hmac_md5 —— 只能比对上面的结构。\n");
  process.exit(0);
}

// ---- 用同一个 token 重算
const [myPwdField, myHmd5] = srun.makePasswordField(token, plainPassword, "srun3", "md5");
const myInfo = srun.makeInfoField(p.username, plainPassword, p.ip, token, "srbx1", p.ac_id);
const myChksum = srun.makeChksum(token, p.username, myHmd5, p.ip, myInfo, p.ac_id);

function diff(label, mine, theirs) {
  if (mine === theirs) {
    process.stdout.write(`  [一致] ${label}\n`);
    return true;
  }
  process.stdout.write(`  [不同] ${label}\n`);
  const n = Math.min(mine.length, theirs.length);
  let i = 0;
  while (i < n && mine[i] === theirs[i]) i++;
  process.stdout.write(`         我的 ${mine.length} 字符, 门户 ${theirs.length} 字符\n`);
  process.stdout.write(`         第 ${i} 个字符起不同:\n`);
  process.stdout.write(`         我的   …${mine.slice(Math.max(0, i - 20), i + 40)}\n`);
  process.stdout.write(`         门户   …${theirs.slice(Math.max(0, i - 20), i + 40)}\n`);
  return false;
}

let allSame = true;
allSame = diff("password", myPwdField, p.password) && allSame;
allSame = diff("info", myInfo, p.info) && allSame;
allSame = diff("chksum", myChksum, p.chksum) && allSame;

process.stdout.write(
  `\n结论: ${allSame ? "完全一致 —— 我的实现与门户发出的请求逐字节相同" : "存在差异, 见上"}\n`
);
process.exit(allSame ? 0 : 1);
