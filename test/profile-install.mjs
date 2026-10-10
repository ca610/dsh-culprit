#!/usr/bin/env node
/**
 * test/profile-install.mjs — 不重启 DSH，用**宿主自己的 profile 解析器**确认
 * dsh-culprit 真的进了目标 profile，并且贡献了它的 patch 行。
 *
 * 为什么需要它：加载不成功的 bundle 会被**静默跳过**（进 `skippedBundles`），
 * 表现是"重启后一切正常，只是没有这个工具"。手工装 Windows 桌面版 profile 时要动三处
 * （junction / `dependencies` 的 `link:` / `dsh.profile.bundles`），漏掉任何一处都在这里现形——
 * 尤其是 `dsh.profile.bundles`：**它才是让加载器去读插件自己 `cordis.patch.yml` 的开关**。
 *
 * 它只**读** profile，不启动应用、不碰端口与会话存储，所以对正在运行的应用是安全的。
 *
 * 用法：
 *
 *   node test/profile-install.mjs
 *   DSH_PROFILE=desktop DSH_HOST_RUNTIME="C:/.../dsh/node_modules/" node test/profile-install.mjs
 *
 * 退出码：0 = 全过；1 = 有失败；2 = 环境不齐 / profile 解析不了（跳过，不算通过）。
 */

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const PACKAGE_ID = "dsh-culprit";
const PROFILE_NAME = process.env.DSH_PROFILE ?? "desktop";
const RUNTIME = process.env.DSH_HOST_RUNTIME ?? "C:/Users/ca/AppData/Local/Temp/dsh-cli/dsh/node_modules/";

const bootPath = join(RUNTIME, "@deepseek-ai", "dsh", "lib", "profile-boot.js");
if (!existsSync(bootPath)) {
  console.log(`SKIP: 找不到宿主的 profile 解析器 —— ${bootPath}`);
  console.log("      设一下 DSH_HOST_RUNTIME 指向含 @deepseek-ai/ 的 node_modules 再跑；这一项没跑，不算通过。");
  process.exit(2);
}

const ok = [];
const bad = [];
const check = (name, condition, detail) => {
  if (condition) ok.push(name);
  else bad.push(detail ? `${name} — ${detail}` : name);
  console.log(`  ${condition ? "ok  " : "FAIL"}  ${name}${!condition && detail ? ` -- ${detail}` : ""}`);
};

console.log("1) 装载宿主自己的 profile 解析器");
const { prepareProfile } = await import(pathToFileURL(bootPath).href);
console.log(`   ${bootPath}`);

console.log(`2) 解析 profile「${PROFILE_NAME}」`);
let profile;
try {
  profile = prepareProfile(PROFILE_NAME, true);
} catch (error) {
  console.log(`SKIP: profile「${PROFILE_NAME}」解析不了 —— ${error.message}`);
  process.exit(2);
}
console.log(`   dir     = ${profile.dir}`);
console.log(`   layers  = ${profile.layers.length}`);
console.log(`   patches = ${profile.patches.length} 条（来自 ${profile.patchPath ?? "?"}）`);

const skipped = profile.skippedBundles ?? [];
const skipNames = skipped.map((s) => (typeof s === "string" ? s : s?.name ?? JSON.stringify(s)));
check(`bundle 没有出现在 skippedBundles 里`, !skipNames.includes(PACKAGE_ID), `skipped = ${JSON.stringify(skipped).slice(0, 300)}`);

console.log("3) profile 的清单是不是真的声明了它");
const manifestPath = join(profile.dir, "package.json");
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  check(`能读到 profile 的 package.json`, false, error.message);
}
if (manifest) {
  const dep = manifest.dependencies?.[PACKAGE_ID];
  check(`dependencies 里有 ${PACKAGE_ID}`, typeof dep === "string", `实际 = ${JSON.stringify(dep)}`);
  if (typeof dep === "string") console.log(`   ${PACKAGE_ID} = ${dep}`);
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  check(
    `dsh.profile.bundles 里选了 ${PACKAGE_ID}（漏了这步 patch 根本不会被读）`,
    Array.isArray(bundles) && bundles.includes(PACKAGE_ID),
    `bundles = ${JSON.stringify(bundles)}`,
  );
  const nmDir = join(profile.dir, "node_modules", PACKAGE_ID);
  check(`profile 的 node_modules 里有 ${PACKAGE_ID}（junction 建对了）`, existsSync(nmDir), nmDir);
}

console.log("4) 解析出的 layer 与 patch");
const layer = profile.layers.find((l) => l.packageName === PACKAGE_ID);
check(`profile.layers 里有 ${PACKAGE_ID} 这一层`, Boolean(layer), "layers 里找不到——bundles 没生效？");
if (layer) {
  const dir = String(layer.packageDir ?? "").replace(/\\/g, "/").toLowerCase();
  console.log(`   packageDir = ${layer.packageDir}`);
  check(`packageDir 指到这个包（不是解析到别处）`, dir.endsWith(`/${PACKAGE_ID}`), dir);
  const patchPaths = layer.patchPaths ?? [];
  console.log(`   patchPaths = ${JSON.stringify(patchPaths)}`);
  check(
    `patchPaths 指向插件自己的 cordis.patch.yml`,
    patchPaths.some((p) => String(p).replace(/\\/g, "/").toLowerCase().endsWith("/cordis.patch.yml")),
    JSON.stringify(patchPaths),
  );
  const payload = JSON.stringify(layer.patches ?? []);
  check(`patch 载荷里出现了 ${PACKAGE_ID}（insert 行已生效）`, payload.includes(PACKAGE_ID), payload.slice(0, 300));
}

console.log("5) 从 profile 的 node_modules 能装进插件吗（也就是安装后的那一份）");
try {
  const entry = new URL(`./node_modules/${PACKAGE_ID}/index.mjs`, pathToFileURL(join(profile.dir, "/")));
  const mod = await import(entry.href);
  const apply = mod.default?.apply ?? mod.apply;
  check(`import 得到插件，apply() 是函数`, typeof apply === "function", "import 成功但没有 apply()");
  const inject = mod.default?.inject ?? mod.inject;
  check(`inject 只声明 tools`, Array.isArray(inject) && inject.length === 1 && inject[0] === "tools", JSON.stringify(inject));
} catch (error) {
  check(`从 profile 的 node_modules import 插件`, false, error.message);
}

console.log("");
console.log(`${ok.length} 通过 / ${bad.length} 失败`);
if (bad.length > 0) {
  console.log("失败项：");
  for (const b of bad) console.log(`  · ${b}`);
}
console.log(bad.length === 0 ? "RESULT: 这个 profile 里的安装是完整的，重启应用就会加载。" : "RESULT: 有问题，先别重启，看上面。");
process.exit(bad.length === 0 ? 0 : 1);
