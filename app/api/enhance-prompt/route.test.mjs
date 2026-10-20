import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// The route resolves the shared model runtime; the fixture answers with
// whatever this test assigned. The alias takes the module's absolute path
// without its extension, in the form jiti compares it with (forward slashes,
// an upper-case drive letter on Windows) — the same trick
// components/SessionSidebar.tabs.test.mjs uses.
const runtimeModule = fileURLToPath(new URL("../../../lib/model-runtime", import.meta.url))
  .replaceAll("\\", "/")
  .replace(/^[a-z]:/, (drive) => drive.toUpperCase());
const jiti = createJiti(import.meta.url, {
  tsconfigPaths: true,
  alias: {
    [runtimeModule]: fileURLToPath(new URL("./__fixtures__/model-runtime.mjs", import.meta.url)),
  },
});
const { POST } = await jiti.import("./route.ts");

function assistant(text = "整理后的提示词", stopReason = "stop") {
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

function runtimeWith({ reply = assistant(), known = true } = {}) {
  return {
    getModel: (provider, id) => (known ? { provider, id, reasoning: false } : undefined),
    completeSimple: async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

function post(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return POST(new Request("http://localhost/api/enhance-prompt", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const VALID = { text: "登录那块有点乱", provider: "test", modelId: "test-model" };

test("rewrites the note with the model the composer names", async () => {
  globalThis.__piWebEnhanceRuntime = runtimeWith();
  const response = await post(VALID);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "整理后的提示词" });
});

test("rejects a foreign host, a non-JSON body and a malformed request", async () => {
  globalThis.__piWebEnhanceRuntime = runtimeWith();
  assert.equal((await post(VALID, { host: "evil.example", "Content-Type": "application/json" })).status, 403);
  assert.equal((await post(VALID, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("{", { host: "localhost", "Content-Type": "application/json" })).status, 400);
  assert.equal((await post({ provider: "test", modelId: "m" })).status, 400);
  assert.equal((await post({ ...VALID, text: "   " })).status, 400);
  assert.equal((await post({ text: "x", modelId: "m" })).status, 400);
});

test("refuses a note longer than the cap", async () => {
  globalThis.__piWebEnhanceRuntime = runtimeWith();
  assert.equal((await post({ ...VALID, text: "字".repeat(20_001) })).status, 413);
});

test("reports an unknown model instead of calling the provider", async () => {
  globalThis.__piWebEnhanceRuntime = runtimeWith({ known: false });
  const response = await post(VALID);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /Model not found/);
});

test("turns a provider failure into a 500 with its message", async () => {
  globalThis.__piWebEnhanceRuntime = runtimeWith({ reply: new Error("provider exploded") });
  const response = await post(VALID);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /provider exploded/);
});

test("a cut-off reply is an error, not a shortened prompt", async () => {
  globalThis.__piWebEnhanceRuntime = runtimeWith({ reply: assistant("半截", "length") });
  const response = await post(VALID);
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /cut off/i);
});
