/**
 * monitor.js —— 连接状态机: 状态轮询、速率估算、断线自动重连、自动登录。
 *
 * 不依赖 Electron, 通过注入的 clientFactory 构造协议客户端, 因此可以在纯 Node
 * 下用模拟网关做端到端测试。
 */
"use strict";

const { EventEmitter } = require("node:events");
const { SrunClient, formatBytes } = require("./srun");
const { readInterfaceBytes, rateFromSamples } = require("./netstat");

const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_MAX_SECONDS = 60;
/** 本机网卡采样间隔: 比状态轮询快得多, 这样速率才有"实时"的感觉。 */
const LOCAL_RATE_INTERVAL_MS = 3000;

class Monitor extends EventEmitter {
  /**
   * @param {{store: any, logger?: any, clientFactory?: (config: object) => SrunClient}} options
   */
  constructor(options = {}) {
    super();
    this.store = options.store;
    this.logger = options.logger || null;
    this.clientFactory =
      options.clientFactory ||
      ((config) =>
        new SrunClient({
          gateway: config.gateway,
          portalPort: config.portalPort,
          statusPort: config.statusPort,
          passwordAlgo: config.passwordAlgo,
          infoFormat: config.infoFormat,
        }));

    this.conn = {
      state: "offline",
      online: false,
      userName: "",
      ip: "",
      // 本次会话(网关的 bytes_in / bytes_out)
      bytesIn: 0,
      bytesOut: 0,
      sessionBytes: 0,
      sessionSeconds: 0,
      // 账号累计(网关的 sum_bytes / sum_seconds)
      sumBytes: 0,
      sumSeconds: 0,
      balance: null,
      addTime: 0,
      keepaliveTime: 0,
      gatewayVer: "",
      message: "",
      lastChecked: 0,
      reconnecting: false,
      nextRetryIn: 0,
    };
    this.rate = { down: 0, up: 0, total: 0 };

    // 退避参数可注入, 便于测试把 5 秒起步的重连压缩到毫秒级
    this.backoffBaseSeconds = options.backoffBaseSeconds || BACKOFF_BASE_SECONDS;
    this.backoffMaxSeconds = options.backoffMaxSeconds || BACKOFF_MAX_SECONDS;

    this._lastSample = null;
    this._pollTimer = null;
    this._retryTimer = null;
    this._countdownTimer = null;
    this._localTimer = null;
    // 本机网卡统计(速率的真实来源)。拿不到就回退成"按网关计数差值估算"。
    this._localAvailable = true;
    this._lastLocal = null;
    // 本次会话流量的"实时累加值": 网关的计数字段几乎不刷新(实测下载 21MB 它都不动),
    // 所以以网关值为基准, 之后叠加本机网卡的增量, 界面上的流量数字才能持续增长。
    this._sessionAccum = 0;
    this._sessionKey = "";
    this._rateSource = "local";
    this._retryAttempt = 0;
    this._wasOnline = false;
    this._manualLogout = false;
    // 本次会话实际尝试登录的学号。不能只依赖 store: 用户关掉「记住密码」时
    // 账号可能根本没落盘, 那样注销就会因为"找不到学号"而失败。
    this._sessionUsername = "";
    this._busy = false;
    this._running = false;
  }

  _log(level, message) {
    if (this.logger && typeof this.logger[level] === "function") this.logger[level](message);
  }

  _client() {
    return this.clientFactory(this.store.config);
  }

  /** 推送当前状态(浅拷贝, 避免渲染层误改内部状态)。 */
  _emitChange() {
    this.emit("change", this.snapshot());
  }

  snapshot() {
    return {
      conn: { ...this.conn },
      rate: { ...this.rate },
    };
  }

  _setConn(patch) {
    this.conn = { ...this.conn, ...patch };
    this._emitChange();
  }

  _notice(kind, message) {
    this.emit("notice", { kind, message });
  }

  // ---------------------------------------------------------------- 生命周期

  start() {
    if (this._running) return;
    this._running = true;
    this._log("info", "状态监控已启动");
    this.refresh({ force: true }).catch(() => {});
    this._schedulepoll();
    this._startLocalSampling();
  }

  stop() {
    this._running = false;
    if (this._localTimer) {
      clearInterval(this._localTimer);
      this._localTimer = null;
    }
    this._clearTimers();
    this._log("info", "状态监控已停止");
  }

  // ---------------------------------------------------------------- 本机速率

  _startLocalSampling() {
    if (this._localTimer) return;
    this._localTimer = setInterval(() => {
      this._sampleLocalBytes().catch(() => {});
    }, LOCAL_RATE_INTERVAL_MS);
  }

