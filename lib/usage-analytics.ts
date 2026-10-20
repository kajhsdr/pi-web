// session 文件就是费用账本。先保留每次调用的身份，确认 Fork 继承关系后再汇总；
// 如果先按文件聚合，复制的历史调用就会被重复计费。
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { usageDateFormatter, usageDateKey } from "./usage-calendar";
import { usageAncestorPaths } from "./usage-lineage";
import { sessionPathKey } from "./session-path";
import type { UsageBucketRow, UsageSnapshot, UsageTokens } from "./api-types";

export type { UsageBucketRow, UsageSnapshot, UsageTokens };

interface UsageCall {
  identity: string | null;
  timestamp: string | number;
  model: string;
  tokens: UsageTokens;
  cost: number;
}
interface FileUsage {
  size: number;
  mtimeMs: number;
  sessionId: string;
  cwd: string;
  title: string;
  parent: string | null;
  ancestors: string[];
  calls: UsageCall[];
}
interface CacheState {
  files: Map<string, FileUsage>;
  snapshot: UsageSnapshot | null;
  running: Promise<UsageSnapshot> | null;
}
declare global {
  var __piWebUsageCacheV4: Map<string, CacheState> | undefined;
}
function getCacheState(root: string, timeZone: string): CacheState {
  const caches = globalThis.__piWebUsageCacheV4 ??= new Map();
  const key = JSON.stringify([resolve(root), timeZone]);
  let state = caches.get(key);
  if (!state) {
    state = { files: new Map(), snapshot: null, running: null };
    caches.set(key, state);
    // 多个浏览器可能使用不同的时区，因此限制保留的文件和调用数据量。
    for (const [oldKey, old] of caches) {
      if (caches.size <= 8) break;
      if (oldKey !== key && !old.running) caches.delete(oldKey);
    }
  }
  return state;
}
function addTokens(target: UsageTokens, source: UsageTokens): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}
function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function tokensFrom(raw: Record<string, unknown>): UsageTokens {
  return {
    input: numberField(raw.input), output: numberField(raw.output),
    cacheRead: numberField(raw.cacheRead), cacheWrite: numberField(raw.cacheWrite),
    total: numberField(raw.total ?? raw.totalTokens),
  };
}
function sessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}
function listSessionFiles(root: string): string[] {
  const found: string[] = [];
  try {
    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      try {
        for (const name of readdirSync(join(root, dir.name))) {
          if (name.endsWith(".jsonl")) found.push(resolve(root, dir.name, name));
        }
      } catch { /* 扫描期间目录被删除。 */ }
    }
  } catch { /* 尚无会话。 */ }
  return found.sort();
}
async function scanFile(path: string): Promise<Omit<FileUsage, "size" | "mtimeMs">> {
  const result: Omit<FileUsage, "size" | "mtimeMs"> = {
    sessionId: "", cwd: "", title: "", parent: null, ancestors: [], calls: [],
  };
  let firstUserText = "";
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // 跳过体积较大的工具结果；匹配字段名时允许 JSON 中存在空格。
      if (!line.includes('"usage"') && !/"type"\s*:\s*"(?:session|session_info)"/.test(line)
        && (firstUserText || !/"role"\s*:\s*"user"/.test(line))) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "session") {
        result.sessionId = typeof entry.id === "string" ? entry.id : "";
        result.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
        result.parent = typeof entry.parentSession === "string"
          ? resolve(dirname(path), entry.parentSession) : null;
        result.ancestors = usageAncestorPaths(entry, path);
        continue;
      }
      if (entry.type === "session_info") {
        if (typeof entry.name === "string") result.title = entry.name.trim();
        continue;
      }
      const message = entry.message;
      if (!firstUserText && message?.role === "user") {
        const text = typeof message.content === "string" ? message.content
          : message.content?.find?.((block: { type: string }) => block.type === "text")?.text;
        if (typeof text === "string") firstUserText = text.trim().slice(0, 80);
      }
      const usage = message?.usage ?? entry.usage;
      if (!usage || entry.timestamp === undefined) continue;
      const model = message?.model ?? entry.model ?? "unknown";
      const provider = message?.provider ?? entry.provider ?? "";
      // SDK Fork 会移除标签并重新连接 parentId，还可能重映射压缩条目的
      // firstKeptEntryId。这两个字段都不能用来标识一次计费调用。
      // 身份指纹包含时间戳和调用内容，不能只依赖容易碰撞的 8hex id。
      const identity = typeof entry.id === "string" ? createHash("sha256").update(JSON.stringify([
        entry.id, entry.type, entry.timestamp, message ?? null, usage,
        entry.provider, entry.model, entry.kind, entry.summary,
      ])).digest("hex") : null;
      result.calls.push({
        identity, timestamp: entry.timestamp, model: provider ? `${provider}/${model}` : model,
        tokens: tokensFrom(usage), cost: numberField(usage.cost?.total),
      });
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  result.title ||= firstUserText;
  return result;
}
function snapshotIsCurrent(state: CacheState, files: string[]): boolean {
  if (state.files.size !== files.length) return false;
  return files.every((path) => {
    const cached = state.files.get(path);
    try {
      const stat = statSync(path);
      return cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs;
    } catch { return false; }
  });
}
async function rebuild(state: CacheState, files: string[], timeZone: string, formatter: Intl.DateTimeFormat): Promise<UsageSnapshot> {
  const seen = new Set(files);
  for (const path of files) {
    try {
      const stat = statSync(path);
      const cached = state.files.get(path);
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) continue;
      const scanned = await scanFile(path);
      state.files.set(path, { ...scanned, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      state.files.delete(path);
    }
  }
  for (const path of state.files.keys()) if (!seen.has(path)) state.files.delete(path);

  // 按当前父会话及删除时持久保存的计费祖先连接继承链，缺失路径仍可标识来源。
  // 没有继承关系的会话即使短 id 和完整调用内容相同，也必须分别计费。
  const parents = new Map<string, string>();
  const find = (path: string): string => {
    const parent = parents.get(path);
    if (!parent || parent === path) return path;
    const root = find(parent);
    parents.set(path, root);
    return root;
  };
  for (const [path, file] of state.files) {
    for (const ancestor of file.ancestors) {
      const child = find(sessionPathKey(path));
      const parent = find(sessionPathKey(ancestor));
      if (child !== parent) parents.set(child, parent);
    }
  }
  const identities = new Map<string, Set<string>>();
  const buckets = new Map<string, UsageBucketRow>();
  // 共享调用归到最早仍存在的祖先；祖先均已删除时，归到首个保留副本。
  // 源会话缺失不能导致保留副本继承的实际费用漏计。
  const ordered: [string, FileUsage][] = [];
  const visited = new Set<string>();
  const visit = (path: string, file: FileUsage) => {
    if (visited.has(path)) return;
    visited.add(path);
    const parent = file.parent && state.files.get(file.parent);
    if (parent) visit(file.parent!, parent);
    ordered.push([path, file]);
  };
  for (const [path, file] of state.files) visit(path, file);
  for (const [path, file] of ordered) {
    const family = find(sessionPathKey(path));
    let billed = identities.get(family);
    if (!billed) identities.set(family, billed = new Set());
    for (const call of file.calls) {
      const date = usageDateKey(call.timestamp, formatter);
      if (!date || (call.identity && billed.has(call.identity))) continue;
      if (call.identity) billed.add(call.identity);
      const key = JSON.stringify([date, path, call.model]);
      const existing = buckets.get(key);
      if (existing) {
        addTokens(existing.tokens, call.tokens);
        existing.cost += call.cost;
        existing.calls++;
      } else {
        buckets.set(key, {
          date, cwd: file.cwd, sessionId: file.sessionId, title: file.title || undefined,
          model: call.model, tokens: { ...call.tokens }, cost: call.cost, calls: 1,
        });
      }
    }
  }
  return state.snapshot = {
    buckets: [...buckets.values()], files: files.length, generatedAt: Date.now(),
    timeZone,
  };
}
/** 按根目录和时区缓存快照；并发读取共享同一次重建。 */
export function getUsageSnapshot(root: string = sessionsRoot(), timeZone = "UTC"): Promise<UsageSnapshot> {
  const formatter = usageDateFormatter(timeZone);
  // 回传请求中的 IANA 名称，并将其纳入缓存键。浏览器与服务端的 ICU 版本
  // 可能将别名规范化为不同名称，例如 Asia/Kolkata 与 Asia/Calcutta。
  const state = getCacheState(root, timeZone);
  if (state.running) return state.running;
  const files = listSessionFiles(root);
  if (state.snapshot && snapshotIsCurrent(state, files)) return Promise.resolve(state.snapshot);
  state.running = rebuild(state, files, timeZone, formatter).finally(() => { state.running = null; });
  return state.running;
}
export function resetUsageCacheForTests(): void {
  globalThis.__piWebUsageCacheV4 = undefined;
}
