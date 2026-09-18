/**
 * store.test.js —— 配置与账号存储的单元测试(用假的 safeStorage, 不需要 Electron)。
 *
 * 用法: node test/store.test.js
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, DEFAULT_CONFIG } = require("../src/main/store");
const { Logger } = require("../src/main/logger");

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
    throw new Error(`${message || "值不相等"}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);
  }
}

/** 假 safeStorage: 用可逆的 base64 包装, 只为验证"落盘不是明文"。 */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
  decryptString: (buf) => {
    const text = Buffer.from(buf).toString("utf8");
    if (!text.startsWith("enc:")) throw new Error("密文格式错误");
    return text.slice(4);
  },
};

const disabledSafeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("不可用");
  },
  decryptString: () => {
    throw new Error("不可用");
  },
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haut-store-"));
}

function main() {
  process.stdout.write("=== 存储层测试 ===\n");
  const dir = tempDir();
  const logger = new Logger({ dir: path.join(dir, "logs") });
  const store = new Store({ dir, safeStorage: fakeSafeStorage, logger });

  check("默认配置与预期一致", () => {
    const config = store.config;
    assertEqual(config.gateway, DEFAULT_CONFIG.gateway, "默认网关");
    assertEqual(config.portalPort, 69, "默认 portal 端口");
    assertEqual(config.statusPort, 80, "默认 status 端口");
    assertEqual(config.pollInterval, 30, "默认轮询间隔");
    assertEqual(config.theme, "dark", "默认主题");
    assertEqual(config.accent, "cyan", "默认主题色");
    assertEqual(config.chromeStyle, "mac", "默认窗口按钮风格");
  });

  check("主题色与按钮风格: 合法值被接受, 非法值回退", () => {
    const ok = store.updateConfig({ accent: "violet", chromeStyle: "windows" });
    assertEqual(ok.accent, "violet", "合法主题色应被接受");
    assertEqual(ok.chromeStyle, "windows", "合法按钮风格应被接受");
    const bad = store.updateConfig({ accent: "rainbow", chromeStyle: "linux" });
    assertEqual(bad.accent, DEFAULT_CONFIG.accent, "非法主题色应回退默认");
    assertEqual(bad.chromeStyle, DEFAULT_CONFIG.chromeStyle, "非法按钮风格应回退默认");
    // 恢复, 免得影响后面的用例
    store.updateConfig({ accent: "cyan", chromeStyle: "mac" });
  });

  check("配置更新做范围校验与非法值回退", () => {
    const config = store.updateConfig({
      pollInterval: 100000,
      portalPort: -5,
      gateway: "  ",
      theme: "rainbow",
      material: "  ",
      passwordAlgo: "nope",
    });
    assertEqual(config.pollInterval, 600, "轮询间隔上限收敛");
    assertEqual(config.portalPort, DEFAULT_CONFIG.portalPort, "非法端口回退默认");
    assertEqual(config.gateway, DEFAULT_CONFIG.gateway, "空网关回退默认");
    assertEqual(config.theme, "dark", "非法主题回退");
    assertEqual(config.material, DEFAULT_CONFIG.material, "非法材质回退");
    assertEqual(config.passwordAlgo, "srun3", "非法算法回退");
  });

  check("合法的配置更新被接受", () => {
    const config = store.updateConfig({
      gateway: "10.0.0.1",
      portalPort: 6900,
      statusPort: 8080,
      pollInterval: 15,
      theme: "light",
      material: "transparent",
      passwordAlgo: "srbx1",
      infoFormat: "none",
    });
    assertEqual(config.gateway, "10.0.0.1", "网关");
    assertEqual(config.portalPort, 6900, "portal 端口");
    assertEqual(config.statusPort, 8080, "status 端口");
    assertEqual(config.theme, "light", "主题");
  });

  check("保存账号后密码以密文落盘且不含明文", () => {
    const result = store.saveAccount({ username: "20230001", password: "S3cret!pass", autoLogin: true });
    assert(result.ok, `保存应成功, 实际: ${result.message}`);
    const accounts = store.accounts();
    assertEqual(accounts.length, 1, "账号数量");
    assertEqual(accounts[0].username, "20230001", "学号");
    assertEqual(accounts[0].hasPassword, true, "hasPassword 应为 true");
    assertEqual(accounts[0].autoLogin, true, "autoLogin 应为 true");

    const raw = fs.readFileSync(path.join(dir, "accounts.json"), "utf8");
    assert(!raw.includes("S3cret!pass"), "落盘文件里不允许出现明文密码");
    // 断言密文确实是加密器产出的, 而不是被存成了空串或别的什么
    const parsed = JSON.parse(raw);
    const secret = Buffer.from(parsed.accounts[0].secret, "base64").toString("utf8");
    assertEqual(secret, "enc:S3cret!pass", "落盘内容应为加密器输出的密文");
  });

  check("可以取回明文密码用于登录", () => {
    const id = store.activeAccountId;
    assertEqual(store.getPassword(id), "S3cret!pass", "解密后的密码");
    const revealed = store.revealPassword(id);
    assertEqual(revealed.password, "S3cret!pass", "reveal 返回的密码");
  });

  check("再次保存不传密码时保留原密码", () => {
    const id = store.activeAccountId;
    const result = store.saveAccount({ id, username: "20230001", label: "我的账号" });
    assert(result.ok, "保存应成功");
    assertEqual(store.getPassword(id), "S3cret!pass", "密码应保留");
    assertEqual(store.findById(id).label, "我的账号", "备注应更新");
  });

  check("同一时刻只有一个账号开启自动登录", () => {
    const second = store.saveAccount({ username: "20230002", password: "another", autoLogin: true });
    assert(second.ok, "第二个账号应保存成功");
    const withAuto = store.accounts().filter((a) => a.autoLogin);
    assertEqual(withAuto.length, 1, "自动登录账号数量");
    assertEqual(withAuto[0].username, "20230002", "自动登录应落在最新账号上");
    assertEqual(store.activeAccountId, second.id, "活动账号应切换");
  });

  check("删除账号后活动账号回退", () => {
    const id = store.activeAccountId;
    const result = store.removeAccount(id);
    assert(result.ok, "删除应成功");
    assertEqual(store.accounts().length, 1, "剩余账号数量");
    assertEqual(store.activeAccount.username, "20230001", "活动账号回退到剩下的账号");
  });

  check("清除密码只清空密文, 账号仍在", () => {
    const id = store.activeAccountId;
    store.forgetPassword(id);
    assertEqual(store.getPassword(id), "", "密码应为空");
    assertEqual(store.accounts().length, 1, "账号仍在");
    assertEqual(store.accounts()[0].hasPassword, false, "hasPassword 应为 false");
  });

  check("配置能跨实例持久化", () => {
    const reopened = new Store({ dir, safeStorage: fakeSafeStorage });
    assertEqual(reopened.config.gateway, "10.0.0.1", "网关应持久化");
    assertEqual(reopened.config.theme, "light", "主题应持久化");
    assertEqual(reopened.accounts().length, 1, "账号应持久化");
    assertEqual(reopened.activeAccount.username, "20230001", "活动账号应持久化");
  });

  check("带 UTF-8 BOM 的配置文件仍能被读取(记事本另存为会加 BOM)", () => {
    const dir4 = tempDir();
    fs.writeFileSync(
      path.join(dir4, "config.json"),
      "\uFEFF" + JSON.stringify({ gateway: "192.168.1.9", pollInterval: 42, theme: "light" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir4, "accounts.json"),
      "\uFEFF" + JSON.stringify({ activeId: "a1", accounts: [{ id: "a1", username: "20239999" }] }),
      "utf8"
    );
    const s4 = new Store({ dir: dir4, safeStorage: fakeSafeStorage });
    assertEqual(s4.config.gateway, "192.168.1.9", "BOM 不应导致配置被丢弃");
    assertEqual(s4.config.pollInterval, 42, "轮询间隔应生效");
    assertEqual(s4.accounts().length, 1, "BOM 不应导致账号被丢弃");
    assertEqual(s4.accounts()[0].username, "20239999", "学号应正确");
  });

  check("配置文件损坏时回退默认值而不是崩溃", () => {
    const dir5 = tempDir();
    fs.writeFileSync(path.join(dir5, "config.json"), "{ 这不是合法 JSON ", "utf8");
    const s5 = new Store({ dir: dir5, safeStorage: fakeSafeStorage });
    assertEqual(s5.config.gateway, DEFAULT_CONFIG.gateway, "应回退默认网关");
    assertEqual(s5.accounts().length, 0, "账号列表应为空");
  });

  check("恢复默认配置不会删除账号", () => {
    const config = store.resetConfig();
    assertEqual(config.gateway, DEFAULT_CONFIG.gateway, "网关回到默认");
    assertEqual(store.accounts().length, 1, "账号应保留");
  });

  check("加密不可用时拒绝保存密码而不是退化成明文", () => {
    const dir2 = tempDir();
    const s2 = new Store({ dir: dir2, safeStorage: disabledSafeStorage });
    const result = s2.saveAccount({ username: "20230003", password: "plaintext" });
    assertEqual(result.ok, false, "应拒绝保存");
    const raw = fs.existsSync(path.join(dir2, "accounts.json"))
      ? fs.readFileSync(path.join(dir2, "accounts.json"), "utf8")
      : "";
    assert(!raw.includes("plaintext"), "绝不能写入明文密码");
  });

  check("日志脱敏不会写入密码原文", () => {
    const dir3 = tempDir();
    const log = new Logger({ dir: dir3 });
    log.info("GET /cgi-bin/srun_portal?action=login&username=20230001&password=%7Babc%7D&info=xyz&chksum=deadbeef");
    const text = log.read(10).join("\n");
    assert(!text.includes("{abc}"), "密码字段应被脱敏");
    assert(!text.includes("xyz"), "info 字段应被脱敏");
    assert(!text.includes("deadbeef"), "chksum 字段应被脱敏");
    assert(text.includes("username=20230001"), "学号可以保留");
  });

  process.stdout.write(
    `\n=== 结果: ${passed} 项通过, ${failures.length} 项失败 ===\n`
  );
  if (failures.length) {
    for (const f of failures) process.stdout.write(`  失败: ${f.name} -> ${f.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();
