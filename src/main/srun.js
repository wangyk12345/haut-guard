/**
 * srun.js —— 深澜 (SRun) 校园网认证协议层 (JavaScript 移植版)
 *
 * 本文件是 `hautguard/srun_client.py` 的逐字节等价移植。算法为 xEncode
 * (XXTEA 变体) + srun 自定义字母表 base64 + hmac_md5 + sha1 chksum。
 *
 * 移植要点(与 Python 语义的精确对齐):
 *   - 参考实现按 **码点** 处理字符串(`ord`/`len` 都是码点语义), 因此这里用
 *     `[...msg]` 展开为码点数组, 而不是 UTF-16 码元。
 *   - 参考实现的整数是任意精度, 初值 `ord(c) << 24` 对非 BMP 字符会超出 32 位,
 *     循环中再用 `& 0xFFFFFFFF` 收敛。这里用 BigInt 复刻该语义, 保证逐位一致。
 *   - 参数编码用 Python `urlencode(quote_via=quote)` 的规则: `quote` 的默认
 *     safe 是 `/`, 且百分号十六进制**大写**, 空格编码为 `%20` 而非 `+`。
 *     这与 JS 的 `encodeURIComponent` 不一致, 故自行实现 `pyQuote`。
 *   - `json.dumps(..., separators=(",", ":"))` 默认 `ensure_ascii=True`, 会把
 *     非 ASCII 转义成小写 `\uXXXX`。JS 的 `JSON.stringify` 不转义, 故自行实现
 *     `pyJsonDumps`(按 UTF-16 码元逐个判断, 与 Python 的代理对一致)。
 *
 * 本模块**不依赖 Electron**, 可在纯 Node 下被测试脚本直接 require。
 */
"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const dgram = require("node:dgram");

// ---------------------------------------------------------------- 常量

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** srun 自定义字母表 (与标准表互为置换) */
const BASE64_ALPHABET = "LVoJPiCN2R8G90yg+hmFHuacZ1OWMnrsSTXkYpUq/3dlbfKwv6xztjI7DeBE45QA";

const DEFAULT_GATEWAY = "172.16.154.130";
const PORTAL_PORT = 69;
const STATUS_PORT = 80;
const AC_ID = "1";
const N = "200";
const TYPE = "1";
const ENC_VER = "srun_bx1";
/** 本网关 (SRunCGIAuthIntfSvr V1.18 B20180614) 实测: password 字段为 hmac_md5(token, 明文密码),
 *  且必须带 "{MD5}" 标记(不带标记网关回 password_algo_error)。 */
const DEFAULT_PASSWORD_ALGO = "srun3";
/** info 前缀流派。真机实测只有 "{SRBX1}" 能被本网关接受; 默认用它。 */
const DEFAULT_INFO_FORMAT = "srbx1";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** srun 错误码 -> 中文说明 (只收录常见项, 其余按原文回显) */
const ERROR_MESSAGES = {
  E2531: "账号或密码错误",
  E2532: "账号被禁用",
  E2553: "密码错误次数过多，账号被暂时锁定",
  E2601: "本机 IP 已在别处登录",
  E2602: "账号已在别处登录",
  E2611: "账号余额不足",
  E2612: "账号已欠费",
  E2613: "账号已停机",
  E2620: "本机已在线，无需重复登录",
  E2621: "本机 IP 格式不正确",
  E3001: "认证参数不完整",
  E3002: "认证参数错误",
  E3005: "网关拒绝登录（参数或签名校验失败）",
  E3101: "网关内部错误",
  E6512: "账号未注册或不存在",
  // 这两个是 HAUT 现网(1.01.20180614)实测返回的**字符串**错误码
  PASSWORD_ALGO_ERROR: "网关不接受该密码算法标记（password 字段需带 {MD5}）",
  AUTH_INFO_ERROR: "认证信息校验失败（info 字段无法校验，通常是前缀或 base64 字母表不对）",
  MISSING_REQUIRED_PARAMETERS_ERROR: "认证参数缺失（ac_id 等为必填）",
  NO_ACID_ERROR: "指定的 ac_id 在本网关不存在",
};

