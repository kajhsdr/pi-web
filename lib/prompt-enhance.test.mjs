import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enhancePrompt, parseEnhancedPrompt, ENHANCED_MAX_CHARS } = await jiti.import("./prompt-enhance.ts");

function assistant(text, stopReason = "stop") {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

test("strips the fence and the quotes a model wraps the answer in", () => {
  assert.equal(parseEnhancedPrompt("```\n修复登录页\n```"), "修复登录页");
  assert.equal(parseEnhancedPrompt('"修复登录页"'), "修复登录页");
  assert.equal(parseEnhancedPrompt("  保持原样，不动  "), "保持原样，不动");
  assert.equal(parseEnhancedPrompt('他说 "先跑测试"，别的没提'), '他说 "先跑测试"，别的没提');
});

test("bounds a runaway reply", () => {
  const long = "字".repeat(ENHANCED_MAX_CHARS + 50);
  assert.equal(Array.from(parseEnhancedPrompt(long)).length, ENHANCED_MAX_CHARS);
});

test("sends the note with the instructions and returns the rewritten prompt", async () => {
  let seen;
  const runtime = {
    completeSimple: async (model, context, options) => {
      seen = { model, context, options };
      return assistant("整理后的提示词");
    },
  };
  const model = { provider: "test", id: "test-model", reasoning: false };

  const result = await enhancePrompt(runtime, model, "登录那块有点乱，帮我理一下");

  assert.equal(result, "整理后的提示词");
  assert.equal(seen.model, model);
  assert.equal(seen.options.cacheRetention, "none");
  const text = JSON.stringify(seen.context.messages[0].content);
  assert.match(text, /登录那块有点乱/);
  assert.match(text, /Rewrite the note below/);
});

test("asks a reasoning model for its cheapest thinking level", async () => {
  let seen;
  const runtime = {
    completeSimple: async (model, context, options) => {
      seen = options;
      return assistant("ok");
    },
  };
  // getSupportedThinkingLevels lists levels in ascending cost order; marking
  // `off` unsupported leaves the cheapest usable one.
  const model = {
    provider: "test",
    id: "reasoning-model",
    reasoning: true,
    thinkingLevelMap: { off: null },
  };

  await enhancePrompt(runtime, model, "note");

  assert.equal(seen.reasoning, "minimal");
});

test("surfaces a failed request instead of returning an empty prompt", async () => {
  const runtime = { completeSimple: async () => assistant("", "error") };
  await assert.rejects(
    () => enhancePrompt(runtime, { provider: "test", id: "m", reasoning: false }, "note"),
    /failed/i,
  );
});

test("rejects a cut-off reply rather than replacing the note with half a prompt", async () => {
  const runtime = { completeSimple: async () => assistant("整理了一半", "length") };
  await assert.rejects(
    () => enhancePrompt(runtime, { provider: "test", id: "m", reasoning: false }, "note"),
    /cut off/i,
  );
});
