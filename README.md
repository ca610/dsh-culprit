# dsh-culprit · 回归归因

> 「这段代码是哪次提交改挂的？」

给一条**有 bug 就退出非零**的命令，dsh-culprit 在仓库历史里二分，直接告诉你肇事提交是哪一个，
并附上它的 diff、改了哪些文件、以及每一步的判定证据。

它不是"再跑一遍测试"，是**把测试变红这件事本身当成一个可以追溯的事实**。

---

## 为什么需要它

生态里的最近邻是 [`slow-stack/euthyna`](https://github.com/slow-stack/euthyna)：它能按行/按历史回答
"这一行是谁引进的"（`--origins`），那是**历史归因**——它读历史，不执行任何东西。

dsh-culprit 回答的是另一个问题：**"从哪个提交开始，这个行为坏了？"**
它必须真的在那些提交上把命令跑一遍。历史归因猜不到"这一版依赖装不上"、
"这个 commit 的测试超时"、"这个改动只在运行时才炸"。

代价是它**会 checkout 你的工作树**，所以这个插件在工程上有一半的力气都花在
"怎么才能不伤到你"上（见下面的[安全保证](#安全保证)）。

---

## 安装

**常规路径**（用户自管 profile）——由 agent 调用插件管理器：

```
plugin_manager(action: "install_bundle", target: "C:\\path\\to\\dsh-culprit")
```

装完需要重启 profile，宿主才会加载新的 JS。卸载用 `remove_bundle`。

**Windows 桌面版**要绕一下：`desktop` profile 由 Electron 应用独占管理，
`dsh plugin --profile desktop add` 会被 `rejectElectronProfile()` 直接拒掉
（理由就是 "managed exclusively by the Electron application"）。手接三样东西即可，
这也是本插件在 Windows 上**实际验证过**的装法：

1. `<profile>/node_modules/<包名>` 目录 junction（`cmd /c mklink /J`）指向仓库路径 ——
   指向仓库而不是复制，改完 JS 只要重启、不必重装；
2. profile 的 `package.json` 里 `dependencies.<包名> = "link:<仓库绝对路径>"`；
3. 同一个 `dsh.profile.bundles` 数组里**追加** `<包名>`——**这一步才是让加载器去读插件自己的
   `cordis.patch.yml` 的开关**，漏了它前两步都白做。

改 profile 的 `package.json` 之前先备份；`bundles` 追加到末尾（宿主自己的 `reconcile()`
也是 `if (!bundles.includes(name)) bundles.push(name)`）。

装完**必须重启 DSH**：插件只在启动时加载，没有热更。

### 怎么确认它真的装上了

"装成功"是最容易骗人的一件事。宿主的 `register()` 会做 schema 校验，而它的异常被
`apply()` 的兜底 try/catch 吞掉了——表现是**日志干净、插件列表里也有、但工具根本不存在**。
所以别信日志，去问宿主：

```
node test/host-dispatch.mjs
```

它起一个真的 cordis 上下文 + 真的 `dsh-tools` 服务，**从 profile 的 node_modules 加载插件**
（也就是安装后的那一份），走 `app.tools.execute()` 真正派发一次归因，
并断言返回值对 `output.schema` 零违规、render 真的在真值上跑过、工作树被还回去了。
找不到宿主 runtime 时它**以退出码 2 明确跳过——跳过不算通过**。

---

## 用法

```
regression_culprit(predicate: "npm test -- src/clamp.test.js")
```

就这一个必填参数。它会自己找到健康的那个提交、自己二分、自己把工作树还回去。

带已知的好点最快也最准：

```
regression_culprit(predicate: "node --test calc.test.mjs", goodRef: "v2.1.0")
```

### 判据怎么写

判据就是一条**在 bug 存在时退出非零**的命令，跟 `git bisect run` 完全同一套语义：

| 退出码 | 含义 |
| --- | --- |
| `0` | 健康，这个提交没问题 |
| 非零 | 有问题，bug 在这个提交上存在 |
| `125` | **跳过**（git bisect 的约定）——这个提交判定不了，不算好也不算坏 |
| 超时 | **跳过**——同上 |

**超时绝不算"坏"**，这一条是刻意的：往历史深处走，依赖没装、服务起不来、
数据库连不上都是常态。把这类失败读成"bug 在这里"，会把你精准地指向一个无关的提交——
比报错还糟糕，因为它看起来很确定。

跑之前最好自己先执行一遍，确认它**在当前 HEAD 上真的是红的**。如果它在 HEAD 上是绿的，
工具会直接告诉你是 `not-reproduced`，而不是硬凑一个答案给你。

### 参数

| 参数 | 说明 |
| --- | --- |
| `predicate` | 必填。判据命令，退出码语义见上。 |
| `goodRef` | 已知健康的提交/tag。给了就跳过自动寻点，最快、最可信。 |
| `badRef` | 已知有问题的提交，默认 `HEAD`。 |
| `root` | 仓库里的任意路径，默认当前会话工作目录。 |
| `mode` | `bisect`（默认）或 `status`（只列未完成的状态，不碰工作树）。 |
| `resume` | 接着上次没跑完的区间继续，不重来。 |
| `maxSteps` | 最多探测多少提交，默认 16（上限 40）。 |
| `timeoutPerStep` | 单次判据超时毫秒，默认 120000。 |
| `totalBudgetMs` | 整个调用的时间预算毫秒，默认 600000。 |

### 返回状态

`found`（找到）· `not-reproduced`（HEAD 上判据是绿的）· `no-good-baseline`（找不到健康基线）·
`budget-exhausted`（预算用尽，可续跑）· `inconclusive`（跳过太多，没收敛）·
`dirty`（工作树不干净，拒绝）· `not-a-repo` · `bisect-in-progress`（仓库里已有 bisect）· `invalid-args`

只有 `found` 会给出 `result.culprit`。**`budget-exhausted` 故意不给**——
没收敛就不认领肇事者，免得你把一个"目前最像"的提交当成结论用。

---

## 安全保证

这个工具会反复 `git checkout --detach`，所以：

1. **工作树不干净就直接拒绝**（`dirty`），一个探针都不跑。你要的是归因，不是丢改动。
2. **仓库里已有 `git bisect` 时拒绝**（`bisect-in-progress`），不和你的交互式 bisect 抢状态。
3. **无论成功、失败还是抛异常，最后一定切回原来的分支/HEAD**——`finally` 里做，
   测试里专门验证了这一点（连"分支名还原"都验）。
4. 只走 `--first-parent` 历史，不会 checkout 到旁支上去。
5. 没有破坏性 git 操作：不用 `reset --hard`，不用 `clean`，不用 `stash`。

## 断点续跑

每探一个提交就落盘一次状态（默认 `%TEMP%\dsh-culprit\<sha1>.json`，键是
`仓库路径 + 判据 + 坏点` 的 sha1）。跑太久被预算掐断时，结果里会带
`state.resumable = true`，再调一次加 `resume: true` 就接着跑，不会从头再来。
收敛之后状态文件会被删掉。

`mode: "status"` 可以列出所有未完成的状态——不碰工作树，纯只读。

---

## 现场演示

`node examples/demo.mjs` 会在临时目录里造一个真的会挂的仓库现场跑一遍
（一个 `clamp(value, max)` 把 `>` 写成 `>=` 的经典边界 bug），跑完打印报告、删掉目录。
下面是它的真实输出：

```
回归归因 · 找到肇事提交
判据 node --test calc.test.mjs
坏点 HEAD (09f35356) · 好点 f5c0abe3 (自动探测，位置 2) · 候选历史 5 个提交
肇事提交 c7b82059「refactor: 整理 clamp 的边界判断」：它上面判据失败，它的前一个提交上判据通过。

肇事提交 c7b82059  refactor: 整理 clamp 的边界判断
  作者 Culprit Demo · 日期 2026-10-10 · 父提交 f5c0abe3
  改了 2 个文件：+3 −1
    CHANGELOG.md  +2 −0
    calc.mjs  +1 −1

探测轨迹（good=判据通过 / bad=判据失败 / skip=跳过）：
  1. 09f35356  bad  exit=1  285ms  坏点自检
  2. c7b82059  bad  exit=1  283ms  自动寻好点（第 1 次，位置 1）
  3. f5c0abe3  good  exit=0  319ms  自动寻好点（第 2 次，位置 2）

diff：
  --- a/calc.mjs
  +++ b/calc.mjs
  @@ -1,5 +1,5 @@
   export function clamp(value, max) {
  -  return value > max ? max : value;
  +  return value >= max ? max - 1 : value;
   }

步数 3/16 · 预算 1s/300s · 总耗时 1s · 置信度 high
```

5 个提交、3 次探测、1 秒收敛。diff 里那两行就是答案——
**只看 diff 很容易划过去**（`>=` 加一个 `-1`），但判据把它钉死了。

---

## 配置

写在 `cordis.patch.yml` 的 `config` 里：

```yaml
- insert:
    - id: culprit
      name: dsh-culprit
      config:
        maxSteps: 24
        timeoutPerStep: 300000
```

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `workdir` | 会话工作目录 | 默认在哪儿找仓库 |
| `maxHistoryScan` | `500` | 最多往回扫多少条历史 |
| `maxSteps` | `16` | 二分最多探多少次（上限 40） |
| `maxAutoProbes` | `8` | 自动寻好点最多探几次 |
| `skipLimit` | `3` | 连续跳过多少次就放弃 |
| `timeoutPerStep` | `120000` | 单次判据超时（毫秒） |
| `totalBudgetMs` | `600000` | 单次调用总预算（毫秒） |
| `stateDir` | `%TEMP%/dsh-culprit` | 续跑状态放哪儿 |
| `allowDirty` | `false` | 允许在脏工作树上跑（不推荐，checkout 可能失败并记为跳过） |
| `shell` | 自动 | `powershell` / `pwsh` / `cmd` / `bash` / `sh` |
| `firstParent` | `true` | 只看第一父历史 |
| `requireBadAtStart` | `true` | 先验证坏点确实坏 |
| `keepState` | `true` | 是否落盘续跑状态 |

---

## 手写工具定义的两个硬约束

本插件**不 import 任何 `@deepseek-ai/*`**（profile 是 link 目录，裸包名解析不到 → `MODULE_NOT_FOUND`），
所以工具定义是普通对象，而不是 `defineTool()` 的 spec 写法。代价是下面两条得自己扛，
它们各埋过一次坑，都有回归测试守着：

1. **`output.schema` 必须是宿主校验器认识的 JSON Schema 子集。**
   合法关键字只有 `type`（**单个字符串**，数组形式不支持）、`oneOf`、`properties`、`required`、
   `additionalProperties`（布尔）、`items`、`enum`、`const`，外加注解类。
   `required` 只能是**字符串数组**，且只能挂在 `type: "object"` 上——`defineTool()` 的 spec 写法
   （每个属性挂 `required: true`）会被 `assertSupportedJsonSchema` **整份拒绝**。
   可空字段必须写成 `oneOf: [{ type: "string" }, { type: "null" }]`：宿主不是只看看 schema，
   它**还会拿 schema 校验真实返回值**（`createSuccessResult`），写窄了会在最常走的那条路径上抛
   `ToolOutputError`。
2. **参数校验得自己来。** `register()` 只校验 `output`；宿主的参数校验只存在于
   `defineTool()` 生成的 execute 包装里。手写定义拿不到那一层，所以本插件的 `parameters`
   只是"给模型看的文档"——`invalid-args` 这类兜底由插件自己在代码里做。

---

## 已知限制

- **只看 `--first-parent` 历史。** 快、确定，但如果肇事者藏在某个已合并分支内部，
  肇事点会落在那个 merge commit 上（结果里会用警告点明这一点）。
- **merge commit 的 diff** 默认拿不到（git 的 combined diff 默认关闭），
  插件会自动退回 `git diff <sha>^1 <sha>`。
- **旧提交上跑不起来的东西会被跳过**，跳太多就是 `inconclusive`——这是诚实的失败，
  不是 bug。给一个更近的 `goodRef` 通常就能收敛。
- **需要 `git` 和能启动子进程的环境。** 沙箱里如果禁止管道 stdio，
  git 拿不到输出，工具会报 `not-a-repo`。

### 一个值得记下来的 Windows 坑

Windows PowerShell **会把任何非零退出码压成 1**：

```
node skip.mjs;                                                  exit=125
powershell -Command "node skip.mjs"                             exit=1     ← 真实码丢了
powershell -Command "node skip.mjs; exit $LASTEXITCODE"         exit=125   ← 只能这么写
```

所以插件在 Windows 上是把判据包成 `... ; exit $LASTEXITCODE` 再执行的
（`cmd` 那条路用 `/v:on` 加 `!ERRORLEVEL!`，因为 `%ERRORLEVEL%` 在解析期就展开了）。
不这么干，"退出码 125 = 跳过"这条约定在 Windows 上直接失效。

---

## 测试

```
node test/culprit.test.mjs      # 108 条断言，不需要宿主
node test/host-dispatch.mjs     # 26 条断言，需要宿主 runtime（见"怎么确认它真的装上了"）
```

第一套全是**真的临时 git 仓库、真的 git、真的子进程**，不用任何测试框架。（`npm test`）重点验证：

- 肇事提交判得对（6 个提交的历史，bug 在第 4 个）；
- **工作树一定被还原**（HEAD、分支名、`git status` 都验）；
- **超时和退出码 125 被当作跳过，绝不被读成"坏"**；
- 脏工作树 / 已有 bisect / 非 git 目录全都拒绝，且不碰工作树；
- 预算用尽 → 落盘 → `resume` 续跑 → 收敛；
- **工具 schema 符合宿主校验器能接受的形状**——一个零依赖的遍历器专门盯六类坏写法
  （布尔型 `required`、非数组 `required`、`required` 挂在非 object 上、`required` 列了未声明的属性、
  非布尔 `additionalProperties`、数组型 `type`），不用连宿主也能守住这个坑；
- 用假 ctx 把 `apply()` 真跑一遍：注册得到工具、`dispose` 摘得掉、
  `ctx` 残缺时也不抛错（`apply` 里同步抛错 = 整个插件加载失败，这条最要命），
  且兜底日志恰好打一条。

第二套（`test/host-dispatch.mjs`）补的正是第一套的结构性盲区：第一套从不经过宿主的
`register()` / 派发 / 取值校验 / render 投影。当初那两个真故障就是它抓出来的
（属性级 `required: true` 导致工具静默不注册；可空字段写窄导致派发时 `ToolOutputError`）。

---

## 结构

```
dsh-culprit/
├─ index.mjs                宿主半边，唯一被加载的文件（不 import 任何 @deepseek-ai/*）
├─ cordis.patch.yml         挂载声明
├─ locale/{zh,en}.json      插件列表里的标题与描述
├─ test/culprit.test.mjs    108 条断言，不依赖宿主
├─ test/host-dispatch.mjs   26 条断言，挂到真宿主服务上跑真派发
├─ examples/demo.mjs        临时造仓库的现场演示
└─ README.md
```

MIT
