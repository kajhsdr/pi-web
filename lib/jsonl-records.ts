/** Above this many records the preview stops listing and says so. */
export const JSONL_MAX_RECORDS = 2000;

/** `.jsonl` and `.ndjson` open as records, the way markdown opens rendered. */
export function isJsonlPath(filePath: string): boolean {
  return /\.(jsonl|ndjson)$/i.test(filePath);
}

export interface JsonlRecord {
  /** 1-based line number in the file. */
  line: number;
  /** The parsed value, or undefined when the line is not JSON. */
  value?: unknown;
  /** The line as it appears in the file, whitespace trimmed. */
  text: string;
  /** Why the line could not be parsed. */
  error?: string;
}

/**
 * One entry per non-blank line of a `.jsonl` / `.ndjson` file. A line that is
 * not JSON is kept as a record with `error`, so a broken file still shows what
 * is there instead of failing whole.
 */
export function parseJsonlRecords(text: string, maxRecords = JSONL_MAX_RECORDS): {
  records: JsonlRecord[];
  truncated: boolean;
} {
  const records: JsonlRecord[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].replace(/\r$/, "");
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (records.length >= maxRecords) return { records, truncated: true };
    try {
      records.push({ line: index + 1, value: JSON.parse(trimmed), text: trimmed });
    } catch (error) {
      records.push({ line: index + 1, text: trimmed, error: String((error as Error)?.message ?? error) });
    }
  }
  return { records, truncated: false };
}

/**
 * The one-line label of a record: its `type` and any scalar fields that name
 * it, which is what a session entry has to say for itself.
 */
export function recordSummary(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `Array(${value.length})`;
  const preferred = ["type", "role", "name", "modelId", "provider", "toolName", "id"];
  const parts: string[] = [];
  for (const key of preferred) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string" || typeof field === "number") parts.push(`${key}: ${field}`);
    if (parts.length >= 3) break;
  }
  if (parts.length === 0) {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? "{}" : keys.slice(0, 4).join(", ");
  }
  return parts.join(" · ");
}
