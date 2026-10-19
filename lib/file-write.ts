import { encodeFilePathForApi } from "./file-paths";

/**
 * Saving a file the viewer already read. `expectedMtimeMs` is the read's
 * `mtimeMs`: the server refuses a save when the file changed on disk since
 * then, and answers with what is there now so the editor can offer a reload.
 */
export type FileWriteResult =
  | { ok: true; mtimeMs: number; size: number }
  | { ok: false; reason: "conflict"; error: string; mtimeMs: number; size: number }
  | { ok: false; reason: "error"; error: string };

export function fileWriteUrl(filePath: string, sessionId?: string | null): string {
  const searchParams = new URLSearchParams({ type: "write" });
  if (sessionId) searchParams.set("sessionId", sessionId);
  return `/api/files/${encodeFilePathForApi(filePath)}?${searchParams.toString()}`;
}

export async function writeFileContent(options: {
  filePath: string;
  content: string;
  expectedMtimeMs: number;
  sessionId?: string | null;
  signal?: AbortSignal;
}): Promise<FileWriteResult> {
  let response: Response;
  try {
    response = await fetch(fileWriteUrl(options.filePath, options.sessionId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: options.content,
        expectedMtimeMs: options.expectedMtimeMs,
      }),
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error | undefined)?.name === "AbortError") throw error;
    return { ok: false, reason: "error", error: String(error) };
  }

  const body = await response.json().catch(() => null) as
    | { error?: string; mtimeMs?: number; size?: number }
    | null;

  if (response.ok) {
    return {
      ok: true,
      mtimeMs: typeof body?.mtimeMs === "number" ? body.mtimeMs : options.expectedMtimeMs,
      size: typeof body?.size === "number" ? body.size : options.content.length,
    };
  }

  const error = body?.error ?? `Save failed (${response.status})`;
  if (response.status === 409 && typeof body?.mtimeMs === "number") {
    return {
      ok: false,
      reason: "conflict",
      error,
      mtimeMs: body.mtimeMs,
      size: typeof body.size === "number" ? body.size : 0,
    };
  }
  return { ok: false, reason: "error", error };
}
