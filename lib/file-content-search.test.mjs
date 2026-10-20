import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isProbablyBinary, searchFileContents } = await jiti.import("./file-content-search.ts");

function fixture(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-content-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("returns the line number and the matched line, case-insensitively", (t) => {
  const dir = fixture(t, {
    "src/a.ts": "first\nconst Needle = 1;\nlast\n",
    "src/b.ts": "nothing here\n",
  });

  const { matches, truncated } = searchFileContents(dir, ["src/a.ts", "src/b.ts"], "needle");

  assert.deepEqual(matches, [{ path: "src/a.ts", line: 2, text: "const Needle = 1;" }]);
  assert.equal(truncated, false);
});

test("skips binary files and files past the size cap", (t) => {
  const dir = fixture(t, {
    "blob.bin": Buffer.from([0x4e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
    "big.txt": `${"x".repeat(64)}needle\n`,
    "ok.txt": "needle\n",
  });

  assert.equal(isProbablyBinary(Buffer.from([0x00, 0x01])), true);
  assert.equal(isProbablyBinary(Buffer.from("plain text")), false);

  const { matches } = searchFileContents(dir, ["blob.bin", "big.txt", "ok.txt"], "needle", {
    maxFileBytes: 32,
  });

  assert.deepEqual(matches.map((match) => match.path), ["ok.txt"]);
});

test("stops at the per-file and total result caps, reporting truncation", (t) => {
  const dir = fixture(t, {
    "many.txt": "needle\nneedle\nneedle\nneedle\nneedle\n",
    "more.txt": "needle\n",
  });

  const perFile = searchFileContents(dir, ["many.txt", "more.txt"], "needle", { maxResults: 200 });
  assert.deepEqual(perFile.matches.map((match) => match.line), [1, 2, 3, 1]);

  const capped = searchFileContents(dir, ["many.txt", "more.txt"], "needle", { maxResults: 2 });
  assert.equal(capped.matches.length, 2);
  assert.equal(capped.truncated, true);
});

test("a query with regex operators is matched literally", (t) => {
  const dir = fixture(t, { "a.ts": "const x = a.b * (c);\nconst y = abb;\n" });

  const { matches } = searchFileContents(dir, ["a.ts"], "a.b * (c)");

  assert.deepEqual(matches.map((match) => match.text), ["const x = a.b * (c);"]);
});

test("an empty query searches nothing", (t) => {
  const dir = fixture(t, { "a.ts": "needle\n" });

  assert.deepEqual(searchFileContents(dir, ["a.ts"], "   ").matches, []);
});
