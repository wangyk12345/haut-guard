'use strict';
/**
 * mock-gateway.js —— 深澜(SRun)校园网认证网关模拟器 (纯 Node, 零依赖)
 *
 * 用途: 为 Electron 版客户端的协议移植提供可复现的验收靶场。
 * 本文件中的加解密/校验逻辑是**独立重写**的 (与 hautguard/srun_client.py 写法不同),
 * 目的是交叉验证: 如果参考实现有 bug, 这里不会跟着一起错。
 *
 * 用法一 (模块):
 *   const { startMockGateway } = require('./mock-gateway');
 *   const gw = await startMockGateway({ port: 0, token: 'fixed-token', failMode: 'none' });
 *   console.log(gw.url, gw.port);
 *   gw.setScenario({ failMode: 'timeout' });
 *   console.log(gw.requests, gw.log);
 *   await gw.close();
 *
 * 用法二 (命令行, 供手工调试):
 *   node mock-gateway.js --port 6900
 *   node mock-gateway.js --port 6901 --token deadbeef --fail-mode garbage
 *
 * 单端口同时服务三条路径:
 *   /cgi-bin/get_challenge   -> callback({"challenge":"<token>","error":"ok"})
 *   /cgi-bin/srun_portal     -> callback({...})  action=login|logout
 *   /cgi-bin/rad_user_info   -> 逗号分隔裸文本 / not_online_error
 *
 * 说明: 真实网关把 get_challenge / rad_user_info 放在 80 端口、srun_portal 放在
 * 69 端口。本 mock 一律使用**同一个端口**, 集成测试通过覆写客户端的 status_url /
 * challenge_url 来适配 (见 integration_python.py 顶部注释)。
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

// ------------------------------------------------------------------ 常量

const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SRUN_ALPHABET = 'LVoJPiCN2R8G90yg+hmFHuacZ1OWMnrsSTXkYpUq/3dlbfKwv6xztjI7DeBE45QA';

const AC_ID = '1';
const N = '200';
const TYPE = '1';
const ENC_VER = 'srun_bx1';
const VERSION = 'SRunCGIAuthIntfSvr V1.18';
const TAG = 0x86014019 | 0x183639A0;

// 与 hautguard/srun_client.py 的 ERROR_MESSAGES 保持一致的中文文案
const ERROR_MESSAGES = {
  E2531: '账号或密码错误',
  E2532: '账号被禁用',
  E2553: '密码错误次数过多，账号被暂时锁定',
  E2601: '本机 IP 已在别处登录',
  E2602: '账号已在别处登录',
  E2611: '账号余额不足',
  E2612: '账号已欠费',
  E2613: '账号已停机',
  E2620: '本机已在线，无需重复登录',
  E2621: '本机 IP 格式不正确',
  E3001: '认证参数不完整',
  E3002: '认证参数错误',
  E3005: '网关拒绝登录（参数或签名校验失败）',
  E3101: '网关内部错误',
  E6512: '账号未注册或不存在',
};

const STATUS_MESSAGES = {
  E2620: '当前本就未在线',
};

// 内置账号夹具 —— 与跨语言(JS 侧)对拍约定的**固定**夹具, 不要随意改动。
//   status:'ok'            -> 比对密码, 密码不符返回 E2531
//   forceError:true        -> 无论密码对错都直接返回该 status(错误码)
// 未在表里的用户名 -> unknownUserCode (默认 E2531; 真实网关上未注册账号是 E6512,
// 可以用 options.unknownUserCode='E6512' 还原真实行为)
const DEFAULT_ACCOUNTS = [
  { username: '20230001', password: 'correct-horse', status: 'ok' },
  { username: '20230002', password: 'battery-staple', status: 'ok' },
  { username: 'disabled', password: 'x', status: 'E2532', forceError: true },
  { username: 'locked', password: 'x', status: 'E2553', forceError: true },
  { username: 'elsewhere-ip', password: 'x', status: 'E2601', forceError: true },
  { username: 'elsewhere-account', password: 'x', status: 'E2602', forceError: true },
  { username: 'lowbalance', password: 'x', status: 'E2611', forceError: true },
  { username: 'arrears', password: 'x', status: 'E2612', forceError: true },
  { username: 'suspended', password: 'x', status: 'E2613', forceError: true },
  { username: 'already', password: 'x', status: 'E2620', forceError: true },
  { username: 'nobody', password: 'x', status: 'E6512', forceError: true },
];

// 在线状态串的 canonical 取值。
//
// 字段语义按 HAUT 现网(网关 1.01.20180614)用 JSONP 命名响应**逐位核对**得出:
//   [3] bytes_in  本次会话下行   [4] bytes_out 本次会话上行
//   [6] sum_bytes 账号累计流量   [7] sum_seconds 账号累计在线秒数
//   [11] user_balance 余额
// 注意: 早先把 [3] 当累计流量、[4] 当在线时长是错的, 会把上行字节显示成
// "在线 595 天"。这里按真实语义建模, 免得测试继续验证错误行为。
const DEFAULT_ONLINE_FIELDS = {
  add_time: 1758000000,
  keepalive_time: 1758002849, // 本次会话 = 2849 秒(47 分 29 秒)
  bytes_in: 320253309, // 本次下行 305.42 MB
  bytes_out: 51417663, // 本次上行 49.04 MB
  sum_bytes: 132329343471, // 账号累计 123.24 GB
  sum_seconds: 644217, // 账号累计 7 天 10 小时 56 分
  user_balance: 20, // 余额 20.00 元
  ip: '10.20.30.40',
  gateway_ver: '1.01.20180614',
};

/** 在线时 rad_user_info 返回的**原文**(账号 20230001 登录成功后即是这一行)。
 *  21 段, 结构与真实网关逐位一致(含 [10] 的空字段)。 */
const DEFAULT_STATUS_TEXT = [
  '20230001', // [0] user_name
  String(DEFAULT_ONLINE_FIELDS.add_time), // [1] add_time
  String(DEFAULT_ONLINE_FIELDS.keepalive_time), // [2] keepalive_time
  String(DEFAULT_ONLINE_FIELDS.bytes_in), // [3] bytes_in
  String(DEFAULT_ONLINE_FIELDS.bytes_out), // [4] bytes_out
  '0', // [5]
  String(DEFAULT_ONLINE_FIELDS.sum_bytes), // [6] sum_bytes
  String(DEFAULT_ONLINE_FIELDS.sum_seconds), // [7] sum_seconds
  DEFAULT_ONLINE_FIELDS.ip, // [8] online_ip
  '0', // [9]
  '', // [10]
  String(DEFAULT_ONLINE_FIELDS.user_balance), // [11] user_balance
  '0', '0', '0', '0', '0', '0', '0', '0', // [12..19]
  DEFAULT_ONLINE_FIELDS.gateway_ver, // [20] sysver
].join(',');

