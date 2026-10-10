/**
 * dsh-culprit — 宿主半边。
 *
 * 目标：把「测试什么时候开始挂的」这件事，从一个人必须盯着的交互式操作，
 * 变成 agent 一次调用能自己跑完、跑不完能续跑的活儿。
 *
 * 语义（刻意对齐 `git bisect run`，因为那是所有人已有的肌肉记忆）：
 *   predicate 退出码 **0 = 健康**，**非零 = 有问题**（即"这个提交上 bug 存在"）。
 *   退出码 125 或**超时** = **跳过**（不算坏）——旧提交上依赖没装、服务起不来
 *   是常态，把超时读成"坏"会把肇事点判错，这是这个插件最容易犯的错。
 *
 * 算法：
 *  1. 前置检查：是 git 仓库？工作树干净？（脏树拒绝，因为要反复 checkout）
 *     `.git/BISECT_LOG` 存在则拒绝——不跟用户手动跑的 bisect 抢状态。
 *  2. 候选 = `git log --first-parent` 的坏点历史（默认上限 500 条）。
 *  3. 先验证坏点确实坏（`requireBadAtStart`）：不坏就直接返回
 *     "not-reproduced"，比跑完 16 步再说"其实没复现"省得多。
 *  4. 找好点：给了 goodRef 就信它；否则按 1/2/4/8/16… 指数回退探测。
 *  5. 在 [lo=坏, hi=好] 上二分，跳过语义见上。
 *  6. 每一步都落盘（state.json）→ 预算耗尽时可以带 `resume: true` 接着跑。
 *  7. **无论成功、失败还是抛错，最后都 checkout 回原来的 HEAD/分支**。
 *
 * 硬性约束（照抄 dsh-change-radar 的实测结论，别重蹈覆辙）：
 *  · **绝不 import 任何 @deepseek-ai/* 包**：profile 装的是 link: 目录，
 *    node_modules 里没有这些包，一 import 就是 MODULE_NOT_FOUND，插件直接没了。
 *    工具定义就是一个普通对象（register 只校验 output.{schema,render}）。
 *  · **inject 只写确定被 provide 的服务**：tools 由 @deepseek-ai/dsh-tools 提供。
 *    声明一个不存在的服务会让 fiber 停在 PENDING，整棵插件树被丢弃。
 *  · **apply 里同步抛错 = 插件加载失败**，装配整体包 try/catch，日志走 console 兜底。
 *  · **一切都要有上限**：候选条数、每步超时、总预算、输出尾巴、diff 长度全部封顶。
 *  · **本插件会改工作树**（checkout），所以 isConcurrencySafe 必须是 false。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE_ID = "dsh-culprit";
const TOOL_NAME = "regression_culprit";
const SCHEMA_ID = "culprit/1";

/** 退出码 125 是 git bisect 的"跳过"约定，沿用。 */
const SKIP_EXIT_CODE = 125;

const DEFAULTS = {
  maxHistoryScan: 500,
  maxSteps: 16,
  maxAutoProbes: 8,
  skipLimit: 3,
  timeoutPerStep: 120_000,
  totalBudgetMs: 600_000,
  maxOutputTail: 1200,
  maxDiffChars: 8000,
  maxProbeListed: 40,
  stateDir: join(tmpdir(), "dsh-culprit"),
  allowDirty: false,
  shell: null,
  firstParent: true,
  requireBadAtStart: true,
  keepState: true,
  gitTimeout: 60_000,
};

/* ─────────────────────────── 小工具 ─────────────────────────── */

function clampNumber(value, fallback, min, max) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toPosix(value) {
  return String(value).split("\\").join("/");
}

function shortSha(sha) {
  return String(sha ?? "").slice(0, 8);
}

/** 输出尾巴：报错信息通常在最后几行，头部噪声最多。 */
function tail(text, max) {
  const s = String(text ?? "").replace(/\s+$/, "");
  if (s.length <= max) return s;
  return `…(已截断)…\n${s.slice(s.length - max)}`;
}

function emptyGit(reason) {
  return { ok: false, code: null, killed: false, stdout: "", stderr: reason, spawnError: true };
}

/* ─────────────────────────── 进程 ─────────────────────────── */

/**
 * 跑一个进程，永远 resolve（不 reject）——探针失败是一种结果，不是异常。
 * 超时的判据是 `error.killed === true`；exit code 在 `error.code`（数字）。
 */
function runProcess(file, args, options = {}) {
  const timeout = options.timeout ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 4 * 1024 * 1024;
  return new Promise((resolvePromise) => {
    const finish = (payload) => resolvePromise(payload);
    let child;
    try {
      child = execFile(
        file,
        args,
        {
          cwd: options.cwd,
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: "utf8",
          env: options.env ?? process.env,
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? "");
          const err = String(stderr ?? "");
          if (error) {
            finish({
              ok: false,
              code: typeof error.code === "number" ? error.code : null,
              killed: error.killed === true,
              stdout: out,
              // execFile 的 message 会把整条 shell 包装命令再抄一遍（Windows 上还是多行的），
              // 那几行对排查毫无价值，却会把真正有用的输出挤出尾巴。所以只在 stderr 为空时
              // 退化成一句短标记——真实退出码本来就单独记着。
              stderr:
                err !== ""
                  ? err
                  : `(stderr 为空；退出码 ${typeof error.code === "number" ? error.code : "未知"})`,
              spawnError: false,
            });
            return;
          }
          finish({ ok: true, code: 0, killed: false, stdout: out, stderr: err, spawnError: false });
        },
      );
    } catch (error) {
      // 平台策略拒绝 spawn（沙箱里实测 EPERM）——也只是一种结果。
      finish(emptyGit(String(error).slice(0, 300)));
      return;
    }
    child.on("error", () => {
      /* 回调里已经拿到 error，这里只是避免 unhandled */
    });
  });
}

