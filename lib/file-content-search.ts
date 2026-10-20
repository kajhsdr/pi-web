import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { hasParentDirectorySegment, isPathWithinRoots, resolveRealRoots } from "./path-security";

const MAX_FILES = 4000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RESULTS = 200;
const MAX_RESULTS_PER_FILE = 3;
const MAX_LINE_CHARS = 400;
const TIME_BUDGET_MS = 3000;
const BINARY_PROBE_BYTES = 8 * 1024;

export interface FileContentMatch {
  /** Path relative to the search root. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** The matched line, trimmed and windowed around the match. */
  text: string;
}

export interface FileContentSearchOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxResults?: number;
  timeBudgetMs?: number;
  signal?: AbortSignal;
  /** 搜索中的链接目标也必须位于这组已授权根内。 */
  allowedRoots?: Set<string>;
}

export interface FileContentSearchResponse {
  matches: FileContentMatch[];
  filesSearched: number;
  /** True when a cap or the time budget stopped the scan early. */
  truncated: boolean;
}

/** A NUL byte in the head of the file: an image, an archive, a compiled binary. */
export function isProbablyBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < end; index++) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function clipLine(line: string, matchIndex: number): string {
  const lead = line.length - line.trimStart().length;
  const trimmed = line.trim();
  if (trimmed.length <= MAX_LINE_CHARS) return trimmed;
  const start = Math.max(0, matchIndex - lead - 60);
  const end = Math.min(trimmed.length, start + MAX_LINE_CHARS);
  return `${start > 0 ? "…" : ""}${trimmed.slice(start, end)}${end < trimmed.length ? "…" : ""}`;
}

/**
 * Literal, case-insensitive search through the given files under `root`.
 *
 * Synchronous and unindexed, like the session search: bounded by file count,
 * file size, result count and a time budget, so a query on a large repository
 * stops with `truncated` instead of stalling the server.
 */
export function searchFileContents(
  root: string,
  files: readonly string[],
  query: string,
  options: FileContentSearchOptions = {},
): FileContentSearchResponse {
  const response: FileContentSearchResponse = { matches: [], filesSearched: 0, truncated: false };
  const needle = query.trim();
  if (!needle) return response;

  const maxFiles = options.maxFiles ?? MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxResults = options.maxResults ?? MAX_RESULTS;
  const deadline = Date.now() + (options.timeBudgetMs ?? TIME_BUDGET_MS);
  const signal = options.signal;
  const realRoots = resolveRealRoots(options.allowedRoots ?? new Set([root]));
  // Literal search: every operator escaped, so offsets stay in the real line.
  const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  for (const relative of files) {
    if (
      response.matches.length >= maxResults
      || response.filesSearched >= maxFiles
      || signal?.aborted
      || Date.now() >= deadline
    ) {
      response.truncated = true;
      break;
    }

    let buffer: Buffer;
    try {
      if (hasParentDirectorySegment(relative)) continue;
      const realFile = realpathSync(join(root, relative));
      if (!isPathWithinRoots(realFile, realRoots)) continue;
      const stat = statSync(realFile);
      if (!stat.isFile() || stat.size === 0 || stat.size > maxFileBytes) continue;
      buffer = readFileSync(realFile);
    } catch {
      continue;
    }
    if (isProbablyBinary(buffer)) continue;

    response.filesSearched++;
    const lines = buffer.toString("utf8").split("\n");
    let perFile = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line) continue;
      const match = matcher.exec(line);
      if (!match) continue;
      response.matches.push({
        path: relative,
        line: index + 1,
        text: clipLine(line.replace(/\r$/, ""), match.index),
      });
      perFile++;
      if (perFile >= MAX_RESULTS_PER_FILE || response.matches.length >= maxResults) break;
    }
  }

  return response;
}
