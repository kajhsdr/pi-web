import fs from "fs";
import { NextResponse } from "next/server";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./file-access";

export type ProjectDirectoryResult = { directory: string } | { response: NextResponse };

/**
 * The `cwd` a project-wide request names, checked against the file allow-list
 * and resolved through links, as `/api/file-index` and the content search both
 * need. A request that may not read it answers 400, 403 or 404 here.
 */
export async function resolveProjectDirectory(value: string | null): Promise<ProjectDirectoryResult> {
  const cwd = value?.trim() ?? "";
  if (!cwd || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    return { response: NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 }) };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return { response: NextResponse.json({ error: "Directory not found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Not a directory" }, { status: 400 }) };
  }
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  return { directory: cwd };
}
