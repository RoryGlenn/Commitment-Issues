// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  recordingGitEnv,
  run,
  setPrecommitConfig,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runPrecommit(tempDir, options = {}) {
  return run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    options,
  );
}

function enableDebugScan(tempDir, overrides = {}) {
  setPrecommitConfig(tempDir, {
    scanSecrets: false,
    scanDebugArtifacts: true,
    ...overrides,
  });
}

test("debug-artifact scanning is opt-in", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { scanSecrets: false });
  writeFile(path.join(tempDir, "src", "app.py"), "pdb.set_trace()\n");
  run("git", ["add", "src/app.py"], tempDir);

  const result = runPrecommit(tempDir);
  assert.equal(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /debug artifact/i);
});

test("an enabled scan aggregates added artifacts into one advisory presentation", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  enableDebugScan(tempDir);
  writeFile(
    path.join(tempDir, "src", "app.py"),
    'print("trace")\npdb.set_trace()\n',
  );
  run("git", ["add", "src/app.py"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /2 temporary debug artifacts staged/);
  assert.match(output, /src\/app\.py:1 \(Python print call\)/);
  assert.match(output, /src\/app\.py:2 \(pdb\.set_trace call\)/);
  assert.equal((output.match(/Pre-commit suggestions found/g) || []).length, 1);
});

test("configured exemptions silence intentional debug paths", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  enableDebugScan(tempDir, { debugArtifactExempt: ["src/devtools/**"] });
  writeFile(
    path.join(tempDir, "src", "devtools", "console.py"),
    'print("intentional CLI output")\n',
  );
  run("git", ["add", "src/devtools/console.py"], tempDir);

  const result = runPrecommit(tempDir);
  assert.equal(result.status, 0);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /temporary debug artifact/,
  );
});

test("default debug exemptions compose custom generated paths", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  enableDebugScan(tempDir, { generatedPaths: ["generated-api/**"] });
  writeFile(
    path.join(tempDir, "generated-api", "client.py"),
    'print("generated")\n',
  );
  run("git", ["add", "generated-api/client.py"], tempDir);

  const result = runPrecommit(tempDir);
  assert.equal(result.status, 0);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /temporary debug artifact/,
  );
});

test("default docs and fixture exclusions can be explicitly replaced", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  enableDebugScan(tempDir, { debugArtifactExempt: [] });
  writeFile(path.join(tempDir, "docs", "example.py"), 'print("example")\n');
  run("git", ["add", "docs/example.py"], tempDir);

  const result = runPrecommit(tempDir);
  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /1 temporary debug artifact staged/,
  );
});

test("hostile repository diff prefixes cannot change staged path attribution", () => {
  for (const [key, value] of [
    ["diff.mnemonicPrefix", "true"],
    ["diff.dstPrefix", "destination/"],
  ]) {
    const tempDir = createTempRepo();
    try {
      run("git", ["config", key, value], tempDir);
      enableDebugScan(tempDir);
      writeFile(path.join(tempDir, "docs", "example.py"), 'print("docs")\n');
      writeFile(path.join(tempDir, "src", "app.py"), 'print("source")\n');
      run("git", ["add", "docs/example.py", "src/app.py"], tempDir);

      const result = runPrecommit(tempDir);
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 0, key);
      assert.match(output, /1 temporary debug artifact staged/, key);
      assert.match(output, /src\/app\.py:1/, key);
      assert.doesNotMatch(output, /docs\/example\.py/, key);
    } finally {
      cleanupTempRepo(tempDir);
    }
  }
});

test("binary staged files do not produce debug findings", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  enableDebugScan(tempDir, { debugArtifactExempt: [] });
  const file = path.join(tempDir, "src", "binary.py");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('print("trace")\0binary'));
  run("git", ["add", "src/binary.py"], tempDir);

  const result = runPrecommit(tempDir);
  assert.equal(result.status, 0);
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /temporary debug artifact/,
  );
});

test(
  "unusual staged paths remain attributed without changing advisory exit behavior",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    enableDebugScan(tempDir, { debugArtifactExempt: [] });
    const unusualPath = "src/ leading\tline\nquote'`$;猫.py";
    writeFile(
      path.join(tempDir, ...unusualPath.split("/")),
      "pdb.set_trace()\n",
    );
    run("git", ["add", "--", unusualPath], tempDir);

    const result = runPrecommit(tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, / leading.*quote.*猫\.py/s);
    assert.match(output, /pdb\.set_trace call/);
  },
);

test(
  "literal backslashes stay exact while newline-bearing default exemptions apply",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    enableDebugScan(tempDir);
    const detectedPath = "src/back\\slash.py";
    const exemptPath = "docs/line\nbreak\\example.py";
    writeFile(path.join(tempDir, detectedPath), 'print("source")\n');
    writeFile(path.join(tempDir, exemptPath), 'print("docs")\n');
    run("git", ["add", "--", detectedPath, exemptPath], tempDir);

    const result = runPrecommit(tempDir);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, /1 temporary debug artifact staged/);
    assert.match(output, /src\/back\\slash\.py:1/);
    assert.doesNotMatch(output, /docs\/line/);
  },
);

test("diff inspection failures remain advisory and identify the unavailable scan", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  enableDebugScan(tempDir);
  writeFile(path.join(tempDir, "src", "app.py"), "pdb.set_trace()\n");
  run("git", ["add", "src/app.py"], tempDir);

  for (const env of [
    fakeGitEnv(tempDir, "diff-tree --no-commit-id --no-renames -r -U0"),
    fakeGitEnv(
      tempDir,
      "diff-tree --no-commit-id --no-renames -r -U0",
      0,
      "not a unified diff\n",
    ),
  ]) {
    const result = runPrecommit(tempDir, { env });
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, /Debug artifact scan unavailable/);
    assert.doesNotMatch(output, /Commit blocked/);
  }
});

test("secret and debug checks reuse exactly one staged patch invocation", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { scanDebugArtifacts: true });
  writeFile(path.join(tempDir, "src", "app.py"), "pdb.set_trace()\n");
  run("git", ["add", "src/app.py"], tempDir);
  const logPath = path.join(tempDir, "git.log");

  const result = runPrecommit(tempDir, {
    env: recordingGitEnv(tempDir, logPath),
  });
  assert.equal(result.status, 0);
  const stagedPatchCalls = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) =>
      line.includes("diff-tree --no-commit-id --no-renames -r -U0"),
    );
  assert.equal(stagedPatchCalls.length, 1);
  assert.match(stagedPatchCalls[0], /--src-prefix=a\/ --dst-prefix=b\//);
});
