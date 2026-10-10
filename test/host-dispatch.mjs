#!/usr/bin/env node
/**
 * test/host-dispatch.mjs — 把插件挂到**真的 cordis 上下文**和**真的 dsh-tools 服务**上，
 * 确认宿主那套 register()/校验/取值链路吃它，然后**走宿主真正的派发路径**跑一次归因。
 *
 * 为什么需要它：插件自己的单元测试全是"直接调内部函数"，而宿主加载插件的真实路径
 * （register 时的 schema 校验 → 派发时的取值校验 → render 投影）一条都没覆盖。
 * 这个文件当初就抓出过两个真实故障：
 *   · output.schema 用了 defineTool 的 spec 写法（属性级 `required: true`），
 *     register() 里宿主会整份拒绝，而 apply() 的兜底 try/catch 把异常吞了 ——
 *     「装好了、日志干净、但工具根本不存在」；
 *   · 可空字段（`culprit`、`probes[].code`）只声明了一个类型，
 *     注册过了也还有第二道坎：宿主派发成功后拿 output.schema 校验返回值，不合规抛 ToolOutputError。
 *
 * 为什么必须走 `app.tools.execute()` 而不是 `definition.execute()`：
 *   ToolRuntime.get(name) 返回的是**原始定义**，直接调它的 execute 会跳过
 *   createSuccessResult() 里的取值校验与 render 投影。旧版脚本正是这么写的，"验过了"是假的。
 *
 * 它**不启动整棵 profile**（不碰端口、不碰会话存储），所以对正在运行的应用是安全的；
 * 插件从 **profile 的 node_modules**（也就是安装后的位置）加载，而不是仓库路径 ——
 * 这样"测试通过"才等价于"用户那份安装真的能用"。
 *
 * 用法（需要宿主 runtime，也就是 DSH 桌面版自带的依赖树）：
 *
 *   node test/host-dispatch.mjs
 *   DSH_HOST_RUNTIME="C:/.../dsh/node_modules/" DSH_PROFILE_NM="C:/Users/me/.dsh/profiles/desktop/node_modules/" \
 *     node test/host-dispatch.mjs
 *
 * 退出码：0 = 全过；1 = 有失败；2 = 找不到宿主 runtime（跳过，不算通过）。
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUNTIME = process.env.DSH_HOST_RUNTIME ?? "C:/Users/ca/AppData/Local/Temp/dsh-cli/dsh/node_modules/";
const PROFILE_NM = process.env.DSH_PROFILE_NM ?? "C:/Users/ca/.dsh/profiles/desktop/node_modules/";
const PACKAGE_ID = "dsh-culprit";
const TOOL_NAME = "regression_culprit";

for (const [label, dir] of [["宿主 runtime", RUNTIME], ["profile node_modules", PROFILE_NM]]) {
  if (!existsSync(dir)) {
    console.log(`SKIP: 找不到${label} —— ${dir}`);
    console.log("      设一下 DSH_HOST_RUNTIME / DSH_PROFILE_NM 再跑；这一项没跑，不算通过。");
    process.exit(2);
  }
}

const require = createRequire(`${RUNTIME}noop.js`);
const load = async (spec) => import(pathToFileURL(require.resolve(spec)).href);

const ok = [];
const bad = [];
const check = (name, condition, detail) => {
  if (condition) ok.push(name);
  else bad.push(detail ? `${name} — ${detail}` : name);
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${name}${!condition && detail ? ` -- ${detail}` : ""}`);
};

console.log("1) 从宿主 runtime 装载真服务");
const { Context } = await load("@deepseek-ai/cordis");
const { default: SystemPrompt } = await load("@deepseek-ai/dsh-system-prompt");
const toolsPkg = await load("@deepseek-ai/dsh-tools");
const { default: ToolRuntime, assertSupportedJsonSchema, jsonSchemaToTs, validateJsonSchemaValue } = toolsPkg;
console.log(`   cordis / systemPrompt / tools 都从 ${RUNTIME} 装载`);

console.log("2) 起一个真 cordis 上下文，装上 systemPrompt + tools");
const app = new Context();
async function mount(plugin, config) {
  const fork = app.plugin(plugin, config);
  if (fork && typeof fork.await === "function") await fork.await();
  else await new Promise((resolve) => setTimeout(resolve, 50));
  return fork;
}
await mount(SystemPrompt);
await mount(ToolRuntime);
check("ctx.tools 服务就绪", app.tools !== undefined && typeof app.tools.register === "function");

console.log("3) 从 profile 的 node_modules（安装后的位置）加载插件并 apply()");
const mod = await import(`${pathToFileURL(join(PROFILE_NM, PACKAGE_ID, "index.mjs")).href}`);
const plugin = mod.default ?? mod;
check("插件有 apply()", typeof plugin.apply === "function");
// apply() 内部有兜底 try/catch（apply 同步抛错 = 插件加载失败），出问题只会静默跳过，
// 所以"没抛错"什么都不能证明 —— 必须显式确认工具真的注册上了。
await mount(plugin);
check(`${TOOL_NAME} 已注册进真 tools 服务`, app.tools.get(TOOL_NAME) !== undefined);

const definition = app.tools.get(TOOL_NAME);
if (definition === undefined) {
  console.log(`\n插件没注册工具，后面没法继续。通过 ${ok.length} / 失败 ${bad.length}`);
  process.exit(1);
}

// 曾经的失败点：register() 会跑 assertSupportedJsonSchema，它只认标准 JSON Schema 子集。
// 属性上挂 `required: true`（defineTool 的 spec 写法）会被整份拒绝，而 apply() 把异常吞了。
try {
  assertSupportedJsonSchema(definition.output.schema);
  check("宿主 assertSupportedJsonSchema 接受 output.schema", true);
} catch (error) {
  check("宿主 assertSupportedJsonSchema 接受 output.schema", false, String(error?.message ?? error).slice(0, 400));
}

// register() 只校验 output.schema，**不校验 parameters**；而且手写的工具定义拿不到宿主的参数校验
// （那层校验只在 defineTool 生成的 execute 包装里）。parameters 只用于给模型渲染类型，
// 所以这里退一步：至少确认宿主能把它渲染出来。
try {
  const renderedTs = jsonSchemaToTs(definition.parameters);
  check("宿主 jsonSchemaToTs 能渲染 parameters", typeof renderedTs === "string" && renderedTs.length > 0);
} catch (error) {
  check("宿主 jsonSchemaToTs 能渲染 parameters", false, String(error?.message ?? error).slice(0, 300));
}

check("工具定义带 output.render", typeof definition?.output?.render === "function");
check("parameters 是 object 且拒绝未知字段", definition?.parameters?.type === "object" && definition.parameters.additionalProperties === false);

console.log("4) 造一个 4 提交、bug 在第 3 个的仓库");
const root = mkdtempSync(join(tmpdir(), "culprit-host-"));
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
git("init", "-q");
git("config", "user.name", "Host Dispatch Check");
git("config", "user.email", "verify@example.invalid");
git("config", "commit.gpgsign", "false");
git("config", "core.autocrlf", "false");

writeFileSync(join(root, "calc.mjs"), "export const clamp = (v, max) => (v > max ? max : v);\n");
writeFileSync(join(root, "calc.test.mjs"), [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { clamp } from "./calc.mjs";',
  'test("clamp", () => { assert.equal(clamp(9, 5), 5); assert.equal(clamp(3, 5), 3); });',
  "",
].join("\n"));
git("add", "-A");
git("commit", "-q", "-m", "feat: 初始 clamp");

writeFileSync(join(root, "notes.txt"), "one\n");
git("add", "-A");
git("commit", "-q", "-m", "docs: 加个说明");

// 第 3 个提交：引入 bug
writeFileSync(join(root, "calc.mjs"), "export const clamp = (v, max) => (v >= max ? max - 1 : v);\n");
git("add", "-A");
git("commit", "-q", "-m", "refactor: 整理边界判断");
const culpritSha = git("rev-parse", "--short", "HEAD").trim();

// 第 4 个提交：无关改动，把 bug 埋深一点
writeFileSync(join(root, "notes.txt"), "one\ntwo\n");
git("add", "-A");
git("commit", "-q", "-m", "docs: 再补一行");

console.log("5) 走宿主真正的派发路径 execute()（含取值校验 + render 投影）");
let seq = 0;
const dispatch = (args) =>
  app.tools.execute({
    callId: `host-dispatch-${++seq}`,
    name: TOOL_NAME,
    arguments: args,
    signal: new AbortController().signal,
  });

const result = await dispatch({
  predicate: "node --test calc.test.mjs",
  root,
  maxSteps: 12,
  timeoutPerStep: 60000,
  totalBudgetMs: 120000,
});

check("派发成功（没有 ToolOutputError / render 抛错）", result?.isError === false, JSON.stringify(result?.error?.message ?? "").slice(0, 400));
const value = result?.value;
check("返回值是真对象", value !== null && typeof value === "object");
check(
  "返回值对 output.schema 零违规",
  (() => {
    try {
      return validateJsonSchemaValue(definition.output.schema, JSON.parse(JSON.stringify(value)), "value").length === 0;
    } catch {
      return false;
    }
  })(),
  (() => {
    try {
      return JSON.stringify(validateJsonSchemaValue(definition.output.schema, JSON.parse(JSON.stringify(value)), "value")).slice(0, 400);
    } catch (error) {
      return String(error?.message ?? error).slice(0, 400);
    }
  })(),
);

check(`result.status = found（实际 ${value?.result?.status}）`, value?.result?.status === "found", JSON.stringify(value?.result?.summary ?? "").slice(0, 300));
check(`指认的肇事提交 == ${culpritSha}`, value?.result?.culprit?.sha?.startsWith(culpritSha), `实际 ${value?.result?.culprit?.sha}`);
check("culprit 满足「已收敛」形状（8 个字段）", Object.keys(value?.result?.culprit ?? {}).length === 8, Object.keys(value?.result?.culprit ?? {}).join(","));
check("探测轨迹非空", Array.isArray(value?.probes) && value.probes.length > 0, `probes=${value?.probes?.length}`);
check("给了 diff", typeof value?.diff?.text === "string" && value.diff.text.includes("clamp"));
check("render 投影产出了文本块", Array.isArray(result?.content) && typeof result.content[0]?.text === "string" && result.content[0].text.length > 0);
check(
  "render 文本里点到了肇事提交",
  typeof result?.content?.[0]?.text === "string" && result.content[0].text.includes(culpritSha),
  String(result?.content?.[0]?.text ?? "").split("\n").slice(0, 3).join(" / ").slice(0, 300),
);
check("工作树无残留改动", git("status", "--porcelain").trim() === "", git("status", "--porcelain").trim().slice(0, 200));

console.log("6) 边界：没给 predicate 应该是 invalid-args，而不是崩或抛错");
const noPredicate = await dispatch({ root });
check("没给 predicate 不报错", noPredicate?.isError === false, JSON.stringify(noPredicate?.error?.message ?? "").slice(0, 300));
check(`没给 predicate → invalid-args（实际 ${noPredicate?.value?.result?.status}）`, noPredicate?.value?.result?.status === "invalid-args");
check("invalid-args 时 culprit 是 null（没跑完不认领）", noPredicate?.value?.result?.culprit === null);
check("invalid-args 时 render 仍产出文本", Array.isArray(noPredicate?.content) && noPredicate.content[0]?.text?.length > 0);

console.log("7) 边界：mode=status 只列状态、不碰工作树");
const statusMode = await dispatch({ mode: "status", root });
check("mode=status 不报错", statusMode?.isError === false, JSON.stringify(statusMode?.error?.message ?? "").slice(0, 300));
check(`mode=status 回的是 status（实际 ${statusMode?.value?.mode}）`, statusMode?.value?.mode === "status");
check("mode=status 的 states 是数组", Array.isArray(statusMode?.value?.states));
check("mode=status 时工作树干净", git("status", "--porcelain").trim() === "", git("status", "--porcelain").trim().slice(0, 200));

rmSync(root, { recursive: true, force: true });

console.log("");
console.log(`通过 ${ok.length} / 失败 ${bad.length}`);
if (bad.length) {
  for (const b of bad) console.log(`  FAIL  ${b}`);
  process.exit(1);
}
console.log("RESULT: dsh-culprit 在宿主真服务上注册成功，并且走宿主真正的派发路径跑出了正确的归因。");