/**
 * 网关用 `suc_msg` 回传的一些"成功但有说明"的字符串, 映射成中文。
 * 例如已在线时网关返回 error=ok 且 suc_msg=ip_already_online_error。
 */
const SUCCESS_MESSAGES = {
  login_ok: "登录成功",
  ok: "登录成功",
  ip_already_online_error: "本机已在线，无需重复登录",
  already_online: "账号已在线，无需重复登录",
  ip_already_online: "本机已在线，无需重复登录",
};
const ALREADY_ONLINE_CODES = new Set(["E2620", "E2601", "E2602"]);

// ---------------------------------------------------------------- 异常

/** 协议/网络层可预期的错误, 携带可直接展示给用户的中文消息。 */
class SrunError extends Error {
  /** @param {string} message @param {{kind?: string, raw?: string}} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = "SrunError";
    this.kind = opts.kind || "network"; // network | gateway | parse | auth
    this.raw = opts.raw || "";
  }
}

// ---------------------------------------------------------------- 编码工具

/** Python `json.dumps(s, separators=(",", ":"))` 的等价实现(ensure_ascii=True)。 */
function pyJsonEscapeString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c <= 0x7e) out += ch;
    else out += "\\u" + c.toString(16).padStart(4, "0");
  }
  return out + '"';
}

/**
 * 生成 srun `info` 字段的 JSON 文本。
 * 键顺序与参考实现一致: username, password, ip, acid, enc_ver。
 */
function pyJsonDumps(obj) {
  const parts = [];
  for (const k of Object.keys(obj)) {
    parts.push(pyJsonEscapeString(k) + ":" + pyJsonEscapeString(String(obj[k])));
  }
  return "{" + parts.join(",") + "}";
}

