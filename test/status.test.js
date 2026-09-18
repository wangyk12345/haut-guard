/**
 * status.test.js —— 状态解析的回归测试, 用**真实网关抓到的原始响应**做夹具。
 *
 * 背景(这是一次真实的踩坑): 早先的实现按位置把裸文本的 [3] 当累计流量、[4] 当在线
 * 时长。而 HAUT 现网(网关 1.01.20180614)的 [3] 是本次会话下行字节、[4] 是本次会话
 * 上行字节 —— 于是界面上会把 49 MB 的上传量显示成"在线 595 天"。
 *
 * 用带 callback 的 JSONP 请求可以拿到**命名字段**, 位置歧义直接消失:
 *   bytes_in / bytes_out(本次会话)、sum_bytes / sum_seconds(账号累计)、user_balance。
 *
 * 下面的夹具是实测抓取的原文(账号、内网 IP 与 MAC 已匿名化, 其余数值保持原样),
 * 因此这个测试同时锁住了"真实字段语义"和"两套解析结果一致"。
 *
 * 用法: node test/status.test.js
 */
"use strict";

const srun = require("../src/main/srun");
const { Monitor } = require("../src/main/monitor");

// ---- 真实网关抓取(仅账号 / 内网 IP / MAC 匿名化)
const REAL_STATUS_TEXT =
  "20230001,1789725112,1789727961,320253309,51417663,0,132329343471,644217," +
  "10.20.30.40,0,,20,0,0,0,0,0,0,0,0,1.01.20180614";

const REAL_STATUS_JSONP =
  'cb({"ServerFlag":4294967041,"add_time":1789725112,"all_bytes":189158253,' +
  '"bytes_in":320253309,"bytes_out":51417663,"checkout_date":0,"domain":"test",' +
  '"error":"ok","keepalive_time":1789727961,"online_ip":"10.20.30.40",' +
  '"real_name":"","remain_seconds":0,"sum_bytes":132329343471,"sum_seconds":644217,' +
  '"sysver":"1.01.20180614","user_balance":20,"user_charge":0,' +
  '"user_mac":"aa:bb:cc:dd:ee:ff","user_name":"20230001","wallet_balance":0})';