// 默认不预置任何在线会话: 全新 mock 的 rad_user_info 返回 not_online_error。
// 需要「已在别处登录」这类场景时, 用 options.onlineSessions 显式预置。
const DEFAULT_ONLINE_SESSIONS = [];

// 自检: 上面拼出来的原文必须与约定夹具逐字节一致, 否则直接拒绝启动。
const PINNED_STATUS_TEXT =
  '20230001,1758000000,1758002849,320253309,51417663,0,132329343471,644217,10.20.30.40,0,,20,0,0,0,0,0,0,0,0,1.01.20180614';
if (DEFAULT_STATUS_TEXT !== PINNED_STATUS_TEXT) {
  throw new Error('DEFAULT_STATUS_TEXT 与约定夹具不一致:\n' +
    `  got:  ${DEFAULT_STATUS_TEXT}\n  want: ${PINNED_STATUS_TEXT}`);
}

// ------------------------------------------------------------------ 加解密 (独立实现)

/** 生成自定义字母表的编码表: 标准 base64 字符 -> srun 字符 */
const ENC_TABLE = (() => {
  const m = Object.create(null);
  for (let i = 0; i < 64; i++) m[STD_ALPHABET[i]] = SRUN_ALPHABET[i];
  return m;
})();

/** 生成反查表: srun 字符 -> 标准 base64 字符 */
const DEC_TABLE = (() => {
  const m = Object.create(null);
  for (let i = 0; i < 64; i++) m[SRUN_ALPHABET[i]] = STD_ALPHABET[i];
  return m;
})();

/** 把 srun 自定义字母表的 base64 文本还原成 Buffer */
function srunB64Decode(text) {
  let std = '';
  for (const ch of text) {
    if (ch === '=' || ch === '\r' || ch === '\n') { std += ch; continue; }
    const mapped = DEC_TABLE[ch];
    if (mapped === undefined) throw new Error(`非法 base64 字符: ${JSON.stringify(ch)}`);
    std += mapped;
  }
  return Buffer.from(std, 'base64');
}

/** 把 Buffer 编码成 srun 自定义字母表的 base64 文本 */
function srunB64Encode(buf) {
  return Buffer.from(buf).toString('base64').split('').map((c) => ENC_TABLE[c] || c).join('');
}

/** JS 字符串按 UTF-8 取字节 (与 Python 的 .encode('utf-8') 等价) */
function utf8Bytes(str) {
  return Buffer.from(str, 'utf8');
}

/**
 * 文本 -> 32 位小端字数组。对应参考实现的 _sencode。
 * 差异点(有意): 参考实现用 ord() 取**码点**, 这里用 charCodeAt 取 UTF-16 码元,
 * 对 BMP 以外字符(emoji)二者不同 —— 这个差异由 gen_vectors.py 记录在向量里。
 */
function packWords(text, appendLength) {
  const out = [];
  for (let i = 0; i < text.length; i += 4) {
    const c0 = i < text.length ? text.charCodeAt(i) : 0;
    const c1 = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
    const c2 = i + 2 < text.length ? text.charCodeAt(i + 2) : 0;
    const c3 = i + 3 < text.length ? text.charCodeAt(i + 3) : 0;
    out.push(((c0 | (c1 << 8) | (c2 << 16) | (c3 << 24)) >>> 0));
  }
  if (appendLength) out.push(text.length);
  return out;
}

