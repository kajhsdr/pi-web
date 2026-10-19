import assert from "node:assert/strict";
import test from "node:test";
import { isJsonlPath, parseJsonlRecords, recordSummary } from "./jsonl-records.ts";

test("parses one record per non-blank line, keeping line numbers", () => {
  const text = '{"type":"message","role":"user"}\n\n{"type":"model_change"}\r\n';

  const { records, truncated } = parseJsonlRecords(text);

  assert.deepEqual(records.map((record) => record.line), [1, 3]);
  assert.deepEqual(records[0].value, { type: "message", role: "user" });
  assert.equal(records[1].text, '{"type":"model_change"}');
  assert.equal(truncated, false);
});

test("a line that is not JSON is kept, with the parse error", () => {
  const { records } = parseJsonlRecords('{"ok":1}\nnot json\n');

  assert.equal(records.length, 2);
  assert.equal(records[1].error !== undefined, true);
  assert.equal(records[1].value, undefined);
});

test("stops at the record cap and reports truncation", () => {
  const text = Array.from({ length: 5 }, (_, index) => `{"n":${index}}`).join("\n");

  const { records, truncated } = parseJsonlRecords(text, 3);

  assert.equal(records.length, 3);
  assert.equal(truncated, true);
});

test("the summary names a record by its type and the fields that identify it", () => {
  assert.equal(recordSummary({ type: "message", role: "user", id: "abc" }), "type: message · role: user · id: abc");
  assert.equal(recordSummary({}), "{}");
  assert.equal(recordSummary([1, 2]), "Array(2)");
  assert.equal(recordSummary("plain"), "plain");
  assert.equal(recordSummary({ alpha: 1, beta: 2 }), "alpha, beta");
});

test("only .jsonl and .ndjson open as records", () => {
  assert.equal(isJsonlPath("/tmp/session.jsonl"), true);
  assert.equal(isJsonlPath("/tmp/session.NDJSON"), true);
  assert.equal(isJsonlPath("/tmp/session.json"), false);
});
