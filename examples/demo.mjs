/**
 * 现场演示：造一个真的会挂的仓库，然后让 dsh-culprit 自己去找肇事提交。
 *
 * 这个脚本不碰你现有的任何仓库——它在新临时目录里从零建一个，
 * 跑完打印报告就把目录删掉。`node examples/demo.mjs` 即可。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __internal } from "../index.mjs";

const { executeCulprit, renderReport } = __internal;

const GOOD_CALC = `export function clamp(value, max) {
  return value > max ? max : value;
}
`;

// 肇事提交：把 > 写成 >=，并且顺手把结果减了 1。
// 只在"正好等于上限"时暴露，所以肉眼看 diff 很容易划过去。
const BUGGY_CALC = `export function clamp(value, max) {
  return value >= max ? max - 1 : value;
}
`;

const TEST_FILE = `import test from "node:test";
import assert from "node:assert/strict";
import { clamp } from "./calc.mjs";

test("低于上限时原样返回", () => {
  assert.equal(clamp(3, 5), 3);
});

test("超过上限时压到上限", () => {
  assert.equal(clamp(9, 5), 5);
});

test("正好等于上限时必须是原值", () => {
  assert.equal(clamp(5, 5), 5);
});
`;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo, subject) {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", subject]);
}

const dir = mkdtempSync(join(tmpdir(), "dsh-culprit-demo-"));
try {
  git(dir, ["init", "-q"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "user.name", "Culprit Demo"]);
  git(dir, ["config", "user.email", "demo@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  writeFileSync(join(dir, "calc.mjs"), GOOD_CALC, "utf8");
  writeFileSync(join(dir, "calc.test.mjs"), TEST_FILE, "utf8");
  writeFileSync(join(dir, "README.md"), "# clamp 小工具\n", "utf8");
  commit(dir, "chore: 起个头");

  writeFileSync(join(dir, "calc.mjs"), GOOD_CALC.replace("value > max", "value > max"), "utf8");
  writeFileSync(join(dir, "NOTES.md"), "记一笔\n", "utf8");
  commit(dir, "docs: 补点笔记");

  writeFileSync(join(dir, "calc.mjs"), `${GOOD_CALC}\nexport function span(max) {\n  return max;\n}\n`, "utf8");
  commit(dir, "feat: 加个 span");

  writeFileSync(join(dir, "calc.mjs"), `${BUGGY_CALC}\nexport function span(max) {\n  return max;\n}\n`, "utf8");
  writeFileSync(join(dir, "CHANGELOG.md"), "## 未发布\n- 整理 clamp 的边界\n", "utf8");
  commit(dir, "refactor: 整理 clamp 的边界判断");

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", private: true, type: "module" }, null, 2), "utf8");
  commit(dir, "chore: 加 package.json");

  const value = await executeCulprit(
    { predicate: "node --test calc.test.mjs", root: dir },
    {
      workdir: dir,
      maxHistoryScan: 100,
      maxSteps: 16,
      maxAutoProbes: 8,
      skipLimit: 3,
      timeoutPerStep: 60_000,
      totalBudgetMs: 300_000,
      maxOutputTail: 600,
      maxDiffChars: 4000,
      stateDir: join(dir, "..", "dsh-culprit-demo-state"),
      allowDirty: false,
      shell: null,
      firstParent: true,
      requireBadAtStart: true,
      keepState: true,
      gitTimeout: 30_000,
    },
  );

  console.log(renderReport(value));
  console.log(`\n判据失败时的真实输出（最后几行）：\n${value.probes[0]?.outputTail ?? "(无)"}`);
  if (value.result.status !== "found") {
    process.exitCode = 1;
    console.log(`\n演示没有成功：${value.result.status}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, "..", "dsh-culprit-demo-state"), { recursive: true, force: true });
}
