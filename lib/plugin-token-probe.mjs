// 插件上下文探针：只消费 SDK 已解析的启用路径，不重新扫描包或解析清单。
// 结果单独写文件，扩展的 stdout/stderr 日志不会混入结构化结果。
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const load = (relative) => import(pathToFileURL(join(input.piDist, relative)).href);
const {
  AgentSession, DefaultPackageManager, ModelRuntime, SessionManager, SettingsManager,
  createCodemodeExtension, createToolSearchExtension,
  createEventBus, createExtensionRuntime, loadSkills,
} = await load("index.js");
const { loadExtensions, loadExtensionFromFactory } = await load("core/extensions/loader.js");
const { estimateTokens } = await load("core/compaction/compaction.js");
const require = createRequire(join(input.piDist, "index.js"));
const { Agent } = await import(pathToFileURL(join(dirname(require.resolve("@earendil-works/pi-agent-core/package.json")), "dist/index.js")).href);
const countTokens = (text) => estimateTokens({ role: "system", content: text });

// 不读取用户凭据、不选择模型、不触发 session_start 或任何模型请求。
const modelRuntime = await ModelRuntime.create({
  authPath: join(dirname(input.resultPath), "auth.json"),
  modelsPath: null,
  modelsStorePath: join(dirname(input.resultPath), "models-store.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});

function createSession(extensions, getSkills) {
  const agent = new Agent({ initialState: { tools: [], messages: [] } });
  const resourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: getSkills(), diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return new AgentSession({
    agent, resourceLoader, modelRuntime, cwd: input.cwd,
    settingsManager: SettingsManager.inMemory(input.settings ?? {}),
    sessionManager: SessionManager.inMemory(input.cwd),
    initialActiveToolNames: input.defaultTools ?? ["read", "bash", "edit", "write"],
  });
}

// 每个包执行前重新解析，不能让排队期间禁用或过滤掉的旧资源运行。
async function resolveEnabledResources() {
  const settingsManager = SettingsManager.create(input.cwd, input.agentDir, { projectTrusted: input.projectTrusted });
  const manager = new DefaultPackageManager({
    cwd: input.cwd, agentDir: input.agentDir, settingsManager,
    builtinExtensions: ["codemode", "tool-search"],
  });
  const paths = await manager.resolve(async () => "skip");
  if (settingsManager.drainErrors().length) throw new Error("settings could not be read before probing");
  return paths;
}

function matchesPackage(resource, pkg) {
  return resource.enabled && resource.metadata.origin === "package" && resource.metadata.source === pkg.source
    && (resource.metadata.scope === "project" ? "project" : "global") === pkg.scope;
}

function samePaths(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

async function withBuiltins(loaded, paths) {
  // 只加载纯声明工厂，不创建 MCP host、不连接服务，也不运行 sandbox。
  const factories = { codemode: createCodemodeExtension, "tool-search": createToolSearchExtension };
  const builtins = [];
  for (const [name, factory] of Object.entries(factories)) {
    if (!paths.extensions.some((resource) => resource.path === `builtin:${name}` && resource.enabled)) continue;
    const extension = await loadExtensionFromFactory(factory(), input.cwd, createEventBus(), loaded.runtime, `builtin:${name}`);
    // 与 SDK replaceable 内置扩展一致，用户注册同名工具、命令或 flag 时由用户接管。
    const replaced = loaded.extensions.some((other) => ["tools", "commands", "flags"].some((kind) => (
      [...extension[kind].keys()].some((key) => other[kind].has(key))
    )));
    if (!replaced) builtins.push(extension);
  }
  return { ...loaded, extensions: [...builtins, ...loaded.extensions] };
}

async function declaredTools(session) {
  // SDK 请求投影移除隐藏声明，并保留 codemode 等 loadout hook 改写后的描述。
  const projected = await session.agent.transformContext([{
    role: "system", content: "", timestamp: Date.now(),
    toolsAdded: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  }], new AbortController().signal);
  return projected.flatMap((message) => message.toolsAdded ?? []);
}

function declarationTokens(tools) {
  return tools.reduce((sum, tool) => sum + countTokens(
    `${tool.name}\n${tool.description ?? ""}\n${JSON.stringify(tool.parameters ?? {})}`,
  ), 0);
}

const results = [];
for (const pkg of input.packages) {
  let session;
  let baseline;
  try {
    const paths = await resolveEnabledResources();
    const enabledExtensions = paths.extensions.filter((resource) => matchesPackage(resource, pkg)).map((resource) => resource.path);
    const enabledSkills = paths.skills.filter((resource) => matchesPackage(resource, pkg)).map((resource) => resource.path);
    if (!samePaths(pkg.extensions, enabledExtensions) || !samePaths(pkg.skillPaths, enabledSkills)) {
      throw new Error("enabled resources changed; refresh to retry");
    }
    baseline = createSession(await withBuiltins({ extensions: [], errors: [], runtime: createExtensionRuntime() }, paths), () => []);
    const basePrompt = countTokens(baseline.systemPrompt);
    const baseDecl = declarationTokens(await declaredTools(baseline));
    const loaded = await loadExtensions(pkg.extensions, input.cwd, createEventBus(), createExtensionRuntime());
    if (loaded.errors.length) throw new Error(loaded.errors.map((entry) => entry.error).join("; "));
    const skills = loadSkills({ cwd: input.cwd, skillPaths: pkg.skillPaths, includeDefaults: false }).skills;
    let includeSkills = false;
    session = createSession(await withBuiltins(loaded, paths), () => includeSkills ? skills : []);
    const prompt = Math.max(countTokens(session.systemPrompt) - basePrompt, 0);
    const names = new Set(loaded.extensions.flatMap((extension) => [...extension.tools.keys()]));
    const declared = await declaredTools(session);
    // 插件也会改变内置 codemode 的描述，必须比较全部最终声明的成本差额。
    const decl = Math.max(declarationTokens(declared) - baseDecl, 0);
    includeSkills = true;
    session.setActiveToolsByName(session.getActiveToolNames());
    const skill = Math.max(countTokens(session.systemPrompt) - basePrompt - prompt, 0);
    results.push({ source: pkg.source, scope: pkg.scope, prompt, decl, skills: skill, ext: prompt + decl, toolCount: declared.filter((tool) => names.has(tool.name)).length });
  } catch (error) {
    results.push({ source: pkg.source, scope: pkg.scope, error: String(error?.message ?? error) });
  } finally {
    session?.dispose();
    baseline?.dispose();
  }
}
writeFileSync(input.resultPath, JSON.stringify({ results }));
// 扩展若在 factory 中留下计时器，结果完成后也不让探针继续驻留。
process.exit(0);
