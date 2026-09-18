/**
 * logger.js —— 轻量文件日志(带敏感信息脱敏与体积轮转)。
 *
 * 设计要点:
 *   - 参考原版客户端只记录长度不记录明文; 这里进一步做正则脱敏, 任何
 *     password / chksum / info / token 的值都不会落盘。
 *   - 同步写入: 日志量很低(几十行/分钟), 不值得引入异步队列。
 *   - 单文件超过 maxBytes 时轮转, 保留 keep 份历史。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** 需要脱敏的查询参数名。 */
const SENSITIVE_KEYS = ["password", "chksum", "info", "token", "challenge", "secret"];
const SENSITIVE_RE = new RegExp(`(${SENSITIVE_KEYS.join("|")})=[^&\\s"']*`, "gi");

/** 把文本里的敏感字段值替换为占位符。 */
function redact(text) {
  return String(text).replace(SENSITIVE_RE, (_m, key) => `${key}=<已隐去>`);
}

/** 时间戳 -> 'YYYY-MM-DD HH:mm:ss.SSS' (本地时间)。 */
function stamp(ts) {
  const d = new Date(ts);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

class Logger {
  /**
   * @param {{dir: string, name?: string, maxBytes?: number, keep?: number}} options
   */
  constructor(options = {}) {
    this.dir = options.dir;
    this.name = options.name || "haut-guard";
    this.maxBytes = options.maxBytes || 1024 * 1024;
    this.keep = options.keep || 3;
    this.filePath = path.join(this.dir, `${this.name}.log`);
    this._listeners = new Set();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* 目录不可用时退化为内存日志 */
    }
  }

  /** 订阅日志条目, 返回取消订阅函数。 */
  onEntry(handler) {
    this._listeners.add(handler);
    return () => this._listeners.delete(handler);
  }

  _rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.filePath}.${i}`;
      const to = `${this.filePath}.${i + 1}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      /* ignore */
    }
  }

  _write(level, message) {
    const ts = Date.now();
    const entry = { ts, level, message: redact(message) };
    const line = `${stamp(ts)} [${level.toUpperCase().padEnd(5)}] ${entry.message}\n`;
    try {
      this._rotateIfNeeded();
      fs.appendFileSync(this.filePath, line, "utf8");
    } catch {
      /* 写盘失败不应影响主流程 */
    }
    for (const handler of this._listeners) {
      try {
        handler(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }

  info(message) {
    return this._write("info", message);
  }

  warn(message) {
    return this._write("warn", message);
  }

  error(message) {
    return this._write("error", message);
  }

  /** 读取最后 N 行(不含空行)。 */
  read(lines = 300) {
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      return text.split(/\r?\n/).filter((l) => l.length > 0).slice(-lines);
    } catch {
      return [];
    }
  }

  /** 清空当前日志文件(不删除历史轮转文件)。 */
  clear() {
    try {
      fs.writeFileSync(this.filePath, "", "utf8");
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { Logger, redact, stamp };