  /**
   * 采样本机网卡累计字节并算出上/下行速率。
   *
   * 只在已认证时采样: 离线时界面本来就不显示速率, 没必要每 3 秒起一个 netstat 进程。
   * 万一 netstat 不可用(极端情况), 会退回网关差值估算, 并把来源标成 gateway。
   */
  async _sampleLocalBytes() {
    if (!this._localAvailable) return;
    if (!this.conn.online) {
      this._lastLocal = null;
      return;
    }
    const sample = await readInterfaceBytes();
    if (!sample) {
      this._localAvailable = false;
      this._rateSource = "gateway";
      this._log("warn", "本机网卡统计不可用，速率回退为按网关计数差值估算（网关计数刷新很慢）");
      return;
    }
    const now = Date.now();
    const next = { t: now, rx: sample.rx, tx: sample.tx };
    const prev = this._lastLocal;
    const computed = rateFromSamples(prev, next);
    if (computed) {
      this.rate = computed;
      // 把这一拍的网卡增量累进"本次会话流量", 界面才能每秒看到数字在涨
      if (prev) {
        const delta = sample.rx - prev.rx + (sample.tx - prev.tx);
        if (delta > 0) this._sessionAccum += delta;
      }
      this.emit("rate", { t: now, ...computed, sessionBytes: this._sessionAccum });
    } else if (prev) {
      // 计数器被重置(适配器重连等): 这一拍算不出速率。归零而不是保留上一拍的旧值,
      // 否则界面会一直显示一个已经过期的速率。
      this.rate = { down: 0, up: 0, total: 0 };
      this.emit("rate", { t: now, ...this.rate, sessionBytes: this._sessionAccum });
    }
    this._lastLocal = next;
    // 同步进状态, 这样 snapshot 里的 sessionBytes 也是实时的
    if (this.conn.online && this._sessionAccum > this.conn.sessionBytes) {
      this._setConn({ sessionBytes: this._sessionAccum });
    }
  }

  _clearTimers() {
    for (const key of ["_pollTimer", "_retryTimer", "_countdownTimer"]) {
      if (this[key]) {
        clearTimeout(this[key]);
        clearInterval(this[key]);
        this[key] = null;
      }
    }
  }

  _schedulepoll() {
    if (!this._running) return;
    if (this._pollTimer) clearTimeout(this._pollTimer);
    const seconds = Math.max(5, Number(this.store.config.pollInterval) || 30);
    this._pollTimer = setTimeout(async () => {
      try {
        await this.refresh();
      } catch {
        /* refresh 内部已处理 */
      }
      this._schedulepoll();
    }, seconds * 1000);
  }

  /** 配置变更后重新排期(轮询间隔可能变了)。 */
  onConfigChanged() {
    this._schedulepoll();
  }

  // ---------------------------------------------------------------- 状态查询

  /** 查询一次在线状态。 */
  async refresh() {
    const client = this._client();
    const now = Date.now();
    try {
      const status = await client.queryStatus();
      this.conn.lastChecked = now;
      if (status.online) {
        this._applyOnline(status, now);
        this._retryAttempt = 0;
        this._cancelReconnect();
        this._wasOnline = true;
      } else {
        // 只有"本来在线、现在掉了"才算掉线, 才值得自动重连;
        // 冷启动时从未登录过属于正常离线, 不该擅自去登录(那是"自动登录"开关的职责)
        const dropped = this._wasOnline;
        this._applyOffline(dropped ? "连接已断开" : "当前未连接校园网", dropped);
        this._wasOnline = false;
        if (dropped) this._maybeReconnect("检测到离线");
      }
    } catch (err) {
      this.conn.lastChecked = now;
      const dropped = this._wasOnline;
      this._applyOffline(err.message || "无法连接认证网关", dropped);
      this._wasOnline = false;
      if (dropped) this._maybeReconnect("状态查询失败");
    }
    return this.snapshot();
  }