/** 32 位小端字数组 -> 字节 Buffer。对应参考实现的 _lencode(key=False)。 */
function unpackWords(words) {
  const buf = Buffer.alloc(words.length * 4);
  for (let i = 0; i < words.length; i++) {
    const v = words[i] >>> 0;
    buf[i * 4] = v & 0xff;
    buf[i * 4 + 1] = (v >>> 8) & 0xff;
    buf[i * 4 + 2] = (v >>> 16) & 0xff;
    buf[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return buf;
}

/**
 * 解码 srun 的 XXTEA 变体 (解密方向)。返回去掉长度字后的字节 Buffer。
 *
 * 加密的每一轮按 op(0), op(1), ..., op(n-1), tail 的顺序原地更新 w[], 其中
 *   op(j)  : z = (j===0 ? w[n] : w[j-1]) 的**本轮更新后**值, y = w[j+1] 的本轮更新前值
 *            w[j] += mix(z, y, k[(j&3)^e])
 *   tail   : w[n] += mix(w[n-1], w[0], k[(n&3)^e])
 * 轮数 q = 6 + 52/(n+1) 可预知, 全程只有加法, 所以解密就是完全逆序做减法:
 * 先撤 tail (此时 w[n-1]/w[0] 仍处于轮末状态, 正是正序 tail 用到的值),
 * 再按 j = n-1..0 逆序撤销 (此时 w[j+1] 已回滚, 正是正序 op(j) 用到的 y)。
 * mix() 里的 z 参数就是"当次操作前的某个字", 逆序时该字恰好处于当次操作前后的同一值。
 */
function xdecodeBytes(buf, keyWords) {
  if (!buf.length) return Buffer.alloc(0);
  if (buf.length % 4 !== 0) throw new Error(`密文长度不是 4 的倍数: ${buf.length}`);
  const k = keyWords.slice();
  while (k.length < 4) k.push(0);

  const v = [];
  for (let i = 0; i < buf.length; i += 4) v.push(buf.readUInt32LE(i));

  const n = v.length - 1;
  if (n < 1) throw new Error('密文过短');
  const q = Math.floor(6 + 52 / (n + 1));
  let d = (q * TAG) >>> 0;   // 正序加密结束时的 d

  for (let round = 0; round < q; round++) {
    const e = (d >>> 2) & 3;

    // (1) 撤销轮末对 w[n] 的操作
    {
      const z = v[n - 1];
      const y = v[0];
      let m = (z >>> 5) ^ (y << 2);
      m = (m + (((y >>> 3) ^ (z << 4)) ^ (d ^ y))) >>> 0;
      m = (m + (k[(n & 3) ^ e] ^ z)) >>> 0;
      v[n] = (v[n] - m) >>> 0;
    }

    // (2) 按 j = n-1 .. 0 逆序撤销 op(j)
    for (let j = n - 1; j >= 0; j--) {
      const z = j === 0 ? v[n] : v[j - 1];
      const y = v[j + 1];
      let m = (z >>> 5) ^ (y << 2);
      m = (m + (((y >>> 3) ^ (z << 4)) ^ (d ^ y))) >>> 0;
      m = (m + (k[(j & 3) ^ e] ^ z)) >>> 0;
      v[j] = (v[j] - m) >>> 0;
    }

    d = (d - TAG) >>> 0;
  }

  // 参考实现的 _sencode(msg, key=True) 把原始长度追加成最后一个字,
  // _lencode(pwd, True) 用它把结果裁回去 —— 不裁的话尾部会多出 1~4 个字节。
  const words = unpackWords(v);
  const limit = (v.length - 1) << 2;
  const m = v[v.length - 1];
  if (m < limit - 3 || m > limit) {
    throw new Error(`xencode 长度字非法(${m}, 期望 ${limit - 3}..${limit})，token 可能不对`);
  }
  return words.slice(0, m);
}

/** 用 token 解开 xencode 密文, 返回 UTF-8 文本 */
function xdecode(buf, key) {
  return xdecodeBytes(buf, packWords(key, false)).toString('utf8');
}

function md5hex(text) {
  return crypto.createHash('md5').update(utf8Bytes(text)).digest('hex');
}

/** hmac_md5(key, msg) 十六进制, 与 hashlib/hmac.new(token.encode(), msg.encode(), md5) 等价 */
function hmacMd5Hex(token, msg) {
  return crypto.createHmac('md5', utf8Bytes(token)).update(utf8Bytes(msg)).digest('hex');
}

function sha1hex(text) {
  return crypto.createHash('sha1').update(utf8Bytes(text)).digest('hex');
}

/** 与参考实现 make_chksum 完全同构的拼接 (独立写一遍, 便于对照) */
function expectedChksum(token, username, hmd5, ip, info) {
  return sha1hex([token, username, token, hmd5, token, AC_ID, token, ip,
    token, N, token, TYPE, token, info].join(''));
}

// ------------------------------------------------------------------ 参数解析

function decodeForm(body) {
  const out = {};
  for (const pair of body.split('&')) {
    if (!pair) continue;
    const idx = pair.indexOf('=');
    const rawK = idx < 0 ? pair : pair.slice(0, idx);
    const rawV = idx < 0 ? '' : pair.slice(idx + 1);
    const k = decodeURIComponent(rawK.replace(/\+/g, ' '));
    const v = decodeURIComponent(rawV.replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

function queryOf(req) {
  const q = req.url.indexOf('?');
  return q < 0 ? {} : decodeForm(req.url.slice(q + 1));
}

function pathOf(req) {
  const q = req.url.indexOf('?');
  return q < 0 ? req.url : req.url.slice(0, q);
}

/** query 与 POST body 合并, body 优先 (客户端用 GET, 但两种都兼容) */
function mergeParams(req, body) {
  const merged = Object.assign({}, queryOf(req));
  const ctype = String(req.headers['content-type'] || '');
  if (body) {
    if (ctype.indexOf('json') >= 0) {
      try {
        const js = JSON.parse(body);
        if (js && typeof js === 'object') Object.assign(merged, js);
      } catch (e) { /* 当作表单再试 */ }
    }
    if (body.indexOf('=') >= 0) Object.assign(merged, decodeForm(body));
  }
  return merged;
}

/** 极简字典序 JSON (与 Python json.dumps(sort_keys=True, ensure_ascii=False) 的输出一致) */
function jsonStable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jsonStable).join(', ') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ': ' + jsonStable(value[k])).join(', ') + '}';
}

// ------------------------------------------------------------------ 网关实现

function defaultScenario() {
  return {
    failMode: 'none',        // none | refuse | timeout | 500 | garbage | drop-after-n
    dropAfterN: 1,           // failMode === 'drop-after-n' 时的 N
    token: null,             // 固定 token; null 表示随机
    passwordAlgo: 'srun3',   // srun3 = hmac_md5(token, 明文密码); srbx1 = hmac_md5(token, "")
    // 真机实测: 本网关只接受 "{SRBX1}" + srun 字母表的 info(三种前缀共用同一张字母表),
    // 且 password 必须带 {MD5} 标记。默认按真机配置, 保证测试验证的是真实语义。
    infoFormat: 'srbx1',
    // 下面两个开关默认关闭, 是为了同时兼容两套验收脚本:
    //   mock.test.js        -> JS 客户端, 发 {SRBX1}(srun 字母表) + {MD5}hmd5 (真机流派)
    //   integration_python.py -> Python 参考实现, 默认发 {SRUN3}\r\n + {hmd5} (老流派),
    //                            且 scenario 7 会逐一验证 srun3/srbx1/none 三种 info 前缀
    // 打开后即为真机严格语义: 前缀/标记不符分别回 auth_info_error / password_algo_error。
    strictInfoFormat: false,      // true: info 前缀必须与 infoFormat 一致
    requirePasswordMarker: false, // true: password 必须带 {MD5} 之类标记
    tokenSingleUse: true,    // 真实网关会作废已用 token
    lanIp: '127.0.0.1',
    unknownUserCode: 'E2531', // 不在账号夹具表里的用户名返回的错误码
    forcePortalError: null,   // 例如 'E3002'/'E3101': srun_portal 直接返回该错误码
  };
}

function createState(options) {
  const opts = options || {};
  const sc = defaultScenario();
  for (const k of Object.keys(sc)) {
    if (opts[k] !== undefined) sc[k] = opts[k];
  }

  const state = {
    scenario: sc,
    accounts: new Map(),
    sessions: new Map(),      // key: `${username}|${loginIp}` -> 在线会话
    tokens: new Map(),        // key: `${username}|${ip}` -> token
    consumedTokens: new Set(),
    requests: [],
    log: [],
    logFile: opts.logFile || null,
    logToConsole: opts.logToConsole !== false,
    handled: 0,               // 已处理(通过故障注入)的请求数, 供 drop-after-n 用
    requestSeq: 0,
    listenHosts: [],
  };

  const accounts = opts.accounts || DEFAULT_ACCOUNTS;
  for (const a of accounts) {
    state.accounts.set(a.username, {
      username: a.username,
      password: a.password,
      status: a.status || 'ok',
      forceError: !!a.forceError,
      online: Object.assign({}, DEFAULT_ONLINE_FIELDS, a.online || {}),
    });
  }

  const seeded = opts.onlineSessions || DEFAULT_ONLINE_SESSIONS;
  for (const s of seeded) {
    state.sessions.set(sessionKey(s.username, s.ip), makeSession(s.username, s.ip, s, state));
  }
  return state;
}

function sessionKey(username, ip) {
  return `${username}|${ip}`;
}

/**
 * 建立在线会话。
 * login_ip: 登录请求里带的 ip(用于「已在线/已在别处登录」判定)
 * ip:       状态串里展示的 ip(取账号夹具的 canonical 值, 与登录 ip 无关 ——
 *           这样跨语言对拍时 rad_user_info 的原文不依赖测试选了哪个 IP)
 */
function makeSession(username, loginIp, extra, state) {
  const e = extra || {};
  const acct = state && state.accounts ? state.accounts.get(username) : null;
  const online = Object.assign({}, DEFAULT_ONLINE_FIELDS, (acct && acct.online) || {}, e);
  return {
    username,
    login_ip: loginIp,
    ip: online.ip,
    add_time: online.add_time,
    keepalive_time: online.keepalive_time,
    bytes_in: online.bytes_in,
    bytes_out: online.bytes_out,
    sum_bytes: online.sum_bytes,
    sum_seconds: online.sum_seconds,
    user_balance: online.user_balance,
    gateway_ver: online.gateway_ver,
  };
}

function randomToken() {
  return crypto.createHash('sha1')
    .update(String(process.hrtime.bigint()) + Math.random())
    .digest('hex');
}

function gatewayMessage(code, fallback) {
  return ERROR_MESSAGES[code] || fallback || code;
}

function record(state, req, pathname, params, note) {
  state.requestSeq += 1;
  const entry = {
    seq: state.requestSeq,
    time: new Date().toISOString(),
    method: req.method,
    path: pathname,
    query: params,
    note: note || '',
  };
  state.requests.push(entry);
  const brief = [
    `#${entry.seq}`,
    entry.time,
    req.method,
    pathname,
    summarizeParams(params),
    note ? `[${note}]` : '',
  ].filter(Boolean).join(' ');
  state.log.push(brief);
  if (state.logToConsole) console.log(`[mock-gateway] ${brief}`);
  if (state.logFile) {
    try {
      fs.appendFileSync(state.logFile, JSON.stringify(entry) + '\n');
    } catch (e) {
      console.error('[mock-gateway] 写日志失败:', e.message);
    }
  }
  return entry;
}

function summarizeParams(params) {
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const k of keys) {
    let v = params[k];
    if (typeof v === 'string' && v.length > 64) v = v.slice(0, 61) + '...';
    parts.push(`${k}=${v}`);
  }
  return parts.join('&');
}

function sendJsonp(res, callback, obj) {
  const payload = jsonStable(obj);
  const body = Buffer.from(`${callback}(${payload})`, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendText(res, status, text, ctype) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': ctype || 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

/**
 * 从 info 字段里取出 JSON。支持 {SRUN3}\r\n / {SRBX1} / 裸 base64 三种前缀。
 *
 * 字母表: **优先按 srun 自定义字母表解**。这一点是被真实网关纠正的: 公开实现常把
 * "{SRBX1}" 写成"标准 base64", 但 HAUT 现网的网页版 JS 里 $.base64.encode 用的是
 * 自定义字母表; 抓下真实登录请求逐字节对拍才确认。
 *
 * 兜底: 本仓库的 Python 参考实现 (hautguard/srun_client.py, 不允许改动) 在
 * info_format="srbx1" 时用的是**标准** base64 —— 两种写法在现实部署里并存, 所以
 * 自定义字母表解不出合法 JSON 时再退到标准 base64 试一次。真正判定"是否合法"的
 * 仍是解密后的长度字 + JSON 可解析性, 因此兜底不会放过伪造载荷。
 * 实际用了哪张表记录在返回值的 alphabet 字段里, 便于排查。
 *
 * 未知前缀(如 {FOO}...)直接抛错, 由调用方回 auth_info_error。
 */
function decodeInfoField(infoField, token) {
  const raw = String(infoField || '');
  let b64 = raw;
  let flavor = 'none';
  if (raw.startsWith('{SRUN3}')) {
    b64 = raw.slice('{SRUN3}'.length).replace(/^(\r\n|\n|\r)/, '');
    flavor = 'srun3';
  } else if (raw.startsWith('{SRBX1}')) {
    b64 = raw.slice('{SRBX1}'.length);
    flavor = 'srbx1';
  } else if (raw.startsWith('{')) {
    const m = /^\{([A-Za-z0-9]{1,16})\}/.exec(raw);
    const err = new Error(`不支持的 info 前缀 ${m ? m[0] : JSON.stringify(raw.slice(0, 8))}`);
    err.code = 'auth_info_error';
    throw err;
  }
  if (!b64) throw new Error('info 字段为空');

  const decoders = [
    ['srun', () => srunB64Decode(b64)],
    ['std', () => Buffer.from(b64.replace(/\s+/g, ''), 'base64')],
  ];
  let firstErr = null;
  for (const [alphabet, decode] of decoders) {
    let cipher;
    try {
      cipher = decode();
    } catch (e) {
      if (!firstErr) firstErr = e;
      continue;
    }
    if (!cipher || !cipher.length) {
      if (!firstErr) firstErr = new Error('base64 解码结果为空');
      continue;
    }
    try {
      const plain = xdecode(cipher, token);
      const parsed = JSON.parse(plain);
      return { flavor, alphabet, plain, json: parsed };
    } catch (e) {
      if (!firstErr) firstErr = e;
    }
  }
  throw firstErr || new Error('info 解密失败');
}

// ------------------------------------------------------------- 三个接口

function handleChallenge(state, req, res, params, pathname) {
  const callback = params.callback || '';
  const username = params.username || '';
  const ip = params.ip || '';
  if (!callback) {
    sendJsonp(res, 'cb', { error: 'E3001', error_msg: gatewayMessage('E3001'), ecode: 1 });
    return;
  }
  if (!username) {
    sendJsonp(res, callback, { error: 'E3001', error_msg: gatewayMessage('E3001'), ecode: 1 });
    return;
  }
  const effectiveIp = ip || state.scenario.lanIp;
  const token = state.scenario.token || randomToken();
  state.tokens.set(sessionKey(username, effectiveIp), token);
  // 也按 username 记一份, 便于客户端先拿 token 后用别的 IP 登录的场景
  state.tokens.set(sessionKey(username, ''), token);
  sendJsonp(res, callback, { challenge: token, error: 'ok', client_ip: effectiveIp });
}

function handleRadUserInfo(state, req, res, params, pathname) {
  const username = params.user_name || params.username || '';
  const ip = params.ip || '';
  const callback = params.callback || '';

  const byLoginIp = (val) => {
    for (const s of state.sessions.values()) if (s.login_ip === val) return s;
    return null;
  };
  const byShownIp = (val) => {
    for (const s of state.sessions.values()) if (s.ip === val) return s;
    return null;
  };
  const byUser = (val) => {
    for (const s of state.sessions.values()) if (s.username === val) return s;
    return null;
  };

  let session = null;
  if (username && ip) session = state.sessions.get(sessionKey(username, ip)) || null;
  if (!session && ip) session = byShownIp(ip) || byLoginIp(ip);
  if (!session && username) session = byUser(username);
  // 参考实现 query_status() 不带任何参数(真实网关按 TCP 源 IP 识别客户端)。
  // mock 里客户端源 IP 恒为 127.0.0.1, 所以退化为: 只有 1 个在线会话时返回它。
  if (!session && !username && !ip) {
    if (state.sessions.size === 1) session = state.sessions.values().next().value;
    else session = byLoginIp('127.0.0.1') || byShownIp('127.0.0.1');
  }

  if (!session) {
    if (callback) {
      sendJsonp(res, callback, { error: 'not_online_error', error_msg: 'not_online_error', ecode: 1 });
    } else {
      sendText(res, 200, 'not_online_error');
    }
    return;
  }
  if (callback) {
    // 命名字段响应的字段集与真实网关一致(实测抓取), 客户端优先走这条路径:
    // 深澜各固件的裸文本位置布局不一致, 命名字段没有歧义。
    sendJsonp(res, callback, {
      ServerFlag: 4294967041,
      error: 'ok',
      user_name: session.username,
      online_ip: session.ip,
      add_time: session.add_time,
      keepalive_time: session.keepalive_time,
      bytes_in: session.bytes_in,
      bytes_out: session.bytes_out,
      all_bytes: session.bytes_in + session.bytes_out,
      sum_bytes: session.sum_bytes,
      sum_seconds: session.sum_seconds,
      user_balance: session.user_balance,
      user_charge: 0,
      wallet_balance: 0,
      remain_seconds: 0,
      checkout_date: 0,
      domain: 'test',
      real_name: '',
      user_mac: 'aa:bb:cc:dd:ee:ff',
      sysver: session.gateway_ver,
    });
    return;
  }
  sendText(res, 200, statusText(session));
}

/**
 * 在线状态裸文本: 逗号分隔 21 段, 与 HAUT 现网(网关 1.01.20180614)逐位一致:
 *   [0]=user_name [1]=add_time [2]=keepalive_time [3]=bytes_in [4]=bytes_out
 *   [5]=0 [6]=sum_bytes [7]=sum_seconds [8]=online_ip [9]=0 [10]=''
 *   [11]=user_balance [12..19]=0 [20]=sysver
 * 账号 20230001 在线时, 输出必须逐字节等于 DEFAULT_STATUS_TEXT。
 */
function statusText(session) {
  return [
    session.username,
    String(session.add_time),
    String(session.keepalive_time),
    String(session.bytes_in),
    String(session.bytes_out),
    '0',
    String(session.sum_bytes),
    String(session.sum_seconds),
    session.ip,
    '0',
    '',
    String(session.user_balance),
    '0',
    '0',
    '0',
    '0',
    '0',
    '0',
    '0',
    '0',
    session.gateway_ver,
  ].join(',');
}

function handlePortal(state, req, res, params, pathname) {
  const callback = params.callback || 'cb';
  const action = String(params.action || '').toLowerCase();
  if (state.scenario.forcePortalError) {
    const code = state.scenario.forcePortalError;
    sendJsonp(res, callback, {
      ecode: 1, error: code, error_msg: gatewayMessage(code), suc_msg: '',
    });
    return;
  }
  if (action === 'logout') return handleLogout(state, res, params, callback);
  if (action === 'login') return handleLogin(state, res, params, callback);
  sendJsonp(res, callback, {
    ecode: 1, error: 'E3002', error_msg: gatewayMessage('E3002'), suc_msg: '',
  });
}

function handleLogout(state, res, params, callback) {
  const username = String(params.username || '');
  const ip = String(params.ip || '');
  let session = null;
  if (username && ip) session = state.sessions.get(sessionKey(username, ip)) || null;
  if (!session && username) {
    for (const s of state.sessions.values()) {
      if (s.username === username) { session = s; break; }
    }
  }
  if (!session && ip) {
    for (const s of state.sessions.values()) {
      if (s.login_ip === ip || s.ip === ip) { session = s; break; }
    }
  }
  // 单客户端靶场的兜底: 只找得到唯一一条在线会话时, 认为那就是要注销的会话
  if (!session && state.sessions.size === 1) session = state.sessions.values().next().value;
  if (!session) {
    sendJsonp(res, callback, {
      ecode: 1,
      error: 'E2620',
      error_msg: STATUS_MESSAGES.E2620,
      suc_msg: STATUS_MESSAGES.E2620,
    });
    return;
  }
  state.sessions.delete(sessionKey(session.username, session.login_ip));
  sendJsonp(res, callback, { ecode: 0, error: 'ok', error_msg: '', suc_msg: '已退出网络连接' });
}

function handleLogin(state, res, params, callback) {
  const fail = (code, extra) => sendJsonp(res, callback, Object.assign({
    ecode: 1,
    error: code,
    error_msg: gatewayMessage(code),
    suc_msg: '',
  }, extra || {}));

  const username = String(params.username || '');
  const ip = String(params.ip || '');
  const passwordField = String(params.password || '');
  const infoField = String(params.info || '');
  const chksum = String(params.chksum || '');
  const acId = String(params.ac_id === undefined ? '' : params.ac_id);
  const n = String(params.n === undefined ? '' : params.n);
  const type = String(params.type === undefined ? '' : params.type);
  const doubleStack = String(params.double_stack === undefined ? '0' : params.double_stack);

  // 1) 必填参数
  const missing = [];
  for (const [name, val] of [['username', username], ['password', passwordField],
    ['ip', ip], ['info', infoField], ['chksum', chksum], ['ac_id', acId]]) {
    if (!val) missing.push(name);
  }
  if (missing.length) return fail('E3001', { error_msg: `${gatewayMessage('E3001')}: ${missing.join(',')}` });
  if (n !== N || type !== TYPE || acId !== AC_ID) return fail('E3002');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return fail('E2621');

  // 2) token / chksum
  const keyed = sessionKey(username, ip);
  let token = state.tokens.get(keyed);
  if (!token) token = state.tokens.get(sessionKey(username, ''));
  if (!token) return fail('E3002', { error_msg: '未先获取 challenge（token 不存在或已过期）' });
  // 注意: token 只在**登录成功**之后作废(见步骤 8)。这样"先故意发一次错误签名、
  // 再用同一个 token 发正确签名"的测试顺序才成立(真实网关也是认证成功才消费 token)。
  const expect = expectedChksum(token, username, hmacMd5FromPasswordField(passwordField), ip, infoField);
  if (chksum.toLowerCase() !== expect) {
    return fail('E3005', { error_msg: 'chksum 校验失败' });
  }

  // 3) info 解密 + 字段核对
  let decoded;
  try {
    decoded = decodeInfoField(infoField, token);
  } catch (e) {
    // 未知前缀属于"算法/前缀不受支持", 按约定回 auth_info_error;
    // 其余(解密失败/JSON 不合法)是签名侧问题, 回 E3005。
    if (e && e.code === 'auth_info_error') {
      return fail('auth_info_error', { error_msg: e.message });
    }
    return fail('E3005', { error_msg: `info 解密失败: ${e.message}` });
  }
  // 真机实测: 本网关只接受 "{SRBX1}" 前缀的 info, 其他前缀回 auth_info_error。
  // 但本仓库的 Python 参考实现默认发 "{SRUN3}\r\n"(info_format="srun3"), 而
  // integration_python.py 又必须用默认参数跑通 —— 两套验收脚本对默认流派的期望相反,
  // 所以默认**自适应接受**三种已知前缀, 需要真机严格语义时把它打开:
  //   options.strictInfoFormat / CLI --strict-info-format / setScenario({strictInfoFormat:true})
  const expectedInfo = state.scenario.infoFormat;
  if (state.scenario.strictInfoFormat && expectedInfo && decoded.flavor !== expectedInfo) {
    return fail('auth_info_error', {
      error_msg: `info 前缀是 ${decoded.flavor}, 本网关期望 ${expectedInfo}`,
    });
  }
  const got = decoded.json;
  const mismatches = [];
  if (got.username !== username) mismatches.push(`username=${got.username}`);
  if (String(got.ip) !== ip) mismatches.push(`ip=${got.ip}`);
  if (String(got.acid) !== acId) mismatches.push(`acid=${got.acid}`);
  if (String(got.enc_ver || ENC_VER) !== ENC_VER) mismatches.push(`enc_ver=${got.enc_ver}`);
  if (mismatches.length) return fail('E3005', { error_msg: `info 字段不一致: ${mismatches.join(',')}` });

  // 4) password 字段的 hmac_md5
  //    真机实测: 本网关**必须**带 "{MD5}" 标记 —— 只包花括号("{<hex>}")会被回
  //    password_algo_error。但本仓库的 Python 参考实现 (不允许改动) 发的正是
  //    "{<hex>}"(无标记), 而 integration_python.py 必须跑通, 所以:
  //      · 默认接受 "{MD5}hex" / "{SRUN3}hex" / "{SRBX1}hex" / "{hex}" / "hex";
  //      · 未知标记(如 {SHA1}xxx) 一律 password_algo_error;
  //      · 打开 requirePasswordMarker 后恢复真机严格语义(无标记即 password_algo_error):
  //        options.requirePasswordMarker / CLI --require-password-marker /
  //        setScenario({requirePasswordMarker:true})
  const algo = state.scenario.passwordAlgo;
  let hmd5Raw = passwordField.trim();
  let marker = null;
  const knownMarker = /^\{(MD5|SRUN3|SRBX1)\}/i.exec(hmd5Raw);
  if (knownMarker) {
    marker = knownMarker[1].toUpperCase();
    hmd5Raw = hmd5Raw.slice(knownMarker[0].length);
  } else {
    // 形如 {SHA1}abcd... 的未知标记; "{<32位hex>}" 是老流派的无标记写法, 不算标记
    const other = /^\{([A-Za-z][A-Za-z0-9]{0,15})\}/.exec(hmd5Raw);
    if (other && !/^[0-9a-fA-F]{32}$/.test(other[1])) {
      return fail('password_algo_error', {
        error_msg: `不支持的算法标记 {${other[1]}}`,
      });
    }
  }
  if (state.scenario.requirePasswordMarker && !marker) {
    return fail('password_algo_error', {
      error_msg:
        `password 字段缺少算法标记(本网关要求 {MD5}): ${JSON.stringify(String(passwordField).slice(0, 24))}`,
    });
  }
  hmd5Raw = hmd5Raw.replace(/^\{/, '').replace(/\}$/, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hmd5Raw)) {
    return fail('E3005', {
      error_msg: `password 字段格式不合法 (期望 hmac_md5 的 32 位 hex): ${JSON.stringify(String(passwordField).slice(0, 24))}`,
    });
  }
  const hmd5 = hmd5Raw.toLowerCase();
  const passwordPlain = typeof got.password === 'string' ? got.password : '';
  const expectHmd5 = algo === 'srbx1'
    ? hmacMd5Hex(token, '')
    : hmacMd5Hex(token, passwordPlain);
  if (hmd5 !== expectHmd5) {
    return fail('E3005', {
      error_msg: `password 字段 hmac_md5 校验失败 (网关按 ${algo} 流派校验)`,
    });
  }

  // 5) 账号夹具表: forceError 的账号无论密码对错都直接返回该错误码
  //    (约定好的校验顺序: chksum/info -> 账号错误码表 -> 密码比对)
  const account = state.accounts.get(username);
  if (account && account.forceError) return fail(account.status);

  // 6) 密码比对 (明文取自 info 解密结果)
  if (!account) {
    // 未在夹具表里的用户名
    return fail(state.scenario.unknownUserCode || 'E2531');
  }
  if (passwordPlain !== String(account.password)) return fail('E2531');

  // 7) 在线冲突: 同一账号已经在线 -> E2620(幂等, 客户端按 already_online 处理)。
  //    注意: 这里**不再**用会话去推断 E2601/E2602 —— 真实网关靠 TCP 源 IP 判定"别处",
  //    而本地 mock 的客户端源 IP 恒为 127.0.0.1, 用请求里的 ip 反推会误伤多账号测试。
  //    E2601/E2602 由账号夹具(elsewhere-ip / elsewhere-account)专门覆盖。
  const mySession = [...state.sessions.values()].find((s) => s.username === username);
  if (mySession) return fail('E2620');

  // 8) 成功: mock 是"单客户端"靶场 —— 一次成功登录会顶掉之前的在线会话,
  //    这样多个测试用例之间不会互相污染 (真实网关是每 IP 一条在线会话)。
  const session = makeSession(username, ip, null, state);
  session.double_stack = doubleStack;
  state.sessions.clear();
  state.sessions.set(keyed, session);
  if (state.scenario.tokenSingleUse) {
    state.tokens.delete(keyed);
    state.tokens.delete(sessionKey(username, ''));
    state.consumedTokens.add(token);
  }
  sendJsonp(res, callback, {
    ecode: 0,
    error: 'ok',
    error_msg: '',
    suc_msg: '登录成功',
    online_ip: session.ip,
    // 真实网关还会回这些, 这里一并给出便于前端联调
    user_name: username,
    add_time: session.add_time,
  });
}

/** 从 password 字段里取 hmac 值 (参数字段可能是 {SRUN3}/{SRBX1}/{MD5}/裸 32 hex) */
function hmacMd5FromPasswordField(field) {
  const m = /\{?([0-9a-fA-F]{32})\}?/.exec(String(field || ''));
  return m ? m[1].toLowerCase() : 'no-hmac-available';
}

// ------------------------------------------------------------------ 故障注入

function applyFailMode(state, req, res) {
  const mode = state.scenario.failMode;
  if (mode === 'none') return false;
  if (mode === 'drop-after-n') {
    if (state.handled < Number(state.scenario.dropAfterN || 1)) return false;
    return doRefuse(req, res);
  }
  if (mode === 'refuse') return doRefuse(req, res);
  if (mode === 'timeout') {
    // 挂起不响应: 保持 socket 打开, 直到客户端自己超时
    if (!res.writableEnded) { /* 什么也不做 */ }
    return true;
  }
  if (mode === '500') {
    sendText(res, 500, 'Internal Server Error');
    return true;
  }
  if (mode === 'garbage') {
    sendText(res, 200, '<<<not a jsonp response at all>>>', 'text/html; charset=utf-8');
    return true;
  }
  return false;
}

function doRefuse(req, res) {
  try {
    req.socket.destroy();
  } catch (e) { /* ignore */ }
  try {
    if (!res.writableEnded) res.destroy();
  } catch (e) { /* ignore */ }
  return true;
}

// ------------------------------------------------------------------ 服务器

function createServer(state) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    let tooLarge = false;
    req.on('data', (c) => {
      if (chunks.length > 64) { tooLarge = true; return; }
      chunks.push(c);
    });
    req.on('error', () => { /* 客户端提前断开 */ });
    req.on('end', () => {
      let body = '';
      try {
        body = Buffer.concat(chunks).toString('utf8');
      } catch (e) { body = ''; }
      safeHandle(state, req, res, body, tooLarge);
    });
  });
  server.on('clientError', (err, socket) => {
    try { socket.destroy(); } catch (e) { /* ignore */ }
  });
  server.on('error', (err) => {
    console.error('[mock-gateway] server error:', err.message);
  });
  return server;
}

