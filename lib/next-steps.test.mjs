import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { generateNextSteps, parseModelKey, parseNextSteps } = await jiti.import("./next-steps.ts");

function assistantMessage(text) {
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
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function replyWith(text, capture) {
  return (model, context, options) => {
    capture?.({ model, ...context, options, messages: [...context.messages] });
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: assistantMessage(text) });
    });
    return stream;
  };
}

test("reads a JSON array of suggestions", () => {
  assert.deepEqual(
    parseNextSteps('["运行 npm test","读一下 src/auth.ts"]'),
    ["运行 npm test", "读一下 src/auth.ts"],
  );
  assert.deepEqual(
    parseNextSteps('```json\n["Run the failing test"]\n```'),
    ["Run the failing test"],
  );
});

test("falls back to plain lines when the model ignores the JSON contract", () => {
  assert.deepEqual(
    parseNextSteps("1. Run the failing test\n2. Read src/auth.ts"),
    ["Run the failing test", "Read src/auth.ts"],
  );
});

test("drops a truncated JSON array instead of sending the fragment", () => {
  // The reply was cut off mid-array: the remaining text is not a suggestion.
  assert.deepEqual(parseNextSteps('["运行 npm test", "读一下 src/auth'), []);
  assert.deepEqual(parseNextSteps('["运行 npm test"'), []);
});

test("dedupes and caps the suggestions", () => {
  assert.deepEqual(
    parseNextSteps('["a","a","b","c","d"]'),
    ["a", "b", "c"],
  );
});

test("splits a provider/model key without losing slashes in the model id", () => {
  assert.deepEqual(parseModelKey("openrouter/anthropic/claude-sonnet-4"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4",
  });
  assert.equal(parseModelKey(""), null);
  assert.equal(parseModelKey("no-provider"), null);
  assert.equal(parseModelKey(undefined), null);
});

test("asks the configured model and leaves extension-injected messages out", async () => {
  let seen;
  const source = {
    agent: {
      state: {
        model: { provider: "test", id: "session-model", reasoning: false },
        messages: [
          { role: "custom", customType: "rules", content: "ADHD MODE ACTIVE", display: true, timestamp: 1 },
          { role: "user", content: "修复登录页", timestamp: 2 },
          assistantMessage("已定位到 slow-login.ts"),
        ],
      },
      streamFunction: replyWith('["看一下 slow-login.ts"]', (value) => { seen = value; }),
      getApiKey: async () => "key",
    },
    modelRuntime: {
      getModel: (provider, modelId) => ({ provider, id: modelId, reasoning: false }),
    },
  };

  const steps = await generateNextSteps(source, { provider: "other", modelId: "cheap" });

  assert.deepEqual(steps, ["看一下 slow-login.ts"]);
  assert.equal(seen.model.provider, "other");
  assert.equal(seen.model.id, "cheap");
  assert.equal(seen.options.cacheRetention, "none");
  const prompt = seen.messages.map((message) => JSON.stringify(message.content)).join("\n");
  assert.match(prompt, /修复登录页/);
  assert.doesNotMatch(prompt, /ADHD MODE ACTIVE/);
});

test("does not spend a request before the user has said anything", async () => {
  let called = false;
  const source = {
    agent: {
      state: {
        model: { provider: "test", id: "session-model", reasoning: false },
        messages: [{ role: "custom", customType: "rules", content: "rules", display: true, timestamp: 1 }],
      },
      streamFunction: () => { called = true; throw new Error("not called"); },
      getApiKey: async () => "key",
    },
    modelRuntime: { getModel: () => undefined },
  };

  assert.deepEqual(await generateNextSteps(source), []);
  assert.equal(called, false);
});

test("an aborted signal reaches the model request", async () => {
  const controller = new AbortController();
  controller.abort();
  let seen;
  const source = {
    agent: {
      state: {
        model: { provider: "test", id: "session-model", reasoning: false },
        messages: [{ role: "user", content: "do it", timestamp: 1 }],
      },
      streamFunction: (model, context, options) => {
        seen = options;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "aborted", message: { ...assistantMessage(""), stopReason: "aborted" } });
        });
        return stream;
      },
      getApiKey: async () => undefined,
    },
    modelRuntime: { getModel: () => undefined },
  };

  await assert.rejects(() => generateNextSteps(source, null, controller.signal), /timed out/);
  assert.equal(seen.signal.aborted, true);
});