  _applyOnline(status, now) {
    const previous = this.conn;
    const patch = {
      state: "online",
      online: true,
      userName: status.userName || previous.userName,
      ip: status.ip || previous.ip,
      // 本次会话
      bytesIn: status.bytesIn || 0,
      bytesOut: status.bytesOut || 0,
      sessionBytes: status.sessionBytes || 0,
      sessionSeconds: status.sessionSeconds || 0,
      // 账号累计
      sumBytes: status.sumBytes || 0,
      sumSeconds: status.sumSeconds || 0,
      balance:
        status.balance === null || status.balance === undefined
          ? previous.balance
          : status.balance,
      addTime: status.addTime || 0,
      keepaliveTime: status.keepaliveTime || 0,
      gatewayVer: status.gatewayVer || previous.gatewayVer,
      message: "已连接",
      reconnecting: false,
      nextRetryIn: 0,
      lastChecked: now,
    };
    const wasOffline = previous.state !== "online";

    // 本次会话流量: 网关值作为基准(它几分钟才刷新一次), 之后由本机网卡增量往上累加。
    // 只增不减 —— 否则网关每次回一个偏小的值时, 界面数字会往回跳。
    const gatewaySession = status.sessionBytes || 0;
    const sessionKey = `${patch.userName}|${patch.addTime}`;
    if (sessionKey !== this._sessionKey) {
      // 新会话(换了账号或重新登录): 以网关值为起点
      this._sessionKey = sessionKey;
      this._sessionAccum = gatewaySession;
    } else if (gatewaySession > this._sessionAccum) {
      this._sessionAccum = gatewaySession;
    }
    patch.sessionBytes = this._sessionAccum;

    this._setConn(patch);
    this._updateRate(status, now);
    if (wasOffline) {
      this._log(
        "info",
        `已在线: ${patch.userName} @ ${patch.ip}，本次已用 ${formatBytes(patch.sessionBytes)}`
      );
    }
  }

  _applyOffline(message, dropped) {
    this._setConn({
      state: dropped ? "error" : "offline",
      online: false,
      bytesIn: 0,
      bytesOut: 0,
      sessionBytes: 0,
      sessionSeconds: 0,
      sumBytes: 0,
      sumSeconds: 0,
      // 离线时查不到余额, 清空以免把上一个账号的余额显示给当前账号
      balance: null,
      keepaliveTime: 0,
      message,
      lastChecked: Date.now(),
    });
    this.rate = { down: 0, up: 0, total: 0 };
    this._lastSample = null;
    // 会话结束: 累加值清空, 下次登录重新以网关值为起点
    this._sessionAccum = 0;
    this._sessionKey = "";
    this.emit("rate", { t: Date.now(), ...this.rate });
  }

  /**
   * 兜底速率: 用两次状态查询之间的**网关**会话字节差估算。
   *
   * 只有在 `_rateSource === "gateway"`(本机网卡统计不可用)时才生效 —— 因为网关的
   * 计数字段实测几乎不动(下载 21 MB 都纹丝不动), 拿它算速率会长期显示 0。
   */
  _updateRate(status, now) {
    if (this._rateSource !== "gateway") return;
    const bytesIn = Number(status.bytesIn) || 0;
    const bytesOut = Number(status.bytesOut) || 0;
    if (this._lastSample && now > this._lastSample.t) {
      const seconds = (now - this._lastSample.t) / 1000;
      const deltaIn = bytesIn - this._lastSample.bytesIn;
      const deltaOut = bytesOut - this._lastSample.bytesOut;
      if (deltaIn >= 0 && deltaOut >= 0) {
        const down = deltaIn / seconds;
        const up = deltaOut / seconds;
        this.rate = { down, up, total: down + up };
      } else {
        // 会话重启会让计数器归零, 这一拍不产生速率
        this.rate = { down: 0, up: 0, total: 0 };
      }
    }
    this._lastSample = { t: now, bytesIn, bytesOut };
    this.emit("rate", { t: now, ...this.rate });
  }

  // ---------------------------------------------------------------- 登录/注销

  /**
   * 登录。
   * @param {{username: string, password: string, accountId?: string|null, silent?: boolean}} input
   */
  async login(input) {
    const username = String(input.username || "").trim();
    const password = String(input.password || "");
    if (!username || !password) {
      const message = "请先填写学号和密码";
      if (!input.silent) this._notice("error", message);
      return { ok: false, message };
    }
    if (this._busy) return { ok: false, message: "正在处理上一个请求，请稍候" };

    this._busy = true;
    this._manualLogout = false;
    this._sessionUsername = username;
    this._cancelReconnect();
    this._setConn({ state: "connecting", message: "正在连接认证网关…" });
    this._log("info", `开始登录: ${username}`);

    try {
      const client = this._client();
      const result = await client.login(username, password);
      if (result.ok) {
        if (input.accountId) this.store.touch(input.accountId);
        this._log(
          "info",
          result.alreadyOnline ? `已在线，无需重复登录: ${username}` : `登录成功: ${username}`
        );
        await this.refresh();
        if (this.conn.state !== "online") {
          // 网关说成功但状态还没刷新出来, 先按成功处理
          this._setConn({ state: "online", online: true, message: result.message });
        }
        this._wasOnline = true;
        if (!input.silent) this._notice("success", result.message || "登录成功");
      } else {
        this._log("warn", `登录失败: ${username} -> ${result.message}`);
        this._setConn({ state: "error", online: false, message: result.message });
        if (!input.silent) this._notice("error", result.message);
      }
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this._log("error", `登录异常: ${message}`);
      this._setConn({ state: "error", online: false, message });
      if (!input.silent) this._notice("error", message);
      this._maybeReconnect("登录异常");
      return { ok: false, message };
    } finally {
      this._busy = false;
    }
  }

