/**
 * dsh-culprit 测试。
 *
 * 刻意不用任何测试框架：宿主里没有可用的框架，`node test/culprit.test.mjs` 直跑最快，
 * 也最容易在别的机器上复现。
 *
 * 全部测试都在**真的临时 git 仓库**上跑真 git、真子进程——因为这个插件的价值全在
 * "跟真实仓库和真实命令打交道"，用 mock 测出来的绿色没有意义。
 *
 * 重点验证的三件事：
 *   1. 肇事提交判得对（包括"没复现"、"工作树脏"这些必须拒绝的情形）；
 *   2. **工作树最后一定被还原**（这是插件最可能伤到用户的地方）；
 *   3. **超时和退出码 125 被当作跳过，绝不能被读成"坏"**（判错了会指错人）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { __internal, apply, inject } from "../index.mjs";

const {
  DEFAULTS,
  buildTool,
  executeCulprit,
  parseLog,
  predicateInvocation,
  renderReport,
  stateKey,
  statePathFor,
} = __internal;

/* ─────────────────────────── 断言 ─────────────────────────── */

let passed = 0;
const failures = [];
const cleanups = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ─────────────────────────── git 夹具 ─────────────────────────── */

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOut(repo, args) {
  return git(repo, args).trim();
}

/** 判据脚本：bug.txt 里有 BUG 就退出 1。 */
const CHECK_MJS = `import { readFileSync } from "node:fs";
const text = readFileSync(new URL("./bug.txt", import.meta.url), "utf8");
process.exit(text.includes("BUG") ? 1 : 0);
`;

/** 判据脚本：有 BUG 时挂住不返回（用来验证"超时 = 跳过"）。 */
const TARDY_MJS = `import { readFileSync } from "node:fs";
const text = readFileSync(new URL("./bug.txt", import.meta.url), "utf8");
if (text.includes("BUG")) await new Promise((resolve) => setTimeout(resolve, 60000));
process.exit(0);
`;

/** 判据脚本：有 BUG 时退出 125（git bisect 的跳过约定）。 */
const SKIPCODE_MJS = `import { readFileSync } from "node:fs";
const text = readFileSync(new URL("./bug.txt", import.meta.url), "utf8");
process.exit(text.includes("BUG") ? 125 : 0);
`;

/**
 * 造一个临时仓库。specs 里每一项是一个提交；`bug` 不写就沿用上一次的值。
 * 返回 { dir, shas, subjects }，shas[0] 是最早的提交。
 */
function makeRepo(specs) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-culprit-"));
  cleanups.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  git(dir, ["config", "core.safecrlf", "false"]);
  git(dir, ["config", "user.name", "Culprit Test"]);
  git(dir, ["config", "user.email", "culprit@example.invalid"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  writeFileSync(join(dir, "check.mjs"), CHECK_MJS, "utf8");
  writeFileSync(join(dir, "tardy.mjs"), TARDY_MJS, "utf8");
  writeFileSync(join(dir, "skipcode.mjs"), SKIPCODE_MJS, "utf8");

  const shas = [];
  const subjects = [];
  let buggy = false;
  for (const [index, spec] of specs.entries()) {
    if (Object.prototype.hasOwnProperty.call(spec, "bug")) buggy = spec.bug;
    writeFileSync(join(dir, "bug.txt"), buggy ? "BUG\n" : "ok\n", "utf8");
    // 每个提交都必须真的动到东西，否则 git 会因为"没有变化"直接拒绝提交。
    writeFileSync(join(dir, "tick.txt"), `${index}\n`, "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", spec.subject]);
    shas.push(gitOut(dir, ["rev-parse", "HEAD"]));
    subjects.push(spec.subject);
  }
  return { dir, shas, subjects };
}

/** 一段"第 3 个提交引入 bug 且一直没修"的历史，共 6 个提交。 */
function buggyHistory() {
  return [
    { subject: "chore: 初始化", bug: false },
    { subject: "feat: 加个字段" },
    { subject: "refactor: 挪一下" },
    { subject: "fix: 顺手改个判断", bug: true },
    { subject: "docs: 补注释" },
    { subject: "chore: 版本号" },
  ];
}

