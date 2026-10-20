import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Model, Api } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveTitleThinkingLevel } from "./session-title";

// The composer's "improve prompt" button (#1312): rewrite whatever is typed
// into the input as a precise prompt, then put the result back for review.
// Nothing is sent — the same contract the OpenAI community thread describes
// (write → improve → review → send), which is also what Cursor and Trae do
// with their sparkle button.

const ENHANCE_TIMEOUT_MS = 60_000;
const ENHANCE_MAX_TOKENS = 2048;
/** The composer's own limit is far below this; it only bounds a runaway reply. */
export const ENHANCED_MAX_CHARS = 20_000;

const SYSTEM_PROMPT = "You rewrite a rough developer note into a precise prompt. Reply with the prompt only.";

const ENHANCE_PROMPT = `Rewrite the note below as a precise prompt for a coding agent.

Rules:
- Preserve the user's language and intent. Never invent requirements, files, or facts.
- Make the goal, the constraints, the relevant paths, and the expected output explicit only when the note implies them.
- Use short numbered steps when the task has several parts; otherwise one tight paragraph.
- Keep every @file reference, path, command, code fragment, and error message character-for-character.
- If the note starts with a /command, keep that command unchanged as the first token and rewrite only the text after it.
- Reply with the rewritten prompt only: no preamble, no explanation, no surrounding code fence, no quotes around it.`;

/** Strip a fence or quoting wrapper a model adds around the whole answer. */
export function parseEnhancedPrompt(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (fenced) value = fenced[1].trim();
  const quoted = value.match(/^"([\s\S]*)"$/);
  if (quoted && !quoted[1].includes('"')) value = quoted[1].trim();
  const characters = Array.from(value);
  if (characters.length > ENHANCED_MAX_CHARS) {
    value = characters.slice(0, ENHANCED_MAX_CHARS).join("").trim();
  }
  return value;
}

function textOf(message: AssistantMessage): string {
  if (message.stopReason === "error") {
    throw new Error(message.errorMessage || "The model request failed");
  }
  if (message.stopReason === "aborted") throw new Error("Prompt enhancement timed out");
  // A cut-off reply would replace the user's note with half a prompt.
  if (message.stopReason === "length") {
    throw new Error("The reply was cut off; shorten the note and try again");
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * One standalone request: the note the user typed, no tools, no session prefix.
 * `runtime` is the shared extension-loaded runtime the settings and provider
 * routes use, so this works for a chat that has no wrapper yet (a fresh
 * session), where there is no session model to borrow.
 */
export async function enhancePrompt(
  runtime: ModelRuntime,
  model: Model<Api>,
  note: string,
  signal?: AbortSignal,
): Promise<string> {
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [{ type: "text", text: `## Note\n\n${note}\n\n## Task\n\n${ENHANCE_PROMPT}` }],
      timestamp: Date.now(),
    }],
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, ENHANCE_TIMEOUT_MS);
  const thinkingLevel = resolveTitleThinkingLevel(model);

  try {
    // `completeSimple`, not `complete`: it is the path that honours `reasoning`
    // and routes a virtual model through the extension that registered it.
    const message = await runtime.completeSimple(model, context, {
      maxTokens: ENHANCE_MAX_TOKENS,
      cacheRetention: "none",
      sessionId: randomUUID(),
      signal: controller.signal,
      ...(thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
    });
    const text = parseEnhancedPrompt(textOf(message));
    if (!text) throw new Error("The model returned an empty prompt");
    return text;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Prompt enhancement timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
