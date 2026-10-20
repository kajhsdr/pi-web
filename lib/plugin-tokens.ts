// 插件成本在独立进程里测量；请求只读取缓存并为 SDK 已启用的资源排队。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "./project-trust";
import type { PluginTokenUsage } from "./api-types";
import { writePrivateFileAtomicSync } from "./atomic-file";

export type { PluginTokenUsage };

export interface PluginTokenTarget {
  source: string;
  scope: string;
  installedPath?: string;
  version?: string;
  extensions: string[];
  skillPaths: string[];
}

export interface PluginTokenSnapshot {
  tokens: Record<string, PluginTokenUsage>;
  pending: boolean;
  batch: string;
}

interface CacheEntry extends PluginTokenUsage { at: number }
type ProbeSettings = ReturnType<SettingsManager["getSettings"]>;
interface QueuedTarget extends PluginTokenTarget {
  cwd: string;
  defaultTools?: string[];
  settings?: ProbeSettings;
  globalResourceKey: string;
}
interface CacheState {
  loaded: boolean;
  entries: Map<string, CacheEntry>;
  running: Set<string>;
  queued: Map<string, QueuedTarget>;
}

declare global {
  var __piPluginTokenCacheV5: CacheState | undefined;
}

const PROBE_TIMEOUT_MS = 120_000;
const CACHE_VERSION = 6;
// 扩展可读取任意项目配置或导入辅助模块；即使入口未变，也必须有界重测。
const CACHE_TTL_MS = 60_000;
const PROBE_SCRIPT = join(process.cwd(), "lib", "plugin-token-probe.mjs");
const zeroUsage = (): PluginTokenUsage => ({ prompt: 0, decl: 0, skills: 0, ext: 0, toolCount: 0 });

function getCacheState(): CacheState {
  return globalThis.__piPluginTokenCacheV5 ??= {
    loaded: false, entries: new Map(), running: new Set(), queued: new Map(),
  };
}

function getCachePath(): string {
  return join(getAgentDir(), "pi-web-plugin-tokens.json");
}

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch {
    return `${path}:missing`;
  }
}

function cacheKey(target: QueuedTarget): string {
  return JSON.stringify([
    resolve(target.cwd), target.scope, target.source, target.installedPath, target.version,
    target.defaultTools, settingsKey(target.settings),
    ...(target.installedPath ? [fileStamp(join(target.installedPath, "package.json"))] : []),
    target.extensions.map(fileStamp), target.skillPaths.map(fileStamp),
  ]);
}

function settingsKey(settings?: ProbeSettings): string {
  return createHash("sha256").update(JSON.stringify(settings ?? {})).digest("hex");
}

// 全局包的开关和资源过滤影响每个项目，项目包则由所属 cwd 单独复核。
function globalResourceKey(settings: ProbeSettings, source: string): string {
  return settingsKey({
    packages: settings.packages?.filter((entry) => (typeof entry === "string" ? entry : entry.source) === source),
    extensions: settings.extensions,
    skills: settings.skills,
  });
}

function discardChangedGlobalQueue(state: CacheState, cwd: string): void {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
  for (const [key, target] of state.queued) {
    if (target.scope === "global" && target.globalResourceKey !== globalResourceKey(settings, target.source)) {
      state.queued.delete(key);
    }
  }
}

export function tokenKey(scope: string, source: string): string {
  return `${scope}\u0000${source}`;
}

function loadCache(state: CacheState): void {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(getCachePath(), "utf8"));
    if (parsed.version !== CACHE_VERSION) return;
    for (const [key, entry] of Object.entries(parsed.entries ?? {}) as [string, CacheEntry][]) {
      if (typeof entry?.ext === "number" && Date.now() - entry.at < CACHE_TTL_MS) state.entries.set(key, entry);
    }
  } catch {
    // 缓存缺失或损坏时重新测量。
  }
}

function saveCache(state: CacheState): void {
  try {
    for (const [key, entry] of state.entries) {
      if (Date.now() - entry.at >= CACHE_TTL_MS) state.entries.delete(key);
    }
    writePrivateFileAtomicSync(getCachePath(), JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(state.entries) }));
  } catch {
    // 缓存写失败不影响本轮结果。
  }
}

function toUsage(raw: Record<string, unknown>): PluginTokenUsage {
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    prompt: number(raw.prompt), decl: number(raw.decl), skills: number(raw.skills),
    ext: number(raw.ext), toolCount: number(raw.toolCount),
    ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
  };
}

function startNextProbe(): void {
  const state = getCacheState();
  if (state.running.size || !state.queued.size) return;
  discardChangedGlobalQueue(state, state.queued.values().next().value!.cwd);
  if (!state.queued.size) return;
  const first = state.queued.values().next().value!;
  const cwd = first.cwd;
  const batch = new Map([...state.queued].filter(([, target]) => (
    target.cwd === cwd && JSON.stringify(target.defaultTools) === JSON.stringify(first.defaultTools)
    && settingsKey(target.settings) === settingsKey(first.settings)
  )));
  for (const key of batch.keys()) {
    state.queued.delete(key);
    state.running.add(key);
  }
  setTimeout(() => { void runProbe(cwd, batch); }, 0);
}