let stateCounter = 0;
function testConfig(dir, overrides = {}) {
  stateCounter += 1;
  const stateDir = mkdtempSync(join(tmpdir(), "dsh-culprit-state-"));
  cleanups.push(stateDir);
  return {
    workdir: dir,
    maxHistoryScan: 200,
    maxSteps: 16,
    maxAutoProbes: 8,
    skipLimit: 3,
    timeoutPerStep: 20_000,
    totalBudgetMs: 300_000,
    maxOutputTail: 1200,
    maxDiffChars: 8000,
    stateDir,
    allowDirty: false,
    shell: null,
    firstParent: true,
    requireBadAtStart: true,
    keepState: true,
    gitTimeout: 30_000,
    ...overrides,
  };
}

function statusOf(value) {
  return value?.result?.status;
}

/* ─────────────────────────── 纯函数 / 装配 ─────────────────────────── */

function testUnit() {
  console.log("\n[1] 解析与装配");

  const parsed = parseLog(
    ["a".repeat(40), "Alice", "2026-01-02T03:04:05+08:00", "feat: 一"].join("\u001f") +
      "\n" +
      ["b".repeat(40), "Bob", "2026-02-03T04:05:06+08:00", "fix: 二"].join("\u001f") +
      "\n",
  );
  equal("parseLog 取出 2 条", parsed.entries.length, 2);
  equal("parseLog 第一条 sha", parsed.entries[0], "a".repeat(40));
  equal("parseLog 带出主题", parsed.subjects.get("b".repeat(40)).subject, "fix: 二");
  equal("parseLog 日期截到天", parsed.subjects.get("a".repeat(40)).date, "2026-01-02");

  equal("垃圾行被丢掉", parseLog("not a sha\n").entries.length, 0);

  const inv = predicateInvocation("node check.mjs", null);
  if (process.platform === "win32") {
    check("Windows 默认走 powershell", inv.file === "powershell", `实际 ${inv.file}`);
  } else {
    check("POSIX 默认走 /bin/sh", inv.file === "/bin/sh", `实际 ${inv.file}`);
  }
  check("命令原样传给 shell", inv.args[inv.args.length - 1].includes("node check.mjs"));
  if (process.platform === "win32") {
    // 实测：Windows PowerShell 会把任何非零退出码压成 1，所以必须显式转交。
    check("Windows 上显式转交 $LASTEXITCODE", inv.args[inv.args.length - 1].includes("exit $LASTEXITCODE"));
  }
  equal("显式指定 cmd", predicateInvocation("x", "cmd").file, "cmd");
  check("cmd 走延迟展开", predicateInvocation("x", "cmd").args.includes("/v:on"));
  equal("显式指定 bash", predicateInvocation("x", "bash").file, "bash");
  equal("sh 不需要包装", predicateInvocation("x", "sh").args[1], "x");

  const tool = buildTool({ ...DEFAULTS, workdir: process.cwd() });
  equal("工具名", tool.name, "regression_culprit");
  check("工具有描述", typeof tool.description === "string" && tool.description.length > 40);
  check("工具有 parameters", tool.parameters?.type === "object" && !!tool.parameters.properties.predicate);
  // 标准 JSON Schema 的写法：要求挂在父对象的 required 数组上，不是属性上的布尔。
  check("predicate 是必填", Array.isArray(tool.parameters.required) && tool.parameters.required.includes("predicate"));
  check("工具有 output.schema", tool.output?.schema?.type === "object");
  check("schema 声明了 required 数组", Array.isArray(tool.output.schema.required) && tool.output.schema.required.includes("result"));

  // 回归守卫：宿主 register() 会跑 assertSupportedJsonSchema（dsh-tools/lib/index.js:2882），
  // 它只认标准 JSON Schema 的一个子集。最早这里用的是 DSH 内部那套「spec 写法」（属性上挂
  // `required: true`），宿主把整份 output.schema 拒了，而 apply() 的兜底 try/catch 把它吞掉 ——
  // 表现是「装好了但工具没注册」，不真接到宿主上跑根本发现不了。
  // 这里用零依赖的方式把同一批规则守住，免得再犯。
  const schemaViolations = [];
  const walkSchema = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walkSchema(child, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    if (typeof node.required === "boolean") {
      schemaViolations.push(`${path}.required 是布尔（标准 JSON Schema 要求字符串数组）`);
    } else if (node.required !== undefined && !Array.isArray(node.required)) {
      schemaViolations.push(`${path}.required 不是数组`);
    }
    if (Array.isArray(node.required) && node.type !== "object") {
      schemaViolations.push(`${path}.required 挂在 type=${JSON.stringify(node.type)} 上`);
    }
    if (Array.isArray(node.required) && node.type === "object") {
      const declared = node.properties ?? {};
      for (const key of node.required) {
        if (!Object.hasOwn(declared, key)) schemaViolations.push(`${path}.required 列了未声明的属性 ${key}`);
      }
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
      schemaViolations.push(`${path}.additionalProperties 不是布尔`);
    }
    if (Array.isArray(node.type)) schemaViolations.push(`${path}.type 是数组（宿主不支持）`);
    for (const [key, val] of Object.entries(node)) walkSchema(val, `${path}.${key}`);
  };
  walkSchema(tool.parameters, "parameters");
  walkSchema(tool.output.schema, "output.schema");
  check(
    "工具 schema 符合宿主校验器能接受的形状",
    schemaViolations.length === 0,
    schemaViolations.slice(0, 4).join(" | "),
  );
  check("render 是函数", typeof tool.output.render === "function");
  const rendered = tool.output.render({}, {
    schema: "culprit/1",
    mode: "bisect",
    workspace: "C:/w",
    repoRoot: "C:/w",
    predicate: "node check.mjs",
    badRef: "HEAD (abc12345)",
    goodRef: "def67890 (自动探测，位置 4)",
    candidateCount: 6,
    result: {
      status: "found",
      confidence: "high",
      summary: "肇事提交 abc12345「fix: 顺手改个判断」",
      culprit: {
        sha: "a".repeat(40), shortSha: "abc12345", subject: "fix: 顺手改个判断",
        author: "Alice", date: "2026-01-02", parent: "00000000", mergeCommit: false,
        files: [{ path: "bug.txt", additions: 1, deletions: 1 }],
      },
    },
    probes: [{ ref: "a".repeat(40), shortSha: "abc12345", result: "bad", code: 1, ms: 120, note: "坏点自检", outputTail: "" }],
    diff: { available: true, truncated: false, filesChanged: 1, insertions: 1, deletions: 1, text: "-ok\n+BUG" },
    state: { file: "", resume: false, resumable: false, stepsDone: 5, stepsAllowed: 16, budgetSpentMs: 400, budgetAllowedMs: 600000, remainingSha: null },
    states: [],
    warnings: [],
    durationMs: 900,
  });
  check("render 返回 text 数组", Array.isArray(rendered) && rendered[0].type === "text");
  check("render 提到肇事提交", rendered[0].text.includes("abc12345"));
  check("render 提到探测轨迹", rendered[0].text.includes("探测轨迹"));
  check("render 提到肇事提交标题", rendered[0].text.includes("fix: 顺手改个判断"));

  check("会改工作树，所以绝不并发安全", tool.isConcurrencySafe() === false);
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

async function testHappyPath() {
  console.log("\n[2] 找到肇事提交");
  const { dir, shas, subjects } = makeRepo(buggyHistory());
  const headBefore = gitOut(dir, ["rev-parse", "HEAD"]);
  const branchBefore = gitOut(dir, ["symbolic-ref", "--short", "HEAD"]);

  const value = await executeCulprit({ predicate: "node check.mjs", root: dir }, testConfig(dir));

  equal("状态是 found", statusOf(value), "found");
  equal("置信度 high（没有跳过）", value.result.confidence, "high");
  check("认出了肇事提交", value.result.culprit !== null, JSON.stringify(value.result));
  if (value.result.culprit) {
    equal("肇事提交 sha 正确", value.result.culprit.sha, shas[3]);
    equal("肇事提交主题正确", value.result.culprit.subject, subjects[3]);
  }
  equal("候选历史 6 个提交", value.candidateCount, 6);
  equal("探针数 = 自检 1 + 寻好点 3 + 二分 1", value.probes.length, 5);
  equal("第一步是坏点自检且判为 bad", value.probes[0].result, "bad");
  equal("自检的退出码是 1", value.probes[0].code, 1);
  check("存在判为 good 的探针", value.probes.some((p) => p.result === "good"));
  check("没有跳过", value.probes.every((p) => p.result !== "skip"));
  check("附带了 diff", value.diff.available && value.diff.text.includes("BUG"), JSON.stringify(value.diff).slice(0, 200));
  equal("diff 统计到 2 个文件（bug.txt + tick.txt）", value.diff.filesChanged, 2);
  check(
    "改了哪个文件也列出来了",
    value.result.culprit?.files?.some((f) => f.path === "bug.txt"),
    JSON.stringify(value.result.culprit?.files),
  );

  equal("工作树还原到原 HEAD", gitOut(dir, ["rev-parse", "HEAD"]), headBefore);
  equal("分支还原", gitOut(dir, ["symbolic-ref", "--short", "HEAD"]), branchBefore);
  equal("工作树干净", gitOut(dir, ["status", "--porcelain"]), "");

  const text = renderReport(value);
  check("报告里出现肇事提交 shortSha", text.includes(shas[3].slice(0, 8)));
  check("报告里出现判据命令", text.includes("node check.mjs"));
  equal("成功时删掉了状态文件", existsSync(value.state.file), false);
}

async function testGoodRef() {
  console.log("\n[3] 用户显式给 goodRef");
  const { dir, shas, subjects } = makeRepo(buggyHistory());
  const value = await executeCulprit(
    { predicate: "node check.mjs", root: dir, goodRef: shas[0] },
    testConfig(dir),
  );
  equal("状态是 found", statusOf(value), "found");
  equal("肇事提交仍是第 4 个", value.result.culprit?.subject, subjects[3]);
  check("goodRef 被写进结果", value.goodRef.includes(shas[0].slice(0, 8)), value.goodRef);
  check("在 goodRef 上探过一次", value.probes.some((p) => p.ref === shas[0] && p.result === "good"));
}

async function testGoodRefForeignKey() {
  console.log("\n[4] goodRef 不是祖先");
  const { dir } = makeRepo(buggyHistory());
  git(dir, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(dir, "side.txt"), "side\n", "utf8");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: 旁支提交"]);
  const sideSha = gitOut(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-q", "-"]);

  const value = await executeCulprit({ predicate: "node check.mjs", root: dir, goodRef: sideSha }, testConfig(dir));
  equal("状态是 invalid-args", statusOf(value), "invalid-args");
  equal("工作树回到原来的分支", gitOut(dir, ["symbolic-ref", "--short", "HEAD"]) !== "side", true);
}

async function testNotReproduced() {
  console.log("\n[5] 判据在坏点上其实是好的");
  const { dir } = makeRepo([
    { subject: "chore: 初始化", bug: false },
    { subject: "feat: 一" },
    { subject: "feat: 二" },
  ]);
  const value = await executeCulprit({ predicate: "node check.mjs", root: dir }, testConfig(dir));
  equal("状态是 not-reproduced", statusOf(value), "not-reproduced");
  equal("只探了一次就收手", value.probes.length, 1);
  equal("没有认领肇事者", value.result.culprit, null);
  equal("工作树干净", gitOut(dir, ["status", "--porcelain"]), "");
}

async function testNoGoodBaseline() {
  console.log("\n[6] 整条历史都是坏的");
  const { dir } = makeRepo([
    { subject: "chore: 初始化", bug: true },
    { subject: "feat: 一" },
    { subject: "feat: 二" },
  ]);
  const value = await executeCulprit(
    { predicate: "node check.mjs", root: dir },
    testConfig(dir, { maxAutoProbes: 2 }),
  );
  equal("状态是 no-good-baseline", statusOf(value), "no-good-baseline");
  check("给了可操作的提示", value.result.summary.includes("goodRef"), value.result.summary);
}

async function testDirtyRefused() {
  console.log("\n[7] 工作树脏 → 拒绝");
  const { dir } = makeRepo(buggyHistory());
  writeFileSync(join(dir, "bug.txt"), "BUG\n# 本地未提交的改动\n", "utf8");
  const before = gitOut(dir, ["rev-parse", "HEAD"]);
  const value = await executeCulprit({ predicate: "node check.mjs", root: dir }, testConfig(dir));
  equal("状态是 dirty", statusOf(value), "dirty");
  equal("没跑任何探针", value.probes.length, 0);
  equal("HEAD 没被动过", gitOut(dir, ["rev-parse", "HEAD"]), before);
  check("本地改动还在", readFileSync(join(dir, "bug.txt"), "utf8").includes("本地未提交"), "");
}

async function testTimeoutIsSkip() {
  console.log("\n[8] 超时必须算跳过，不能算坏");
  const { dir } = makeRepo(buggyHistory());
  const value = await executeCulprit(
    { predicate: "node tardy.mjs", root: dir },
    testConfig(dir, { timeoutPerStep: 2000 }),
  );
  equal("状态是 inconclusive", statusOf(value), "inconclusive");
  equal("超时被记为 skip", value.probes[0].result, "skip");
  check("说明里点明是超时", /超时/.test(value.probes[0].note), value.probes[0].note);
  check("没有把它当成坏点认领", value.result.culprit === null);
  equal("工作树依然还原", gitOut(dir, ["status", "--porcelain"]), "");
}

async function testExit125IsSkip() {
  console.log("\n[9] 退出码 125 = 跳过");
  const { dir } = makeRepo(buggyHistory());
  const value = await executeCulprit({ predicate: "node skipcode.mjs", root: dir }, testConfig(dir));
  equal("状态是 inconclusive", statusOf(value), "inconclusive");
  equal("记为 skip", value.probes[0].result, "skip");
  equal("退出码记到 125", value.probes[0].code, 125);
}

async function testBudgetAndResume() {
  console.log("\n[10] 预算用尽 → 落盘 → 续跑");
  const { dir, shas, subjects } = makeRepo(buggyHistory());
  const config = testConfig(dir, { maxSteps: 1 });

  const first = await executeCulprit({ predicate: "node check.mjs", root: dir }, config);
  equal("状态是 budget-exhausted", statusOf(first), "budget-exhausted");
  check("提示可以续跑", first.result.summary.includes("resume"), first.result.summary);
  equal("结果标记可续跑", first.state.resumable, true);
  check("状态文件已落盘", existsSync(first.state.file), first.state.file);
  equal("落盘路径由 sha1(仓库+判据+坏点) 决定", first.state.file, statePathFor(config.stateDir, stateKey(dir, "node check.mjs", shas[5], true)));
  equal("没收敛就不认领肇事者", first.result.culprit, null);
  equal("没收敛就不给 diff", first.diff.available, false);
  check("提示里点名了当前最像的那个", first.result.summary.includes(shas[3].slice(0, 8)), first.result.summary);
  equal("工作树已还原", gitOut(dir, ["status", "--porcelain"]), "");
  const saved = JSON.parse(readFileSync(first.state.file, "utf8"));
  check("落盘内容含完整候选列表", Array.isArray(saved.tokens) && saved.tokens.length === 6);
  check("落盘内容含原始 HEAD", saved.original?.head === shas[5], JSON.stringify(saved.original));

  // 续跑必须复用同一个状态目录，否则就是"重跑一遍"而不是"接着跑"。
  const second = await executeCulprit(
    { predicate: "node check.mjs", root: dir, resume: true },
    { ...config, maxSteps: 16 },
  );
  equal("续跑后找到肇事提交", statusOf(second), "found");
  equal("肇事提交仍是第 4 个", second.result.culprit?.subject, subjects[3]);
  check("续跑识别出是恢复的", second.warnings.some((w) => w.includes("恢复")), JSON.stringify(second.warnings));
  check("续跑没有从零开始（步数多过新跑一轮）", second.state.stepsDone >= 2, String(second.state.stepsDone));
  equal("工作树还原", gitOut(dir, ["status", "--porcelain"]), "");
  equal("收敛后清掉了状态文件", existsSync(first.state.file), false);
}

async function testGuards() {
  console.log("\n[11] 前置守卫");

  const plain = mkdtempSync(join(tmpdir(), "dsh-culprit-plain-"));
  cleanups.push(plain);
  const notRepo = await executeCulprit({ predicate: "node -e 0", root: plain }, testConfig(plain));
  equal("非 git 目录 → not-a-repo", statusOf(notRepo), "not-a-repo");

  const { dir } = makeRepo(buggyHistory());
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "BISECT_LOG"), "git bisect start\n", "utf8");
  const inProgress = await executeCulprit({ predicate: "node check.mjs", root: dir }, testConfig(dir));
  equal("已有 bisect → bisect-in-progress", statusOf(inProgress), "bisect-in-progress");
  rmSync(join(dir, ".git", "BISECT_LOG"), { force: true });

  const noPredicate = await executeCulprit({ root: dir }, testConfig(dir));
  equal("缺判据 → invalid-args", statusOf(noPredicate), "invalid-args");

  const { dir: dir2 } = makeRepo(buggyHistory());
  const badRef = await executeCulprit(
    { predicate: "node check.mjs", root: dir2, badRef: "no-such-ref-xyz" },
    testConfig(dir2),
  );
  equal("坏点解析不了 → invalid-args", statusOf(badRef), "invalid-args");
}