function safeHandle(state, req, res, body, tooLarge) {
  const pathname = pathOf(req);
  let params = {};
  try {
    params = mergeParams(req, body);
  } catch (e) {
    params = {};
  }
  const note = tooLarge ? 'body 过大' : '';
  const entry = record(state, req, pathname, params, note);
  try {
    if (tooLarge) { sendText(res, 500, 'request body too large'); return; }
    // /__mock__/* 是控制面(探测就绪/切换场景), 不受故障注入影响, 否则
    // failMode=refuse|timeout 时连"探活"都做不了。
    const isControl = pathname.startsWith('/__mock__/');
    if (!isControl && applyFailMode(state, req, res)) {
      entry.note = (entry.note ? entry.note + ';' : '') + `failMode=${state.scenario.failMode}`;
      return;
    }
    state.handled += 1;
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }
    if (pathname === '/cgi-bin/get_challenge') return handleChallenge(state, req, res, params, pathname);
    if (pathname === '/cgi-bin/srun_portal') return handlePortal(state, req, res, params, pathname);
    if (pathname === '/cgi-bin/rad_user_info') return handleRadUserInfo(state, req, res, params, pathname);
    if (pathname === '/__mock__/state') {
      sendText(res, 200, JSON.stringify({
        ok: true,
        failMode: state.scenario.failMode,
        passwordAlgo: state.scenario.passwordAlgo,
        infoFormat: state.scenario.infoFormat,
        strictInfoFormat: state.scenario.strictInfoFormat,
        requirePasswordMarker: state.scenario.requirePasswordMarker,
        online: [...state.sessions.values()],
        requestCount: state.requests.length,
      }), 'application/json; charset=utf-8');
      return;
    }
    if (pathname === '/__mock__/scenario' && req.method === 'POST') {
      if (body) {
        try { state.scenario = Object.assign(state.scenario, JSON.parse(body)); } catch (e) { /* ignore */ }
      }
      sendText(res, 200, JSON.stringify({ ok: true, failMode: state.scenario.failMode }),
        'application/json; charset=utf-8');
      return;
    }
    sendText(res, 404, 'Not Found');
  } catch (err) {
    entry.note = (entry.note ? entry.note + ';' : '') + `handler error: ${err.message}`;
    try {
      if (!res.writableEnded) {
        sendJsonp(res, params.callback || 'cb', {
          ecode: 1, error: 'E3101', error_msg: `${gatewayMessage('E3101')}: ${err.message}`, suc_msg: '',
        });
      }
    } catch (e2) {
      try { res.destroy(); } catch (e3) { /* ignore */ }
    }
    console.error('[mock-gateway] handler 异常:', err && err.stack ? err.stack : err);
  }
}

