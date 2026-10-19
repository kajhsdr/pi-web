// 测量插件会占用多少模型上下文。
//
// 探针（lib/plugin-token-probe.mjs）在自己的 node 进程里跑：装载扩展、数工具
// 声明、读 SKILL.md frontmatter，用 pi 自己的估算器算 token。装载要跑用户的
// 扩展代码，慢且可能抛错，所以绝不放在请求路径里 —— 这里立刻返回已知结果，
// 缺的在后台补，面板轮询取。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PluginTokenUsage } from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";

export type { PluginTokenUsage };

export interface PluginTokenTarget {
  source: string;
  /** 同一个包可以同时装在全局和项目里，两处的版本可能不同。 */
  scope: string;
  /** 已安装包目录；缺省表示装不上，探针无从下手。 */
  installedPath?: string;
  version?: string;
}

export interface PluginTokenSnapshot {
  /** 按 `scope\0source` 索引，只含已经算出来的条目。 */
  tokens: Record<string, PluginTokenUsage>;
  /** 还有插件在算，前端稍后再取一次。 */
  pending: boolean;
}

interface CacheEntry extends PluginTokenUsage {
  at: number;
}

interface CacheState {
  loaded: boolean;
  entries: Map<string, CacheEntry>;
  running: boolean;
  queued: Map<string, PluginTokenTarget & { cwd: string }>;
}

declare global {
  var __piPluginTokenCacheV3: CacheState | undefined;
}

const PROBE_TIMEOUT_MS = 120_000;
// 换版本号 = 丢掉旧口径算出来的缓存。
const CACHE_VERSION = 4;
// 失败条目过期后才重试：装载失败多半是包本身坏了，但用户装好依赖或修好包之后
// 不该还要手动清缓存。
const ERROR_TTL_MS = 10 * 60_000;
const PROBE_SCRIPT = join(process.cwd(), "lib", "plugin-token-probe.mjs");

function getCacheState(): CacheState {
  if (!globalThis.__piPluginTokenCacheV3) {
    globalThis.__piPluginTokenCacheV3 = {
      loaded: false,
      entries: new Map(),
      running: false,
      queued: new Map(),
    };
  }
  return globalThis.__piPluginTokenCacheV3;
}

function getCachePath(): string {
  return join(getAgentDir(), "pi-web-plugin-tokens.json");
}

// 测量结果只跟包本身有关（工具声明 + skill 说明），不同项目里同一个包算一遍就够；
// 之前把 cwd 算进 key，切一个项目就把全部包重测一遍。
function cacheKey(target: PluginTokenTarget): string {
  // 版本号盖不住「原地改了代码但没 bump version」的 git 包，所以再拿
  // package.json 的 mtime 当指纹。
  let stamp = target.version ?? "";
  if (target.installedPath) {
    try {
      stamp += `@${statSync(join(target.installedPath, "package.json")).mtimeMs}`;
    } catch {
      // 没装上的包只有版本号可用。
    }
  }
  return [target.scope, target.installedPath ?? "", stamp, target.source].join("\u0000");
}

/** 前端拿这个 key 取数字，和 `packageKey()` 同构。 */
export function tokenKey(scope: string, source: string): string {
  return `${scope}\u0000${source}`;
}

function loadCache(state: CacheState): void {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(getCachePath(), "utf8")) as {
      version?: number;
      entries?: Record<string, CacheEntry>;
    };
    if (parsed.version !== CACHE_VERSION) return;
    for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
      if (typeof entry?.ext === "number") state.entries.set(key, entry);
    }
  } catch {
    // 首次运行或文件损坏：从空缓存开始，下次探测时重建。
  }
}

function saveCache(state: CacheState): void {
  try {
    const entries: Record<string, CacheEntry> = {};
    for (const [key, entry] of state.entries) entries[key] = entry;
    writePrivateFileAtomicSync(getCachePath(), JSON.stringify({ version: CACHE_VERSION, entries }));
  } catch {
    // 缓存写不进去不影响本轮结果，下次再算一遍。
  }
}

function toUsage(raw: Record<string, unknown>): PluginTokenUsage {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const usage: PluginTokenUsage = {
    prompt: number(raw.prompt),
    decl: number(raw.decl),
    skills: number(raw.skills),
    ext: number(raw.ext),
    toolCount: number(raw.toolCount),
  };
  if (typeof raw.error === "string" && raw.error) usage.error = raw.error;
  return usage;
}

