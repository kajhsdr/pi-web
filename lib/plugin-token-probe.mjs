// 插件上下文成本探针。
//
// 装一个 pi 插件，模型上下文会被吃掉多少 token？三块来源：
//   1. prompt：工具自带的 promptSnippet / promptGuidelines 进系统提示词的增量
//   2. decl：每个活跃工具（defaultActive !== false）的 name + description + JSON
//      schema，模型每次请求都会收到
//   3. skills：包内 SKILL.md 的 name + description 进系统提示词的增量
//
// 全部用 pi 自己的构建器和估算器算，所以和真实会话同一套口径：
//   buildSystemPromptSections() 组装系统提示词，estimateTokens() 计数。
//
// 用法：node plugin-token-probe.mjs <input.json>
//   input:  { piDist, cwd, packages: [{ source, dir }] }
//   output: { results: [{ source, prompt, decl, skills, ext, error? }] }
//   ext = prompt + decl（插件真正进上下文的量）
//
// 实现思路参考 danielbill/pi-flash（GPL-3.0），代码按 pi SDK 公开 API 独立编写。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const load = (relative) => import(pathToFileURL(join(input.piDist, relative)).href);

const { buildSystemPromptSections } = await load("core/system-prompt.js");
const { estimateTokens } = await load("core/compaction/compaction.js");
const { readPiManifest } = await load("core/pi-manifest.js");
const { createEventBus } = await load("core/event-bus.js");
const { loadExtensions, createExtensionRuntime } = await load("core/extensions/loader.js");
const tools = await load("core/tools/index.js");

// 基线 = pi 的内置工具集，任何插件包的增量都相对它算。
const BASE_TOOLS = [
  tools.createReadToolDefinition(input.cwd),
  tools.createBashToolDefinition(input.cwd),
  tools.createEditToolDefinition(input.cwd),
  tools.createWriteToolDefinition(input.cwd),
  tools.createGrepToolDefinition(input.cwd),
  tools.createFindToolDefinition(input.cwd),
  tools.createLsToolDefinition(input.cwd),
];

const countTokens = (text) => estimateTokens({ role: "system", content: text });

/** 一组工具定义 + skills → 系统提示词 token 数。 */
function promptTokens(definitions, skills) {
  const toolSnippets = {};
  const toolGuidelines = {};
  for (const definition of definitions) {
    if (typeof definition.promptSnippet === "string" && definition.promptSnippet) {
      toolSnippets[definition.name] = definition.promptSnippet;
    }
    if (Array.isArray(definition.promptGuidelines) && definition.promptGuidelines.length > 0) {
      toolGuidelines[definition.name] = [...definition.promptGuidelines];
    }
  }
  const sections = buildSystemPromptSections({
    selectedTools: definitions.map((definition) => definition.name),
    toolSnippets,
    toolGuidelines,
    skills,
    cwd: input.cwd,
  });
  return countTokens(Object.values(sections).join("\n\n"));
}

/** 工具调用声明：模型每次请求都要收到的 tools 数组。 */
function declarationTokens(definitions) {
  let total = 0;
  for (const definition of definitions) {
    if (definition.defaultActive === false) continue;
    const schema = JSON.stringify(definition.parameters ?? {});
    total += countTokens(`${definition.name}\n${definition.description ?? ""}\n${schema}`);
  }
  return total;
}

/** 包的扩展入口：pi.extensions 清单 → index.ts/js → 目录扫描。 */
function resolveEntries(dir) {
  const manifest = readPiManifest(join(dir, "package.json"));
  if (manifest?.extensions?.length) {
    const entries = manifest.extensions
      .map((entry) => resolvePath(dir, entry))
      .filter((entry) => existsSync(entry));
    if (entries.length > 0) return entries;
  }
  for (const name of ["index.ts", "index.js"]) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return [candidate];
  }
  const found = [];
  const walk = (current, depth) => {
    if (depth > 3 || found.length > 50) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(ts|js)$/.test(entry.name)) found.push(full);
    }
  };
  walk(dir, 0);
  return found;
}

/** SKILL.md frontmatter 里的 name / description，pi 就靠这两行进上下文。 */
function readSkill(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
    const pick = (key) => {
      const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
      return match?.[1]?.trim().replace(/^["']|["']$/g, "");
    };
    const description = pick("description") ?? "";
    if (!description) return null;
    return {
      name: pick("name") ?? basename(dirname(filePath)),
      description,
      filePath,
    };
  } catch {
    return null;
  }
}

/** 一个 skills 条目可能指向 .md 文件、单个 skill 目录，或一批 skill 目录。 */
function skillFiles(target) {
  if (target.endsWith(".md")) return [target];
  const direct = join(target, "SKILL.md");
  if (existsSync(direct)) return [direct];
  const found = [];
  const walk = (current, depth) => {
    if (depth > 2 || found.length > 100) return;
    const nested = join(current, "SKILL.md");
    if (existsSync(nested)) {
      found.push(nested);
      return;
    }
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(join(current, entry.name), depth + 1);
      }
    }
  };
  walk(target, 0);
  return found;
}

/** 包内 skills：pi.skills 清单，逐条展开成 SKILL.md 文件。 */
function packageSkills(dir) {
  const listed = readPiManifest(join(dir, "package.json"))?.skills ?? [];
  const skills = [];
  for (const entry of listed) {
    const target = resolvePath(dir, entry);
    if (!existsSync(target)) continue;
    for (const filePath of skillFiles(target)) {
      const skill = readSkill(filePath);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

const basePrompt = promptTokens(BASE_TOOLS, []);
const results = [];

for (const pkg of input.packages) {
  try {
    if (!pkg.dir || !existsSync(pkg.dir)) throw new Error("package directory not found");
    const entries = resolveEntries(pkg.dir);
    if (entries.length === 0) throw new Error("no extension entry point found");

    // 每个包一套独立的 runtime / bus，装载失败或副作用互不串线。
    const loaded = await loadExtensions(entries, input.cwd, createEventBus(), createExtensionRuntime());
    if (loaded.extensions.length === 0) {
      throw new Error(loaded.errors[0]?.error ?? "no extension loaded");
    }

    const definitions = loaded.extensions.flatMap((extension) =>
      [...extension.tools.values()].map((tool) => tool.definition),
    );
    const skills = packageSkills(pkg.dir);

    const prompt = Math.max(promptTokens([...BASE_TOOLS, ...definitions], []) - basePrompt, 0);
    const decl = declarationTokens(definitions);
    const skill = skills.length > 0
      ? Math.max(promptTokens(BASE_TOOLS, skills) - basePrompt, 0)
      : 0;

    results.push({
      source: pkg.source,
      scope: pkg.scope,
      prompt,
      decl,
      skills: skill,
      ext: prompt + decl,
      toolCount: definitions.length,
    });
  } catch (error) {
    results.push({ source: pkg.source, scope: pkg.scope, error: String(error?.message ?? error) });
  }
}

process.stdout.write(JSON.stringify({ results }));
