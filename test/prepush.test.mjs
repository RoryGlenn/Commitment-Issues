// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { countTerminalBoxes, stripAnsi } from "./helpers/output.mjs";
import {
  addBareRemote,
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  installInterruptibleProcessFixture,
  readFile,
  recordingGitEnv,
  run,
  runAsync,
  waitForCompletion,
  waitForPath,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runPrePush(tempDir, input = "", options = {}) {
  return run("node", [path.join(tempDir, "scripts", "prepush.mjs")], tempDir, {
    input,
    ...options,
  });
}

// Simulate a human running the hook by hand in a terminal. We can't attach a
// real TTY from spawnSync, so use the script's interactive override seam.
function runPrePushManual(tempDir) {
  return run("node", [path.join(tempDir, "scripts", "prepush.mjs")], tempDir, {
    input: "",
    env: { ...process.env, COMMITMENT_ISSUES_ASSUME_TTY: "1" },
  });
}

test("manager-composed pre-push honors the legacy Husky skip switch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const result = spawnSync(
    process.execPath,
    [path.join(tempDir, "scripts", "cli.mjs"), "hook", "prepush"],
    {
      cwd: tempDir,
      encoding: "utf8",
      input: "",
      env: { ...process.env, HUSKY: "0" },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`, "");
});

test("explicit pre-push runs under hook-only skip variables", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const skippedBy of ["COMMITMENT_ISSUES", "HUSKY"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(tempDir, "scripts", "cli.mjs"), "prepush", "--json"],
      {
        cwd: tempDir,
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          COMMITMENT_ISSUES: skippedBy === "COMMITMENT_ISSUES" ? "0" : "1",
          HUSKY: skippedBy === "HUSKY" ? "0" : "1",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).command, "prepush");
  }
});

function setConfig(tempDir, precommitChecks) {
  const pkg = JSON.parse(readFile(tempDir, "package.json"));
  pkg.precommitChecks = precommitChecks;
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}

function installTestArgRecorder(tempDir) {
  const selectedPath = path.join(tempDir, "selected-tests.json");
  writeFile(
    path.join(tempDir, "record-tests.mjs"),
    'import fs from "node:fs";\n' +
      `fs.writeFileSync(${JSON.stringify(selectedPath)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  return {
    selectedPath,
    testCommand: ["node", "record-tests.mjs"],
  };
}

function setStandaloneConfig(tempDir, config, { raw = false } = {}) {
  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    raw ? config : `${JSON.stringify(config, null, 2)}\n`,
  );
}

// Builds the stdin line git feeds a pre-push hook so the script diffs
// HEAD~1..HEAD (i.e. the freshly committed files) as "the push".
function pushInput(tempDir) {
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const base = run("git", ["rev-parse", "HEAD~1"], tempDir).stdout.trim();
  return `refs/heads/main ${head} refs/heads/main ${base}\n`;
}

function preCommitPushEnv(tempDir, overrides = {}) {
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const base = run("git", ["rev-parse", "HEAD~1"], tempDir).stdout.trim();
  return {
    ...process.env,
    PRE_COMMIT_LOCAL_BRANCH: "refs/heads/main",
    PRE_COMMIT_TO_REF: head,
    PRE_COMMIT_REMOTE_BRANCH: "refs/heads/main",
    PRE_COMMIT_FROM_REF: base,
    PRE_COMMIT_REMOTE_NAME: "origin",
    PRE_COMMIT_REMOTE_URL: "example.invalid/repo.git",
    ...overrides,
  };
}

function commitWidget(tempDir, expected) {
  writeFile(
    path.join(tempDir, "src", "widget.mjs"),
    "export const widget = () => 1;\n",
  );
  writeFile(
    path.join(tempDir, "src", "widget.test.mjs"),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { widget } from "./widget.mjs";\n' +
      `test("widget", () => assert.equal(widget(), ${expected}));\n`,
  );
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "add widget"], tempDir);
}

test("stays silent and allows the push when the gate is disabled (default)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Explicitly disable the gate so this test is independent of how this repo's
  // own package.json happens to be configured.
  setConfig(tempDir, { testExempt: ["scripts/lib/**"] });

  const result = runPrePush(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
});

test("allows the push when pushed files have no associated tests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  writeFile(path.join(tempDir, "src", "lonely.mjs"), "export const x = 1;\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "add lonely"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No tests to run before push/);
  assert.match(output, /Push allowed with 1 warning/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("uses pre-commit framework push-range environment when stdin is consumed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, "", {
    env: preCommitPushEnv(tempDir),
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /All tests passed/);
  assert.match(output, /widget\.test\.mjs/);
});

