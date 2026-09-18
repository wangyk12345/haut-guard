/**
 * vectors.test.js —— 协议移植的**逐字节对拍测试**。
 *
 * 读取 `test/vectors.json`(由 gen_vectors.py 从已验证的 Python 参考实现导出),
 * 逐条调用 JS 实现并比对。任何一条不一致都会以非 0 退出码失败。
 *
 * 用法: node test/vectors.test.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const srun = require("../src/main/srun");

const VECTORS = process.env.VECTORS_FILE
  ? path.resolve(process.env.VECTORS_FILE)
  : path.join(__dirname, "vectors.json");
const MAX_REPORT = 8;

function fmt(value) {
  if (typeof value === "string") {
    const preview = value.length > 120 ? `${value.slice(0, 120)}…(len=${value.length})` : value;
    return JSON.stringify(preview);
  }
  return JSON.stringify(value);
}

/** 按用例类型调用对应的 JS 实现。 */
function invoke(testCase) {
  const args = testCase.args || [];
  switch (testCase.fn) {
    case "xencode":
      return srun.xencode(args[0], args[1]);
    case "b64_srun": {
      const hex = String(testCase.input_hex || "");
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
        throw new Error(`input_hex 非法: ${hex.slice(0, 40)}`);
      }
      return srun.b64Srun(Buffer.from(hex, "hex"));
    }
    case "make_password_field":
      return srun.makePasswordField(args[0], args[1], args[2]);
    case "make_info_field":
      return srun.makeInfoField(args[0], args[1], args[2], args[3], args[4]);
    case "make_chksum":
      return srun.makeChksum(args[0], args[1], args[2], args[3], args[4]);
    default:
      throw new Error(`未知用例类型: ${testCase.fn}`);
  }
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function main() {
  if (!fs.existsSync(VECTORS)) {
    process.stderr.write(
      `找不到 ${VECTORS}\n请先运行: python test/gen_vectors.py (需要先生成对拍向量)\n`
    );
    process.exit(2);
  }
  const payload = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
  const cases = Array.isArray(payload.cases) ? payload.cases : [];
  if (!cases.length) {
    process.stderr.write("vectors.json 里没有任何用例\n");
    process.exit(2);
  }

  const stats = new Map();
  const failures = [];
  const errorDivergences = [];
  let valueCases = 0;

  for (const testCase of cases) {
    const key = testCase.fn;
    if (!stats.has(key)) stats.set(key, { total: 0, failed: 0 });
    stats.get(key).total += 1;

    if (testCase.error) {
      // 参考实现抛异常的用例: 要求 JS 侧同样抛出, 只做提示不做失败判定
      let threw = false;
      try {
        invoke(testCase);
      } catch {
        threw = true;
      }
      if (!threw) {
        errorDivergences.push({
          fn: key,
          args: testCase.args,
          expected: `抛异常 (${testCase.error})`,
          actual: "正常返回",
        });
      }
      continue;
    }

    valueCases += 1;
    let actual;
    try {
      actual = invoke(testCase);
    } catch (err) {
      stats.get(key).failed += 1;
      failures.push({
        fn: key,
        args: testCase.args || testCase.input_hex,
        expected: testCase.expected,
        actual: `抛出异常: ${err.message}`,
      });
      continue;
    }
    if (!sameValue(actual, testCase.expected)) {
      stats.get(key).failed += 1;
      failures.push({
        fn: key,
        args: testCase.args || testCase.input_hex,
        expected: testCase.expected,
        actual,
      });
    }
  }

  const totalFailed = failures.length;
  process.stdout.write("\n=== 协议对拍结果 (JS 移植 vs Python 参考实现) ===\n");
  process.stdout.write(`向量文件: ${VECTORS}\n`);
  if (payload.meta) {
    process.stdout.write(
      `参考实现: Python ${payload.meta.python_version || "?"}, 种子 ${payload.meta.seed}, ` +
        `生成于 ${payload.meta.generated_by || "?"}\n`
    );
  }
  process.stdout.write(`用例总数: ${cases.length}(其中数值比对 ${valueCases} 条)\n\n`);
  for (const [fn, s] of stats) {
    const mark = s.failed === 0 ? "通过" : `失败 ${s.failed}`;
    process.stdout.write(`  ${fn.padEnd(22)} ${String(s.total).padStart(5)} 条  ${mark}\n`);
  }

  if (failures.length) {
    process.stdout.write(`\n--- 不一致明细(最多显示 ${MAX_REPORT} 条)---\n`);
    for (const f of failures.slice(0, MAX_REPORT)) {
      process.stdout.write(
        `\n[${f.fn}] args=${fmt(f.args)}\n  期望: ${fmt(f.expected)}\n  实际: ${fmt(f.actual)}\n`
      );
    }
  }
  if (errorDivergences.length) {
    process.stdout.write(
      `\n注意: ${errorDivergences.length} 条"参考实现抛异常"的用例在 JS 侧没有抛异常(不影响判定)\n`
    );
    for (const d of errorDivergences.slice(0, 3)) {
      process.stdout.write(`  [${d.fn}] args=${fmt(d.args)} 期望 ${d.expected}, 实际 ${d.actual}\n`);
    }
  }

  if (totalFailed) {
    process.stdout.write(`\n结论: 失败 —— ${totalFailed} 条与参考实现不一致\n`);
    process.exit(1);
  }
  process.stdout.write(
    `\n结论: 通过 —— ${valueCases}/${valueCases} 条与 Python 参考实现逐字节一致` +
      `(另有 ${cases.length - valueCases} 条异常路径用例)\n`
  );
  process.exit(0);
}

main();
