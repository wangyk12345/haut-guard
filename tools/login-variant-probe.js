/**
 * login-variant-probe.js —— 判定网关接受哪种登录签名变体(零风险)。
 *
 * 原理: 用**不存在的用户名** + 编造的密码去试登录。网关先校验签名, 所以:
 *   - 返回 E3005(签名/参数校验失败) -> 这个变体的签名是错的
 *   - 返回 E2531/E6512 之类(账号或密码错误) -> 签名通过了, 只是账号不对
 * 这样就能确定变体, 而完全不触碰真实账号(不会让真实账号累计失败次数)。
 *
 * 判定完变体后, 真正登录时只要填对用户名密码即可。
 *
 * 用法: node tools/login-variant-probe.js [gateway] [bogusUsername]
 */
"use strict";

const path = require("node:path");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

const gateway = process.argv[2] || srun.DEFAULT_GATEWAY;
// 默认用不存在的学号(零风险); 传 HAUT_PROBE_USER/HAUT_PROBE_PASS 环境变量则用真实账号,
// 密码只从环境变量读, 不落盘、不打日志。
const probeUser = process.env.HAUT_PROBE_USER || process.argv[3] || "000000000000";
const probePassword = process.env.HAUT_PROBE_PASS || "not-a-real-password";
const isRealAccount = !!(process.env.HAUT_PROBE_USER || process.argv[3]);
const probeLabel = isRealAccount ? "真实账号(密码来自环境变量)" : "不存在的账号";

/**
 * 判定某个变体的结果。
 *
 * 变体正确的标志: 网关不再抱怨签名/密码算法 —— 而是走到"已在线"或直接成功。
 * 已知表示"这个变体不对"的错误码:
 *   password_algo_error  password 字段缺少/不认算法标记
 *   auth_info_error      info 字段无法解密或与请求不一致
 *   E3005 / E3002 / E3001  签名或参数校验失败
 */
function judge(code, ecode) {
  const c = String(code || "").toUpperCase();
  if (c === "") return ecode === 0 || ecode === "0" ? "变体可用" : "空响应";
  if (c === "OK") return "变体可用";
  if (/^E26\d\d$/.test(c)) return "变体可用(已在线一族)";
  if (c === "PASSWORD_ALGO_ERROR" || c === "AUTH_INFO_ERROR") return "变体不对";
  if (/^E300\d$/.test(c)) return "变体不对";
  if (c === "E2531" || c === "E6512") return "签名通过(账号/密码错)";
  return "未知";
}

/**
 * 变体组合。
 *
 * 已经由实测排除: password 不带标记(如 "{hmd5}")-> 网关回 password_algo_error,
 * 所以只保留 "{MD5}hmd5" 这一族; 剩下的变量是 info 前缀与 ac_id。
 * ac_id 之所以要试空串: 抓下来的真实登录页里 `<input id="ac_id" value="">` 是空的。
 */
const VARIANTS = [
  { name: "srbx1 + MD5, ac_id=''", infoFormat: "srbx1", prefix: "md5", acId: "" },
  { name: "srbx1 + MD5, ac_id=1", infoFormat: "srbx1", prefix: "md5", acId: "1" },
  { name: "srbx1 + MD5, ac_id=0", infoFormat: "srbx1", prefix: "md5", acId: "0" },
  { name: "srun3 + MD5, ac_id=''", infoFormat: "srun3", prefix: "md5", acId: "" },
  { name: "none  + MD5, ac_id=''", infoFormat: "none", prefix: "md5", acId: "" },
];

(async () => {
  const client = new srun.SrunClient({ gateway, timeout: 8000 });
  process.stdout.write(`=== 登录变体探测 ===\n`);
  process.stdout.write(`网关    ${client.portalUrl}\n`);
  process.stdout.write(`探测对象 ${probeLabel}  (账号 ${probeUser})\n\n`);

  const results = [];
  for (const variant of VARIANTS) {
    let line = `${variant.name.padEnd(26)}`;
    try {
      // 每个变体都用新的 challenge
      const token = await client.getToken(probeUser, "");
      const ip = await client.resolveIp();
      const [pwdField, hmd5] = srun.makePasswordField(
        token,
        probePassword,
        "srun3",
        variant.prefix
      );
      const info = srun.makeInfoField(
        probeUser,
        probePassword,
        ip,
        token,
        variant.infoFormat,
        variant.acId
      );
      const params = {
        callback: `jsonp${Date.now()}`,
        action: "login",
        username: probeUser,
        password: pwdField,
        ac_id: variant.acId,
        ip: ip,
        info: info,
        chksum: srun.makeChksum(token, probeUser, hmd5, ip, info, variant.acId),
        n: srun.N,
        type: srun.TYPE,
        os: "Windows 10",
        name: "Windows",
        double_stack: "0",
      };
      const text = await srun.httpGet(`${client.portalUrl}?${srun.urlencode(params)}`);
      const data = srun.parseJsonp(text);
      const code = String(data.error || "");
      const ecode = data.ecode;
      // 变体正确的标志: 网关不再抱怨签名/密码算法, 而是走到"已在线"或直接成功
      const verdict = judge(code, ecode);
      line += `error=${code.padEnd(20)} ecode=${String(ecode).padEnd(3)} ${verdict}`;
      results.push({ variant, code, ecode, verdict, data });
    } catch (err) {
      line += `异常: ${err.message}`;
      results.push({ variant, code: "", verdict: "异常", error: err.message });
    }
    process.stdout.write(`${line}\n`);
  }

  const ok = results.filter((r) => r.verdict === "变体可用");
  process.stdout.write("\n=== 结论 ===\n");
  if (!ok.length) {
    process.stdout.write("没有变体走到\"已在线/成功\", 需要看上面的错误码进一步判断。\n");
    process.exit(2);
  }
  for (const r of ok) {
    process.stdout.write(`可用: ${r.variant.name}  (网关返回 ${r.code || "ecode=" + r.ecode})\n`);
  }
  process.stdout.write(
    `\n推荐配置: infoFormat=${ok[0].variant.infoFormat}, passwordAlgo=srun3` +
      `, password 前缀=${ok[0].variant.prefix}\n`
  );
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`探测异常: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
