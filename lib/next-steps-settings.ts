import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";

// Pi Web's own setting for the next-step suggestions (#1341): whether a
// settled run asks a model for 1–3 follow-up messages, and which model asks.
// It is not a pi setting, so it lives in its own file beside pi's settings.json
// rather than as an unknown key inside it. Written the way every other
// pi-web-owned agent-dir file is: one queue per path, temp file, rename, 0600.

export interface NextStepsSettings {
  /** Off by default: every run that turns this on spends one extra request. */
  enabled: boolean;
  /** "provider/modelId"; empty means the session's own model. */
  model?: string;
}

export interface NextStepsSettingsPatch {
  enabled?: boolean;
  model?: string;
}

const DEFAULTS: NextStepsSettings = { enabled: false };
const WRITE_QUEUE_KEY: symbol = Symbol.for("pi-web:next-steps-settings");

export function getNextStepsSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-next-steps.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(settings: NextStepsSettings): NextStepsSettings {
  const model = settings.model?.trim();
  return {
    enabled: settings.enabled === true,
    ...(model ? { model } : {}),
  };
}

/** Read the file as settings; anything unreadable means "as configured by default". */
export function parseNextStepsSettings(raw: string | undefined): NextStepsSettings {
  if (!raw) return { ...DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (!isRecord(parsed)) return { ...DEFAULTS };
  return normalize({
    enabled: parsed.enabled === true,
    model: typeof parsed.model === "string" ? parsed.model : undefined,
  });
}

export async function readNextStepsSettings(): Promise<NextStepsSettings> {
  try {
    return parseNextStepsSettings(await readFile(getNextStepsSettingsPath(), "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Apply a patch under the file's queue, so two Settings clicks in quick
 * succession (the switch, then the model) cannot each write a copy that
 * predates the other.
 */
export async function updateNextStepsSettings(
  patch: NextStepsSettingsPatch,
): Promise<NextStepsSettings> {
  const path = getNextStepsSettingsPath();
  return serializeByKey(WRITE_QUEUE_KEY, path, async () => {
    const current = await readNextStepsSettings();
    const next = normalize({
      enabled: patch.enabled ?? current.enabled,
      model: patch.model !== undefined ? patch.model : current.model,
    });
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}