async function runProbe(cwd: string, batch: Map<string, QueuedTarget>): Promise<void> {
  const state = getCacheState();
  let workDir: string | undefined;
  let settled = false;
  const finish = (results?: Record<string, unknown>[], error = "probe produced no results") => {
    if (settled) return;
    settled = true;
    const byKey = new Map((results ?? []).map((raw) => [tokenKey(String(raw.scope), String(raw.source)), raw]));
    for (const [key, target] of batch) {
      const raw = byKey.get(tokenKey(target.scope, target.source));
      // 使用排队时的键，资源在测量期间改变不能把旧结果写入新指纹。
      state.entries.set(key, { ...(raw ? toUsage(raw) : { ...zeroUsage(), error }), at: Date.now() });
      state.running.delete(key);
    }
    saveCache(state);
    if (workDir) {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* 临时目录可稍后清理。 */ }
    }
    startNextProbe();
  };
  try {
    // running 只是调度占位；真正 spawn 前必须用最新 SDK 解析结果复核，禁止旧入口启动。
    const agentDir = getAgentDir();
    const projectTrusted = getProjectTrustStatus(cwd, agentDir).trusted;
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
    const paths = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve(async () => "skip");
    if (settingsManager.drainErrors().length) throw new Error("settings could not be read before probing");
    for (const [key, target] of batch) {
      const matches = (["extensions", "skills"] as const).every((kind) => {
        const enabled = paths[kind].filter((resource) => (
          resource.enabled && resource.metadata.origin === "package" && resource.metadata.source === target.source
          && (resource.metadata.scope === "project" ? "project" : "global") === target.scope
        )).map((resource) => resource.path).sort();
        const requested = [...(kind === "extensions" ? target.extensions : target.skillPaths)].sort();
        return JSON.stringify(enabled) === JSON.stringify(requested);
      });
      if (!matches) {
        state.entries.set(key, { ...zeroUsage(), error: "enabled resources changed; refresh to retry", at: Date.now() });
        state.running.delete(key);
        batch.delete(key);
      }
    }
    if (!batch.size) { finish(); return; }
    workDir = mkdtempSync(join(tmpdir(), "pi-web-tokens-"));
    const inputPath = join(workDir, "input.json");
    const resultPath = join(workDir, "result.json");
    // Node 解析遵守依赖提升布局，不要求 SDK 物理存在于 pi-web/node_modules。
    const sdkManifest = findPackageJSON("@earendil-works/pi-coding-agent", pathToFileURL(join(process.cwd(), "package.json")).href);
    if (!sdkManifest) throw new Error("pi SDK package was not found");
    writeFileSync(inputPath, JSON.stringify({
      piDist: join(dirname(sdkManifest), "dist"),
      cwd, agentDir, projectTrusted,
      resultPath, defaultTools: batch.values().next().value!.defaultTools,
      settings: batch.values().next().value!.settings,
      packages: [...batch.values()],
    }));
    const child = spawn(process.execPath, [PROBE_SCRIPT, inputPath], {
      cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined, "probe timed out");
    }, PROBE_TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); finish(undefined, error.message); });
    child.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      try {
        const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
        finish(Array.isArray(parsed.results) ? parsed.results : undefined);
      } catch {
        finish(undefined, stderr.trim() || "probe result was not readable JSON");
      }
    });
  } catch (error) {
    finish(undefined, error instanceof Error ? error.message : String(error));
  }
}

export function getPluginTokenSnapshot(cwd: string, targets: PluginTokenTarget[], defaultTools?: string[], settings?: ProbeSettings): PluginTokenSnapshot {
  const state = getCacheState();
  loadCache(state);
  discardChangedGlobalQueue(state, cwd);
  const globalSettings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
  const tokens: Record<string, PluginTokenUsage> = {};
  const keys: string[] = [];
  const requestedKeys = new Set<string>();
  let pending = false;
  for (const target of targets) {
    const queued = { ...target, cwd: resolve(cwd), defaultTools, settings, globalResourceKey: globalResourceKey(globalSettings, target.source) };
    const key = cacheKey(queued);
    requestedKeys.add(key);
    // 批次包含结果时间，使同一资源在 TTL 后重测时也获得新的轮询预算。
    const cached = state.entries.get(key);
    keys.push(key, String(cached?.at ?? "pending"));
    if (!target.extensions.length && !target.skillPaths.length) {
      tokens[tokenKey(target.scope, target.source)] = zeroUsage();
    } else if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      tokens[tokenKey(target.scope, target.source)] = toUsage({ ...cached });
    } else if (!target.installedPath || !existsSync(target.installedPath)) {
      tokens[tokenKey(target.scope, target.source)] = { ...zeroUsage(), error: "package is not installed" };
    } else {
      pending = true;
      if (!state.running.has(key)) state.queued.set(key, queued);
    }
  }
  // 排队时用户可能关闭或过滤资源；尚未启动的旧任务不能继续执行。
  for (const [key, target] of state.queued) {
    if (target.cwd === resolve(cwd) && !requestedKeys.has(key)) state.queued.delete(key);
  }
  startNextProbe();
  return { tokens, pending, batch: createHash("sha256").update(JSON.stringify(keys)).digest("hex") };
}