/** Python `urllib.parse.quote(s, safe="/")` 的等价实现(百分号十六进制大写)。 */
function pyQuote(value, safe = "/") {
  const alwaysSafe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";
  const bytes = Buffer.from(String(value), "utf8");
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (alwaysSafe.indexOf(ch) >= 0 || safe.indexOf(ch) >= 0) out += ch;
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/**
 * Python `urllib.parse.urlencode(params, quote_via=quote)` 的等价实现。
 * 保持对象键的插入顺序, 与参考实现构造参数的顺序一致。
 */
function urlencode(params, safe = "/") {
  const parts = [];
  for (const k of Object.keys(params)) {
    parts.push(pyQuote(k, safe) + "=" + pyQuote(params[k], safe));
  }
  return parts.join("&");
}

// ---------------------------------------------------------------- xEncode

const MASK32 = 0xffffffffn;

/** 参考实现 `_sencode`: 按码点每 4 个字符打包成一个整数(key=True 时追加长度)。 */
function sencode(msg, key) {
  const chars = [...msg]; // 码点数组, 与 Python 的 str 索引语义一致
  const length = chars.length;
  const cp = (k) => (length > k ? BigInt(chars[k].codePointAt(0)) : 0n);
  const pwd = [];
  for (let i = 0; i < length; i += 4) {
    pwd.push(cp(i) | (cp(i + 1) << 8n) | (cp(i + 2) << 16n) | (cp(i + 3) << 24n));
  }
  if (key) pwd.push(BigInt(length));
  return pwd;
}

/**
 * srun 的 XXTEA 变体。与 `hautguard.srun_client.xencode` 逐字节等价。
 *
 * 返回值是 latin-1 语义的字符串(每个字符码 0..255), 与参考实现返回的字符串
 * 完全一致; 需要字节时用 `Buffer.from(result, "latin1")`。
 *
 * @param {string} msg
 * @param {string} key
 * @returns {string}
 */
function xencode(msg, key) {
  if (!msg) return "";
  const pwd = sencode(msg, true);
  const pwdk = sencode(key, false);
  while (pwdk.length < 4) pwdk.push(0n);

  const n = pwd.length - 1;
  let z = pwd[n];
  let y = pwd[0];
  let d = 0n;
  const c = 0x86014019n | 0x183639a0n;
  let q = 6 + Math.floor(52 / (n + 1));

  while (q > 0) {
    d = (d + c) & MASK32;
    const e = Number((d >> 2n) & 3n);
    for (let p = 0; p < n; p++) {
      y = pwd[p + 1];
      const m =
        ((z >> 5n) ^ (y << 2n)) +
        (((y >> 3n) ^ (z << 4n)) ^ (d ^ y)) +
        (pwdk[(p & 3) ^ e] ^ z);
      pwd[p] = (pwd[p] + m) & MASK32;
      z = pwd[p];
    }
    // 参考实现里 while p < n 结束后 p == n, 索引为 (n & 3) ^ e
    y = pwd[0];
    const m =
      ((z >> 5n) ^ (y << 2n)) +
      (((y >> 3n) ^ (z << 4n)) ^ (d ^ y)) +
      (pwdk[(n & 3) ^ e] ^ z);
    pwd[n] = (pwd[n] + m) & MASK32;
    z = pwd[n];
    q -= 1;
  }

  let out = "";
  for (const v of pwd) {
    out += String.fromCharCode(
      Number(v & 0xffn),
      Number((v >> 8n) & 0xffn),
      Number((v >> 16n) & 0xffn),
      Number((v >> 24n) & 0xffn)
    );
  }
  return out;
}

/** srun 自定义字母表的 base64 编码。 */
function b64Srun(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "latin1");
  return buf
    .toString("base64")
    .split("")
    .map((ch) => {
      const i = STD_ALPHABET.indexOf(ch);
      return i < 0 ? ch : BASE64_ALPHABET[i];
    })
    .join("");
}

/**
 * 登录请求的 password 字段。返回 [字段文本, hmd5]。
 *
 * `prefix` 决定 hmd5 外面包什么(两种流派在真实部署里并存):
 *   "brace" -> "{hmd5}"    老版 srun3 客户端用法(默认, 与 Python 参考实现一致)
 *   "md5"   -> "{MD5}hmd5" 网关自带网页版用法 —— 见 tools/gateway_js/jquery.srun.portal.js:
 *                          `password: "{MD5}"+hmd5`
 */
function makePasswordField(token, password, algo = DEFAULT_PASSWORD_ALGO, prefix = "brace") {
  const message = algo === "srbx1" ? "" : password;
  const hmd5 = crypto.createHmac("md5", Buffer.from(token, "utf8"))
    .update(Buffer.from(message, "utf8"))
    .digest("hex");
  const field = prefix === "md5" ? `{MD5}${hmd5}` : `{${hmd5}}`;
  return [field, hmd5];
}

/**
 * 由 `infoFormat` 推出配套的 password 前缀。
 *
 * 依据是网关自己派发的登录 JS: 它用 `{SRBX1}` 前缀的 info 时, password 一定是
 * `{MD5}hmd5`(见 portal.js 的 $.Login); 老版 `{SRUN3}\r\n` 流派则用 `{hmd5}`。
 * 两个字段必须配套, 混用会被网关判为签名失败(E3005)。
 */
function passwordPrefixFor(infoFormat) {
  return infoFormat === "srbx1" ? "md5" : "brace";
}

