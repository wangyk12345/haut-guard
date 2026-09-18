/**
 * live-status.js —— 只读查询真实网关的在线状态并打印人类可读结果。
 *
 * **不做任何登录/注销等写操作**, 不需要账号密码, 不会改变校园网上的认证状态。
 * 用途: 在没有登录的情况下确认"网关通不通、解析对不对、显示值是否合理"。
 *
 * 用法: node tools/live-status.js [gateway]
 */
"use strict";

const path = require("node:path");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

const gateway = process.argv[2] || srun.DEFAULT_GATEWAY;

(async () => {
  const client = new srun.SrunClient({ gateway, timeout: 8000 });
  process.stdout.write(`=== 只读状态查询: ${gateway} ===\n`);
  process.stdout.write(`portal   ${client.portalUrl}\n`);
  process.stdout.write(`status   ${client.statusUrl}\n\n`);

  const started = Date.now();
  let status;
  try {
    status = await client.queryStatus();
  } catch (err) {
    process.stdout.write(`查询失败: ${err.message}\n`);
    process.exit(1);
  }
  const ms = Date.now() - started;

  if (!status.online) {
    process.stdout.write(`当前未在线 (${status.error || "unknown"})，耗时 ${ms} ms\n`);
    process.exit(0);
  }

  const rows = [
    ["用户名", status.userName],
    ["IP", status.ip],
    ["登录时间", new Date(status.addTime * 1000).toLocaleString("zh-CN")],
    ["心跳时间", new Date(status.keepaliveTime * 1000).toLocaleString("zh-CN")],
    ["本次时长", srun.formatDuration(status.sessionSeconds)],
    ["本次下行", `${srun.formatBytes(status.bytesIn)} (${status.bytesIn} B)`],
    ["本次上行", `${srun.formatBytes(status.bytesOut)} (${status.bytesOut} B)`],
    ["本次合计", srun.formatBytes(status.sessionBytes)],
    ["累计流量", `${srun.formatBytes(status.sumBytes)} (${status.sumBytes} B)`],
    ["累计时长", srun.formatDuration(status.sumSeconds)],
    ["账户余额", status.balance === null ? "(未提供)" : `${status.balance.toFixed(2)} 元`],
    ["网关版本", status.gatewayVer || "(未提供)"],
    ["查询耗时", `${ms} ms`],
  ];
  const width = Math.max(...rows.map((r) => r[0].length)) + 2;
  for (const [key, value] of rows) {
    process.stdout.write(`${key.padEnd(width)}${value}\n`);
  }
  process.stdout.write("\n(字段语义: 本次 = 网关 bytes_in/bytes_out；累计 = sum_bytes/sum_seconds)\n");
})().catch((err) => {
  process.stderr.write(`异常: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
