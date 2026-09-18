/**
 * all.js —— 依次运行全部测试。
 *
 * 用法: node test/all.js
 * 任一测试失败则以非 0 退出。
 */
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const TESTS = [
  { name: "存储层单元测试", file: "store.test.js", required: true },
  { name: "状态解析回归测试 (真机夹具)", file: "status.test.js", required: true },
  { name: "协议对拍测试 (JS vs Python)", file: "vectors.test.js", required: false },
  { name: "模拟网关端到端集成测试", file: "mock.test.js", required: false },
];

const results = [];

for (const test of TESTS) {
  process.stdout.write(`\n${"=".repeat(60)}\n运行: ${test.name}  (${test.file})\n${"=".repeat(60)}\n`);
  const result = spawnSync(process.execPath, [path.join(__dirname, test.file)], {
    stdio: "inherit",
    cwd: path.join(__dirname, ".."),
  });
  const code = result.status === null ? 1 : result.status;
  results.push({ ...test, code });
  if (code === 2) {
    process.stdout.write(`\n(跳过: ${test.file} 的前置依赖尚未生成, 退出码 2)\n`);
  }
}

process.stdout.write(`\n${"=".repeat(60)}\n汇总\n${"=".repeat(60)}\n`);
let failed = 0;
let skipped = 0;
for (const r of results) {
  let verdict;
  if (r.code === 0) verdict = "通过";
  else if (r.code === 2) {
    verdict = "跳过(缺少前置产物)";
    skipped += 1;
  } else {
    verdict = `失败 (退出码 ${r.code})`;
    failed += 1;
  }
  process.stdout.write(`  ${r.name.padEnd(32)} ${verdict}\n`);
}
process.stdout.write(
  `\n共 ${results.length} 项: ${results.length - failed - skipped} 通过, ${failed} 失败, ${skipped} 跳过\n`
);
process.exit(failed ? 1 : 0);