/** 登录请求的 info 字段: 前缀 + base64(xEncode(json, token))。
 *
 * 关于 base64 字母表(真机实测踩过的坑):
 *   `{SRBX1}` 在公开实现里常被写成"标准 base64", 但**这个网关不是** ——
 *   它的网页版 JS 里 `$.base64.encode` 用的是 srun 自定义字母表。抓下真实登录请求
 *   再逐字节对拍才确认: 三种前缀(info/none/srun3)用的都是同一张自定义字母表,
 *   区别只在有没有前缀。用标准表会得到长度相同但内容错误的 info, 网关回
 *   `auth_info_error`, 且真实账号与不存在的账号返回一模一样 —— 极难定位。
 */
function makeInfoField(
  username,
  password,
  ip,
  token,
  fmt = DEFAULT_INFO_FORMAT,
  acId = AC_ID
) {
  const info = pyJsonDumps({
    username: username,
    password: password,
    ip: ip,
    acid: acId,
    enc_ver: ENC_VER,
  });
  const payload = Buffer.from(xencode(info, token), "latin1");
  if (fmt === "srbx1") return "{SRBX1}" + b64Srun(payload);
  if (fmt === "none") return b64Srun(payload);
  return "{SRUN3}\r\n" + b64Srun(payload);
}

/** 登录请求的 chksum 字段。 */
function makeChksum(token, username, hmd5, ip, info, acId = AC_ID) {
  // 参考实现在入参非字符串时会抛异常。这里显式校验: 与其静默拼出一个错误的
  // 签名(最后表现为网关回 E3005, 极难定位), 不如立刻报错。
  const args = { token, username, hmd5, ip, info, acId };
  for (const key of Object.keys(args)) {
    if (typeof args[key] !== "string") {
      throw new TypeError(`makeChksum 的 ${key} 必须是字符串, 实际为 ${typeof args[key]}`);
    }
  }
  const raw =
    token + username + token + hmd5 + token + acId + token + ip +
    token + N + token + TYPE + token + info;
  return crypto.createHash("sha1").update(Buffer.from(raw, "utf8")).digest("hex");
}

// ---------------------------------------------------------------- 展示格式化

/** 流量字节数 -> 人类可读文本(与参考实现 `StatusResult.bytes_text` 一致)。 */
function formatBytes(sumBytes) {
  let n = Number(sumBytes) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  for (const unit of units) {
    if (n < 1024 || unit === "TB") {
      return unit === "B" ? `${Math.trunc(n)} B` : `${n.toFixed(2)} ${unit}`;
    }
    n /= 1024;
  }
  return `${n.toFixed(2)} TB`;
}

/** 在线秒数 -> 中文时长文本(与参考实现 `StatusResult.duration_text` 一致)。 */
function formatDuration(sumSeconds) {
  let secs = Math.trunc(Number(sumSeconds) || 0);
  const d = Math.trunc(secs / 86400);
  let rem = secs % 86400;
  const h = Math.trunc(rem / 3600);
  rem = rem % 3600;
  const m = Math.trunc(rem / 60);
  const s = rem % 60;
  if (d) return `${d} 天 ${h} 小时 ${m} 分`;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

// ---------------------------------------------------------------- HTTP

/**
 * 发起一次 GET 请求。非 2xx 视为 `network` 错误, 与参考实现的 urllib 行为一致。
 * @returns {Promise<string>}
 */
function httpGet(url, { timeout = 8000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new SrunError(`认证地址无效: ${url}`, { kind: "network" }));
      return;
    }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Connection: "close",
          ...headers,
        },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const code = res.statusCode || 0;
          if (code < 200 || code >= 300) {
            reject(new SrunError(`网关返回 HTTP ${code}`, { kind: "network", raw: body }));
          } else {
            resolve(body);
          }
        });
        res.on("error", (err) => {
          reject(new SrunError(`无法连接认证网关（${err.message}）`, { kind: "network" }));
        });
      }
    );
    // 参考实现超时抛 socket.timeout; 这里统一成「无法连接认证网关」文案
    req.setTimeout(timeout, () => {
      req.destroy(new Error("请求超时"));
    });
    req.on("error", (err) => {
      reject(new SrunError(`无法连接认证网关（${err.message}）`, { kind: "network" }));
    });
    req.end();
  });
}