test("recovers pre-commit framework all-files first pushes without range variables", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    blockProtectedBranches: true,
    protectedBranches: ["main"],
  });
  commitWidget(tempDir, 2);
  const environment = preCommitPushEnv(tempDir);
  environment.PRE_COMMIT_LOCAL_BRANCH = run(
    "git",
    ["symbolic-ref", "HEAD"],
    tempDir,
  ).stdout.trim();
  delete environment.PRE_COMMIT_FROM_REF;
  delete environment.PRE_COMMIT_TO_REF;

  const protectedResult = runPrePush(tempDir, "", { env: environment });
  assert.equal(protectedResult.status, 1);
  assert.match(
    `${protectedResult.stdout}${protectedResult.stderr}`,
    /Push blocked: protected branch/,
  );

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });
  const testResult = runPrePush(tempDir, "", { env: environment });
  const output = `${testResult.stdout}${testResult.stderr}`;
  assert.equal(testResult.status, 1);
  assert.match(output, /tests failed/i);
  assert.match(output, /widget\.test\.mjs/);
});

test("ignores a partial pre-commit push environment", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 2);
  const environment = preCommitPushEnv(tempDir);
  delete environment.PRE_COMMIT_REMOTE_BRANCH;

  const result = runPrePush(tempDir, "", { env: environment });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
  assert.doesNotMatch(output, /widget\.test\.mjs/);
});

test("problems-only suppresses a no-tests info box without changing exit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });
  writeFile(path.join(tempDir, "src", "lonely.mjs"), "export const x = 1;\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "add lonely"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
  assert.equal(countTerminalBoxes(output), 0);
});

test("ignores deleted test files in the push (no run for removed tests)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  // Add a passing test, then a commit that deletes it.
  commitWidget(tempDir, 1);
  run("git", ["rm", "src/widget.mjs", "src/widget.test.mjs"], tempDir);
  run("git", ["commit", "-m", "remove widget"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No tests to run before push/);
});

test("runs a surviving related test when its source file is deleted", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);
  run("git", ["rm", "src/widget.mjs"], tempDir);
  run("git", ["commit", "-m", "remove widget source"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: tests failed/);
  assert.match(output, /widget\.test\.mjs/);
  assert.match(output, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test("does not try to execute a deleted test when its source remains", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);
  run("git", ["rm", "src/widget.test.mjs"], tempDir);
  run("git", ["commit", "-m", "remove widget test"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No tests to run before push/);
  assert.doesNotMatch(output, /Could not find|ERR_MODULE_NOT_FOUND/);
});

test("runs a test left behind by a renamed source file", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);
  run("git", ["mv", "src/widget.mjs", "src/renamed-widget.mjs"], tempDir);
  run("git", ["commit", "-m", "rename widget source"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: tests failed/);
  assert.match(output, /widget\.test\.mjs/);
  assert.match(output, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test("runs a failing test when its source and test are renamed together", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);
  run("git", ["mv", "src/widget.mjs", "src/renamed-widget.mjs"], tempDir);
  run(
    "git",
    ["mv", "src/widget.test.mjs", "src/renamed-widget.test.mjs"],
    tempDir,
  );
  writeFile(
    path.join(tempDir, "src", "renamed-widget.test.mjs"),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { widget } from "./renamed-widget.mjs";\n' +
      'test("renamed widget", () => assert.equal(widget(), 2));\n',
  );
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "rename widget and test"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: tests failed/);
  assert.match(output, /renamed-widget\.test\.mjs/);
  assert.match(output, /1 !== 2|Expected values to be strictly equal/);
});

test("runs only the pushed files' tests and blocks on failure", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 2); // widget() returns 1, so asserting 2 fails

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: tests failed/);
  assert.match(output, /Additional warning/);
  assert.match(output, /protected branch "main"/);
  assert.equal(countTerminalBoxes(output), 1);
  // It ran widget's test specifically, not the whole suite.
  assert.match(output, /widget\.test\.mjs/);
});

