/**
 * live-login.js —— 真机登录测试(只用环境变量收密码)。
 *
 * 用途: 验证「这个网关 + 这组凭据 + 这套签名变体」到底能不能登上。
 * 密码**只从环境变量读**, 不写文件、不进日志、不出现在命令行参数里。
 *
 * 用法:
 *   $env:HAUT_USER='学号'; $env:HAUT_PASS='密码'
 *   node tools/live-login.js [portalPort] [infoFormat]
 *   例: node tools/live-login.js 80 srbx1
 *
 * 注意: 如果账号已在线, 网关会返回"已在线"(E26xx), 本工具会把它标为成功,
 *       因为那同样证明请求格式与凭据都被网关接受了。
 */
"use strict";

const path = require("node:path");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

const user = process.env.HAUT_USER || "";
const pass = process.env.HAUT_PASS || "";
const portalPort = Number(process.argv[2] || 80);
const infoFormat = process.argv[3] || "srbx1";
const gateway = process.env.HAUT_GATEWAY || srun.DEFAULT_GATEWAY;

if (!user || !pass) {
  process.stderr.write("请通过 HAUT_USER / HAUT_PASS 环境变量提供账号密码\n");
  process.exit(2);
}

(async () => {
  const client = new srun.SrunClient({
    gateway,
    portalPort,
    statusPort: 80,
    timeout: 10000,
    passwordAlgo: "srun3",
    infoFormat,
  });

  process.stdout.write(`=== 真机登录测试 ===\n`);
  process.stdout.write(`账号     ${user}\n`);
  process.stdout.write(`网关     ${gateway}\n`);
  process.stdout.write(`portal   ${client.portalUrl}\n`);
  process.stdout.write(`变体     infoFormat=${infoFormat}, passwordAlgo=srun3` +
    `, password 前缀=${srun.passwordPrefixFor(infoFormat)}\n\n`);

  // 先看当前状态
  const before = await client.queryStatus().catch((err) => ({ online: false, error: err.message }));
  process.stdout.write(`登录前: ${before.online ? `已在线 ${before.userName} @ ${before.ip}` : `未在线(${before.error || ""})`}\n\n`);

  const started = Date.now();
  let result;
  try {
    result = await client.login(user, pass);
  } catch (err) {
    process.stdout.write(`登录请求异常: ${err.message}\n`);
    process.exit(1);
  }
  const ms = Date.now() - started;

  process.stdout.write(`登录结果: ok=${result.ok} alreadyOnline=${!!result.alreadyOnline} code=${result.code || "-"} 耗时=${ms}ms\n`);
  process.stdout.write(`网关说明: ${result.message}\n`);
  if (result.raw) {
    process.stdout.write(`网关原始响应: ${String(result.raw).slice(0, 400)}\n`);
  }

  // 再查一次状态确认
  await new Promise((r) => setTimeout(r, 800));
  const after = await client.queryStatus().catch((err) => ({ online: false, error: err.message }));
  process.stdout.write(`\n登录后: ${after.online ? `已在线 ${after.userName} @ ${after.ip}` : `未在线(${after.error || ""})`}\n`);
  if (after.online) {
    process.stdout.write(`本次时长 ${srun.formatDuration(after.sessionSeconds)} / 本次流量 ${srun.formatBytes(after.sessionBytes)}\n`);
    process.stdout.write(`累计流量 ${srun.formatBytes(after.sumBytes)} / 累计时长 ${srun.formatDuration(after.sumSeconds)}\n`);
  }

  const verdict = result.ok ? "成功" : "失败";
  process.stdout.write(`\n结论: ${verdict}\n`);
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`异常: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
