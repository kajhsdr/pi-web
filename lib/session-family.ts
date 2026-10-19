import type { SessionInfo } from "./types";

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string | null>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = session.id;
    let rootId: string | null = null;

    while (true) {
      if (roots.has(currentId)) {
        rootId = roots.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;

      visited.add(currentId);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (current.relation?.kind !== "subagent") {
        rootId = current.id;
        break;
      }
      currentId = current.relation.parentSessionId;
    }

    for (const id of path) roots.set(id, rootId);
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const rootId = rootsBySessionId.get(session.id);
    const family = rootId ? families.get(rootId) : undefined;
    if (!family) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  return [...families.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}

/** Subagents of a family that the sidebar's running poll lists. */
export function countRunningSubagents(
  subagents: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): number {
  return subagents.filter((session) => runningSessionIds.has(session.id)).length;
}

/** The top bar's Agents badge: how many run while any does, else how many there are. */
export function getAgentsBadge(
  subagents: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): { count: number; running: boolean } {
  const running = countRunningSubagents(subagents, runningSessionIds);
  return running > 0 ? { count: running, running: true } : { count: subagents.length, running: false };
}

/**
 * The family's subagents as a tree: each parent's children keep the flat
 * list's order (running first, then newest), so a subagent spawned by another
 * subagent sits indented under it instead of ahead of it. A relation naming a
 * parent outside the family is treated as a child of the session itself.
 */
export function agentTreeOrder(
  subagents: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): Array<{ session: SessionInfo; depth: number }> {
  const known = new Set(subagents.map((session) => session.id));
  const byParent = new Map<string | null, SessionInfo[]>();
  for (const session of subagents) {
    const parentSessionId = session.relation?.kind === "subagent" ? session.relation.parentSessionId : null;
    const key = parentSessionId && known.has(parentSessionId) ? parentSessionId : null;
    const siblings = byParent.get(key);
    if (siblings) siblings.push(session);
    else byParent.set(key, [session]);
  }

  const compare = (a: SessionInfo, b: SessionInfo) => {
    const aRunning = runningSessionIds.has(a.id);
    const bRunning = runningSessionIds.has(b.id);
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  };

  const ordered: Array<{ session: SessionInfo; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const child of (byParent.get(parentId) ?? []).sort(compare)) {
      ordered.push({ session: child, depth });
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  return ordered;
}