/** 解析网关的 JSONP 响应。 */
function parseJsonp(text) {
  let body = String(text == null ? "" : text).trim();
  if (!body) throw new SrunError("网关返回空响应", { kind: "parse", raw: text });
  if (body.indexOf("(") >= 0 && body.endsWith(")")) {
    body = body.slice(body.indexOf("(") + 1, body.lastIndexOf(")"));
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new SrunError(`网关响应无法解析: ${body.slice(0, 80)}`, { kind: "parse", raw: text });
  }
}

/** 数值容错转换。 */
function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * 会话时长的合理性上限(30 天)。
 *
 * 本次会话时长 = keepalive_time - add_time。若网关的两个时间戳来自不同基准
 * (时钟漂移、固件 bug、或者 add_time 其实是账号创建时间), 差值会算出"几百天"
 * 这种荒谬结果 —— 实测就撞到过 367 天。宁可显示 0(表示不可信), 也不要给用户
 * 一个明显错误的天数。
 */
const MAX_PLAUSIBLE_SESSION_SECONDS = 30 * 86400;

/** 由两个时间戳推算本次会话秒数, 超出合理范围时返回 0。 */
function sessionSecondsFrom(addTime, keepaliveTime) {
  if (!(keepaliveTime > addTime)) return 0;
  const seconds = keepaliveTime - addTime;
  return seconds > MAX_PLAUSIBLE_SESSION_SECONDS ? 0 : seconds;
}

/**
 * 把网关的**命名字段**响应规范化为状态对象(首选路径)。
 *
 * 为什么首选它: 深澜不同固件的裸文本**位置布局不一致**, 而带 callback 时返回的
 * 命名字段没有歧义。HAUT 现网(网关 1.01.20180614)实测返回:
 *   add_time / keepalive_time / bytes_in / bytes_out / sum_bytes / sum_seconds /
 *   online_ip / user_balance / user_mac / sysver / domain / all_bytes ...
 *
 * 语义要点(踩过的坑):
 *   - `bytes_in` / `bytes_out` 是**本次会话**的下行/上行字节, 不是累计流量;
 *   - `sum_bytes` / `sum_seconds` 才是**累计**流量与累计在线秒数;
 *   - 本次会话时长 = keepalive_time - add_time。
 * 早期实现把 [3] 当累计流量、[4] 当在线时长, 结果会把上传量显示成"在线 595 天"。
 */
function statusFromJson(data) {
  const bytesIn = toInt(data.bytes_in);
  const bytesOut = toInt(data.bytes_out);
  const addTime = toInt(data.add_time);
  const keepaliveTime = toInt(data.keepalive_time);
  const hasSessionBytes = data.bytes_in !== undefined || data.bytes_out !== undefined;
  return {
    online: true,
    userName: String(data.user_name || ""),
    ip: String(data.online_ip || data.ip || ""),
    addTime,
    keepaliveTime,
    bytesIn,
    bytesOut,
    sessionBytes: hasSessionBytes ? bytesIn + bytesOut : toInt(data.all_bytes),
    sessionSeconds: sessionSecondsFrom(addTime, keepaliveTime),
    sumBytes: toInt(data.sum_bytes),
    sumSeconds: toInt(data.sum_seconds),
    balance: data.user_balance === undefined || data.user_balance === null
      ? null
      : Number(data.user_balance),
    gatewayVer: String(data.sysver || ""),
    domain: String(data.domain || ""),
    userMac: String(data.user_mac || ""),
    error: "",
  };
}

