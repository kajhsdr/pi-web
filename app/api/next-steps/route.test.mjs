import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-next-steps-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

const settingsPath = path.join(agentDir, "pi-web-next-steps.json");

function put(body, headers = { host: "localhost", "Content-Type": "application/json" }) {
  return PUT(new Request("http://localhost/api/next-steps", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

test("off until it is turned on, and no file appears for reading the default", async () => {
  assert.deepEqual(await (await GET()).json(), { enabled: false });
  await assert.rejects(readFile(settingsPath, "utf8"), { code: "ENOENT" });
});

test("saves the switch and the model, and clears the model with an empty string", async () => {
  assert.deepEqual(await (await put({ enabled: true })).json(), { enabled: true });
  assert.deepEqual(await (await put({ model: "other/cheap" })).json(), {
    enabled: true,
    model: "other/cheap",
  });
  assert.deepEqual(await (await put({ model: "" })).json(), { enabled: true });
  // The next GET reads what was written, not a cached copy.
  assert.deepEqual(await (await GET()).json(), { enabled: true });
});

test("two saves in flight together keep both fields", async () => {
  await put({ enabled: false, model: "" });
  await Promise.all([
    put({ enabled: true }),
    put({ model: "other/model" }),
  ]);
  assert.deepEqual(await (await GET()).json(), { enabled: true, model: "other/model" });
});

test("rejects a foreign host, a non-JSON body and bad values", async () => {
  assert.equal((await put({ enabled: true }, { host: "evil.example" })).status, 403);
  assert.equal((await put("{", { host: "localhost", "Content-Type": "application/json" })).status, 400);
  assert.equal((await put({ enabled: true }, { host: "localhost", "Content-Type": "text/plain" })).status, 415);
  assert.equal((await put({ enabled: "true" })).status, 400);
  assert.equal((await put({ model: 3 })).status, 400);
});
