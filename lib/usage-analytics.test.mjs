import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getUsageSnapshot, resetUsageCacheForTests } = await jiti.import("./usage-analytics.ts");

/** 每个用例一份干净的临时 sessions 目录，互不干扰。 */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-usage-"));
  mkdirSync(join(root, "--proj--"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  resetUsageCacheForTests();
  return { root, file: join(root, "--proj--", "session.jsonl") };
}

const HEADER = JSON.stringify({ type: "session", id: "sess-1", cwd: "D:\\proj" });

function assistantLine(timestamp, usage, model = "deepseek-chat") {
  return JSON.stringify({
    type: "message",
    timestamp,
    message: { role: "assistant", provider: "testco", model, usage },
  });
}

function usageLine(timestamp, usage, model = "deepseek-chat") {
  return JSON.stringify({ type: "usage", timestamp, provider: "testco", model, usage });
}

function usage(input, output, cacheRead, total, cost) {
  return { input, output, cacheRead, cacheWrite: 0, total, cost: { total: cost } };
}

function write(file, lines) {
  writeFileSync(file, `${[HEADER, ...lines].join("\n")}\n`);
}

/** 和实现同一套口径：本地时区的 YYYY-MM-DD。 */
function expectedDate(timestamp) {
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

test("assistant message 的 usage 与 cost 进桶", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T10:00:00.000Z";
  write(file, [assistantLine(timestamp, usage(100, 20, 30, 150, 0.25))]);

  const snapshot = await getUsageSnapshot(root);

  assert.equal(snapshot.files, 1);
  assert.equal(snapshot.buckets.length, 1);
  const [bucket] = snapshot.buckets;
  assert.equal(bucket.date, expectedDate(timestamp));
  assert.equal(bucket.cwd, "D:\\proj");
  assert.equal(bucket.sessionId, "sess-1");
  assert.equal(bucket.model, "testco/deepseek-chat");
  assert.equal(bucket.calls, 1);
  assert.equal(bucket.cost, 0.25);
  assert.deepEqual(bucket.tokens, { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 150 });
});

test("独立 usage 条目单独记一条，没有 usage 的行被跳过", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T11:00:00.000Z";
  write(file, [
    assistantLine(timestamp, usage(10, 5, 0, 15, 0.1)),
    usageLine(timestamp, usage(0, 0, 5000, 5000, 0.02)),
    // 工具结果：体积大、没有 usage，必须被子串判断挡掉
    JSON.stringify({ type: "message", timestamp, message: { role: "toolResult", content: "x".repeat(5000) } }),
  ]);

  const snapshot = await getUsageSnapshot(root);

  assert.equal(snapshot.buckets.length, 1, "同一天同一模型合成一个桶");
  assert.equal(snapshot.buckets[0].calls, 2);
  assert.equal(snapshot.buckets[0].tokens.cacheRead, 5000);
  assert.ok(Math.abs(snapshot.buckets[0].cost - 0.12) < 1e-9);
});

test("不同模型、不同会话分桶", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T12:00:00.000Z";
  write(file, [
    assistantLine(timestamp, usage(1, 1, 0, 2, 0.01), "model-a"),
    assistantLine(timestamp, usage(2, 2, 0, 4, 0.02), "model-b"),
  ]);

  const snapshot = await getUsageSnapshot(root);

  assert.equal(snapshot.buckets.length, 2);
  const models = snapshot.buckets.map((bucket) => bucket.model).sort();
  assert.deepEqual(models, ["testco/model-a", "testco/model-b"]);
});

test("文件追加后重新取快照能看到新用量", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T13:00:00.000Z";
  write(file, [assistantLine(timestamp, usage(10, 1, 0, 11, 0.05))]);

  const first = await getUsageSnapshot(root);
  assert.equal(first.buckets[0].calls, 1);

  appendFileSync(file, `${assistantLine(timestamp, usage(20, 2, 0, 22, 0.07))}\n`);
  const second = await getUsageSnapshot(root);

  assert.equal(second.buckets[0].calls, 2);
  assert.ok(Math.abs(second.buckets[0].cost - 0.12) < 1e-9);
});

test("文件没变时复用快照，删掉文件后桶跟着消失", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T14:00:00.000Z";
  write(file, [assistantLine(timestamp, usage(5, 5, 0, 10, 0.03))]);

  const first = await getUsageSnapshot(root);
  const again = await getUsageSnapshot(root);
  assert.equal(again.generatedAt, first.generatedAt, "没改动时不该重新扫盘");

  rmSync(file);
  const afterDelete = await getUsageSnapshot(root);
  assert.equal(afterDelete.buckets.length, 0);
  assert.equal(afterDelete.files, 0);
});

test("坏行不影响同一文件里其它条目", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T15:00:00.000Z";
  write(file, [
    '{"type":"message","timestamp":"2026-10-19T15:00:00.000Z","message":{"usage":',
    assistantLine(timestamp, usage(7, 3, 0, 10, 0.04)),
  ]);

  const snapshot = await getUsageSnapshot(root);

  assert.equal(snapshot.buckets.length, 1);
  assert.equal(snapshot.buckets[0].cost, 0.04);
});

test("会话标题取 session_info 的 name", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T16:00:00.000Z";
  write(file, [
    JSON.stringify({ type: "session_info", timestamp, name: "重构鉴权模块" }),
    assistantLine(timestamp, usage(1, 1, 0, 2, 0.01)),
  ]);

  const snapshot = await getUsageSnapshot(root);

  assert.equal(snapshot.buckets[0].title, "重构鉴权模块");
});

test("没设名字时退回首条用户消息", async (t) => {
  const { root, file } = makeRoot(t);
  const timestamp = "2026-10-19T17:00:00.000Z";
  write(file, [
    JSON.stringify({
      type: "message",
      timestamp,
      message: { role: "user", content: [{ type: "text", text: "为什么构建这么慢" }] },
    }),
    assistantLine(timestamp, usage(1, 1, 0, 2, 0.01)),
  ]);

  const snapshot = await getUsageSnapshot(root);

  assert.equal(snapshot.buckets[0].title, "为什么构建这么慢");
});