  /** 注销。 */
  async logout() {
    this._manualLogout = true;
    this._cancelReconnect();
    const account = this.store.activeAccount;
    const username =
      this._sessionUsername ||
      (account && account.username) ||
      this.store.config.lastUsername ||
      "";
    if (!username) {
      return { ok: false, message: "请先填写学号" };
    }
    if (this._busy) return { ok: false, message: "正在处理上一个请求，请稍候" };
    this._busy = true;
    this._setConn({ state: "connecting", message: "正在断开连接…" });
    try {
      const client = this._client();
      const result = await client.logout(username, this.conn.ip || "");
      if (result.ok) {
        this._log("info", `已注销: ${username}`);
        this._wasOnline = false;
        this._applyOffline(result.message || "已退出网络连接", false);
        this._setConn({ state: "offline", message: result.message || "已断开连接" });
        this._notice("success", result.message || "已断开连接");
      } else {
        this._log("warn", `注销失败: ${result.message}`);
        this._setConn({ state: "error", message: result.message });
        this._notice("error", result.message);
      }
      return result;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this._log("error", `注销异常: ${message}`);
      this._setConn({ state: "error", message });
      this._notice("error", message);
      return { ok: false, message };
    } finally {
      this._busy = false;
    }
  }

  // ---------------------------------------------------------------- 自动重连

  _reconnectCredentials() {
    const account = this.store.activeAccount;
    if (account) {
      const password = this.store.getPassword(account.id);
      if (password) return { username: account.username, password, accountId: account.id };
    }
    const last = this.store.findByUsername(this.store.config.lastUsername);
    if (last) {
      const password = this.store.getPassword(last.id);
      if (password) return { username: last.username, password, accountId: last.id };
    }
    return null;
  }

  _maybeReconnect(reason) {
    if (!this._running) return;
    if (!this.store.config.autoReconnect) return;
    if (this._manualLogout) return;
    if (this._retryTimer || this._countdownTimer) return;
    const credentials = this._reconnectCredentials();
    if (!credentials) {
      this._log("info", `需要重连(${reason})，但没有保存的密码，等待手动登录`);
      return;
    }
    const delay = Math.min(
      this.backoffBaseSeconds * Math.pow(2, this._retryAttempt),
      this.backoffMaxSeconds
    );
    this._retryAttempt += 1;
    this._log("info", `将在 ${delay} 秒后尝试自动重连(${reason})`);

    let remaining = delay;
    this._setConn({ reconnecting: true, nextRetryIn: remaining });
    this._countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) return;
      this._setConn({ nextRetryIn: remaining });
    }, 1000);

    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (this._countdownTimer) {
        clearInterval(this._countdownTimer);
        this._countdownTimer = null;
      }
      this._setConn({ reconnecting: false, nextRetryIn: 0 });
      this._log("info", "开始自动重连");
      const result = await this.login({ ...credentials, silent: true });
      if (result.ok) {
        this._retryAttempt = 0;
        this._notice("success", "自动重连成功");
      } else {
        this._notice("warning", `自动重连失败：${result.message}`);
        this._maybeReconnect("自动重连失败");
      }
    }, delay * 1000);
  }

  _cancelReconnect() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
    if (this.conn.reconnecting || this.conn.nextRetryIn) {
      this._setConn({ reconnecting: false, nextRetryIn: 0 });
    }
  }

  /** 启动时按配置自动登录(仅在保存了密码时)。 */
  async maybeAutoLogin() {
    if (!this.store.config.autoLogin) return { ok: false, skipped: true };
    const credentials = this._reconnectCredentials();
    if (!credentials) {
      this._log("info", "已启用自动登录，但没有可用的保存密码，跳过");
      return { ok: false, skipped: true };
    }
    const status = await this.refresh().catch(() => null);
    if (status && status.conn.online) {
      this._log("info", "启动检查: 已在线，跳过自动登录");
      return { ok: true, skipped: true, alreadyOnline: true };
    }
    this._log("info", "启动自动登录");
    return this.login({ ...credentials, silent: true });
  }
}

module.exports = { Monitor };