/**
 * 启动模拟网关。
 * @param {object} [options]
 *   port            监听端口, 0 表示随机可用端口 (默认 6900)
 *   host            监听地址, 默认 undefined(=0.0.0.0, 同时可达 127.0.0.1 与局域网 IP)
 *   token           固定 challenge token (默认随机)
 *   failMode        none|refuse|timeout|500|garbage|drop-after-n
 *   dropAfterN      drop-after-n 的 N
 *   passwordAlgo    srun3|srbx1
 *   infoFormat      srun3|srbx1|none
 *   accounts        账号夹具数组 (覆盖内置)
 *   onlineSessions  预置在线会话数组
 *   logFile         把请求日志追加写到该 JSONL 文件
 *   logToConsole    是否打印到 stdout (默认 true)
 * @returns {Promise<{port:number,url:string,host:string,listenHosts:string[],close:Function,log:string[],requests:object[],setScenario:Function,state:object,server:object}>}
 */
function startMockGateway(options) {
  const opts = Object.assign({}, options || {});
  const state = createState(opts);
  const server = createServer(state);
  const port = opts.port === undefined ? 6900 : opts.port;
  const host = opts.host;

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const actualPort = addr.port;
      const listenHosts = ['127.0.0.1'];
      if (state.scenario.lanIp && state.scenario.lanIp !== '127.0.0.1') listenHosts.push(state.scenario.lanIp);
      const handle = {
        port: actualPort,
        host: '127.0.0.1',
        url: `http://127.0.0.1:${actualPort}`,
        listenHosts,
        server,
        state,
        get requests() { return state.requests; },
        get log() { return state.log; },
        setScenario(patch) {
          state.scenario = Object.assign(state.scenario, patch || {});
          return state.scenario;
        },
        reset() {
          state.sessions.clear();
          for (const s of (opts.onlineSessions || DEFAULT_ONLINE_SESSIONS)) {
            state.sessions.set(sessionKey(s.username, s.ip),
              makeSession(s.username, s.ip, s, state));
          }
          state.tokens.clear();
          state.consumedTokens.clear();
          state.handled = 0;
          state.requests.length = 0;
          state.log.length = 0;
        },
        close() {
          return new Promise((res2) => {
            // 处理 timeout 场景残留下来的悬挂连接
            try { server.closeAllConnections(); } catch (e) { /* 旧版本 node 没有 */ }
            server.close(() => res2());
          });
        },
      };
      resolve(handle);
    });
  });
}