/**
 * 解析裸文本状态(位置语义), 作为不支持命名响应时的兜底。
 *
 * HAUT 现网实测布局(用 JSONP 命名响应逐位核对):
 *   [0]user_name [1]add_time [2]keepalive_time [3]bytes_in [4]bytes_out
 *   [5]? [6]sum_bytes [7]sum_seconds [8]online_ip [9]? [10]? [11]user_balance
 *   末段 sysver
 * 字段数不足 21 时按深澜旧版布局兜底:
 *   [0]user_name [1]add_time [3]sum_bytes [4]sum_seconds [8]online_ip 末段 sysver
 */
function statusFromText(body) {
  const text = String(body == null ? "" : body).trim();
  const fields = text.split(",");
  if (fields.length < 9) {
    throw new SrunError(`状态接口返回非预期格式: ${text.slice(0, 80)}`, {
      kind: "parse",
      raw: text,
    });
  }
  const at = (i) => toInt(fields[i]);
  const balanceValue = Number(fields[11]);
  // 末段取"最后一个非空字段": 有的固件会在末尾多带一个逗号(得到空字段)
  const lastNonEmpty = (() => {
    for (let i = fields.length - 1; i >= 0; i--) {
      const value = String(fields[i]).trim();
      if (value !== "") return value;
    }
    return "";
  })();

  if (fields.length >= 21) {
    const addTime = at(1);
    const keepaliveTime = at(2);
    const bytesIn = at(3);
    const bytesOut = at(4);
    return {
      online: true,
      userName: fields[0],
      ip: fields[8],
      addTime,
      keepaliveTime,
      bytesIn,
      bytesOut,
      sessionBytes: bytesIn + bytesOut,
      sessionSeconds: sessionSecondsFrom(addTime, keepaliveTime),
      sumBytes: at(6),
      sumSeconds: at(7),
      balance: Number.isFinite(balanceValue) ? balanceValue : null,
      gatewayVer: fields[fields.length - 1],
      domain: "",
      userMac: "",
      error: "",
    };
  }

  return {
    online: true,
    userName: fields[0],
    ip: fields[8],
    addTime: at(1),
    keepaliveTime: at(1),
    bytesIn: at(3),
    bytesOut: 0,
    sessionBytes: at(3),
    sessionSeconds: at(4),
    sumBytes: at(3),
    sumSeconds: at(4),
    balance: null,
    gatewayVer: fields[fields.length - 1],
    domain: "",
    userMac: "",
    error: "",
  };
}

// ---------------------------------------------------------------- 客户端

/**
 * srun portal HTTP 客户端。每次请求独立, 无共享可变状态。
 */
class SrunClient {
  /**
   * @param {{gateway?: string, timeout?: number, portalPort?: number, statusPort?: number,
   *          passwordAlgo?: string, infoFormat?: string, os?: string, name?: string}} [options]
   */
  constructor(options = {}) {
    this.gateway = String(options.gateway || "").trim() || DEFAULT_GATEWAY;
    this.timeout = options.timeout || 8000;
    this.portalPort = options.portalPort || PORTAL_PORT;
    this.statusPort = options.statusPort || STATUS_PORT;
    this.passwordAlgo = options.passwordAlgo || DEFAULT_PASSWORD_ALGO;
    this.infoFormat = options.infoFormat || DEFAULT_INFO_FORMAT;
    this.os = options.os || "Windows 10";
    this.name = options.name || "Windows";
  }

