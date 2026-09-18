/**
 * preload.js —— 渲染进程与主进程之间的唯一通道 (契约文件, 请勿随意改动)。
 *
 * 渲染层只能通过 `window.haut` 访问能力, 不开启 nodeIntegration, 保持上下文隔离。
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** 允许渲染层订阅的推送频道白名单。 */
const PUSH_CHANNELS = ["state", "rate", "log", "toast"];

const api = {
  /** 取一次完整快照: { conn, rate, config, accounts, activeAccountId, appVersion, platform, material } */
  getSnapshot: () => ipcRenderer.invoke("app:snapshot"),

  auth: {
    /**
     * 登录。
     * @param {{username?: string, password?: string, accountId?: string}} payload
     * @returns {Promise<{ok: boolean, alreadyOnline?: boolean, message: string, code?: string}>}
     */
    login: (payload) => ipcRenderer.invoke("auth:login", payload || {}),
    /** 注销当前账号。 */
    logout: () => ipcRenderer.invoke("auth:logout"),
    /** 立即查询一次在线状态。 */
    refresh: () => ipcRenderer.invoke("auth:refresh"),
  },

  accounts: {
    /** @returns {Promise<Array<{id: string, username: string, label: string, hasPassword: boolean, autoLogin: boolean, lastUsed: number}>>} */
    list: () => ipcRenderer.invoke("accounts:list"),
    /** 新增或更新(有 id 即更新)。password 为空表示保持原密码不变。 */
    save: (account) => ipcRenderer.invoke("accounts:save", account || {}),
    remove: (id) => ipcRenderer.invoke("accounts:remove", { id }),
    select: (id) => ipcRenderer.invoke("accounts:select", { id }),
    /** 取某个账号的明文密码(仅用于填入输入框, 需要用户点击眼睛图标才调用)。 */
    reveal: (id) => ipcRenderer.invoke("accounts:reveal", { id }),
  },

  config: {
    /** 局部更新配置, 返回更新后的完整配置。 */
    update: (patch) => ipcRenderer.invoke("config:update", patch || {}),
    /** 恢复默认配置(不清除账号)。 */
    reset: () => ipcRenderer.invoke("config:reset"),
  },

  diag: {
    /** 运行诊断: 返回 [{name, ok, detail, ms}] 与总体结论。 */
    run: () => ipcRenderer.invoke("diag:run"),
  },

  logs: {
    /** @returns {Promise<{path: string, lines: string[]}>} */
    read: (lines) => ipcRenderer.invoke("logs:read", { lines: lines || 300 }),
    clear: () => ipcRenderer.invoke("logs:clear"),
    openFolder: () => ipcRenderer.invoke("logs:open"),
  },

  app: {
    /** @returns {Promise<{version: string, electron: string, node: string, chrome: string, platform: string,
     *                     material: string, materialSupported: boolean}>} */
    info: () => ipcRenderer.invoke("app:info"),
    /** 切换窗口背景材质: 'acrylic' | 'mica' | 'transparent'。返回实际生效值。 */
    setMaterial: (material) => ipcRenderer.invoke("app:set-material", { material }),
    quit: () => ipcRenderer.invoke("app:quit"),
  },

  win: {
    minimize: () => ipcRenderer.invoke("win:minimize"),
    close: () => ipcRenderer.invoke("win:close"),
    hide: () => ipcRenderer.invoke("win:hide"),
    /** 拖动窗口时使用(自绘标题栏)。 */
    beginDrag: () => ipcRenderer.send("win:begin-drag"),
  },

  /**
   * 订阅主进程推送。
   * @param {'state'|'rate'|'log'|'toast'} channel
   * @param {(payload: any) => void} handler
   * @returns {() => void} 取消订阅
   */
  on: (channel, handler) => {
    if (PUSH_CHANNELS.indexOf(channel) < 0) {
      throw new Error(`未知的推送频道: ${channel}`);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("haut", api);
