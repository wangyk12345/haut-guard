/**
 * mock.test.js —— 用本地模拟网关做端到端集成测试。
 *
 * 覆盖: 离线/在线状态解析、登录成功与各类错误码、注销、伪造签名被拒、
 *       断网时的错误处理、以及 Monitor 的自动重连与自动登录。
 *
 * 依赖 test/mock-gateway.js(独立实现的服务端, 用来交叉验证客户端加密是否正确)。
 * 用法: node test/mock.test.js
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const srun = require("../src/main/srun");
const { Monitor } = require("../src/main/monitor");
const { Store } = require("../src/main/store");
const { Logger } = require("../src/main/logger");

const MOCK_PATH = path.join(__dirname, "mock-gateway.js");
const FIXED_TOKEN = "test-token-0001";
const OK_USER = "20230001";
const OK_PASSWORD = "correct-horse";
const EXPECTED_STATUS = {
  userName: "20230001",
  addTime: 1758000000,
  keepaliveTime: 1758002849,
  // 本次会话(网关 bytes_in / bytes_out)
  bytesIn: 320253309,
  bytesOut: 51417663,
  sessionBytes: 371670972,
  sessionSeconds: 2849,
  // 账号累计(网关 sum_bytes / sum_seconds)
  sumBytes: 132329343471,
  sumSeconds: 644217,
  balance: 20,
  ip: "10.20.30.40",
  gatewayVer: "1.01.20180614",
};

let passed = 0;
const failures = [];
/** 当前使用的模拟网关, 供 check() 在每个用例前重置状态。 */
let activeGateway = null;