// ------------------------------------------------------------------ CLI

function parseCli(argv) {
  const opts = { port: 6900, logToConsole: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port' || a === '-p') opts.port = Number(next());
    else if (a === '--host') opts.host = next();
    else if (a === '--token' || a === '-t') opts.token = next();
    else if (a === '--fail-mode') opts.failMode = next();
    else if (a === '--drop-after-n') opts.dropAfterN = Number(next());
    else if (a === '--password-algo') opts.passwordAlgo = next();
    else if (a === '--info-format') opts.infoFormat = next();
    else if (a === '--strict-info-format') opts.strictInfoFormat = true;
    else if (a === '--require-password-marker') opts.requirePasswordMarker = true;
    else if (a === '--log-json') opts.logFile = next();
    else if (a === '--fixtures') opts.fixturesFile = next();
    else if (a === '--quiet') opts.logToConsole = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else console.error(`[mock-gateway] 未知参数: ${a}`);
  }
  if (opts.fixturesFile) {
    // 夹具文件: {"accounts": [...], "onlineSessions": [...], 以及任意 scenario 字段}
    try {
      const raw = fs.readFileSync(opts.fixturesFile, 'utf8');
      const fx = JSON.parse(raw);
      for (const key of Object.keys(fx)) {
        if (opts[key] === undefined) opts[key] = fx[key];
      }
    } catch (e) {
      console.error(`[mock-gateway] 读取夹具失败 ${opts.fixturesFile}: ${e.message}`);
      process.exit(2);
    }
  }
  return opts;
}

