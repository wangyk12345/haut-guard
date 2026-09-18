/**
 * _live-logout.js —— 只读客户端之外的"注销"动作, 供真机测试脚本调用。
 *
 * 注销只需要学号, **不需要密码**, 所以这个脚本不接触任何凭据。
 * 用法: node tools/_live-logout.js <username> [gateway]
 */
"use strict";

const path = require("node:path");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

const username = process.argv[2];
const gateway = process.argv[3] || srun.DEFAULT_GATEWAY;

if (!username) {
  process.stderr.write("用法: node tools/_live-logout.js <username>\n");
  process.exit(2);
}

(async () => {
  const client = new srun.SrunClient({ gateway, timeout: 10000 });
  const before = await client.queryStatus().catch(() => ({ online: false }));
  process.stdout.write(
    `注销前: ${before.online ? `已在线 ${before.userName} @ ${before.ip}` : "未在线"}\n`
  );
  const result = await client.logout(username);
  process.stdout.write(`注销结果: ok=${result.ok} ${result.message}\n`);
  await new Promise((r) => setTimeout(r, 600));
  const after = await client.queryStatus().catch(() => ({ online: false }));
  process.stdout.write(`注销后: ${after.online ? "仍在线" : "已离线"}\n`);
  process.exit(result.ok ? 0 : 1);
})().catch((err) => {
  process.stderr.write(`异常: ${err.message}\n`);
  process.exit(1);
});
