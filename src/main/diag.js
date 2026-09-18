/**
 * diag.js —— 「诊断」面板的后端: 逐项检查并给出可读结论。
 *
 * 每一项都独立计时与捕获异常, 单项失败不会中断整份报告。设计意图是让用户在
 * 校园网里能自己判断「到底是没连上网关、密码错了、还是本机网络不通」。
 */
"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { SrunClient } = require("./srun");

/** 测试 TCP 端口连通性。 */
function tcpCheck(host, port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeout);
    socket.on("connect", () => done());
    socket.on("timeout", () => done(new Error(`连接超时 (${timeout} ms)`)));
    socket.on("error", (err) => done(err));
  });
}

/**
 * 运行全部诊断项。
 * @param {{config: object, store: any, logger: any}} ctx
 * @returns {Promise<{ok: boolean, items: Array<{name: string, ok: boolean, detail: string, ms: number}>}>}
 */
async function runDiagnostics(ctx) {
  const { config, store, logger } = ctx;
  const items = [];

  const check = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      items.push({ name, ok: true, detail: String(detail == null ? "通过" : detail), ms: Date.now() - started });
    } catch (err) {
      items.push({ name, ok: false, detail: err && err.message ? err.message : String(err), ms: Date.now() - started });
    }
  };

  const client = new SrunClient({
    gateway: config.gateway,
    portalPort: config.portalPort,
    statusPort: config.statusPort,
    passwordAlgo: config.passwordAlgo,
    infoFormat: config.infoFormat,
  });

  await check("配置检查", () => {
    if (!config.gateway) throw new Error("网关地址为空");
    if (!(config.portalPort > 0 && config.portalPort < 65536)) throw new Error("portal 端口非法");
    if (!(config.statusPort > 0 && config.statusPort < 65536)) throw new Error("status 端口非法");
    return `网关 ${config.gateway}，portal ${config.portalPort}，status ${config.statusPort}`;
  });

  await check("本机认证 IP", async () => {
    const ip = await client.resolveIp();
    if (!ip) throw new Error("未能探测到本机出口 IP，请确认已接入网络");
    return `探测到 ${ip}`;
  });

  await check(`网关端口连通 (TCP ${config.portalPort})`, async () => {
    const host = /^https?:\/\//i.test(config.gateway) ? new URL(config.gateway).hostname : config.gateway;
    await tcpCheck(host, config.portalPort, 3000);
    return `${host}:${config.portalPort} 可建立 TCP 连接`;
  });

  // 先探一次状态: 结果同时供后面的状态项与令牌项使用, 避免重复打网关
  const statusProbe = await (async () => {
    const ip = await client.resolveIp().catch(() => "");
    try {
      return { ...(await client.queryStatus()), ip };
    } catch (err) {
      return { error: err.message, ip, online: false };
    }
  })();

  await check("在线状态接口", async () => {
    if (statusProbe.error) throw new Error(statusProbe.error);
    if (!statusProbe.online) return "网关可达，当前未在线";
    return `在线：${statusProbe.userName} ${statusProbe.ip}，网关版本 ${statusProbe.gatewayVer}`;
  });

  await check("认证令牌接口", async () => {
    const ip = statusProbe.ip || (await client.resolveIp());
    if (!ip) throw new Error("缺少本机 IP，无法请求令牌");
    const username = String(config.lastUsername || "test").trim() || "test";
    const token = await client.getToken(username, ip);
    return `已取得令牌（长度 ${token.length}）`;
  });

  await check("登录协议配置", () => {
    const algo = String(config.passwordAlgo || "");
    const fmt = String(config.infoFormat || "");
    // 本网关(SRunCGIAuthIntfSvr V1.18 B20180614)实测: password 必须是对**密码**取
    // hmac_md5 并带 {MD5} 标记; info 用 {SRBX1}。
    // passwordAlgo="srbx1" 表示对**空串**取 hmac —— 网关会回 E2553「Password is error」,
    // 用户看到"密码错误"但密码其实是对的, 极难排查, 所以这里直接点出来。
    if (algo === "srbx1") {
      throw new Error(
        "passwordAlgo=srbx1 表示对空串取 hmac，本网关会判为密码错误；请在设置里把「登录协议」改为「标准（推荐）」"
      );
    }
    if (algo === "srun3" && fmt === "srbx1") {
      return "标准（passwordAlgo=srun3 + infoFormat=srbx1，本网关实测可用）";
    }
    return `非标准组合：passwordAlgo=${algo} + infoFormat=${fmt}（标准为 srun3 + srbx1；登录失败时先改回标准）`;
  });

  await check("凭据加密存储", () => {
    if (!store.encryptionAvailable) {
      throw new Error("系统凭据加密不可用，密码不会被保存");
    }
    return "可用（Windows DPAPI / safeStorage）";
  });

  await check("日志目录可写", () => {
    const dir = path.dirname(logger.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".write-test");
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return dir;
  });

  const ok = items.every((i) => i.ok);
  if (logger) {
    logger.info(`诊断完成: ${ok ? "全部通过" : "存在失败项"} (${items.filter((i) => i.ok).length}/${items.length})`);
  }
  return { ok, items };
}

module.exports = { runDiagnostics, tcpCheck };