  /** 网关基地址, 允许用户直接填完整 URL 覆盖。 */
  get base() {
    if (/^https?:\/\//i.test(this.gateway)) return this.gateway.replace(/\/+$/, "");
    return `http://${this.gateway}`;
  }

  /** 取 base 的 host 部分(用于拼接不同端口的 URL)。 */
  get _host() {
    if (/^https?:\/\//i.test(this.gateway)) {
      const u = new URL(this.gateway);
      return `${u.protocol}//${u.hostname}`;
    }
    return `http://${this.gateway}`;
  }

  get portalUrl() {
    return `${this._host}:${this.portalPort}/cgi-bin/srun_portal`;
  }

  get statusUrl() {
    return this.statusPort === 80
      ? `${this.base}/cgi-bin/rad_user_info`
      : `${this._host}:${this.statusPort}/cgi-bin/rad_user_info`;
  }

  get challengeUrl() {
    return this.statusPort === 80
      ? `${this.base}/cgi-bin/get_challenge`
      : `${this._host}:${this.statusPort}/cgi-bin/get_challenge`;
  }

  /** 底层 GET, 自动拼接查询串。 */
  async _get(url, params = null, timeout = null) {
    const query = params ? urlencode(params) : "";
    const full = query ? `${url}?${query}` : url;
    return httpGet(full, { timeout: timeout || this.timeout });
  }

  /**
   * 查询在线状态。离线时网关返回 not_online_error 或空串。
   *
   * 优先带 callback 请求: 支持命名响应的网关会返回 JSON, 字段语义无歧义;
   * 若网关忽略 callback 仍返回裸文本, 再按位置解析(见 statusFromText)。
   */
  async queryStatus() {
    const text = await this._get(this.statusUrl, { callback: `jsonp${Date.now()}` });
    const body = String(text == null ? "" : text).trim();
    if (!body || body === "not_online_error" || body === "error") {
      return { online: false, error: body || "not_online" };
    }

    if (body.indexOf("{") >= 0) {
      try {
        const data = parseJsonp(body);
        const err = String(data.error === undefined || data.error === null ? "ok" : data.error);
        if (err === "not_online_error" || err === "not_online") {
          return { online: false, error: "not_online_error" };
        }
        if (err === "ok" || err === "" || data.user_name || data.sum_bytes !== undefined) {
          return statusFromJson(data);
        }
        return { online: false, error: err };
      } catch {
        // 含花括号却不是合法 JSONP, 落到位解析
      }
    }
    return statusFromText(body);
  }

  /** 获取认证令牌 (challenge)。 */
  async getToken(username, ip) {
    const callback = `jsonp${Date.now()}`;
    const text = await this._get(this.challengeUrl, { callback, username, ip });
    const data = parseJsonp(text);
    const error = String(data.error === undefined || data.error === null ? "ok" : data.error);
    if (error !== "ok" && error !== "") {
      throw new SrunError(data.error_msg || "获取认证令牌失败", { kind: "gateway", raw: text });
    }
    const token = data.challenge || "";
    if (!token) throw new SrunError("认证令牌为空", { kind: "gateway", raw: text });
    return token;
  }

  /**
   * 取本机用于认证的 IP: 优先用探测到的源地址, 否则取默认路由出口 IP。
   * 参考实现用 UDP connect 到 223.5.5.5:80 取源地址, 这里同法。
   */
  resolveIp(preferred = "") {
    if (preferred) return Promise.resolve(preferred);
    return new Promise((resolve) => {
      const sock = dgram.createSocket("udp4");
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        resolve(value);
      };
      sock.on("error", () => finish(""));
      sock.connect(80, "223.5.5.5", () => {
        try {
          finish(sock.address().address || "");
        } catch {
          finish("");
        }
      });
      setTimeout(() => finish(""), 2000);
    });
  }