/** 跑一次探针进程，覆盖这一批插件；结果写回缓存。 */
function runProbe(cwd: string, batch: Map<string, PluginTokenTarget & { cwd: string }>): void {
  const state = getCacheState();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.running = false;
    if (!workDir) return;
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 临时目录清不掉不影响结果。
    }
  };

  let workDir: string | null = null;
  try {
    workDir = mkdtempSync(join(tmpdir(), "pi-web-tokens-"));
    const inputPath = join(workDir, "input.json");
    writeFileSync(
      inputPath,
      JSON.stringify({
        piDist: join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "dist"),
        cwd,
        packages: [...batch.values()].map((target) => ({
          source: target.source,
          scope: target.scope,
          dir: target.installedPath,
        })),
      }),
    );

    const child = spawn(process.execPath, [PROBE_SCRIPT, inputPath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // kill 不一定立刻生效：先记失败并放开 running，别让面板永久轮询。
      child.kill();
      failBatch(batch, "probe timed out");
      cleanup();
    }, PROBE_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      failBatch(batch, error.message);
      cleanup();
    });
    // 临时目录要等子进程真正读完 input.json 才能删，所以清理放在 close 里。
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        cleanup();
        return;
      }
      try {
        const results = (JSON.parse(stdout) as { results?: Record<string, unknown>[] }).results ?? [];
        if (results.length === 0) {
          failBatch(batch, stderr.trim() || "probe produced no results");
        } else {
          assignResults(batch, results);
          saveCache(state);
        }
      } catch {
        failBatch(batch, stderr.trim() || "probe output was not readable JSON");
      } finally {
        cleanup();
      }
    });
  } catch (error) {
    failBatch(batch, error instanceof Error ? error.message : String(error));
    cleanup();
  }
}

/** 把探针结果按「scope + source」写回缓存。 */
function assignResults(
  batch: Map<string, PluginTokenTarget & { cwd: string }>,
  results: Record<string, unknown>[],
): void {
  const state = getCacheState();
  const byKey = new Map<string, PluginTokenTarget & { cwd: string }>();
  for (const target of batch.values()) byKey.set(tokenKey(target.scope, target.source), target);

  for (const raw of results) {
    const source = typeof raw.source === "string" ? raw.source : "";
    const scope = typeof raw.scope === "string" ? raw.scope : "global";
    const key = tokenKey(scope, source);
    const queued = byKey.get(key);
    if (!queued) continue;
    state.entries.set(cacheKey(queued), { ...toUsage(raw), at: Date.now() });
  }
}

function failBatch(
  batch: Map<string, PluginTokenTarget & { cwd: string }>,
  message: string,
): void {
  const state = getCacheState();
  for (const [key] of batch) {
    state.entries.set(key, {
      prompt: 0,
      decl: 0,
      skills: 0,
      ext: 0,
      toolCount: 0,
      error: message,
      at: Date.now(),
    });
  }
  saveCache(state);
}

/**
 * 已知的插件上下文成本 + 是否还在算。
 *
 * 第一次调用为缺的插件排队并启动后台探针，不等它跑完；前端拿到 `pending`
 * 就再取一次。同一个插件只算一次，结果落盘长期复用；失败条目 10 分钟后重试。
 */
export function getPluginTokenSnapshot(
  cwd: string,
  targets: PluginTokenTarget[],
): PluginTokenSnapshot {
  const state = getCacheState();
  loadCache(state);

  const tokens: Record<string, PluginTokenUsage> = {};
  let missing = 0;

  for (const target of targets) {
    const key = cacheKey(target);
    const cached = state.entries.get(key);
    if (cached) {
      // 失败条目过期了就重新排队，否则一次坏的装载会永久显示错误。
      if (!cached.error || Date.now() - cached.at <= ERROR_TTL_MS) {
        tokens[tokenKey(target.scope, target.source)] = {
          prompt: cached.prompt,
          decl: cached.decl,
          skills: cached.skills,
          ext: cached.ext,
          toolCount: cached.toolCount,
          ...(cached.error ? { error: cached.error } : {}),
        };
        continue;
      }
      state.entries.delete(key);
    }

    if (!target.installedPath || !existsSync(target.installedPath)) {
      // 没装上的包没得测，直接记 0，别让它一直 pending。
      const usage: PluginTokenUsage = {
        prompt: 0,
        decl: 0,
        skills: 0,
        ext: 0,
        toolCount: 0,
        error: "package is not installed",
      };
      state.entries.set(key, { ...usage, at: Date.now() });
      tokens[tokenKey(target.scope, target.source)] = usage;
      continue;
    }

    missing += 1;
    if (!state.running) state.queued.set(key, { ...target, cwd });
  }

  if (missing > 0 && !state.running && state.queued.size > 0) {
    const batch = new Map(state.queued);
    state.queued.clear();
    // 同步占位：同一 tick 里的第二个请求不该再开一个探针进程。
    state.running = true;
    // 后台跑，请求立刻返回。
    setTimeout(() => runProbe(cwd, batch), 0);
  }

  return { tokens, pending: missing > 0 };
}
