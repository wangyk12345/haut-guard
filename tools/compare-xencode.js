/**
 * compare-xencode.js —— 用网关自己的 xEncode 实现与我的移植做逐字节对拍。
 *
 * 背景: 真机登录卡在 `info` 字段对不上时, 必须排除"我的 xEncode 与网关不等价"这个
 * 可能。网关派发的 jquery.srun.portal.js 里的 xEncode 是它**实际使用**的版本
 * (charCodeAt + 32 位有符号位运算), 而我的移植对齐的是 Python 参考实现的任意精度
 * 语义。两者在数学上应当同余于 2^32 —— 这个脚本就是用来实测确认的。
 *
 * 结论(实测): 在 ASCII 输入下两者**完全一致**。当初 info 对不上真正的原因是
 * base64 字母表(网关的 `{SRBX1}` 用的是 srun 自定义字母表, 不是标准 base64),
 * 与 xEncode 无关。
 *
 * 用法: node tools/compare-xencode.js ["<msg>" "<key>"]
 *       node tools/compare-xencode.js            # 用内置的若干样例
 */
"use strict";

const path = require("node:path");
const srun = require(path.join(__dirname, "..", "src", "main", "srun"));

// ---------------------------------------------------------------- 门户原版实现
// 逐行照抄网关派发的 jquery.srun.portal.js(不做任何改写)
function portal_s(a, b) {
  var c = a.length,
    v = [];
  for (var i = 0; i < c; i += 4) {
    v[i >> 2] =
      a.charCodeAt(i) |
      (a.charCodeAt(i + 1) << 8) |
      (a.charCodeAt(i + 2) << 16) |
      (a.charCodeAt(i + 3) << 24);
  }
  if (b) {
    v[v.length] = c;
  }
  return v;
}

function portal_l(a, b) {
  var d = a.length,
    c = (d - 1) << 2;
  if (b) {
    var m = a[d - 1];
    if (m < c - 3 || m > c) return null;
    c = m;
  }
  for (var i = 0; i < d; i++) {
    a[i] = String.fromCharCode(
      a[i] & 0xff,
      (a[i] >>> 8) & 0xff,
      (a[i] >>> 16) & 0xff,
      (a[i] >>> 24) & 0xff
    );
  }
  if (b) {
    return a.join("").substring(0, c);
  } else {
    return a.join("");
  }
}

function portalXEncode(str, key) {
  if (str == "") return "";
  var v = portal_s(str, true),
    k = portal_s(key, false);
  if (k.length < 4) k.length = 4;
  var n = v.length - 1,
    z = v[n],
    y = v[0],
    c = 0x86014019 | 0x183639a0,
    m,
    e,
    p,
    q = Math.floor(6 + 52 / (n + 1)),
    d = 0;
  while (0 < q--) {
    d = (d + c) & (0x8ce0d9bf | 0x731f2640);
    e = (d >>> 2) & 3;
    for (p = 0; p < n; p++) {
      y = v[p + 1];
      m = (z >>> 5) ^ (y << 2);
      m += ((y >>> 3) ^ (z << 4)) ^ (d ^ y);
      m += (k[(p & 3) ^ e] ^ z);
      z = v[p] = (v[p] + m) & (0xefb8d130 | 0x10472ecf);
    }
    y = v[0];
    m = (z >>> 5) ^ (y << 2);
    m += ((y >>> 3) ^ (z << 4)) ^ (d ^ y);
    m += (k[(p & 3) ^ e] ^ z);
    z = v[n] = (v[n] + m) & (0xbb390742 | 0x44c6f8bd);
  }
  return portal_l(v, false);
}

// ---------------------------------------------------------------- 对拍
function diffOne(msg, key, label) {
  const mine = srun.xencode(msg, key);
  const portal = portalXEncode(msg, key);
  const same = mine === portal;
  process.stdout.write(`\n${label}\n`);
  process.stdout.write(
    `  msg=${JSON.stringify(msg.length > 60 ? msg.slice(0, 60) + "…" : msg)} (len=${msg.length})\n`
  );
  process.stdout.write(`  key=${JSON.stringify(key)}\n`);
  process.stdout.write(`  结果: ${same ? "一致" : "**不同**"}\n`);
  if (!same) {
    const a = Buffer.from(mine, "latin1");
    const b = Buffer.from(portal, "latin1");
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    process.stdout.write(`  我的长度 ${a.length}, 门户长度 ${b.length}, 第 ${i} 字节起不同\n`);
    process.stdout.write(`  我的 …${a.slice(Math.max(0, i - 4), i + 12).toString("hex")}\n`);
    process.stdout.write(`  门户 …${b.slice(Math.max(0, i - 4), i + 12).toString("hex")}\n`);
  }
  return same;
}

const argMsg = process.argv[2];
const argKey = process.argv[3];

let allSame = true;
if (argMsg !== undefined) {
  allSame = diffOne(argMsg, argKey || "", "指定输入");
} else {
  // 样例全部用虚构数据(与真实账号无关)
  const token = "0000000000000000000000000000000000000000000000000000000000000001";
  const samples = [
    [
      JSON.stringify({
        username: "20230001",
        password: "20230001",
        ip: "10.20.30.40",
        acid: "1",
        enc_ver: "srun_bx1",
      }),
      token,
      "info 明文(与真实请求同结构, 数据虚构)",
    ],
    ["abc", "key", "极短消息"],
    ["a", "", "空 key"],
    ["0123456789abcdef", "0123456789abcdef", "16 字符"],
    [JSON.stringify({ a: 1, b: "中文" }), token, "含非 ASCII"],
  ];
  for (const [m, k, label] of samples) {
    allSame = diffOne(m, k, label) && allSame;
  }
}

process.stdout.write(
  `\n结论: ${allSame ? "两种实现完全一致" : "**存在差异** —— 我的移植与网关实际使用的实现不等价"}\n`
);
process.exit(allSame ? 0 : 1);
