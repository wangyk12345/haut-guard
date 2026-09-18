/**
 * live-check.js —— 真实网关只读交叉校验: JS 实现 vs Python 参考实现。
 *
 * 比模拟网关更强的一层证据: 同一台机器、同一个网关, 两套独立实现各发一次请求,
 * 比较原始响应与解析结果。
 *
 * **只调用 rad_user_info 与 get_challenge**, 不做登录/注销, 不需要账号密码,
 * 不会改变校园网上的认证状态。
 *
 * 校验思路:
 *   1. 权威语义取"命名字段响应"(带 callback 的 JSONP), 它没有位置歧义;
 *   2. JS 的命名路径 vs Python 的命名结果 —— 这是主要的通过/失败判据;
 *   3. JS 的位置解析(裸文本)也应当与命名结果一致;
 *   4. Python 参考实现 query_status() 用的是位置映射, 若与命名结果不符,
 *      会单列为"参考实现偏差"并给出提示(已知它在 HAUT 现网上把 bytes_out
 *      当成了在线时长)。
 *
 * 用法: node tools/live-check.js [gateway]
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

const gateway = process.argv[2] || srun.DEFAULT_GATEWAY;
const root = path.join(__dirname, "..");

/** 稳定字段(两次请求之间不会变的)才参与判定。 */
const STABLE = ["user_name", "ip", "add_time", "sum_bytes", "sum_seconds", "gateway_ver"];

function normalizeNamed(source) {
  // 把不同来源都归一成 {user_name, ip, add_time, sum_bytes, sum_seconds, gateway_ver, ...}
  if (!source) return null;
  return {
    user_name: source.userName !== undefined ? source.userName : source.user_name,
    ip: source.ip !== undefined ? source.ip : source.online_ip,
    add_time: source.addTime !== undefined ? source.addTime : source.add_time,
    sum_bytes: source.sumBytes !== undefined ? source.sumBytes : source.sum_bytes,
    sum_seconds: source.sumSeconds !== undefined ? source.sumSeconds : source.sum_seconds,
    // 三个来源的键名各不相同: JS 侧用 camelCase, 参考实现用 gateway_ver,
    // 命名字段响应里叫 sysver —— 都必须能取到, 否则会误报"缺版本号"。
    gateway_ver:
      source.gatewayVer !== undefined
        ? source.gatewayVer
        : source.gateway_ver !== undefined
          ? source.gateway_ver
          : source.sysver,
    balance: source.balance !== undefined ? source.balance : source.user_balance,
  };
}

async function probeWithJs() {
  const client = new srun.SrunClient({ gateway, timeout: 8000 });
  const out = { gateway };
  try {
    const raw = await srun.httpGet(client.statusUrl, { timeout: 8000 });
    out.positional = normalizeNamed(srun.statusFromText(raw));
    out.positionalRaw = raw;
  } catch (err) {
    out.positionalError = `${err.name}: ${err.message}`;
  }
  try {
    out.named = normalizeNamed(await client.queryStatus());
  } catch (err) {
    out.namedError = `${err.name}: ${err.message}`;
  }
  try {
    const token = await client.getToken("probe", (out.named && out.named.ip) || "");
    out.challengeOk = true;
    out.tokenLen = token.length;
  } catch (err) {
    out.challengeOk = false;
    out.challengeError = `${err.name}: ${err.message}`;
  }
  return out;
}

function probeWithPython() {
  const script = path.join(__dirname, "live-check.py");
  if (!fs.existsSync(script)) return { error: "缺少 tools/live-check.py" };
  const result = spawnSync("python", [script, gateway], {
    cwd: root,
    encoding: "utf8",
    timeout: 90000,
  });
  if (result.status !== 0) {
    return { error: `python 退出码 ${result.status}: ${(result.stderr || "").trim().slice(0, 300)}` };
  }
  const lines = String(result.stdout || "").trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      try {
        return JSON.parse(line);
      } catch {
        /* 继续找 */
      }
    }
  }
  return { error: `python 输出无法解析: ${String(result.stdout).slice(0, 200)}` };
}

function fmt(value) {
  if (value === undefined || value === null) return "(无)";
  if (typeof value === "string" && value.length > 40) return `${value.slice(0, 40)}…`;
  return String(value);
}

(async () => {
  process.stdout.write(`=== 真实网关只读交叉校验: ${gateway} ===\n`);
  process.stdout.write("(只调用 rad_user_info 与 get_challenge，不登录、不注销)\n\n");

  const js = await probeWithJs();
  const py = probeWithPython();

  if (js.namedError || js.positionalError) {
    process.stdout.write(`JS 侧查询异常: ${js.namedError || js.positionalError}\n`);
  }
  if (py.error) {
    process.stdout.write(`Python 侧不可用: ${py.error}\n`);
  }

  const pyNamed = normalizeNamed(py.named);
  const pyPositional = normalizeNamed(py.status_parsed);

  const rows = [];
  let failed = 0;

  for (const key of STABLE) {
    const a = js.named ? js.named[key] : undefined;
    const b = pyNamed ? pyNamed[key] : undefined;
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) failed += 1;
    rows.push({
      name: key,
      js: a,
      py: b,
      same,
      note: same ? "" : "JS(命名) 与 Python(命名) 不一致",
    });
  }

  process.stdout.write("主判据: 命名字段语义 —— JS 实现 vs Python 侧的命名结果\n");
  process.stdout.write("-".repeat(96) + "\n");
  process.stdout.write("字段".padEnd(16) + "JS 实现".padEnd(34) + "Python\n");
  for (const row of rows) {
    process.stdout.write(
      `${row.same ? "  " : "≠ "}${row.name.padEnd(14)}${fmt(row.js).padEnd(34)}${fmt(row.py)}\n`
    );
  }

  // JS 的两条解析路径必须一致
  let positionalMismatch = 0;
  for (const key of STABLE) {
    const a = js.named ? js.named[key] : undefined;
    const b = js.positional ? js.positional[key] : undefined;
    if (JSON.stringify(a) !== JSON.stringify(b)) positionalMismatch += 1;
  }
  process.stdout.write(
    `\nJS 内部一致性: 命名字段解析 vs 裸文本位置解析 —— ` +
      (positionalMismatch ? `${positionalMismatch} 项不一致(需检查 statusFromText)\n` : "全部一致\n")
  );

  // 参考实现与命名语义的差异(如果还有)
  if (pyPositional && pyNamed) {
    const diffs = STABLE.filter(
      (k) => JSON.stringify(pyPositional[k]) !== JSON.stringify(pyNamed[k])
    );
    if (diffs.length) {
      process.stdout.write(
        `\n注意: Python 参考实现 query_status() 与命名字段语义不一致, 涉及 ${diffs.join(", ")}。\n`
      );
      for (const key of diffs) {
        process.stdout.write(`  ${key}: 参考实现=${fmt(pyPositional[key])}  命名语义=${fmt(pyNamed[key])}\n`);
      }
      process.stdout.write("  (参考实现已改为优先取命名字段; 若仍不一致说明它落后于当前语义)\n");
    }
  }

  process.stdout.write(
    `\n结论: ${STABLE.length - failed}/${STABLE.length} 项一致` +
      (failed ? ` —— ${failed} 项不一致\n` : " —— JS 实现与参考实现在真实网关上一致\n")
  );
  process.exit(failed || positionalMismatch ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`校验异常: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