function assert(condition, message) {
  if (!condition) throw new Error(message || "断言失败");
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message || "值不相等"}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`
    );
  }
}

async function check(name, fn) {
  try {
    // 模拟网关的在线会话是全局状态, 用例之间会互相污染(前一个用例登录后,
    // 后一个用例就会撞上"本机 IP 已在别处登录")。每个用例都从干净状态开始。
    if (activeGateway && typeof activeGateway.reset === "function") {
      activeGateway.reset();
      if (typeof activeGateway.setScenario === "function") {
        activeGateway.setScenario({ failMode: "none" });
      }
    }
    await fn();
    passed += 1;
    process.stdout.write(`  [通过] ${name}\n`);
  } catch (err) {
    failures.push({ name, message: err.message });
    process.stdout.write(`  [失败] ${name} -> ${err.message}\n`);
  }
}

/** 测试用的假加密器(只为让 Store 能保存密码)。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decryptString: (buf) => Buffer.from(buf).toString("utf8").slice(4),
};

function makeContext(gatewayPort, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haut-mock-"));
  const logger = new Logger({ dir: path.join(dir, "logs") });
  const store = new Store({ dir, safeStorage: fakeSafeStorage, logger });
  store.updateConfig({
    gateway: "127.0.0.1",
    portalPort: gatewayPort,
    statusPort: gatewayPort,
    pollInterval: 600,
    autoReconnect: options.autoReconnect !== undefined ? options.autoReconnect : false,
    autoLogin: !!options.autoLogin,
  });
  const monitor = new Monitor({
    store,
    logger,
    backoffBaseSeconds: 1,
    backoffMaxSeconds: 2,
    clientFactory: (config) =>
      new srun.SrunClient({
        gateway: config.gateway,
        portalPort: config.portalPort,
        statusPort: config.statusPort,
        passwordAlgo: config.passwordAlgo,
        infoFormat: config.infoFormat,
      }),
  });
  return { store, logger, monitor, dir };
}

function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function main() {
  if (!fs.existsSync(MOCK_PATH)) {
    process.stderr.write(
      `找不到 ${MOCK_PATH}\n模拟网关尚未生成, 集成测试无法运行。\n`
    );
    process.exit(2);
  }
  const { startMockGateway } = require("./mock-gateway");

  process.stdout.write("=== 模拟网关端到端集成测试 ===\n");
  const gw = await startMockGateway({ port: 0, token: FIXED_TOKEN });
  const port = gw.port || (gw.url ? Number(new URL(gw.url).port) : 0);
  if (!port) {
    process.stderr.write("模拟网关未返回可用端口\n");
    process.exit(2);
  }
  process.stdout.write(`模拟网关已启动: ${baseUrl(port)}\n\n`);
  activeGateway = gw;

  try {
    // ---------------------------------------------- 状态解析
    await check("离线时 status 解析为未在线", async () => {
      const { monitor } = makeContext(port);
      const snap = await monitor.refresh();
      assertEqual(snap.conn.online, false, "online");
      assertEqual(snap.conn.state, "offline", "state");
    });

    await check("登录成功后状态字段与夹具逐位相符", async () => {
      const { monitor } = makeContext(port);
      const result = await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      assertEqual(result.ok, true, `登录应成功, 实际: ${result.message}`);
      const c = monitor.conn;
      assertEqual(c.online, true, "online");
      assertEqual(c.userName, EXPECTED_STATUS.userName, "userName");
      assertEqual(c.addTime, EXPECTED_STATUS.addTime, "addTime");
      assertEqual(c.keepaliveTime, EXPECTED_STATUS.keepaliveTime, "keepaliveTime");
      assertEqual(c.bytesIn, EXPECTED_STATUS.bytesIn, "bytesIn(本次下行)");
      assertEqual(c.bytesOut, EXPECTED_STATUS.bytesOut, "bytesOut(本次上行)");
      assertEqual(c.sessionBytes, EXPECTED_STATUS.sessionBytes, "本次会话流量");
      assertEqual(c.sessionSeconds, EXPECTED_STATUS.sessionSeconds, "本次会话时长");
      assertEqual(c.sumBytes, EXPECTED_STATUS.sumBytes, "sumBytes(账号累计)");
      assertEqual(c.sumSeconds, EXPECTED_STATUS.sumSeconds, "sumSeconds(账号累计)");
      assertEqual(c.balance, EXPECTED_STATUS.balance, "账号余额");
      assertEqual(c.ip, EXPECTED_STATUS.ip, "ip");
      assertEqual(c.gatewayVer, EXPECTED_STATUS.gatewayVer, "gatewayVer");
    });

    await check("走的是命名字段(JSONP)路径, 而不是位置解析", async () => {
      const { monitor } = makeContext(port);
      await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      // 只有命名字段响应里才有这些字段; 位置解析拿不到
      assertEqual(monitor.conn.balance, EXPECTED_STATUS.balance, "余额只有命名响应才有");
      const offline = monitor.conn.state === "online";
      assert(offline, "应处于在线态");
      // 状态请求必须带 callback, 否则不会走命名路径
      const statusRequests = (gw.requests || []).filter((r) => r.path === "/cgi-bin/rad_user_info");
      assert(statusRequests.length > 0, "应记录到状态请求");
      const last = statusRequests[statusRequests.length - 1];
      assert(last.query && last.query.callback, `状态请求应带 callback, 实际: ${JSON.stringify(last.query)}`);
    });

    await check("流量与时长格式化与真实语义一致", () => {
      // 本次会话
      assertEqual(srun.formatBytes(EXPECTED_STATUS.bytesIn), "305.42 MB", "本次下行");
      assertEqual(srun.formatBytes(EXPECTED_STATUS.bytesOut), "49.04 MB", "本次上行");
      assertEqual(srun.formatBytes(EXPECTED_STATUS.sessionBytes), "354.45 MB", "本次合计");
      assertEqual(srun.formatDuration(EXPECTED_STATUS.sessionSeconds), "47 分 29 秒", "本次时长");
      // 账号累计
      assertEqual(srun.formatBytes(EXPECTED_STATUS.sumBytes), "123.24 GB", "累计流量");
      assertEqual(srun.formatDuration(EXPECTED_STATUS.sumSeconds), "7 天 10 小时 56 分", "累计时长");
      // 边界
      assertEqual(srun.formatBytes(0), "0 B", "0 字节");
      assertEqual(srun.formatBytes(900), "900 B", "不足 1KB");
      assertEqual(srun.formatDuration(59), "59 秒", "不足 1 分钟");
      assertEqual(srun.formatDuration(90000), "1 天 1 小时 0 分", "跨天");
    });

    // ---------------------------------------------- 错误码
    await check("密码错误返回中文提示", async () => {
      const { monitor } = makeContext(port);
      const result = await monitor.login({ username: "20230002", password: "wrong-password" });
      assertEqual(result.ok, false, "不应登录成功");
      assertEqual(result.message, "账号或密码错误", "message");
      assertEqual(result.code, "E2531", "code");
      assertEqual(monitor.conn.state, "error", "state 应为 error");
    });

    await check("正确密码可以登录", async () => {
      const { monitor } = makeContext(port);
      const result = await monitor.login({ username: "20230002", password: "battery-staple" });
      assertEqual(result.ok, true, `应成功, 实际: ${result.message}`);
    });

    // 真正失败的错误码: ok 必须是 false, 且给出中文说明
    const failureCases = [
      ["arrears", "E2612", "账号已欠费"],
      ["disabled", "E2532", "账号被禁用"],
      ["locked", "E2553", "密码错误次数过多，账号被暂时锁定"],
      ["lowbalance", "E2611", "账号余额不足"],
      ["suspended", "E2613", "账号已停机"],
      ["nobody", "E6512", "账号未注册或不存在"],
    ];
    for (const [username, expectedCode, expectedMessage] of failureCases) {
      await check(`失败分支: ${username} -> ${expectedMessage}`, async () => {
        const { monitor } = makeContext(port);
        const result = await monitor.login({ username, password: "x" });
        assertEqual(result.ok, false, `${username} 不应登录成功`);
        assertEqual(result.message, expectedMessage, "message");
        assertEqual(result.code, expectedCode, "code");
        assertEqual(monitor.conn.online, false, "不应置为在线");
        assertEqual(monitor.conn.state, "error", "state 应为 error");
      });
    }

    // 网关明确表示"已经在线了"的码: 视为成功(参考实现同样如此), 但标记 alreadyOnline
    const onlineCases = [
      ["already", "本机已在线，无需重复登录"],
      ["elsewhere-ip", "本机 IP 已在别处登录"],
      ["elsewhere-account", "账号已在别处登录"],
    ];
    for (const [username, expectedMessage] of onlineCases) {
      await check(`已在线分支: ${username} -> ${expectedMessage}`, async () => {
        const { monitor } = makeContext(port);
        const result = await monitor.login({ username, password: "x" });
        assertEqual(result.ok, true, `${username} 应被视为成功(网关照常计费, 不必再登)`);
        assertEqual(result.alreadyOnline, true, "alreadyOnline");
        assertEqual(result.message, expectedMessage, "message");
      });
    }

    // ---------------------------------------------- 注销
    await check("注销成功后状态回到离线", async () => {
      const { monitor } = makeContext(port);
      await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      assertEqual(monitor.conn.online, true, "登录后应在线");
      const result = await monitor.logout();
      assertEqual(result.ok, true, `注销应成功, 实际: ${result.message}`);
      const snap = await monitor.refresh();
      assertEqual(snap.conn.online, false, "注销后应离线");
    });

    // ---------------------------------------------- 签名校验
    await check("伪造 chksum 会被网关拒绝, 正确签名被接受", async () => {
      const client = new srun.SrunClient({
        gateway: "127.0.0.1",
        portalPort: port,
        statusPort: port,
      });
      const ip = EXPECTED_STATUS.ip;

      // 每次请求前都重新取一次 challenge: 真实客户端就是这么做的,
      // 而且网关侧的令牌可能是一次性的
      const sendWith = async (buildChksum) => {
        const token = await client.getToken(OK_USER, ip);
        assertEqual(token, FIXED_TOKEN, "固定 token");
        // 用真机验证过的变体: info="{SRBX1}"+srun 字母表, password="{MD5}hmd5"
        const [pwdField, hmd5] = srun.makePasswordField(token, OK_PASSWORD, "srun3", "md5");
        const info = srun.makeInfoField(OK_USER, OK_PASSWORD, ip, token, "srbx1");
        const params = {
          callback: "cb",
          action: "login",
          username: OK_USER,
          password: pwdField,
          ac_id: "1",
          ip,
          info,
          chksum: buildChksum(token, hmd5, info),
          n: "200",
          type: "1",
        };
        const text = await srun.httpGet(
          `${baseUrl(port)}/cgi-bin/srun_portal?${srun.urlencode(params)}`
        );
        return srun.parseJsonp(text);
      };

      const bad = await sendWith(() => "0".repeat(40));
      assert(
        String(bad.error || "").toUpperCase() === "E3005",
        `伪造签名应被拒绝(E3005), 实际响应: ${JSON.stringify(bad)}`
      );

      const good = await sendWith((token, hmd5, info) =>
        srun.makeChksum(token, OK_USER, hmd5, ip, info)
      );
      assertEqual(String(good.error), "ok", `正确签名应被接受, 实际: ${JSON.stringify(good)}`);
    });

    // ---------------------------------------------- 断网
    await check("从未连上时网关不可达: 给出可读错误且不崩溃", async () => {
      const { monitor } = makeContext(port);
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "refuse" });
      const snap = await monitor.refresh();
      assertEqual(snap.conn.online, false, "online");
      // 刚启动就联不通网关属于"未连接"而非"异常", 但必须给出可读原因
      assert(
        snap.conn.state === "offline" || snap.conn.state === "error",
        `state 应为 offline/error, 实际 ${snap.conn.state}`
      );
      assert(/无法连接/.test(snap.conn.message), `message 应说明连不上网关, 实际: ${snap.conn.message}`);

      const result = await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      assertEqual(result.ok, false, "断网时登录不应成功");
      assert(/无法连接/.test(result.message), `message 应说明连不上网关, 实际: ${result.message}`);
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "none" });
    });

    await check("在线后突然断网会被标记为异常状态", async () => {
      const { monitor } = makeContext(port);
      await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      assertEqual(monitor.conn.online, true, "先要在线");
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "refuse" });
      const snap = await monitor.refresh();
      assertEqual(snap.conn.online, false, "online");
      assertEqual(snap.conn.state, "error", "掉线应标记为 error, 以便界面提示");
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "none" });
    });

    await check("网关返回垃圾数据时报解析错误", async () => {
      const { monitor } = makeContext(port);
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "garbage" });
      const snap = await monitor.refresh();
      assertEqual(snap.conn.online, false, "online");
      assert(snap.conn.message.length > 0, "应给出错误说明");
      assert(
        snap.conn.state === "error" || snap.conn.state === "offline",
        `state 应为 offline/error, 实际 ${snap.conn.state}`
      );
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "none" });
    });

    // ---------------------------------------------- 自动重连
    await check("断线后进入重连倒计时并自动恢复", async () => {
      const { store, monitor } = makeContext(port, { autoReconnect: true });
      store.saveAccount({ username: OK_USER, password: OK_PASSWORD });
      await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      assertEqual(monitor.conn.online, true, "先要在线");

      monitor._running = true; // 模拟应用已启动
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "refuse" });
      await monitor.refresh();
      assertEqual(monitor.conn.reconnecting, true, "应进入重连倒计时");
      assert(monitor.conn.nextRetryIn > 0, "应有倒计时秒数");

      // 恢复网关, 等待退避到期后自动重连成功
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "none" });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !monitor.conn.online) {
        await new Promise((r) => setTimeout(r, 200));
      }
      assertEqual(monitor.conn.online, true, "应自动重连成功");
      assertEqual(monitor.conn.reconnecting, false, "重连完成后不应还在倒计时");
      monitor.stop();
    });

    await check("手动注销后不会触发自动重连", async () => {
      const { store, monitor } = makeContext(port, { autoReconnect: true });
      store.saveAccount({ username: OK_USER, password: OK_PASSWORD });
      await monitor.login({ username: OK_USER, password: OK_PASSWORD });
      monitor._running = true;
      await monitor.logout();
      await monitor.refresh();
      assertEqual(monitor.conn.reconnecting, false, "手动注销后不应自动重连");
      monitor.stop();
    });

    // ---------------------------------------------- 自动登录
    await check("启动时按配置自动登录", async () => {
      const { store, monitor } = makeContext(port, { autoLogin: true });
      store.saveAccount({ username: OK_USER, password: OK_PASSWORD });
      const result = await monitor.maybeAutoLogin();
      assertEqual(result.ok, true, `自动登录应成功, 实际: ${JSON.stringify(result)}`);
      assertEqual(monitor.conn.online, true, "online");
    });

    await check("没有保存密码时自动登录安全跳过", async () => {
      const { monitor } = makeContext(port, { autoLogin: true });
      const result = await monitor.maybeAutoLogin();
      assertEqual(result.skipped, true, "应跳过");
      assertEqual(monitor.conn.online, false, "不应在线");
    });
    // ---------------------------------------------- 诊断
    await check("网关可达时诊断报告完整且关键项通过", async () => {
      const { store, logger } = makeContext(port);
      const { runDiagnostics } = require("../src/main/diag");
      const report = await runDiagnostics({ config: store.config, store, logger });
      assert(Array.isArray(report.items), "应有 items 数组");
      assert(report.items.length >= 6, `诊断项应不少于 6 项, 实际 ${report.items.length}`);
      for (const item of report.items) {
        assert(typeof item.name === "string" && item.name, "每项都要有名称");
        assert(typeof item.ms === "number", "每项都要有耗时");
      }
      const cred = report.items.find((i) => i.name.includes("凭据"));
      assert(cred && cred.ok, `凭据加密项应通过, 实际: ${cred && cred.detail}`);
      const logItem = report.items.find((i) => i.name.includes("日志"));
      assert(logItem && logItem.ok, `日志目录项应通过, 实际: ${logItem && logItem.detail}`);
      const tcp = report.items.find((i) => i.name.includes("端口连通"));
      assert(tcp && tcp.ok, `端口连通项应通过, 实际: ${tcp && tcp.detail}`);
      const challenge = report.items.find((i) => i.name.includes("令牌"));
      assert(challenge && challenge.ok, `令牌项应通过, 实际: ${challenge && challenge.detail}`);
    });

    await check("网关不可达时诊断报告逐项失败但不抛异常", async () => {
      const { store, logger } = makeContext(port, { autoReconnect: false });
      const { runDiagnostics } = require("../src/main/diag");
      if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "refuse" });
      try {
        const report = await runDiagnostics({ config: store.config, store, logger });
        assertEqual(report.ok, false, "存在失败项时 ok 应为 false");
        assert(report.items.length >= 6, "失败时同样要给出完整清单");
        const failed = report.items.filter((i) => !i.ok);
        assert(failed.length > 0, "应有失败项");
        for (const item of failed) {
          assert(item.detail && item.detail.length > 0, `失败项 ${item.name} 应给出原因`);
        }
      } finally {
        if (typeof gw.setScenario === "function") gw.setScenario({ failMode: "none" });
      }
    });
  } finally {
    if (typeof gw.close === "function") await gw.close();
  }

  process.stdout.write(`\n=== 结果: ${passed} 项通过, ${failures.length} 项失败 ===\n`);
  if (failures.length) {
    for (const f of failures) process.stdout.write(`  失败: ${f.name} -> ${f.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`集成测试异常终止: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