const EXPECTED = {
  userName: "20230001",
  ip: "10.20.30.40",
  addTime: 1789725112,
  keepaliveTime: 1789727961,
  sessionSeconds: 2849, // 47 分 29 秒
  bytesIn: 320253309,
  bytesOut: 51417663,
  sessionBytes: 371670972,
  sumBytes: 132329343471,
  sumSeconds: 644217,
  balance: 20,
  gatewayVer: "1.01.20180614",
};

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  [通过] ${name}\n`);
  } catch (err) {
    failures.push({ name, message: err.message });
    process.stdout.write(`  [失败] ${name} -> ${err.message}\n`);
  }
}

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

process.stdout.write("=== 状态解析回归测试 (夹具来自真实网关) ===\n");

check("命名字段(JSONP)解析出全部真实字段", () => {
  const data = srun.parseJsonp(REAL_STATUS_JSONP);
  const status = srun.statusFromJson(data);
  assertEqual(status.userName, EXPECTED.userName, "userName");
  assertEqual(status.ip, EXPECTED.ip, "ip");
  assertEqual(status.addTime, EXPECTED.addTime, "addTime");
  assertEqual(status.keepaliveTime, EXPECTED.keepaliveTime, "keepaliveTime");
  assertEqual(status.sessionSeconds, EXPECTED.sessionSeconds, "本次会话秒数");
  assertEqual(status.bytesIn, EXPECTED.bytesIn, "bytesIn");
  assertEqual(status.bytesOut, EXPECTED.bytesOut, "bytesOut");
  assertEqual(status.sessionBytes, EXPECTED.sessionBytes, "本次会话字节");
  assertEqual(status.sumBytes, EXPECTED.sumBytes, "sumBytes");
  assertEqual(status.sumSeconds, EXPECTED.sumSeconds, "sumSeconds");
  assertEqual(status.balance, EXPECTED.balance, "balance");
  assertEqual(status.gatewayVer, EXPECTED.gatewayVer, "gatewayVer");
});

check("裸文本(位置语义)解析出同样的值", () => {
  const status = srun.statusFromText(REAL_STATUS_TEXT);
  for (const key of Object.keys(EXPECTED)) {
    assertEqual(status[key], EXPECTED[key], `裸文本 ${key}`);
  }
});

check("两套解析路径结果完全一致", () => {
  const fromJson = srun.statusFromJson(srun.parseJsonp(REAL_STATUS_JSONP));
  const fromText = srun.statusFromText(REAL_STATUS_TEXT);
  for (const key of Object.keys(EXPECTED)) {
    assertEqual(fromJson[key], fromText[key], `两条路径的 ${key} 应一致`);
  }
});

check("旧的位置映射会把结果解释错(记录这次踩坑)", () => {
  const fields = REAL_STATUS_TEXT.split(",");
  // 旧实现: sum_bytes = [3], sum_seconds = [4]
  const oldSumBytes = Number(fields[3]);
  const oldSumSeconds = Number(fields[4]);
  assertEqual(oldSumBytes, 320253309, "旧映射读到的 sum_bytes");
  assertEqual(oldSumSeconds, 51417663, "旧映射读到的 sum_seconds");
  // 旧实现渲染出来的时长 —— 正是那个荒唐的"595 天"
  assertEqual(srun.formatDuration(oldSumSeconds), "595 天 2 小时 41 分", "旧实现会显示的天数");
  // 新实现渲染出来的是本次会话时长
  const status = srun.statusFromText(REAL_STATUS_TEXT);
  assertEqual(srun.formatDuration(status.sessionSeconds), "47 分 29 秒", "本次会话时长");
  assertEqual(srun.formatDuration(status.sumSeconds), "7 天 10 小时 56 分", "账号累计时长");
});

check("人类可读格式化的真实取值", () => {
  assertEqual(srun.formatBytes(EXPECTED.bytesIn), "305.42 MB", "下行");
  assertEqual(srun.formatBytes(EXPECTED.bytesOut), "49.04 MB", "上行");
  assertEqual(srun.formatBytes(EXPECTED.sessionBytes), "354.45 MB", "本次合计");
  assertEqual(srun.formatBytes(EXPECTED.sumBytes), "123.24 GB", "账号累计");
});

check("离线响应被判为未在线", () => {
  const offline = 'cb({"error":"not_online_error","error_msg":"not_online_error"})';
  const data = srun.parseJsonp(offline);
  assertEqual(String(data.error), "not_online_error", "离线标记");
});

check("位置解析在字段不足时明确报错", () => {
  let threw = false;
  try {
    srun.statusFromText("not,a,valid,status");
  } catch (err) {
    threw = true;
    assertEqual(err.name, "SrunError", "异常类型");
    assertEqual(err.kind, "parse", "异常分类");
  }
  assert(threw, "字段不足应抛 SrunError 而不是静默返回脏数据");
});

check("会话时长异常(时间戳不同源)时置 0, 不显示荒谬天数", () => {
  // 实测撞到过: keepalive 用当前时间、add_time 用旧值, 差值算出 367 天
  const weird = JSON.parse(
    '{"error":"ok","user_name":"20230001","online_ip":"10.20.30.40",' +
      '"bytes_in":100,"bytes_out":200,"add_time":1758000000,' +
      '"keepalive_time":1789728000,"sum_bytes":1,"sum_seconds":2}'
  );
  const status = srun.statusFromJson(weird);
  assertEqual(status.sessionSeconds, 0, "超出 30 天的会话时长应置 0");
  // 正常的会话时长不受影响
  assertEqual(
    srun.statusFromJson({ ...weird, add_time: 1789725151 }).sessionSeconds,
    2849,
    "正常差值应保留"
  );
  // 时间戳反过来(keepalive 早于 add_time)同样是 0
  assertEqual(
    srun.statusFromJson({ ...weird, add_time: 1789729000 }).sessionSeconds,
    0,
    "反向时间戳应为 0"
  );
});

// ---- 速率
// 注意: 速率的**首选**来源是本机网卡统计(网关计数几乎不刷新, 见 netstat.js), 所以
// 下面这组用例显式把 _rateSource 设成 "gateway", 验证的是**兜底路径**。
check("兜底路径: 按网关会话字节差算出下行/上行", () => {
  const monitor = new Monitor({ store: { config: {}, activeAccount: null } });
  monitor._rateSource = "gateway";
  const t0 = 1_000_000;
  monitor._updateRate({ bytesIn: 1000, bytesOut: 200 }, t0);
  // 10 秒后: 下行 +10000 字节(1000 B/s), 上行 +2000 字节(200 B/s)
  monitor._updateRate({ bytesIn: 11000, bytesOut: 2200 }, t0 + 10_000);
  assertEqual(Math.round(monitor.rate.down), 1000, "下行 B/s");
  assertEqual(Math.round(monitor.rate.up), 200, "上行 B/s");
  assertEqual(Math.round(monitor.rate.total), 1200, "合计 B/s");
});

check("兜底路径: 会话重启(计数器归零)不会算出负速率", () => {
  const monitor = new Monitor({ store: { config: {}, activeAccount: null } });
  monitor._rateSource = "gateway";
  const t0 = 2_000_000;
  monitor._updateRate({ bytesIn: 500000, bytesOut: 90000 }, t0);
  monitor._updateRate({ bytesIn: 120, bytesOut: 30 }, t0 + 30_000);
  assertEqual(monitor.rate.down, 0, "计数器归零后速率应为 0");
  assertEqual(monitor.rate.up, 0, "计数器归零后速率应为 0");
  assertEqual(monitor.rate.total, 0, "合计应为 0");
});

check("首选路径: 本机网卡统计的解析与速率", () => {
  const netstat = require("../src/main/netstat");

  // 真实 netstat -e 输出(节选)
  const english = [
    "Interface Statistics",
    "",
    "                           Received            Sent",
    "",
    "Bytes                    4216491975      1152631308",
    "Unicast packets            10011680         8454576",
  ].join("\r\n");
  const parsed = netstat.parseNetstatBytes(english);
  assert(parsed, "应能解析出字节数");
  assertEqual(parsed.rx, 4216491975, "接收字节");
  assertEqual(parsed.tx, 1152631308, "发送字节");

  // 中文系统的表头会被本地化, 解析必须只看结构(首行"三段且后两段是数字")
  const localized = [
    "接口统计",
    "",
    "                            接收              发送",
    "",
    "字节                     4216491975      1152631308",
    "单播数据包                10011680         8454576",
  ].join("\r\n");
  const parsed2 = netstat.parseNetstatBytes(localized);
  assert(parsed2, "本地化输出也应能解析");
  assertEqual(parsed2.rx, 4216491975, "本地化: 接收字节");
  assertEqual(parsed2.tx, 1152631308, "本地化: 发送字节");

  // 速率: 3 秒内收 3 MB、发 300 KB
  const rate = netstat.rateFromSamples(
    { t: 1000, rx: 1000, tx: 500 },
    { t: 4000, rx: 1000 + 3 * 1024 * 1024, tx: 500 + 300 * 1024 }
  );
  assertEqual(Math.round(rate.down), 1024 * 1024, "下行 ≈1 MB/s");
  assertEqual(Math.round(rate.up), 100 * 1024, "上行 ≈100 KB/s");

  // 计数器回绕/时间未推进 -> 不返回速率(调用方保留上一拍)
  assertEqual(netstat.rateFromSamples({ t: 5, rx: 900, tx: 900 }, { t: 5, rx: 900, tx: 900 }), null, "时间未推进");
  assertEqual(netstat.rateFromSamples({ t: 1, rx: 900, tx: 900 }, { t: 2, rx: 10, tx: 900 }), null, "计数器归零");
  assertEqual(netstat.parseNetstatBytes("完全没有数字表头的文本"), null, "无法解析时返回 null");
});

check("本次会话流量: 以网关值为基准, 只增不减, 换会话时重置", () => {
  const monitor = new Monitor({ store: { config: {}, activeAccount: null } });
  const status = (sessionBytes, addTime) => ({
    userName: "20230001",
    ip: "10.20.30.40",
    sessionBytes,
    bytesIn: 0,
    bytesOut: 0,
    sumBytes: 0,
    sumSeconds: 0,
    addTime,
    keepaliveTime: addTime + 10,
    balance: 20,
    gatewayVer: "x",
  });
  const MB = 1024 * 1024;

  // 1) 首次上线: 直接采用网关值
  monitor._applyOnline(status(100 * MB, 1000), 1_000_000);
  assertEqual(monitor.conn.sessionBytes, 100 * MB, "首次应以网关值为准");

  // 2) 同一会话、网关计数没刷新(实测常态): 不能把本机已累加的数字压回去
  monitor._sessionAccum = 120 * MB;
  monitor._applyOnline(status(100 * MB, 1000), 1_005_000);
  assertEqual(monitor.conn.sessionBytes, 120 * MB, "网关没刷新时不应回退");

  // 3) 网关计数终于变大: 抬到网关值
  monitor._applyOnline(status(200 * MB, 1000), 1_010_000);
  assertEqual(monitor.conn.sessionBytes, 200 * MB, "网关刷新后应抬到它的值");

  // 4) 换了会话(重新登录): 以新的网关值重新起步
  monitor._applyOnline(status(5 * MB, 2000), 1_015_000);
  assertEqual(monitor.conn.sessionBytes, 5 * MB, "新会话应以新网关值起步");

  // 5) 离线清零
  monitor._applyOffline("断线", false);
  assertEqual(monitor.conn.sessionBytes, 0, "离线应清零");
  assertEqual(monitor._sessionAccum, 0, "累加值也应清空");
});

process.stdout.write(`\n=== 结果: ${passed} 项通过, ${failures.length} 项失败 ===\n`);
if (failures.length) {
  for (const f of failures) process.stdout.write(`  失败: ${f.name} -> ${f.message}\n`);
  process.exit(1);
}
process.exit(0);