async function testStatusMode() {
  console.log("\n[12] status 模式只看不碰");
  const { dir } = makeRepo(buggyHistory());
  const config = testConfig(dir);

  const empty = await executeCulprit({ mode: "status", root: dir }, config);
  equal("空状态目录报告 status", statusOf(empty), "status");
  equal("没有未完成状态", empty.states.length, 0);
  equal("没探任何提交", empty.probes.length, 0);

  await executeCulprit({ predicate: "node check.mjs", root: dir }, { ...config, maxSteps: 1 });
  const listed = await executeCulprit({ mode: "status", root: dir }, config);
  check("列出了未完成状态", listed.states.length >= 1, JSON.stringify(listed.states));
  check("列出项带仓库路径", listed.states[0]?.repoRoot !== "", JSON.stringify(listed.states[0]));
  check("报告里有未完成状态段", renderReport(listed).includes("未完成状态"));
}

async function testApplyIntegration() {
  console.log("\n[13] 装配路径（模拟宿主加载）");

  // 宿主最致命的失败模式：apply 里同步抛错 = 整个插件加载失败。
  // 所以这里用假的 ctx 把 apply 真跑一遍，确认它注册得到工具、且怎么都不炸。
  const registered = [];
  const disposers = [];
  const fakeCtx = {
    logger: null,
    effect(fn, name) {
      disposers.push({ name, dispose: fn() });
      return () => {};
    },
    tools: {
      register(tool) {
        registered.push(tool);
        return () => {
          const idx = registered.indexOf(tool);
          if (idx >= 0) registered.splice(idx, 1);
        };
      },
    },
  };

  let threw = null;
  try {
    apply(fakeCtx, {});
  } catch (error) {
    threw = error;
  }
  check("apply 不抛错", threw === null, String(threw));
  equal("注册了 1 个工具", registered.length, 1);
  equal("注册的工具名正确", registered[0]?.name, "regression_culprit");
  equal("只注册了一个 effect", disposers.length, 1);
  check("effect 带了说明", typeof disposers[0].name === "string" && disposers[0].name.length > 0);
  disposers[0].dispose();
  equal("dispose 之后工具被摘掉", registered.length, 0);

  check("inject 只声明 tools（多写一个不存在的服务会让整棵树 PENDING）", 
    Array.isArray(inject) && inject.length === 1 && inject[0] === "tools",
    JSON.stringify(inject));

  // 宿主环境缺服务 / ctx 为 null 时也不能把加载搞崩。
  // 顺带要求它**大声**报错：当初正是「静默不注册」让那个 schema 问题藏了很久，
  // 所以这段测试连日志一起断言，并且把日志收走，免得测试输出里常年挂着一条吓人的失败行。
  let resilient = true;
  const before = registered.length;
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(" "));
  try {
    apply({ effect: () => {}, tools: undefined }, {});
    apply(null, {});
  } catch (error) {
    resilient = false;
    failures.push(`apply 在残缺环境下抛错：${String(error)}`);
  } finally {
    console.error = realError;
  }
  check("残缺的 ctx 也不抛错", resilient);
  // 第一句的 fakeCtx.effect 不会真的执行回调，所以它安静通过；第二句 ctx 是 null，必须报错。
  check(
    "残缺环境下会打出显眼的报错（绝不静默失败）",
    logged.length === 1 && logged.every((line) => line.includes("dsh-culprit") && line.includes("初始化失败")),
    JSON.stringify(logged),
  );
  equal("残缺环境下没有注册任何工具", registered.length, before);

  // 配置被塞了越界值也要能正常装配（会被夹到合法区间）。
  apply(fakeCtx, { maxSteps: 9999, timeoutPerStep: -5, stateDir: "" });
  equal("越界配置仍然装配成功", registered.length, before + 1);
  equal("越界配置注册的工具名依然正确", registered[before]?.name, "regression_culprit");
}

/* ─────────────────────────── 跑起来 ─────────────────────────── */

async function main() {
  console.log("dsh-culprit 测试");
  const started = Date.now();
  try {
    testUnit();
    await testHappyPath();
    await testGoodRef();
    await testGoodRefForeignKey();
    await testNotReproduced();
    await testNoGoodBaseline();
    await testDirtyRefused();
    await testTimeoutIsSkip();
    await testExit125IsSkip();
    await testBudgetAndResume();
    await testGuards();
    await testStatusMode();
    await testApplyIntegration();
  } catch (error) {
    failures.push(`测试抛异常：${String(error?.stack ?? error)}`);
    console.log(`  FAIL 测试抛异常：${String(error?.stack ?? error)}`);
  } finally {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清不掉就留给系统临时目录 */
      }
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${passed} 通过 / ${failures.length} 失败 · ${seconds}s`);
  if (failures.length > 0) {
    console.log("失败项：");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`临时目录 ${basename(tmpdir())} 下的夹具已清理。`);
}

await main();
