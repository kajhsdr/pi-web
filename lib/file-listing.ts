import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { isHiddenOutsideGit } from "./file-tree-visibility";

const execFileAsync = promisify(execFile);

/** Hard caps on the full in-memory listing */
export const GIT_HARD_CAP = 200_000;
export const WALK_HARD_CAP = 50_000;
const MAX_WALK_DEPTH = 8;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

export interface FileListing {
  /** Paths relative to the listing root. */
  files: string[];
  /** True when even the hard cap was exceeded. */
  hardTruncated: boolean;
}

async function listWithGit(cwd: string): Promise<FileListing | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
    );
    const all = stdout.split("\0").filter(Boolean);
    if (all.length > GIT_HARD_CAP) {
      return { files: all.slice(0, GIT_HARD_CAP), hardTruncated: true };
    }
    return { files: all, hardTruncated: false };
  } catch {
    // Not a git repo (or git unavailable) — caller falls back to readdir walk.
    return null;
  }
}

function listWithWalk(cwd: string): FileListing {
  const files: string[] = [];
  // BFS so shallow files win when the cap truncates the listing.
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: cwd, rel: "", depth: 0 }];
  while (queue.length > 0) {
    const { abs, rel, depth } = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      // The file tree's name list, only for this non-git fallback. Git repos
      // rely on .gitignore instead (matches the TUI's fd behavior).
      if (isHiddenOutsideGit(d.name)) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (depth + 1 <= MAX_WALK_DEPTH) {
          queue.push({ abs: path.join(abs, d.name), rel: childRel, depth: depth + 1 });
        }
      } else if (d.isFile()) {
        if (files.length >= WALK_HARD_CAP) {
          return { files, hardTruncated: true };
        }
        files.push(childRel);
      }
    }
  }
  return { files, hardTruncated: false };
}

/** Every file under `cwd`, honouring `.gitignore` when `cwd` is a repository. */
export async function listProjectFiles(cwd: string): Promise<FileListing> {
  return (await listWithGit(cwd)) ?? listWithWalk(cwd);
}

// Per-cwd cache on globalThis so it survives Next.js hot-reload: the @ menu and
// the sidebar search both ask repeatedly, and a listing must not be recomputed
// within a short window.
declare global {
  var __piFileListingCache: Map<string, { listing: FileListing; expiresAt: number }> | undefined;
}

/** `listProjectFiles` with the short TTL the file index and search share. */
export async function getFileListing(cwd: string): Promise<FileListing> {
  const cache = (globalThis.__piFileListingCache ??= new Map());
  const now = Date.now();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > now) return cached.listing;
  const listing = await listProjectFiles(cwd);
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(cwd, { listing, expiresAt: now + CACHE_TTL_MS });
  return listing;
}