function usage() {
  console.log(`深澜网关模拟器

用法: node mock-gateway.js [选项]

  --port <n>            监听端口 (默认 6900, 0=随机)
  --host <ip>           监听地址 (默认全部)
  --token <s>           固定 challenge token (默认随机)
  --fail-mode <m>       none|refuse|timeout|500|garbage|drop-after-n
  --drop-after-n <n>    drop-after-n 模式下的 N
  --password-algo <a>   srun3|srbx1 (默认 srun3)
  --info-format <f>     srun3|srbx1|none (默认 srbx1)
  --strict-info-format  info 前缀必须与 --info-format 一致, 否则 auth_info_error
  --require-password-marker
                        password 必须带 {MD5} 标记, 否则 password_algo_error
  --log-json <path>     请求日志追加到 JSONL 文件
  --fixtures <path>     从 JSON 文件读入 {accounts, onlineSessions, ...} 夹具
  --quiet               不打印请求日志
  -h, --help            显示帮助

说明: 默认自适应接受三种 info 前缀({SRUN3}/{SRBX1}/裸) 与有无 {MD5} 标记的 password,
      因为 mock.test.js(真机流派 {SRBX1}+{MD5}) 与 integration_python.py(老流派
      {SRUN3}+{hmd5}) 两套验收脚本对默认流派的期望相反; 未知前缀/未知标记仍然报错。
      要复现真机严格语义, 加 --strict-info-format --require-password-marker。

手工调试示例 (PowerShell):
  node mock-gateway.js --port 6901 --token test-token-0001 --quiet
  curl.exe "http://127.0.0.1:6901/cgi-bin/get_challenge?callback=cb&username=20230001&ip=10.20.30.40"
  curl.exe "http://127.0.0.1:6901/cgi-bin/rad_user_info"

内置账号夹具 (DEFAULT_ACCOUNTS):
  20230001 / correct-horse       登录成功
  20230002 / battery-staple      密码比对; 写错 -> E2531
  disabled            -> E2532    locked            -> E2553
  elsewhere-ip        -> E2601    elsewhere-account -> E2602
  lowbalance          -> E2611    arrears           -> E2612
  suspended           -> E2613    already           -> E2620
  nobody              -> E6512    未列出的用户名    -> E2531
登录成功后 rad_user_info 返回 (DEFAULT_STATUS_TEXT):
  ${DEFAULT_STATUS_TEXT}
`);
}

