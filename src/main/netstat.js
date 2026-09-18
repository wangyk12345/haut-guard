/**
 * netstat.js —— 读取本机网卡的累计收/发字节数。
 *
 * 为什么需要它: 网关的状态接口**不提供实时流量**。实测(2026-09-18, HAUT 现网):
 * 持续下载 20 秒共 21 MB, 而 `bytes_in` / `bytes_out` / `sum_bytes` / `all_bytes`
 * 四个字段**全都没有变化** —— 网关的计费计数只按很粗的周期刷新。所以任何基于它的
 * "实时速率"必然长期显示 0, 只能改从本机网卡统计取。
 *
 * 实现用 `netstat -e`(系统自带, 无需依赖): 它输出的第一行统计就是累计字节数,
 * 分别是"接收"与"发送"。解析**不依赖语言**: 取第一行"恰好 3 段、且后两段是纯数字"
 * 的记录(中文系统上表头会本地化, 所以不能按 "Bytes" 关键字匹配)。
 */
"use strict";

const { execFile } = require("node:child_process");

/**
 * 从 `netstat -e` 的输出里取 { rx, tx }(累计字节)。
 * @param {string} text
 * @returns {{rx: number, tx: number}|null}
 */
function parseNetstatBytes(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 3) continue;
    if (!/^[\d,]+$/.test(parts[1]) || !/^[\d,]+$/.test(parts[2])) continue;
    const rx = Number(parts[1].replace(/,/g, ""));
    const tx = Number(parts[2].replace(/,/g, ""));
    if (Number.isFinite(rx) && Number.isFinite(tx)) return { rx, tx };
  }
  return null;
}

/**
 * 读取一次本机网卡累计字节数。
 * @param {number} [timeoutMs]
 * @returns {Promise<{rx: number, tx: number}|null>} 读取失败返回 null(调用方应回退)
 */
function readInterfaceBytes(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve(null);
      return;
    }
    execFile(
      "netstat",
      ["-e"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        resolve(parseNetstatBytes(stdout));
      }
    );
  });
}

/**
 * 由两次采样算出速率(字节/秒)。抽成纯函数便于单测。
 * @param {{rx:number,tx:number,t:number}} prev
 * @param {{rx:number,tx:number,t:number}} next
 * @returns {{down:number,up:number,total:number}|null} 时间未推进或计数器回绕时返回 null
 */
function rateFromSamples(prev, next) {
  if (!prev || !next) return null;
  const seconds = (next.t - prev.t) / 1000;
  if (!(seconds > 0)) return null;
  const deltaRx = next.rx - prev.rx;
  const deltaTx = next.tx - prev.tx;
  // 网卡计数器在适配器重连/重启后会归零, 负值视为重置
  if (deltaRx < 0 || deltaTx < 0) return null;
  const down = deltaRx / seconds;
  const up = deltaTx / seconds;
  return { down, up, total: down + up };
}

module.exports = { readInterfaceBytes, parseNetstatBytes, rateFromSamples };