test("allows the push and shows a summary when associated tests pass", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1); // widget() returns 1, so asserting 1 passes

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /All tests passed/);
  assert.match(output, /1 passed, 0 failed/);
  assert.match(output, /Push allowed with 1 warning/);
  assert.match(output, /protected branch "main"/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("pre-push does not reuse or delete a predictable TAP path", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });
  commitWidget(tempDir, 1);

  const recordPath = path.join(tempDir, "tap-collision-path.txt");
  const preloadPath = path.join(tempDir, "tap-collision-preload.cjs");
  writeFile(
    preloadPath,
    `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
if (String(process.argv[1] || "").endsWith("prepush.mjs")) {
  const collision = path.join(os.tmpdir(), "prepush-tap-" + process.pid + ".tap");
  fs.writeFileSync(collision, "do not touch\\n");
  fs.writeFileSync(process.env.TAP_COLLISION_RECORD, collision);
}
`,
  );

  const result = runPrePush(tempDir, pushInput(tempDir), {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preloadPath}`,
      TAP_COLLISION_RECORD: recordPath,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const collisionPath = fs.readFileSync(recordPath, "utf8");
  t.after(() => fs.rmSync(collisionPath, { force: true }));

  assert.equal(fs.readFileSync(collisionPath, "utf8"), "do not touch\n");
});

test("default pushed Node tests treat option-like paths as files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });

  const sourceFile = "--test-name-pattern=never.mjs";
  const testFile = "--test-name-pattern=never.test.mjs";
  writeFile(path.join(tempDir, sourceFile), "export const value = 1;\n");
  writeFile(
    path.join(tempDir, testFile),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'test("option-like path executes", () => assert.fail("sentinel"));\n',
  );
  run("git", ["add", "--", sourceFile, testFile], tempDir);
  run("git", ["commit", "-m", "add option-like test path"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: tests failed/);
  assert.match(output, /option-like path executes/);
});

test("problems-only suppresses a successful final box after tests run", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
  });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(countTerminalBoxes(output), 0);
  assert.doesNotMatch(output, /All tests passed/);
  assert.match(output, /widget/);
});

test("normal preserves the successful pre-push summary box", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    protectedBranches: [],
    hookOutput: "normal",
  });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(countTerminalBoxes(output), 1);
  assert.match(output, /All tests passed/);
});

test("blocks the push when the test command cannot run", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: ["definitely-not-a-real-binary-xyz"],
  });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /could not run tests/);
});

test("blocks the push and reports a timeout when the test command exceeds timeoutMs", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A 1ms ceiling kills the runner before it finishes, exercising the
  // result.signal (timed out) branch of the could-not-run reason.
  setConfig(tempDir, { blockPushOnTestFailure: true, timeoutMs: 1 });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: could not run tests/);
  assert.match(output, /timed out/);
});

test(
  "prepush cancels custom-runner descendants before exiting on SIGINT",
  { skip: process.platform === "win32" },
  async (t) => {
    const tempDir = createTempRepo();
    commitWidget(tempDir, 1);
    const target = path.join(tempDir, "src", "widget.test.mjs");
    const original = readFile(tempDir, "src/widget.test.mjs");
    const fixture = installInterruptibleProcessFixture(tempDir, {
      target,
      mutation: "export const survivor = true;\n",
    });
    setConfig(tempDir, {
      advisePushTests: true,
      testCommand: fixture.command,
    });
    const execution = runAsync(
      process.execPath,
      [path.join(tempDir, "scripts", "prepush.mjs")],
      tempDir,
      {
        input: pushInput(tempDir),
        env: { ...process.env, ...fixture.env },
      },
    );
    t.after(() => {
      execution.child.kill("SIGKILL");
      fixture.cleanup();
      cleanupTempRepo(tempDir);
    });

    await waitForPath(fixture.ready);
    execution.child.kill("SIGINT");
    const result = await waitForCompletion(
      execution.completed,
      "prepush did not finish cancellation",
    );
    const bytesAtExit = readFile(tempDir, "src/widget.test.mjs");

    fixture.release();
    await delay(250);

    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGINT");
    assert.equal(bytesAtExit, original);
    assert.equal(readFile(tempDir, "src/widget.test.mjs"), original);
    assert.equal(
      run("git", ["show", "HEAD:src/widget.test.mjs"], tempDir).stdout,
      original,
    );
  },
);

test("advisory mode runs tests and warns without blocking on failure", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { advisePushTests: true });
  commitWidget(tempDir, 2); // widget() returns 1, so asserting 2 fails

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  // Failing tests must NOT block the push in advisory mode.
  assert.equal(result.status, 0);
  assert.match(output, /Tests failed \(advisory\)/);
  assert.match(output, /widget\.test\.mjs/);
  assert.match(output, /Push allowed with 2 warnings/);
  assert.match(output, /protected branch "main"/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("standalone push settings override package.json per key", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  setStandaloneConfig(tempDir, {
    blockPushOnTestFailure: false,
    advisePushTests: true,
  });
  commitWidget(tempDir, 2);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Tests failed \(advisory\)/);
  assert.doesNotMatch(output, /Push blocked: tests failed/);
});

test("pre-push warns and uses package fallback for malformed standalone config", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { advisePushTests: true });
  setStandaloneConfig(tempDir, "{ invalid\n", { raw: true });
  commitWidget(tempDir, 2);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Ignoring \.commitmentrc\.json/);
  assert.match(output, /Tests failed \(advisory\)/);
});

test("advisory mode shows passing summary and allows the push", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { advisePushTests: true });
  commitWidget(tempDir, 1); // widget() returns 1, so asserting 1 passes

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /All tests passed/);
  assert.match(output, /1 passed, 0 failed/);
  // A single mode is not a conflict, so no conflict warning should appear.
  assert.doesNotMatch(output, /advisePushTests are set/);
});

test("blockPushOnTestFailure takes precedence over advisePushTests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    advisePushTests: true,
  });
  commitWidget(tempDir, 2); // failing test

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: tests failed/);
  // Setting both modes is a config conflict and must be surfaced.
  assert.match(
    output,
    /Both blockPushOnTestFailure and advisePushTests are set/,
  );
});

test("advisory mode warns but allows the push when the test command cannot run", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    advisePushTests: true,
    testCommand: ["definitely-not-a-real-binary-xyz"],
  });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Could not run tests \(advisory\)/);
});

test("normal explains how to enable checks when run manually with no mode set", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // No push mode enabled; running by hand should not vanish silently.
  setConfig(tempDir, {
    testExempt: ["scripts/lib/**"],
    hookOutput: "normal",
  });

  const result = runPrePushManual(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Pre-push test checks are disabled/);
  assert.match(output, /blockPushOnTestFailure/);
  assert.match(output, /advisePushTests/);
});

test("problems-only keeps a manual no-mode run quiet", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setConfig(tempDir, {
    testExempt: ["scripts/lib/**"],
    protectedBranches: [],
  });

  const result = runPrePushManual(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
});

test("stays silent during a real push when no mode is set", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Git invocation (refs piped on stdin) must stay completely silent.
  // protectedBranches: [] keeps the branch guard out of this mode test
  // (the push input targets refs/heads/main).
  setConfig(tempDir, {
    testExempt: ["scripts/lib/**"],
    protectedBranches: [],
  });

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
});

test("warns about a typo'd push-mode key even when the push proceeds", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // advisePushTest (singular) silently disables the mode the user thinks is
  // on — exactly the case the one-line typo warning exists for.
  setConfig(tempDir, { advisePushTest: true });

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /unknown precommitChecks key\(s\).*advisePushTest/);
  // The typo means no mode is enabled, so nothing else prints.
  assert.doesNotMatch(output, /All tests passed|Tests failed/);
});

test("warns about an invalid recognized push-mode value", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // advisePushTests is recognized but the string value is invalid: it is
  // sanitized away (no mode enabled) and surfaced on the one-line warning.
  setConfig(tempDir, { advisePushTests: "yes" });

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(
    output,
    /invalid precommitChecks value\(s\).*advisePushTests must be a boolean/,
  );
  assert.doesNotMatch(output, /All tests passed|Tests failed/);
});

test("falls back to the upstream branch when run without piped refs", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    hookOutput: "normal",
    protectedBranches: [],
  });
  addBareRemote(tempDir); // sets an upstream at the current HEAD
  commitWidget(tempDir, 1); // a new commit ahead of @{u}, with a passing test

  // Interactive run: no refs on stdin, so it diffs @{u}..HEAD instead.
  const result = runPrePushManual(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /All tests passed/);
  assert.match(output, /widget\.test\.mjs/);
});

test("runs a non-node test command and allows the push", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // `cat` is not the node test runner, so the tee/summary fallback path runs.
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: ["cat"],
  });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /All tests passed/);
});

test("blocks the push when the node runner writes no summary (bad flag)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Still recognized as the node runner (has --test), but the bogus flag makes
  // node abort before writing the TAP file, so the summary parse falls back.
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: ["node", "--test", "--totally-bogus-flag-xyz"],
  });
  commitWidget(tempDir, 1);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked/);
});

test("blocks the push when the pushed-files diff cannot be computed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);

  // Fail the diff that lists pushed files. Blocking mode must fail closed
  // rather than treat an un-inspectable push as "no tests to run".
  const env = fakeGitEnv(tempDir, "--name-status -z");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input: pushInput(tempDir), env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: could not inspect pushed files/);
});

test("escapes controls in captured Git diagnostics", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);

  const diagnostic = "git failed\rFAKE SUCCESS\n\t\b\u001b[31mRED\u001b[39m";
  const env = fakeGitEnv(tempDir, "--name-status -z", 1, "", diagnostic);
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input: pushInput(tempDir), env },
  );
  const output = `${result.stdout}${result.stderr}`;
  const visibleOutput = stripAnsi(output);

  assert.equal(result.status, 1);
  assert.match(visibleOutput, /git failed\\rFAKE SUCCESS\\n\\t\\x08RED/);
  assert.doesNotMatch(visibleOutput, /\r|\t|\x08|\u001b/);
  assert.doesNotMatch(output, /FAKE SUCCESS.*\u001b\[31mRED/s);
});

test("blocks the push when Git returns malformed name-status output", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);

  const malformedRename = "R100\0src/widget.mjs\0";
  const env = fakeGitEnv(tempDir, "--name-status -z", 0, malformedRename);
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input: pushInput(tempDir), env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: could not inspect pushed files/);
  assert.match(output, /malformed name-status output/);
});

test("advisory mode warns but allows when the pushed-files diff cannot be computed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { advisePushTests: true });
  commitWidget(tempDir, 1);

  const env = fakeGitEnv(tempDir, "--name-status -z");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input: pushInput(tempDir), env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Could not inspect pushed files \(advisory\)/);
  assert.match(output, /Push allowed/);
});

test("stays silent and allows when the diff fails but no mode is enabled", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Disabled mode exits before any diff, so a broken diff is irrelevant.
  // protectedBranches: [] keeps the branch guard out of this mode test.
  setConfig(tempDir, {
    testExempt: ["scripts/lib/**"],
    protectedBranches: [],
  });
  commitWidget(tempDir, 1);

  const env = fakeGitEnv(tempDir, "--name-status -z");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input: pushInput(tempDir), env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
});

test("uses literal NUL-delimited name-status output for pushed files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  commitWidget(tempDir, 1);

  const logPath = path.join(tempDir, "git-invocations.log");
  const env = recordingGitEnv(tempDir, logPath);
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input: pushInput(tempDir), env },
  );

  assert.equal(result.status, 0);
  // The pushed-file diff must retain status and use NUL terminators so
  // deletions, renames, Unicode, whitespace, and newlines remain unambiguous.
  const log = fs.readFileSync(logPath, "utf8");
  assert.match(
    log,
    /-c core\.quotePath=false diff --name-status -z --find-renames/,
  );
});

test("discovers associated tests for pushed files with Unicode paths", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setConfig(tempDir, { blockPushOnTestFailure: true });
  // A Unicode filename is octal-escaped by git unless core.quotePath=false, in
  // which case the associated test would not be found and would silently pass.
  writeFile(
    path.join(tempDir, "src", "gadget-猫.mjs"),
    "export const gadget = () => 1;\n",
  );
  writeFile(
    path.join(tempDir, "src", "gadget-猫.test.mjs"),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'import { gadget } from "./gadget-猫.mjs";\n' +
      'test("gadget", () => assert.equal(gadget(), 1));\n',
  );
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "add unicode gadget"], tempDir);

  const result = runPrePush(tempDir, pushInput(tempDir));
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  // The Unicode-named test must actually be discovered and run, not skipped.
  assert.doesNotMatch(output, /No tests to run before push/);
  assert.match(output, /All tests passed/);
  assert.match(output, /1 passed, 0 failed/);
});

test(
  "passes exact NUL-delimited pathological paths to pushed-file tests",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const recorder = installTestArgRecorder(tempDir);
    setConfig(tempDir, {
      blockPushOnTestFailure: true,
      testCommand: recorder.testCommand,
      protectedBranches: [],
    });

    const dir = "src/ leading\t猫\ntrailing ";
    const source = `${dir}/widget.mjs`;
    const relatedTest = `${dir}/widget.test.mjs`;
    writeFile(
      path.join(tempDir, ...source.split("/")),
      "export const x = 1;\n",
    );
    writeFile(path.join(tempDir, ...relatedTest.split("/")), "export {};\n");
    run("git", ["add", "--", "package.json", source, relatedTest], tempDir);
    run("git", ["commit", "-m", "pathological path"], tempDir);

    const result = runPrePush(tempDir, pushInput(tempDir));

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
      relatedTest,
    ]);
  },
);

test("first push of a based branch diffs from its remote merge base", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const recorder = installTestArgRecorder(tempDir);
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: recorder.testCommand,
    protectedBranches: [],
  });

  writeFile(path.join(tempDir, "src", "legacy.mjs"), "export const x = 1;\n");
  writeFile(path.join(tempDir, "src", "legacy.test.mjs"), "export {};\n");
  run("git", ["add", "package.json", "src"], tempDir);
  run("git", ["commit", "-m", "remote baseline"], tempDir);
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  run("git", ["switch", "-c", "feature/first-push"], tempDir);
  writeFile(path.join(tempDir, "src", "feature.mjs"), "export const y = 2;\n");
  writeFile(path.join(tempDir, "src", "feature.test.mjs"), "export {};\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "feature"], tempDir);
  assert.notEqual(run("git", ["rev-parse", "@{u}"], tempDir).status, 0);
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const input =
    `refs/heads/feature/first-push ${head} ` +
    `refs/heads/feature/first-push ${"0".repeat(40)}\n`;

  const result = runPrePush(tempDir, input);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "src/feature.test.mjs",
  ]);

  // An explicit upstream is sufficient even when remote-ref enumeration is
  // unavailable. This also verifies the full push ref is converted to the
  // short local branch syntax required by the @{upstream} revision suffix.
  run(
    "git",
    ["branch", "--set-upstream-to=origin/main", "feature/first-push"],
    tempDir,
  );
  const env = fakeGitEnv(tempDir, "for-each-ref");
  const upstreamResult = run(
    "node",
    [path.join(tempDir, "scripts", "prepush.mjs")],
    tempDir,
    { input, env },
  );
  assert.equal(upstreamResult.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "src/feature.test.mjs",
  ]);
});

test("first push of an orphan history falls back safely to the empty tree", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const recorder = installTestArgRecorder(tempDir);
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: recorder.testCommand,
    protectedBranches: [],
  });
  const orphanPackage = readFile(tempDir, "package.json");
  const scriptsTarget = fs.readlinkSync(path.join(tempDir, "scripts"));

  writeFile(path.join(tempDir, "src", "legacy.mjs"), "export const x = 1;\n");
  writeFile(path.join(tempDir, "src", "legacy.test.mjs"), "export {};\n");
  run("git", ["add", "package.json", "src"], tempDir);
  run("git", ["commit", "-m", "remote baseline"], tempDir);
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  run("git", ["checkout", "--orphan", "orphan"], tempDir);
  run("git", ["rm", "-rf", "--ignore-unmatch", "."], tempDir);
  fs.symlinkSync(scriptsTarget, path.join(tempDir, "scripts"));
  writeFile(path.join(tempDir, "package.json"), orphanPackage);
  writeFile(path.join(tempDir, "src", "orphan.mjs"), "export const x = 1;\n");
  writeFile(path.join(tempDir, "src", "orphan.test.mjs"), "export {};\n");
  run(
    "git",
    ["add", "package.json", "src/orphan.mjs", "src/orphan.test.mjs"],
    tempDir,
  );
  run("git", ["commit", "-m", "orphan history"], tempDir);
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const result = runPrePush(
    tempDir,
    `refs/heads/orphan ${head} refs/heads/orphan ${"0".repeat(40)}\n`,
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "src/orphan.test.mjs",
  ]);
});

test("first push recognizes a SHA-256-length zero object ID", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const recorder = installTestArgRecorder(tempDir);
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: recorder.testCommand,
    protectedBranches: [],
  });

  run("git", ["add", "package.json"], tempDir);
  run("git", ["commit", "-m", "remote baseline"], tempDir);
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  run("git", ["switch", "-c", "feature/sha256-zero"], tempDir);
  writeFile(path.join(tempDir, "src", "feature.mjs"), "export const x = 1;\n");
  writeFile(path.join(tempDir, "src", "feature.test.mjs"), "export {};\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "feature"], tempDir);
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const result = runPrePush(
    tempDir,
    `refs/heads/feature/sha256-zero ${head} ` +
      `refs/heads/feature/sha256-zero ${"0".repeat(64)}\n`,
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "src/feature.test.mjs",
  ]);
});

test("multiple first-pushed refs each use the existing remote base", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const recorder = installTestArgRecorder(tempDir);
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: recorder.testCommand,
    protectedBranches: [],
  });
  run("git", ["add", "package.json"], tempDir);
  run("git", ["commit", "-m", "configure"], tempDir);
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  run("git", ["switch", "-c", "feature/a"], tempDir);
  writeFile(path.join(tempDir, "src", "a.mjs"), "export const a = 1;\n");
  writeFile(path.join(tempDir, "src", "a.test.mjs"), "export {};\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "feature a"], tempDir);
  const headA = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  run("git", ["switch", "-c", "feature/b"], tempDir);
  writeFile(path.join(tempDir, "src", "b.mjs"), "export const b = 2;\n");
  writeFile(path.join(tempDir, "src", "b.test.mjs"), "export {};\n");
  run("git", ["add", "src"], tempDir);
  run("git", ["commit", "-m", "feature b"], tempDir);
  const headB = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const zero = "0".repeat(40);

  const result = runPrePush(
    tempDir,
    `refs/heads/feature/a ${headA} refs/heads/feature/a ${zero}\n` +
      `refs/heads/feature/b ${headB} refs/heads/feature/b ${zero}\n`,
  );

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)).sort(), [
    "src/a.test.mjs",
    "src/b.test.mjs",
  ]);
});

test("same-basename monorepo sources select only their package tests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const recorder = installTestArgRecorder(tempDir);
  setConfig(tempDir, {
    blockPushOnTestFailure: true,
    testCommand: recorder.testCommand,
    protectedBranches: [],
  });
  const rootPackage = JSON.parse(readFile(tempDir, "package.json"));
  rootPackage.workspaces = ["packages/*"];
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(rootPackage, null, 2)}\n`,
  );

  for (const workspace of ["a", "b"]) {
    writeFile(
      path.join(tempDir, "packages", workspace, "package.json"),
      "{}\n",
    );
    writeFile(
      path.join(tempDir, "packages", workspace, "src", "index.mjs"),
      `export const workspace = "${workspace}";\n`,
    );
    writeFile(
      path.join(tempDir, "packages", workspace, "test", "index.test.mjs"),
      "export {};\n",
    );
  }
  writeFile(path.join(tempDir, "test", "index.test.mjs"), "export {};\n");
  run("git", ["add", "package.json", "packages", "test"], tempDir);
  run("git", ["commit", "-m", "monorepo baseline"], tempDir);

  const sourceA = path.join(tempDir, "packages", "a", "src", "index.mjs");
  writeFile(sourceA, 'export const workspace = "a2";\n');
  run("git", ["add", "packages/a/src/index.mjs"], tempDir);
  run("git", ["commit", "-m", "change a"], tempDir);
  let result = runPrePush(tempDir, pushInput(tempDir));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "packages/a/test/index.test.mjs",
  ]);

  const sourceB = path.join(tempDir, "packages", "b", "src", "index.mjs");
  writeFile(sourceB, 'export const workspace = "b2";\n');
  run("git", ["add", "packages/b/src/index.mjs"], tempDir);
  run("git", ["commit", "-m", "change b"], tempDir);
  result = runPrePush(tempDir, pushInput(tempDir));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "packages/b/test/index.test.mjs",
  ]);

  run(
    "git",
    ["rm", "packages/a/package.json", "packages/a/src/index.mjs"],
    tempDir,
  );
  run("git", ["commit", "-m", "remove a source"], tempDir);
  result = runPrePush(tempDir, pushInput(tempDir));
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(recorder.selectedPath)), [
    "packages/a/test/index.test.mjs",
  ]);
});