if (require.main === module) {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    usage();
    process.exit(0);
  }
  startMockGateway(cli).then((gw) => {
    console.log(`[mock-gateway] 已启动: ${gw.url}  (failMode=${gw.state.scenario.failMode}, ` +
      `passwordAlgo=${gw.state.scenario.passwordAlgo}, infoFormat=${gw.state.scenario.infoFormat}, ` +
      `token=${gw.state.scenario.token || '(随机)'})`);
    console.log(`[mock-gateway] 端点: ${gw.url}/cgi-bin/get_challenge | ` +
      `${gw.url}/cgi-bin/srun_portal | ${gw.url}/cgi-bin/rad_user_info`);
    const shutdown = () => {
      gw.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    console.error('[mock-gateway] 启动失败:', err.message);
    process.exit(1);
  });
}

module.exports = {
  startMockGateway,
  // 便于测试脚本直接复用
  DEFAULT_ACCOUNTS,
  DEFAULT_ONLINE_SESSIONS,
  DEFAULT_ONLINE_FIELDS,
  DEFAULT_STATUS_TEXT,
  ERROR_MESSAGES,
  SRUN_ALPHABET,
  srunB64Decode,
  srunB64Encode,
  xdecode,
  expectedChksum,
  hmacMd5Hex,
  md5hex,
  statusText,
  decodeInfoField,
  jsonStable,
};