  /** 登录。 */
  async login(username, password, options = {}) {
    const user = String(username || "").trim();
    if (!user || !password) {
      return { ok: false, message: "请先填写学号和密码" };
    }

    // 第一步: 确认本机认证 IP (在线时网关状态接口直接给出)
    let authIp = "";
    try {
      const st = await this.queryStatus();
      if (st.online && st.ip) authIp = st.ip;
    } catch {
      /* 状态查询失败不影响登录流程 */
    }
    if (!authIp) authIp = await this.resolveIp(options.ip || "");

    const token = await this.getToken(user, authIp);
    const [pwdField, hmd5] = makePasswordField(
      token,
      password,
      this.passwordAlgo,
      passwordPrefixFor(this.infoFormat)
    );
    const info = makeInfoField(user, password, authIp, token, this.infoFormat);
    const params = {
      callback: `jsonp${Date.now()}`,
      action: "login",
      username: user,
      password: pwdField,
      ac_id: AC_ID,
      ip: authIp,
      info: info,
      chksum: makeChksum(token, user, hmd5, authIp, info),
      n: N,
      type: TYPE,
      os: this.os,
      name: this.name,
      double_stack: "0",
    };
    const text = await this._get(this.portalUrl, params);
    const data = parseJsonp(text);
    const ecode = data.ecode;
    const error = String(data.error || "");
    const suc = String(data.suc_msg || "");
    // 与参考实现保持一致的判定: (ecode 成功 且 error 为 ok/空/success) 或 suc_msg 非空
    if (((ecode === 0 || ecode === "0") && ["ok", "", "success"].includes(error)) || suc) {
      const friendly = SUCCESS_MESSAGES[suc.toLowerCase()] || suc || "登录成功";
      const already = !SUCCESS_MESSAGES[suc.toLowerCase()] && /already|online/i.test(suc);
      return {
        ok: true,
        alreadyOnline: already,
        message: friendly,
        code: "",
        raw: text,
      };
    }
    const code = error.toUpperCase();
    if (ALREADY_ONLINE_CODES.has(code)) {
      return {
        ok: true,
        alreadyOnline: true,
        message: ERROR_MESSAGES[code] || suc || "已在线",
        code,
        raw: text,
      };
    }
    const msg =
      ERROR_MESSAGES[code] || data.error_msg || suc || `登录失败(${error || ecode})`;
    return { ok: false, alreadyOnline: false, message: String(msg), code, raw: text };
  }

  /** 注销。返回 { ok, message }。 */
  async logout(username, ip = "") {
    const user = String(username || "").trim();
    if (!user) return { ok: false, message: "请先填写学号" };
    let authIp = ip;
    if (!authIp) {
      try {
        const st = await this.queryStatus();
        authIp = st.online ? st.ip : "";
      } catch {
        authIp = "";
      }
    }
    if (!authIp) authIp = await this.resolveIp();
    const params = {
      callback: `jsonp${Date.now()}`,
      action: "logout",
      username: user,
      ip: authIp,
      ac_id: AC_ID,
      type: TYPE,
    };
    const text = await this._get(this.portalUrl, params);
    const data = parseJsonp(text);
    const ecode = data.ecode;
    const error = String(data.error || "");
    if (ecode === 0 || ecode === "0" || ["ok", "", "success"].includes(error)) {
      return { ok: true, message: data.suc_msg || "已退出网络连接" };
    }
    const code = error.toUpperCase();
    if (code === "E2620" || error.indexOf("not_online") >= 0) {
      return { ok: true, message: "当前本就未在线" };
    }
    return {
      ok: false,
      message: ERROR_MESSAGES[code] || data.error_msg || "注销失败",
      code,
    };
  }
}

module.exports = {
  // 客户端
  SrunClient,
  SrunError,
  // 常量
  DEFAULT_GATEWAY,
  PORTAL_PORT,
  STATUS_PORT,
  AC_ID,
  N,
  TYPE,
  ENC_VER,
  BASE64_ALPHABET,
  STD_ALPHABET,
  ERROR_MESSAGES,
  ALREADY_ONLINE_CODES,
  DEFAULT_PASSWORD_ALGO,
  DEFAULT_INFO_FORMAT,
  // 算法(供对拍测试直接调用)
  xencode,
  sencode,
  b64Srun,
  makePasswordField,
  passwordPrefixFor,
  makeInfoField,
  makeChksum,
  pyQuote,
  pyJsonDumps,
  urlencode,
  parseJsonp,
  statusFromJson,
  statusFromText,
  httpGet,
  // 展示格式化
  formatBytes,
  formatDuration,
};
