import { dirname, resolve } from "node:path";
import { sessionPathKey } from "./session-path";

export interface UsageLineageHeader {
  parentSession?: unknown;
  /** 仅供费用去重使用；删除重写时保留原始祖先，不参与侧栏关系判断。 */
  piWebUsageAncestorPaths?: unknown;
}

/** 兼容旧头部，并将当前父会话和持久计费祖先统一为去重后的绝对路径。 */
export function usageAncestorPaths(header: UsageLineageHeader, filePath: string): string[] {
  const candidates = [
    header.parentSession,
    ...(Array.isArray(header.piWebUsageAncestorPaths) ? header.piWebUsageAncestorPaths : []),
  ];
  const paths = new Map<string, string>();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate || candidate.includes("\0")) continue;
    const path = resolve(dirname(filePath), candidate);
    paths.set(sessionPathKey(path), path);
  }
  paths.delete(sessionPathKey(resolve(filePath)));
  return [...paths.values()];
}