/** 测试注入点；生产路径永远是 null。 */
let GIT_RUNNER = null;

function runGit(repo, args, timeout = DEFAULTS.gitTimeout) {
  if (typeof GIT_RUNNER === "function") return GIT_RUNNER(repo, args, timeout);
  return runProcess("git", ["-C", repo, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
}

async function gitText(repo, args, timeout) {
  const r = await runGit(repo, args, timeout);
  return r.ok ? r.stdout.trim() : null;
}

/* ─────────────────────────── 探针命令 ─────────────────────────── */

/**
 * Windows 默认走 powershell 而不是 cmd：`&&`、引号、环境变量语法差异太大，
 * 而 agent 写出来的命令九成是 POSIX 风格的（在 pwsh 里也能跑）。
 *
 * **但 Windows PowerShell 会把任何非零退出码压成 1**（实测 `powershell -Command "node x.mjs"`
 * 在 x 退出 125 时给到的是 1）。不显式转交 `$LASTEXITCODE` 的话，判据的真实退出码就丢了，
 * "退出码 125 = 跳过"这条约定在 Windows 上直接失效。所幸成功路径的 0 是准的，
 * 所以 good/bad 还能分，但 125 和别的特殊码必须自己捞回来。
 */
function predicateInvocation(predicate, shell) {
  const chosen = shell ?? (process.platform === "win32" ? "powershell" : "sh");
  if (chosen === "powershell" || chosen === "pwsh") {
    const exe = chosen === "pwsh" ? "pwsh" : "powershell";
    // 换行而不是分号：判据可能以 `# 注释` 结尾，接分号会把转交代码一并注掉。
    const script =
      `${predicate}\n` +
      "if ($null -eq $LASTEXITCODE) { if ($?) { exit 0 } else { exit 1 } } else { exit $LASTEXITCODE }";
    return { file: exe, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] };
  }
  if (chosen === "cmd") {
    // 必须开延迟展开：`%ERRORLEVEL%` 在整条命令解析时就展开了，会拿到上一个命令的码。
    return { file: "cmd", args: ["/v:on", "/d", "/s", "/c", `${predicate} & exit /b !ERRORLEVEL!`] };
  }
  if (chosen === "bash") return { file: "bash", args: ["-c", predicate] };
  return { file: "/bin/sh", args: ["-c", predicate] };
}

/* ─────────────────────────── 状态落盘 ─────────────────────────── */

function stateKey(repoRoot, predicate, badRef, firstParent) {
  return createHash("sha1")
    .update(`${toPosix(repoRoot)}\u0000${predicate}\u0000${badRef}\u0000${firstParent ? "1" : "0"}`)
    .digest("hex")
    .slice(0, 16);
}

function statePathFor(stateDir, key) {
  return join(stateDir, `${key}.json`);
}

function loadState(file) {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(file, state) {
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function listStates(stateDir) {
  try {
    if (!existsSync(stateDir)) return [];
    return readdirSync(stateDir)
      .filter((name) => name.endsWith(".json"))
      .slice(0, DEFAULTS.maxProbeListed)
      .map((name) => {
        const parsed = loadState(join(stateDir, name));
        if (!parsed) return null;
        return {
          key: name.replace(/\.json$/, ""),
          file: join(stateDir, name),
          repoRoot: String(parsed.repoRoot ?? ""),
          predicate: String(parsed.predicate ?? ""),
          badRef: String(parsed.badRef ?? ""),
          steps: Number(parsed.steps ?? 0),
          probes: Array.isArray(parsed.probes) ? parsed.probes.length : 0,
          loSha: parsed.tokens && Number.isInteger(parsed.lo) ? String(parsed.tokens[parsed.lo] ?? "") : "",
          hiSha: parsed.tokens && Number.isInteger(parsed.hi) ? String(parsed.tokens[parsed.hi] ?? "") : "",
          spentMs: Number(parsed.spentMs ?? 0),
          updatedAt: String(parsed.updatedAt ?? ""),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ─────────────────────────── 历史 ─────────────────────────── */

function parseLog(stdout) {
  const entries = [];
  const subjects = new Map();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const parts = line.split("\u001f");
    const sha = (parts[0] ?? "").trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) continue;
    const author = parts[1] ?? "";
    const date = (parts[2] ?? "").slice(0, 10);
    const subject = parts[3] ?? "";
    entries.push(sha);
    subjects.set(sha, { author, date, subject });
  }
  return { entries, subjects };
}

async function readHistory(repo, badSha, config) {
  const format = "%H%x1f%an%x1f%aI%x1f%s";
  const args = ["log", `--format=${format}`, `-n`, String(config.maxHistoryScan)];
  if (config.firstParent) args.push("--first-parent");
  args.push(badSha);
  const r = await runGit(repo, args);
  if (!r.ok) return { ok: false, reason: tail(r.stderr, 300), entries: [], subjects: new Map() };
  const parsed = parseLog(r.stdout);
  return { ok: true, ...parsed };
}

/* ─────────────────────────── 探针 ─────────────────────────── */

/**
 * 在某个提交上跑判据。
 * result: good（判据通过，健康）| bad（判据失败，有 bug）| skip（超时/125/checkout 失败）
 * 特别提醒：**超时绝不算 bad**。
 */
async function probeCommit(sha, ctx) {
  const started = Date.now();
  const checkout = await runGit(ctx.repoRoot, ["checkout", "--detach", "--quiet", sha], ctx.gitTimeout);
  if (!checkout.ok) {
    return {
      ref: sha,
      shortSha: shortSha(sha),
      result: "skip",
      code: null,
      ms: Date.now() - started,
      note: `checkout 失败：${tail(checkout.stderr, 200)}`,
      outputTail: "",
    };
  }

  const { file, args } = predicateInvocation(ctx.predicate, ctx.shell);
  const run = await runProcess(file, args, { cwd: ctx.repoRoot, timeout: ctx.timeoutPerStep });

  let result;
  let note = "";
  if (run.spawnError) {
    result = "skip";
    note = `判据无法启动：${tail(run.stderr, 200)}`;
  } else if (run.killed) {
    result = "skip";
    note = `超时 ${ctx.timeoutPerStep}ms（超时不判为"坏"，因为旧提交上依赖/服务缺失是常态）`;
  } else if (run.code === 0) {
    result = "good";
  } else if (run.code === SKIP_EXIT_CODE) {
    result = "skip";
    note = `退出码 ${SKIP_EXIT_CODE}（git bisect 的跳过约定）`;
  } else {
    result = "bad";
  }

  const combined = [run.stdout, run.stderr].filter((s) => String(s).trim() !== "").join("\n");
  return {
    ref: sha,
    shortSha: shortSha(sha),
    result,
    code: run.code,
    ms: Date.now() - started,
    note,
    outputTail: tail(combined, ctx.maxOutputTail),
  };
}

/* ─────────────────────────── 还原 ─────────────────────────── */

async function restoreCheckout(original, repoRoot) {
  if (!original) return { ok: false, note: "没有记录到原始 HEAD" };
  try {
    if (original.branch) {
      const r = await runGit(repoRoot, ["checkout", "--quiet", original.branch], DEFAULTS.gitTimeout);
      if (r.ok) return { ok: true, note: `已切回分支 ${original.branch}` };
      const r2 = await runGit(repoRoot, ["checkout", "--detach", "--quiet", original.head], DEFAULTS.gitTimeout);
      return r2.ok
        ? { ok: true, note: `切回分支失败，已按 sha 还原到 ${shortSha(original.head)}` }
        : { ok: false, note: `还原失败：${tail(r2.stderr, 200)}` };
    }
    const r = await runGit(repoRoot, ["checkout", "--detach", "--quiet", original.head], DEFAULTS.gitTimeout);
    return r.ok
      ? { ok: true, note: `已还原到游离 HEAD ${shortSha(original.head)}` }
      : { ok: false, note: `还原失败：${tail(r.stderr, 200)}` };
  } catch (error) {
    return { ok: false, note: `还原抛错：${String(error).slice(0, 200)}` };
  }
}

/* ─────────────────────────── 结果组装 ─────────────────────────── */

function baseValue(mode, workspace) {
  return {
    schema: SCHEMA_ID,
    mode,
    workspace,
    repoRoot: "",
    predicate: "",
    badRef: "",
    goodRef: "",
    candidateCount: 0,
    result: { status: "invalid-args", confidence: "low", culprit: null, summary: "" },
    probes: [],
    diff: { available: false, truncated: false, filesChanged: 0, insertions: 0, deletions: 0, text: "" },
    state: {
      file: "",
      resume: false,
      resumable: false,
      stepsDone: 0,
      stepsAllowed: 0,
      budgetSpentMs: 0,
      budgetAllowedMs: 0,
      remainingSha: "",
    },
    states: [],
    warnings: [],
    durationMs: 0,
  };
}

function finish(value, status, summary, confidence = "low") {
  value.result = { status, confidence, culprit: value.result?.culprit ?? null, summary };
  return value;
}

async function describeCulprit(repo, sha, subjects, config) {
  const info = subjects.get(sha) ?? {};
  const parentsRaw = await gitText(repo, ["rev-list", "--parents", "-n", "1", sha]);
  const parents = String(parentsRaw ?? "").trim().split(/\s+/).slice(1);
  const numstatRaw = await gitText(repo, ["show", "--numstat", "--format=", sha]);
  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of String(numstatRaw ?? "").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [a, d, ...rest] = line.split("\t");
    const path = toPosix(rest.join("\t").trim());
    if (path === "") continue;
    const adds = Number.parseInt(a, 10);
    const dels = Number.parseInt(d, 10);
    const safeAdds = Number.isFinite(adds) ? adds : 0;
    const safeDels = Number.isFinite(dels) ? dels : 0;
    insertions += safeAdds;
    deletions += safeDels;
    files.push({ path, additions: safeAdds, deletions: safeDels });
  }

  let diffText = "";
  let diffArgs = ["show", "--patch", "--no-color", "--format=", "--unified=3", sha];
  // 合并提交的 `git show` 默认输出是空的（combined diff 默认关闭），
  // 这时退回第一父提交的差异——否则"肇事者是个 merge"会得到一份空 diff，等于没说。
  if (parents.length > 1) diffArgs = ["diff", "--no-color", "--unified=3", `${sha}^1`, sha];
  const diff = await gitText(repo, diffArgs);
  if (diff) diffText = diff;

  const truncated = diffText.length > config.maxDiffChars;
  return {
    culprit: {
      sha,
      shortSha: shortSha(sha),
      subject: String(info.subject ?? ""),
      author: String(info.author ?? ""),
      date: String(info.date ?? ""),
      parent: parents[0] ? shortSha(parents[0]) : "",
      mergeCommit: parents.length > 1,
      files: files.slice(0, 40),
    },
    diff: {
      available: diffText.trim() !== "",
      truncated,
      filesChanged: files.length,
      insertions,
      deletions,
      text: truncated ? `${diffText.slice(0, config.maxDiffChars)}\n…(diff 已截断到 ${config.maxDiffChars} 字符)` : diffText,
    },
  };
}

/* ─────────────────────────── 主流程 ─────────────────────────── */

async function executeCulprit(args, config) {
  const started = Date.now();
  const root = resolve(String(args.root ?? config.workdir ?? process.cwd()));
  const value = baseValue(args.mode === "status" ? "status" : "bisect", root);
  value.state.stepsAllowed = config.maxSteps;
  value.state.budgetAllowedMs = config.totalBudgetMs;
  value.states = listStates(config.stateDir);

  const done = (status, summary, confidence) => {
    value.durationMs = Date.now() - started;
    value.state.budgetSpentMs = value.state.budgetSpentMs || 0;
    return finish(value, status, summary, confidence);
  };

  if (args.mode === "status") {
    return done(
      "status",
      value.states.length === 0
        ? "没有找到任何未完成的回归归因状态。"
        : `发现 ${value.states.length} 份状态（最新的在 ${value.states[value.states.length - 1].file}）。带 resume: true 可接着跑。`,
      "low",
    );
  }

  const predicate = typeof args.predicate === "string" ? args.predicate.trim() : "";
  if (predicate === "") {
    return done("invalid-args", "缺少 predicate：需要一个「有 bug 时退出非零」的命令。", "low");
  }
  value.predicate = predicate;

  /* 1. 前置检查 ------------------------------------------------------------ */
  const toplevel = await gitText(root, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) {
    return done("not-a-repo", `${root} 不是 git 仓库（或 git 不可用）。`, "low");
  }
  const repoRoot = resolve(toplevel);
  value.repoRoot = repoRoot;

  const gitDir = await gitText(repoRoot, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir && existsSync(join(gitDir, "BISECT_LOG"))) {
    return done("bisect-in-progress", "检测到仓库里已有 git bisect 在进行中；先 git bisect reset，别让两边抢工作树。", "low");
  }

  const headSha = await gitText(repoRoot, ["rev-parse", "HEAD"]);
  if (!headSha) return done("not-a-repo", "读不到 HEAD。", "low");
  const branchRaw = await gitText(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const original = { head: headSha, branch: branchRaw && branchRaw.trim() !== "" ? branchRaw.trim() : null };

  if (!config.allowDirty) {
    const status = await runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=no"]);
    if (status.ok && String(status.stdout).trim() !== "") {
      const files = String(status.stdout).trim().split(/\r?\n/).slice(0, 20).map((l) => toPosix(l.slice(3).trim()));
      value.warnings.push(`工作树不干净，拒绝 checkout（会覆盖你的改动）。脏文件：${files.join(", ")}`);
      return done(
        "dirty",
        `工作树有 ${files.length} 个已跟踪文件被修改，先提交或 stash；确实想冒险可以把 config.allowDirty 设为 true。`,
        "low",
      );
    }
  } else {
    value.warnings.push("allowDirty 已开启：checkout 可能因本地改动而失败（失败会记为 skip）。");
  }

  const badSha = await gitText(repoRoot, ["rev-parse", `${args.badRef ?? "HEAD"}^{commit}`]);
  if (!badSha) return done("invalid-args", `badRef ${String(args.badRef ?? "HEAD")} 解析不成一个提交。`, "low");
  value.badRef = `${String(args.badRef ?? "HEAD")} (${shortSha(badSha)})`;

  /* 2. 候选历史 ------------------------------------------------------------ */
  const history = await readHistory(repoRoot, badSha, config);
  if (!history.ok) return done("not-a-repo", `读 git 历史失败：${history.reason}`, "low");
  const tokens = history.entries;
  const subjects = history.subjects;
  value.candidateCount = tokens.length;
  if (tokens.length < 2) {
    return done("no-good-baseline", "坏点的历史里只有 1 个提交，没有可二分的区间；给一个更早的 goodRef 或调大 maxHistoryScan。", "low");
  }
  if (config.firstParent) {
    value.warnings.push("使用 --first-parent 历史：若肇事者位于某个已合并分支内部，肇事点会落在那个 merge commit 上。");
  }

  /* 3. 状态恢复或新建 ------------------------------------------------------ */
  const key = stateKey(repoRoot, predicate, badSha, config.firstParent);
  const stateFile = statePathFor(config.stateDir, key);
  value.state.file = stateFile;
  const resume = args.resume === true;
  value.state.resume = resume;

  const ctx = {
    repoRoot,
    predicate,
    shell: config.shell,
    timeoutPerStep: config.timeoutPerStep,
    gitTimeout: config.gitTimeout,
    maxOutputTail: config.maxOutputTail,
  };

  let lo = null;
  let hi = null;
  let steps = 0;
  let skips = 0;
  let spentMs = 0;
  const probes = [];
  // 同一个数组对象既喂给 record() 也挂在结果上，避免"跑得对但报告是空的"。
  value.probes = probes;
  value.goodRef = "";

  let saved = resume ? loadState(stateFile) : null;
  if (resume && saved && saved.tokens && saved.tokens[0] === badSha && saved.predicate === predicate) {
    lo = Number.isInteger(saved.lo) ? saved.lo : null;
    hi = Number.isInteger(saved.hi) ? saved.hi : null;
    steps = Number(saved.steps ?? 0);
    skips = Number(saved.skips ?? 0);
    spentMs = Number(saved.spentMs ?? 0);
    for (const p of Array.isArray(saved.probes) ? saved.probes : []) probes.push(p);
    if (saved.goodRef) value.goodRef = saved.goodRef;
    value.warnings.push(`已从 ${stateFile} 恢复：已完成 ${steps} 步，区间 [${lo}, ${hi}]。`);
  } else {
    if (resume && saved) value.warnings.push("状态文件与本次判据/坏点不匹配，已忽略并重新开始。");
    const leftover = loadState(stateFile);
    if (leftover && !resume) {
      value.warnings.push(`存在未完成状态 ${stateFile}；本次是全新运行，若想接着跑请带 resume: true。`);
    }
  }

  const persist = () => {
    if (!config.keepState) return;
    saveState(stateFile, {
      version: 1,
      repoRoot,
      predicate,
      badRef: String(args.badRef ?? "HEAD"),
      firstParent: config.firstParent,
      tokens,
      lo,
      hi,
      steps,
      skips,
      spentMs,
      goodRef: value.goodRef,
      probes: probes.map((p) => ({ ref: p.ref, result: p.result, code: p.code, ms: p.ms })),
      original,
      updatedAt: new Date().toISOString(),
    });
  };

  const record = (probe) => {
    probes.push(probe);
    steps += probe.result === "skip" ? 1 : 1;
    spentMs += probe.ms;
    value.state.stepsDone = steps;
    value.state.budgetSpentMs = spentMs;
    persist();
  };

  const budgetLeft = () => config.totalBudgetMs - spentMs;

  try {
    /* 4. 坏点必须真的坏 --------------------------------------------------- */
    if (steps === 0 && config.requireBadAtStart) {
      const first = await probeCommit(badSha, ctx);
      first.note = first.note || "坏点自检";
      record(first);
      if (first.result === "good") {
        return done(
          "not-reproduced",
          `判据在坏点 ${shortSha(badSha)} 上是通过的（退出码 0）——也就是说这里没有可归因的回归，先确认判据写对了。`,
          "high",
        );
      }
      if (first.result === "skip") {
        return done(
          "inconclusive",
          `判据在坏点上被跳过（${first.note || "超时/125"}），无法确立"坏"这一端。`,
          "low",
        );
      }
      lo = 0;
    }

    /* 5. 找好点 ------------------------------------------------------------ */
    if (lo === null) lo = 0;

    if (String(args.goodRef ?? "").trim() !== "") {
      const goodSha = await gitText(repoRoot, ["rev-parse", `${String(args.goodRef).trim()}^{commit}`]);
      if (!goodSha) return done("invalid-args", `goodRef ${String(args.goodRef).trim()} 解析不成一个提交。`, "low");
      const idx = tokens.indexOf(goodSha);
      if (idx < 0) {
        return done(
          "invalid-args",
          `goodRef ${shortSha(goodSha)} 不在坏点的第一父历史里（可能不是祖先，或超出了 ${config.maxHistoryScan} 条扫描上限）。`,
          "low",
        );
      }
      value.goodRef = `${shortSha(goodSha)} (goodRef 指定)`;
      if (idx <= lo) {
        return done("no-good-baseline", `goodRef ${shortSha(goodSha)} 不比坏点更早，区间不成立。`, "low");
      }
      if (steps === 0 || !probes.some((p) => p.ref === goodSha)) {
        const gp = await probeCommit(goodSha, ctx);
        gp.note = gp.note || "goodRef 校验";
        record(gp);
        if (gp.result === "bad") {
          return done("no-good-baseline", `你给的 goodRef ${shortSha(goodSha)} 上判据同样失败——它不是个好点。`, "medium");
        }
        if (gp.result === "skip") {
          value.warnings.push(`goodRef ${shortSha(goodSha)} 被跳过，已按"假定健康"使用——肇事点的判定因此降级。`);
        }
      }
      hi = idx;
    } else if (hi === null) {
      // 指数回退：1,2,4,8…（--first-parent 上越界就取最后一个）
      let probesUsed = 0;
      let cursor = 1;
      let found = false;
      while (probesUsed < config.maxAutoProbes) {
        if (budgetLeft() <= 0) break;
        const idx = Math.min(cursor, tokens.length - 1);
        if (idx <= lo) break;
        const p = await probeCommit(tokens[idx], ctx);
        p.note = p.note || `自动寻好点（第 ${probesUsed + 1} 次，位置 ${idx}）`;
        record(p);
        probesUsed += 1;
        if (p.result === "bad") {
          lo = Math.max(lo, idx);
          if (idx >= tokens.length - 1) break;
          cursor = Math.max(idx + 1, cursor * 2);
          continue;
        }
        if (p.result === "good") {
          hi = idx;
          found = true;
          value.goodRef = `${shortSha(tokens[idx])} (自动探测，位置 ${idx})`;
          break;
        }
        // skip：位置不可用，继续往更早找
        if (idx >= tokens.length - 1) break;
        cursor = Math.max(idx + 1, cursor * 2);
      }
      if (!found && hi === null) {
        return done(
          "no-good-baseline",
          `沿历史往回探了 ${probesUsed} 个点都没找到"判据通过"的提交。可能回归一直存在，或者需要显式传 goodRef／调大 maxHistoryScan（当前 ${config.maxHistoryScan}）。`,
          "low",
        );
      }
    }

    /* 6. 二分 -------------------------------------------------------------- */
    let exhausted = false;
    while (hi !== null && lo !== null && hi - lo > 1) {
      if (steps >= config.maxSteps) {
        exhausted = true;
        value.warnings.push(`达到 maxSteps=${config.maxSteps}，区间还剩 ${hi - lo - 1} 个提交未判定。`);
        break;
      }
      if (budgetLeft() <= 0) {
        exhausted = true;
        value.warnings.push(`达到总预算 ${config.totalBudgetMs}ms，区间还剩 ${hi - lo - 1} 个提交未判定。`);
        break;
      }
      const mid = lo + Math.floor((hi - lo) / 2);
      const p = await probeCommit(tokens[mid], ctx);
      p.note = p.note || `二分（区间 ${lo}–${hi}）`;
      record(p);

      if (p.result === "bad") {
        lo = mid;
        continue;
      }
      if (p.result === "good") {
        hi = mid;
        continue;
      }
      // skip：不装懂。先记一次，再试着用相邻可判定点把区间推窄；推不动就认输。
      skips += 1;
      value.warnings.push(`${shortSha(tokens[mid])} 被跳过（${p.note || "超时/125"}）。`);
      if (skips > config.skipLimit) {
        return done("inconclusive", `跳过次数超过 ${config.skipLimit} 次，区间无法收敛。`, "low");
      }
      const alt = mid + 1 < hi ? mid + 1 : mid - 1 > lo ? mid - 1 : null;
      if (alt === null) {
        return done("inconclusive", `区间只剩 ${hi - lo} 个提交且其中点在跳过，无法收敛。`, "low");
      }
      const p2 = await probeCommit(tokens[alt], ctx);
      p2.note = p2.note || `跳过后的替代点（位置 ${alt}）`;
      record(p2);
      if (p2.result === "bad") lo = alt;
      else if (p2.result === "good") hi = alt;
      else return done("inconclusive", `跳过后的替代点也无法判定，区间无法收敛。`, "low");
    }

    if (hi === null || lo === null) {
      return done("no-good-baseline", "没能建立起 [坏, 好] 区间。", "low");
    }

    if (exhausted) {
      // 没收敛就**不认领**肇事者：宁可说"还不知道"，也不能让调用方把一个
      // 只是"当前最像"的提交当成结论用——那正是这个工具存在的意义所在。
      const provisional = await describeCulprit(repoRoot, tokens[lo], subjects, config);
      value.result.culprit = null;
      value.diff = { available: false, truncated: false, filesChanged: 0, insertions: 0, deletions: 0, text: "" };
      value.state.remainingSha = tokens[hi];
      value.state.resumable = config.keepState;
      persist();
      return done(
        "budget-exhausted",
        `预算用尽，还没收敛到单个提交。当前区间 [${shortSha(tokens[lo])} 坏, ${shortSha(tokens[hi])} 好] 已落盘；` +
          `区间下界 ${shortSha(tokens[lo])}「${provisional.culprit.subject}」目前最像，但未经判定。` +
          "带 resume: true 再调一次可接着跑，不用重来。",
        "low",
      );
    }

    const culpritSha = tokens[lo];
    const described = await describeCulprit(repoRoot, culpritSha, subjects, config);
    value.result.culprit = described.culprit;
    value.diff = described.diff;
    value.state.remainingSha = "";

    const confidence = skips === 0 ? "high" : "medium";
    if (config.keepState) {
      try {
        rmSync(stateFile, { force: true });
      } catch {
        /* 删不掉也无所谓 */
      }
    }
    return done(
      "found",
      `肇事提交 ${shortSha(culpritSha)}「${described.culprit.subject}」：它上面判据失败，它的前一个提交上判据通过。`,
      confidence,
    );
  } finally {
    // 无论怎么退出，都把工作树还给用户。
    const restored = await restoreCheckout(original, repoRoot);
    if (!restored.ok) value.warnings.push(`工作树还原异常：${restored.note}`);
    else if (config.allowDirty) value.warnings.push(restored.note);
    value.durationMs = Date.now() - started;
  }
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

function renderReport(value) {
  const lines = [];
  const statusLabel = {
    found: "找到肇事提交",
    "not-reproduced": "未复现",
    "no-good-baseline": "缺少健康基线",
    "budget-exhausted": "预算用尽（可续跑）",
    inconclusive: "无法收敛",
    dirty: "工作树不干净",
    "not-a-repo": "不是 git 仓库",
    "bisect-in-progress": "已有 bisect 在进行",
    "invalid-args": "参数不对",
    status: "状态",
  }[value.result.status] ?? value.result.status;

  lines.push(`回归归因 · ${statusLabel} · 工作区 ${value.repoRoot || value.workspace}`);
  lines.push(`判据 ${value.predicate || "(未提供)"}`);
  lines.push(
    `坏点 ${value.badRef || "(未知)"} · 好点 ${value.goodRef || "(未确立)"} · 候选历史 ${value.candidateCount} 个提交`,
  );
  lines.push(value.result.summary);

  const c = value.result.culprit;
  if (c) {
    lines.push("");
    lines.push(`肇事提交 ${c.shortSha}  ${c.subject}`);
    lines.push(`  作者 ${c.author || "?"} · 日期 ${c.date || "?"} · 父提交 ${c.parent || "?"}${c.mergeCommit ? " · 这是 merge commit" : ""}`);
    if (c.files.length > 0) {
      lines.push(`  改了 ${c.files.length} 个文件：+${value.diff.insertions} −${value.diff.deletions}`);
      for (const f of c.files.slice(0, 12)) lines.push(`    ${f.path}  +${f.additions} −${f.deletions}`);
      if (c.files.length > 12) lines.push(`    …还有 ${c.files.length - 12} 个`);
    }
  }

  if (value.probes.length > 0) {
    lines.push("");
    lines.push("探测轨迹（good=判据通过 / bad=判据失败 / skip=跳过）：");
    value.probes.slice(0, DEFAULTS.maxProbeListed).forEach((p, i) => {
      const code = p.code === null || p.code === undefined ? "-" : String(p.code);
      const why = p.note ? `  ${p.note}` : "";
      lines.push(`  ${i + 1}. ${p.shortSha}  ${p.result}  exit=${code}  ${Math.round(p.ms)}ms${why}`);
    });
    if (value.probes.length > DEFAULTS.maxProbeListed) {
      lines.push(`  …还有 ${value.probes.length - DEFAULTS.maxProbeListed} 步`);
    }
  }

  if (value.diff.available) {
    lines.push("");
    lines.push(`diff${value.diff.truncated ? "（已截断）" : ""}：`);
    for (const line of value.diff.text.split(/\r?\n/).slice(0, 200)) lines.push(`  ${line}`);
  }

  if (value.mode === "status" && value.states.length > 0) {
    lines.push("");
    lines.push("未完成状态：");
    for (const s of value.states) {
      lines.push(`  ${s.file}`);
      lines.push(`    工作区 ${s.repoRoot} · 判据 ${s.predicate} · ${s.steps} 步 · 区间 ${s.loSha || "?"}–${s.hiSha || "?"}`);
    }
  }

  if (value.warnings.length > 0) {
    lines.push("");
    lines.push("警告：");
    for (const w of value.warnings) lines.push(`  · ${w}`);
  }

  lines.push("");
  lines.push(
    `步数 ${value.state.stepsDone}/${value.state.stepsAllowed} · 预算 ${Math.round(value.state.budgetSpentMs / 1000)}s/${Math.round(
      value.state.budgetAllowedMs / 1000,
    )}s · 总耗时 ${Math.round(value.durationMs / 1000)}s · 置信度 ${value.result.confidence}`,
  );
  return lines.join("\n");
}

/* ─────────────────────────── 工具定义 ─────────────────────────── */

/**
 * 普通对象形式的工具定义：不 import defineTool，避免 MODULE_NOT_FOUND。
 */
function buildTool(config) {
  const parameters = {
    type: "object",
    additionalProperties: false,
    // predicate 是主参数，必填。status 模式不需要真的判据——传空字符串即可：
    // `required` 只要求这个属性**出现**，而代码在 status 分支提前返回，根本不看它。
    required: ["predicate"],
    properties: {
      predicate: {
        type: "string",
        description:
          "判据命令，**退出码 0 = 健康，非零 = 有问题**（就是 git bisect run 的语义）。" +
          "例：「npm test -- src/user.test.js」「node check.mjs」。" +
          "退出码 125 或超时会被当作「跳过」而不是「坏」。务必先自己跑一遍，确认它在坏点上真的失败。",
      },
      goodRef: {
        type: "string",
        description: "已知健康的提交/tag。给了就跳过自动寻点，速度最快、结果最可信。",
      },
      badRef: {
        type: "string",
        description: "已知有问题的提交，默认 HEAD。",
      },
      mode: {
        type: "string",
        enum: ["bisect", "status"],
        description: "bisect（默认）跑归因；status 只列未完成的状态文件、不碰工作树（此时 predicate 会被忽略，传空字符串即可）。",
      },
      resume: {
        type: "boolean",
        description: "带 true 接着上次未跑完的区间跑（结果里出现 budget-exhausted 时用它）。",
      },
      root: {
        type: "string",
        description: "仓库里的任意路径（或工作区绝对路径），默认当前会话工作目录。",
      },
      maxSteps: {
        type: "integer",
        description: `最多探测多少个提交，默认 ${DEFAULTS.maxSteps}（上限 40）。`,
      },
      timeoutPerStep: {
        type: "integer",
        description: `单次判据超时，毫秒，默认 ${DEFAULTS.timeoutPerStep}。超时记为跳过。`,
      },
      totalBudgetMs: {
        type: "integer",
        description: `整个调用的时间预算，毫秒，默认 ${DEFAULTS.totalBudgetMs}。用尽会带着可续跑的区间返回。`,
      },
    },
  };

  const output = {
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "schema", "mode", "workspace", "repoRoot", "predicate", "badRef",
        "goodRef", "candidateCount", "result", "probes", "diff", "state", "states", "warnings", "durationMs",
      ],
      properties: {
        schema: { type: "string" },
        mode: { type: "string", enum: ["bisect", "status"] },
        workspace: { type: "string" },
        repoRoot: { type: "string" },
        predicate: { type: "string" },
        badRef: { type: "string" },
        goodRef: { type: "string" },
        candidateCount: { type: "integer" },
        result: {
          type: "object",
          additionalProperties: false,
          required: ["status", "confidence", "summary", "culprit"],
          properties: {
            status: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            summary: { type: "string" },
            culprit: {
              oneOf: [
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "sha", "shortSha", "subject", "author",
                    "date", "parent", "mergeCommit", "files",
                  ],
                  properties: {
                    sha: { type: "string" },
                    shortSha: { type: "string" },
                    subject: { type: "string" },
                    author: { type: "string" },
                    date: { type: "string" },
                    parent: { type: "string" },
                    mergeCommit: { type: "boolean" },
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: ["path", "additions", "deletions"],
                        properties: {
                          path: { type: "string" },
                          additions: { type: "integer" },
                          deletions: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              ],
              description: "肇事提交；没收敛时是 null（没跑完不认领）。",
            },
          },
        },
        probes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["ref", "shortSha", "result", "code", "ms", "note", "outputTail"],
            properties: {
              ref: { type: "string" },
              shortSha: { type: "string" },
              result: { type: "string", enum: ["good", "bad", "skip"] },
              code: { oneOf: [{ type: "integer" }, { type: "null" }] },
              ms: { type: "integer" },
              note: { type: "string" },
              outputTail: { type: "string" },
            },
          },
        },
        diff: {
          type: "object",
          additionalProperties: false,
          required: ["available", "truncated", "filesChanged", "insertions", "deletions", "text"],
          properties: {
            available: { type: "boolean" },
            truncated: { type: "boolean" },
            filesChanged: { type: "integer" },
            insertions: { type: "integer" },
            deletions: { type: "integer" },
            text: { type: "string" },
          },
        },
        state: {
          type: "object",
          additionalProperties: false,
          required: [
            "file", "resume", "resumable", "stepsDone", "stepsAllowed",
            "budgetSpentMs", "budgetAllowedMs", "remainingSha",
          ],
          properties: {
            file: { type: "string" },
            resume: { type: "boolean" },
            resumable: { type: "boolean" },
            stepsDone: { type: "integer" },
            stepsAllowed: { type: "integer" },
            budgetSpentMs: { type: "integer" },
            budgetAllowedMs: { type: "integer" },
            remainingSha: { type: "string" },
          },
        },
        states: {
          type: "array",
          description: "磁盘上还没跑完、可以用 resume: true 接着跑的状态文件。",
          items: {
            type: "object",
            required: [
              "key", "file", "repoRoot", "predicate", "badRef", "steps",
              "probes", "loSha", "hiSha", "spentMs", "updatedAt",
            ],
            properties: {
              key: { type: "string" },
              file: { type: "string" },
              repoRoot: { type: "string" },
              predicate: { type: "string" },
              badRef: { type: "string" },
              steps: { type: "integer" },
              probes: { type: "integer" },
              loSha: { type: "string" },
              hiSha: { type: "string" },
              spentMs: { type: "integer" },
              updatedAt: { type: "string" },
            },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
        durationMs: { type: "integer" },
      },
    },
    render: (_args, value) => [{ type: "text", text: renderReport(value) }],
  };

  return {
    name: TOOL_NAME,
    description:
      "Find the commit that BROKE something, by running a predicate that fails when the bug is present. " +
      "Give `predicate` (exit 0 = healthy, non-zero = buggy — same semantics as `git bisect run`) and get back the culprit commit, " +
      "its diff, the probe trajectory, and per-step evidence. Uses --first-parent history, treats timeouts and exit code 125 as SKIP " +
      "(never as 'bad'), persists progress so a budget-exhausted run continues with `resume: true`, and always restores the original " +
      "checkout. Refuses to run on a dirty working tree or while a `git bisect` is already in progress. " +
      "「这段代码是哪次提交改挂的」：给一条「有 bug 就退出非零」的判据，自动二分出肇事提交并附上 diff 与每一步证据。",
    parameters,
    output,
    // 会 checkout 工作树，所以绝不能并发跑。
    isConcurrencySafe: () => false,
    execute: (args, exec) => {
      const workdir = config.workdir ?? exec?.agent?.session?.header?.cwd ?? process.cwd();
      return executeCulprit(args, { ...config, workdir });
    },
  };
}

/* ─────────────────────────── 接入 ─────────────────────────── */

let logger = null;

function loggerFor(ctx) {
  try {
    const candidate = ctx?.logger;
    if (typeof candidate === "function") return candidate(PACKAGE_ID) ?? console;
    if (candidate && typeof candidate.info === "function") return candidate;
  } catch {
    /* 落到 console */
  }
  return console;
}

function say(level, message) {
  const line = `[${PACKAGE_ID}] ${message}`;
  try {
    const sink = logger ?? console;
    if (typeof sink[level] === "function") sink[level](line);
    else if (typeof sink.log === "function") sink.log(line);
  } catch {
    try {
      console.log(line);
    } catch {
      /* 放弃 */
    }
  }
}

/** 只声明 tools —— 它由 @deepseek-ai/dsh-tools 提供，是本插件唯一的硬依赖。 */
export const inject = ["tools"];

export function apply(ctx, config) {
  try {
    setup(ctx, config ?? {});
  } catch (error) {
    try {
      console.error(`[${PACKAGE_ID}] 初始化失败，已跳过（不影响其它功能）：${String(error)}`);
    } catch {
      /* ignore */
    }
  }
}

function setup(ctx, config) {
  logger = loggerFor(ctx);
  const resolved = {
    workdir: config.workdir ?? process.cwd(),
    maxHistoryScan: clampNumber(config.maxHistoryScan, DEFAULTS.maxHistoryScan, 10, 100_000),
    maxSteps: clampNumber(config.maxSteps, DEFAULTS.maxSteps, 1, 40),
    maxAutoProbes: clampNumber(config.maxAutoProbes, DEFAULTS.maxAutoProbes, 1, 30),
    skipLimit: clampNumber(config.skipLimit, DEFAULTS.skipLimit, 0, 10),
    timeoutPerStep: clampNumber(config.timeoutPerStep, DEFAULTS.timeoutPerStep, 1000, 1_800_000),
    totalBudgetMs: clampNumber(config.totalBudgetMs, DEFAULTS.totalBudgetMs, 5000, 3_600_000),
    maxOutputTail: clampNumber(config.maxOutputTail, DEFAULTS.maxOutputTail, 200, 20_000),
    maxDiffChars: clampNumber(config.maxDiffChars, DEFAULTS.maxDiffChars, 500, 200_000),
    stateDir: typeof config.stateDir === "string" && config.stateDir.trim() !== "" ? config.stateDir : DEFAULTS.stateDir,
    allowDirty: config.allowDirty === true,
    shell: typeof config.shell === "string" && config.shell.trim() !== "" ? config.shell.trim() : null,
    firstParent: config.firstParent !== false,
    requireBadAtStart: config.requireBadAtStart !== false,
    keepState: config.keepState !== false,
    gitTimeout: clampNumber(config.gitTimeout, DEFAULTS.gitTimeout, 2000, 600_000),
  };

  const tool = buildTool(resolved);
  ctx.effect(() => {
    const dispose = ctx.tools.register(tool);
    say("info", `已注册工具 ${TOOL_NAME}（默认工作区 ${resolved.workdir}，状态目录 ${resolved.stateDir}）`);
    return () => {
      try {
        dispose();
      } catch {
        /* 卸载异常不冒泡 */
      }
    };
  }, "culprit: register regression_culprit tool");
}

// 供测试直接调用内部实现（不注册到宿主）。
export const __internal = {
  DEFAULTS,
  SKIP_EXIT_CODE,
  clampNumber,
  shortSha,
  tail,
  runProcess,
  predicateInvocation,
  stateKey,
  statePathFor,
  loadState,
  saveState,
  listStates,
  parseLog,
  readHistory,
  probeCommit,
  restoreCheckout,
  describeCulprit,
  executeCulprit,
  buildTool,
  renderReport,
  /** 注入一个假的 git 实现；传 null 恢复真实调用。 */
  setGitRunner(runner) {
    GIT_RUNNER = typeof runner === "function" ? runner : null;
  },
};
