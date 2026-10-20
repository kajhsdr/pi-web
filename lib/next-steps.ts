import { randomUUID } from "node:crypto";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  normalizeContext,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { buildTitleTranscript, resolveTitleThinkingLevel } from "./session-title";

// Next-step suggestions (#1341): after a run settles, one cheap extra request
// turns the transcript into 1–3 messages the user could send next. It reuses
// the session-title machinery — same transcript budget, same one-shot request
// shape, same "cheapest thinking level" rule — because both are short
// classifications of an existing transcript rather than a new conversation.

const NEXT_STEPS_TIMEOUT_MS = 45_000;
const NEXT_STEPS_MAX_TOKENS = 512;
/** More than three chips is a menu, not a next step. */
export const MAX_NEXT_STEPS = 3;
const STEP_MAX_CHARS = 160;

const SYSTEM_PROMPT =
  "You list the next actions a developer can take. Reply with a JSON array of strings only.";

const NEXT_STEPS_PROMPT = `List the next actions for this session.

Requirements:
- 1 to 3 items. Fewer is better when fewer are clear.
- Match the language the user writes in.
- Each item is a complete instruction the user could send as their next message: imperative, self-contained, at most one short sentence (CJK text: at most 24 characters).
- Order them from the most unblocking to the least.
- Pick the smallest action that removes the most uncertainty now: run one command, read one file, write one test.
- Name concrete paths, commands and identifiers only when the conversation gives them. Never invent any.
- Do not number the items. Do not end with a question mark.
- Reply with the JSON array only: no code fence, no commentary, no keys.`;

/** Strip the wrapping a model likes to add and reject anything unusable. */
function cleanStep(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();
  value = value.replace(/^(?:[-*•]|\d+[.)])\s+/, "");
  value = value.replace(/^["'`“「『](.*)["'`”」』]$/u, "$1").trim();
  value = value.replace(/\s+/g, " ").trim();
  const characters = Array.from(value);
  if (characters.length > STEP_MAX_CHARS) value = `${characters.slice(0, STEP_MAX_CHARS).join("").trim()}…`;
  return value;
}

/**
 * The model is asked for a JSON array, but a single plain sentence is a fine
 * answer too: take it rather than showing nothing.
 */
export function parseNextSteps(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  const items: string[] = [];
  if (start >= 0) {
    // A "[" means the model chose the JSON contract. If the array is cut off or
    // unparsable the answer is truncated, and the fragment ("Run the tests", "Read
    // lib/a.ts) is not a suggestion: show nothing rather than send it as a prompt.
    if (end <= start) return [];
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item !== "string") continue;
          const step = cleanStep(item);
          if (step) items.push(step);
        }
      }
    } catch {
      return [];
    }
  }
  if (start < 0) {
    for (const line of raw.replace(/```/g, "").split(/\r?\n/)) {
      const step = cleanStep(line);
      if (step) items.push(step);
      if (items.length >= MAX_NEXT_STEPS) break;
    }
  }
  const unique = [...new Set(items)];
  return unique.slice(0, MAX_NEXT_STEPS);
}

/**
 * "provider/modelId" as stored in the settings (the modelId may itself contain
 * slashes, as OpenRouter's do) split into the two halves the runtime takes.
 * Null for an empty or malformed value, which means "the session's model".
 */
export function parseModelKey(key: string | undefined): { provider: string; modelId: string } | null {
  const raw = key?.trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

function stepsFromAssistant(message: AssistantMessage): string[] {  if (message.stopReason === "error") {
    throw new Error(message.errorMessage || "The next-step model request failed");
  }
  if (message.stopReason === "aborted") throw new Error("Next-step generation timed out");
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) return [];
  return parseNextSteps(text);
}

/**
 * Generate the next-step suggestions for a settled run.
 *
 * `preferred` is the model chosen in Settings › General; when it is missing or
 * unknown the session's own model is used, which is what the session-title
 * generator always does.
 */
export async function generateNextSteps(
  source: AgentSession,
  preferred?: { provider: string; modelId: string } | null,
  signal?: AbortSignal,
): Promise<string[]> {
  const agent = source.agent;
  const chosen: Model<never> | undefined = preferred
    ? (source.modelRuntime.getModel(preferred.provider, preferred.modelId) as Model<never> | undefined)
    : undefined;
  const model = (chosen ?? agent.state.model) as Model<never> | undefined;
  if (!model) throw new Error("No model is selected");

  // Nothing to suggest before the user has said anything. Extension-injected
  // custom messages (a ruleset, a context block) are left out: they are
  // instructions to the model, not turns of the conversation, and a transcript
  // full of them produces suggestions about the instructions.
  const conversation = agent.state.messages.filter((message) =>
    message.role === "user"
    || message.role === "assistant"
    || message.role === "compactionSummary"
    || message.role === "branchSummary");
  const transcript = buildTitleTranscript(conversation);
  if (!transcript.trim()) return [];

  const thinkingLevel = resolveTitleThinkingLevel(model);
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [{ type: "text", text: `${transcript}\n\n${NEXT_STEPS_PROMPT}` }],
      timestamp: Date.now(),
    }],
  };

  if (signal?.aborted) return [];
  const apiKey = await agent.getApiKey?.(model.provider);
  // 凭据读取期间也可能取消，取消后不再发起付费请求。
  if (signal?.aborted) return [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, NEXT_STEPS_TIMEOUT_MS);
  const options: SimpleStreamOptions = {
    maxTokens: NEXT_STEPS_MAX_TOKENS,
    cacheRetention: "none",
    sessionId: randomUUID(),
    signal: controller.signal,
    ...(agent.transport ? { transport: agent.transport } : {}),
    ...(agent.thinkingBudgets ? { thinkingBudgets: agent.thinkingBudgets } : {}),
    ...(agent.maxRetryDelayMs ? { maxRetryDelayMs: agent.maxRetryDelayMs } : {}),
    ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    ...(apiKey ? { apiKey } : {}),
  };

  try {
    const stream = await agent.streamFunction(model, normalizeContext(context), options);
    return stepsFromAssistant(await stream.result());
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Next-step generation timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
