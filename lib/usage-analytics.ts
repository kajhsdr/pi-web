// 从 pi 的 session 文件里汇总花费和 token。
//
// pi 每条 assistant message 的 `usage` 里都带 `cost.total`（美元），所以这里
// 不需要价格表，也不需要账本 —— session 文件本身就是账本。要做的只有：把
// 几百个文件里带 usage 的行挑出来，按 日期 × 会话 × 模型 聚成桶。
//
// 这里只出桶，不产出「今日/本月/按项目/按模型」那些视角：筛选和汇总全放在
// 前端做，换个筛选条件就不用再扫一遍盘。
//
// 文件动辄几十 MB，工具结果那几行最大且肯定不含 usage，所以先做子串判断再
// JSON.parse，跳过绝大多数字节。每个文件按 size/mtime 缓存，只有变动的文件
// 重解析。
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { UsageBucketRow, UsageSnapshot, UsageTokens } from "./api-types";

export type { UsageBucketRow, UsageSnapshot, UsageTokens };

interface FileUsage {
  size: number;
  mtimeMs: number;
  buckets: UsageBucketRow[];
}

interface CacheState {
  files: Map<string, FileUsage>;
  snapshot: UsageSnapshot | null;
  running: Promise<UsageSnapshot> | null;
}

declare global {
  var __piWebUsageCache: CacheState | undefined;
}

function getCacheState(): CacheState {
  if (!globalThis.__piWebUsageCache) {
    globalThis.__piWebUsageCache = { files: new Map(), snapshot: null, running: null };
  }
  return globalThis.__piWebUsageCache;
}

function addTokens(target: UsageTokens, source: UsageTokens): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
}

/** 本地时区的 YYYY-MM-DD；日期汇总按用户看到的日历走。 */
function dateKey(timestamp: string | number | undefined): string | null {
  if (timestamp === undefined) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokensFrom(raw: Record<string, unknown>): UsageTokens {
  return {
    input: numberField(raw.input),
    output: numberField(raw.output),
    cacheRead: numberField(raw.cacheRead),
    cacheWrite: numberField(raw.cacheWrite),
    total: numberField(raw.total ?? raw.totalTokens),
  };
}

function sessionsRoot(): string {
  return join(getAgentDir(), "sessions");
}

/** session 文件全集：pi 的布局是 `sessions/--cwd--/file.jsonl`。 */
function listSessionFiles(root: string): string[] {
  const found: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return found;
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(join(root, dir)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) found.push(join(root, dir, name));
  }
  return found;
}

/** 解析一个 session 文件里所有带 usage 的条目，聚成本文件内的桶。 */
async function scanFile(path: string): Promise<UsageBucketRow[]> {
  const buckets = new Map<string, UsageBucketRow>();
  let sessionId = "";
  let cwd = "";

  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // 工具结果占了绝大部分体积，且一定不含 usage：先做子串判断再解析。
      if (!line.includes('"usage"')) {
        if (line.includes('"type":"session"')) {
          try {
            const header = JSON.parse(line) as { id?: string; cwd?: string };
            if (typeof header.id === "string") sessionId = header.id;
            if (typeof header.cwd === "string") cwd = header.cwd;
          } catch {
            // header 坏了不影响后面的统计
          }
        }
        continue;
      }

      let entry: {
        timestamp?: string;
        message?: { provider?: string; model?: string; usage?: Record<string, unknown> };
        provider?: string;
        model?: string;
        usage?: Record<string, unknown>;
      };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      // 两种来源：assistant message 的 usage，以及 pi 单独记的 usage 条目
      // （cache_warm、压缩摘要等，同样计入会话总额）。
      const usage = entry.message?.usage ?? entry.usage;
      if (!usage) continue;
      const date = dateKey(entry.timestamp);
      if (!date) continue;

      const model = entry.message?.model ?? entry.model ?? "unknown";
      const provider = entry.message?.provider ?? entry.provider ?? "";
      const label = provider ? `${provider}/${model}` : model;
      const tokens = tokensFrom(usage);
      const cost = numberField((usage.cost as Record<string, unknown> | undefined)?.total);

      // 会话进 key，这样「今日会话」和「按项目」都能从前端还原出来。
      const key = `${date}\u0000${sessionId}\u0000${label}`;
      const existing = buckets.get(key);
      if (existing) {
        addTokens(existing.tokens, tokens);
        existing.cost += cost;
        existing.calls += 1;
      } else {
        buckets.set(key, {
          date,
          cwd,
          sessionId,
          model: label,
          tokens,
          cost,
          calls: 1,
        });
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...buckets.values()];
}

/** 文件没变就复用上次快照：stat 一遍全部文件只要几毫秒，比 TTL 更准，
 *  刚结束的对话也能立刻出现在费用页。 */
function snapshotIsCurrent(state: CacheState, files: string[]): boolean {
  if (state.files.size !== files.length) return false;
  for (const path of files) {
    const cached = state.files.get(path);
    if (!cached) return false;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return false;
    }
    if (cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) return false;
  }
  return true;
}

/** 重算整份快照：只重解析 size/mtime 变过的文件。 */
async function rebuild(files: string[]): Promise<UsageSnapshot> {
  const state = getCacheState();
  const seen = new Set<string>();

  for (const path of files) {
    seen.add(path);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    const cached = state.files.get(path);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) continue;
    try {
      const buckets = await scanFile(path);
      state.files.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, buckets });
    } catch {
      // 读不了的文件跳过，不拖垮整份统计。
    }
  }
  // 删掉的会话文件也要从缓存里清掉。
  for (const path of [...state.files.keys()]) {
    if (!seen.has(path)) state.files.delete(path);
  }

  const buckets: UsageBucketRow[] = [];
  for (const file of state.files.values()) {
    for (const bucket of file.buckets) buckets.push(bucket);
  }

  state.snapshot = { buckets, files: files.length, generatedAt: Date.now() };
  return state.snapshot;
}

/**
 * 费用快照。
 *
 * 首次要读全部 session 文件（几百个、几百 MB），所以并发调用共享同一个重建
 * 任务，不排队等多次全扫；文件指纹没变时直接返回上次结果。
 */
export function getUsageSnapshot(root: string = sessionsRoot()): Promise<UsageSnapshot> {
  const state = getCacheState();
  if (state.running) return state.running;
  const files = listSessionFiles(root);
  if (state.snapshot && snapshotIsCurrent(state, files)) {
    return Promise.resolve(state.snapshot);
  }
  state.running = rebuild(files)
    .catch(() => state.snapshot ?? { buckets: [], files: 0, generatedAt: Date.now() })
    .finally(() => {
      state.running = null;
    });
  return state.running;
}

/** 测试用：清空文件指纹与快照。 */
export function resetUsageCacheForTests(): void {
  globalThis.__piWebUsageCache = undefined;
}
