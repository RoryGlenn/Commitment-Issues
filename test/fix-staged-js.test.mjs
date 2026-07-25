// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  cleanupTempRepo,
  createTempRepo,
  readFile,
  run,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runFixStagedJs(tempDir, files, options = {}) {
  const { cwd = tempDir, ...runOptions } = options;
  return run(
    "node",
    [path.join(tempDir, "scripts", "fix-staged-js.mjs"), ...files],
    cwd,
    runOptions,
  );
}

test("formats given files and exits 0 when everything is auto-fixable", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "fixme.js"), "export const x=1;\n");

  const result = runFixStagedJs(tempDir, ["src/fixme.js"]);

  assert.equal(result.status, 0);
  assert.equal(readFile(tempDir, "src/fixme.js"), "export const x = 1;\n");
});

test("exits 1 when a file has remaining non-fixable lint issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "broken.js"), "const unused=1\n");

  const result = runFixStagedJs(tempDir, ["src/broken.js"]);

  // ESLint cannot fix no-unused-vars, but Prettier still reformats the file.
  assert.equal(result.status, 1);
  assert.equal(readFile(tempDir, "src/broken.js"), "const unused = 1;\n");
});

test("formats a TypeScript file and exits 0 when auto-fixable", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "fixme.ts"), "export const x=1;\n");

  const result = runFixStagedJs(tempDir, ["src/fixme.ts"]);

  assert.equal(result.status, 0);
  assert.equal(readFile(tempDir, "src/fixme.ts"), "export const x = 1;\n");
});

test("preserves caller-relative file arguments below the root", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const nested = path.join(tempDir, "nested path");
  writeFile(path.join(nested, "fixme.js"), "export const x=1;\n");

  const result = runFixStagedJs(tempDir, ["fixme.js"], { cwd: nested });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(
    readFile(tempDir, "nested path/fixme.js"),
    "export const x = 1;\n",
  );
});

test("exits 0 immediately when given no file arguments", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runFixStagedJs(tempDir, []);

  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.trim(), "");
});

test("exits 1 when Prettier cannot parse the file", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A syntax error makes both ESLint and Prettier fail; the Prettier failure
  // branch flips hasRemainingIssues too.
  writeFile(path.join(tempDir, "src", "syntax.js"), "const x = ;\n");

  const result = runFixStagedJs(tempDir, ["src/syntax.js"]);

  assert.equal(result.status, 1);
});

test("reports every missing local fixer without a command fallback", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "missing.js"), "export const x=1;\n");
  fs.unlinkSync(path.join(tempDir, "node_modules"));
  fs.mkdirSync(path.join(tempDir, "node_modules"));

  const result = runFixStagedJs(tempDir, ["src/missing.js"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /missing local tool\(s\): eslint, prettier/i);
  assert.match(output, /npm install -D eslint@\^9 prettier@\^3/);
});
