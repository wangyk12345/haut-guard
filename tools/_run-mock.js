/**
 * _run-mock.js —— 联调用: 在固定端口启动模拟网关, 预置一个在线会话, 并模拟流量增长。
 *
 * 两个用途:
 *   1. 客户端不带参数查询状态时, 模拟网关只有 1 个在线会话就会把它返回,
 *      这样应用无需登录就能进入在线态, 便于截图与联调;
 *   2. 每秒给会话累加字节数, 让「实时速率」真的能算出非零值、曲线有数据
 *      (静态夹具只能验证 0 值路径)。
 *
 * 用法: node tools/_run-mock.js [port]
 */
"use strict";

const path = require("node:path");
const { startMockGateway } = require(path.join(__dirname, "..", "test", "mock-gateway"));

const port = Number(process.argv[2] || 6900);

startMockGateway({
  port,
  token: "test-token-0001",
  onlineSessions: [
    {
      username: "20230001",
      ip: "10.20.30.40",
      login_ip: "127.0.0.1",
      // 累计值用真机量级: 123.24 GB / 7 天 10 小时 56 分
      sum_bytes: 132329343471,
      sum_seconds: 644217,
      user_balance: 20,
    },
  ],
})
  .then((gw) => {
    process.stdout.write(
      `[mock] 已启动: ${gw.url} (预置在线会话 20230001, 每秒模拟流量增长)\n`
    );

    // 模拟真实流量: 下行 ~0.2-0.6 MB/s, 上行 ~0.02-0.08 MB/s
    const SESSION_START = Math.floor(Date.now() / 1000) - 2849; // 会话已持续 47 分 29 秒
    const timer = setInterval(() => {
      try {
        const now = Math.floor(Date.now() / 1000);
        for (const session of gw.state.sessions.values()) {
          session.bytes_in += Math.round(200000 + Math.random() * 400000);
          session.bytes_out += Math.round(20000 + Math.random() * 60000);
          // 注意 add_time 与 keepalive_time 必须同源, 否则客户端算出的会话时长会
          // 变成几百天(实测撞到过 367 天: keepalive 用当前时间 + add_time 用旧夹具值)
          session.add_time = SESSION_START;
          session.keepalive_time = now;
        }
      } catch {
        /* 会话被清空时忽略 */
      }
    }, 1000);

    const shutdown = () => {
      clearInterval(timer);
      Promise.resolve(gw.close()).finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  })
  .catch((err) => {
    process.stderr.write(`[mock] 启动失败: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
