// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { hookBody } from "../scripts/lib/hooks.mjs";
import { countTerminalBoxes } from "./helpers/output.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  installInterruptibleProcessFixture,
  readFile,
  readHeadFile,
  run,
  runAsync,
  setPrecommitConfig,
  waitForCompletion,
  waitForPath,
  writeCrossPlatformShim,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runHook(tempDir, options = {}) {
  return run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    options,
  );
}

function installRealPrecommitHook(tempDir) {
  const hookPath = path.join(tempDir, ".git", "hooks", "pre-commit");
  writeFile(hookPath, hookBody("pre-commit"));
  fs.chmodSync(hookPath, 0o755);
}

test("manager-composed pre-commit honors the project-wide skip switch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "broken.js"), "const value=1\n");
  run("git", ["add", "src/broken.js"], tempDir);

  const result = spawnSync(
    process.execPath,
    [path.join(tempDir, "scripts", "cli.mjs"), "hook", "precommit"],
    {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, COMMITMENT_ISSUES: "0" },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`, "");
});

test("explicit precommit still runs when hook-only skips are configured", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { requireTests: false });
  writeFile(path.join(tempDir, "src", "broken.json"), '{"value":1}\n');
  run("git", ["add", "src/broken.json"], tempDir);

  const result = spawnSync(
    process.execPath,
    [path.join(tempDir, "scripts", "cli.mjs"), "precommit", "--json"],
    {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, COMMITMENT_ISSUES: "0", HUSKY: "0" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).command, "precommit");
});

test(
  "precommit cancels custom-runner descendants before exiting on SIGHUP",
  { skip: process.platform === "win32" },
  async (t) => {
    const tempDir = createTempRepo();
    const target = path.join(tempDir, "test", "interrupt.test.mjs");
    const original = "export const safe = true;\n";
    const mutation = "export const survivor = true;\n";
    writeFile(target, original);
    const fixture = installInterruptibleProcessFixture(tempDir, {
      target,
      mutation,
    });
    setPrecommitConfig(tempDir, {
      requireTests: false,
      runStagedTests: true,
      testCommand: fixture.command,
    });
    run("git", ["add", "test/interrupt.test.mjs"], tempDir);
    const execution = runAsync(
      process.execPath,
      [path.join(tempDir, "scripts", "precommit.mjs")],
      tempDir,
      { env: { ...process.env, ...fixture.env } },
    );
    t.after(() => {
      execution.child.kill("SIGKILL");
      fixture.cleanup();
      cleanupTempRepo(tempDir);
    });

    await waitForPath(fixture.ready);
    execution.child.kill("SIGHUP");
    const result = await waitForCompletion(
      execution.completed,
      "precommit did not finish cancellation",
    );
    const bytesAtExit = readFile(tempDir, "test/interrupt.test.mjs");

    fixture.release();
    await delay(250);

    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGHUP");
    assert.equal(bytesAtExit, original);
    assert.equal(readFile(tempDir, "test/interrupt.test.mjs"), original);
    assert.equal(
      run("git", ["show", ":test/interrupt.test.mjs"], tempDir).stdout,
      original,
    );
  },
);

test("shows commit:fix for fully auto-fixable warnings", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "format-only.json"), '{"alpha":1}\n');
  run("git", ["add", "src/format-only.json"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /npm run commit:fix/);
  assert.doesNotMatch(output, /still need your attention/);
});

test("shows commit:fix and manual warning note for mixed safe warnings", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "mixed.js"), "const value=1\n");
  run("git", ["add", "src/mixed.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /npm run commit:fix/);
  assert.match(output, /Manual items above still need your attention\./);
});

test("suppresses commit:fix when tracked worktree changes would block amend", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "README.md"), "dirty\n");
  writeFile(path.join(tempDir, "src", "format-only.json"), '{"alpha":1}\n');
  run("git", ["add", "src/format-only.json"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /npm run commit:fix/);
  assert.match(
    output,
    /Other tracked changes will still be present after commit/,
  );
});

test("labels non-fixable ESLint issues as manual and omits commit:fix", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Prettier-clean file whose only problem is an unfixable no-unused-vars error.
  writeFile(
    path.join(tempDir, "src", "manual.js"),
    "const unusedValue = 123;\n",
  );
  run("git", ["add", "src/manual.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /ESLint issue needing manual fixes/);
  assert.match(output, /manual\.js.*no-unused-vars/);
  assert.doesNotMatch(output, /npm run commit:fix/);
});

test("does not flag files that live inside a test directory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, "test", "helpers", "util.mjs"),
    "export const u = 1;\n",
  );
  run("git", ["add", "test/helpers/util.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("does not flag source files that have a matching test in test/", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, "src", "widget.mjs"),
    "export const widget = () => 1;\n",
  );
  writeFile(path.join(tempDir, "test", "widget.test.mjs"), "export {};\n");
  run("git", ["add", "src/widget.mjs", "test/widget.test.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("does not let an untracked matching test satisfy the staged tree", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    protectedBranches: [],
    runStagedTests: true,
  });

  writeFile(
    path.join(tempDir, "src", "untracked-test.mjs"),
    "export const value = 1;\n",
  );
  writeFile(
    path.join(tempDir, "test", "untracked-test.test.mjs"),
    'import test from "node:test";\ntest("untracked", () => {});\n',
  );
  run("git", ["add", "src/untracked-test.mjs"], tempDir);

  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs"), "--json"],
    tempDir,
  );
  const payload = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    payload.checks.find((check) => check.id === "missing-tests").status,
    "advisory",
  );
  assert.deepEqual(
    payload.checks.find((check) => check.id === "staged-tests").details.files,
    [],
  );
});

test("requireTests:false disables the missing-test check", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const pkg = JSON.parse(readFile(tempDir, "package.json"));
  pkg.precommitChecks = {
    requireTests: false,
    showWelcomeOnFirstCommit: false,
  };
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  writeFile(path.join(tempDir, "src", "widget.mjs"), "export const w = 1;\n");
  run("git", ["add", "src/widget.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("standalone config overrides package.json during pre-commit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: true });
  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    '{"requireTests":false}\n',
  );
  writeFile(path.join(tempDir, "src", "widget.mjs"), "export const w = 1;\n");
  run("git", ["add", "src/widget.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /missing unit tests/);
});

test("pre-commit warns and falls back for malformed standalone config", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  writeFile(path.join(tempDir, ".commitmentrc.json"), "{ invalid\n");
  writeFile(path.join(tempDir, "src", "widget.mjs"), "export const w = 1;\n");
  run("git", ["add", "src/widget.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Ignoring \.commitmentrc\.json/);
  assert.match(output, /contains invalid JSON/);
  assert.doesNotMatch(output, /missing unit tests/);
});

test("pre-commit warns when malformed package.json disables package config", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "package.json"), "{ invalid\n");
  writeFile(path.join(tempDir, "README.md"), "# Updated\n");
  run("git", ["add", "README.md"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Ignoring package\.json precommitChecks/);
  assert.match(output, /contains invalid JSON/);
});

test("pre-commit attributes standalone key diagnostics", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {});
  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    '{"requireTest":false,"tone":"silly"}\n',
  );

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(
    output,
    /unknown precommitChecks key\(s\) in \.commitmentrc\.json: requireTest/,
  );
  assert.match(
    output,
    /invalid precommitChecks value\(s\) in \.commitmentrc\.json: tone must/,
  );
});

test("warns about unknown precommitChecks keys but still runs", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // requireTest (singular) is a typo of requireTests: warn, then behave as if
  // the key were absent (the missing-test check stays on).
  setPrecommitConfig(tempDir, { requireTest: false });
  writeFile(path.join(tempDir, "src", "widget.mjs"), "export const w = 1;\n");
  run("git", ["add", "src/widget.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /unknown precommitChecks key\(s\).*requireTest/);
  assert.match(output, /missing unit tests/);
});

test("does not warn when only known precommitChecks keys are set", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false, tone: "fun" });
  writeFile(path.join(tempDir, "src", "widget.mjs"), "export const w = 1;\n");
  run("git", ["add", "src/widget.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /unknown precommitChecks key/);
});

test("warns about invalid precommitChecks values but still runs", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // requireTests is a recognized key but the string value is invalid: warn,
  // then behave as if it were absent (the missing-test check stays on).
  setPrecommitConfig(tempDir, { requireTests: "nope" });
  writeFile(path.join(tempDir, "src", "widget.mjs"), "export const w = 1;\n");
  run("git", ["add", "src/widget.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(
    output,
    /invalid precommitChecks value\(s\).*requireTests must be a boolean/,
  );
  assert.match(output, /missing unit tests/);
});

test("invalid hookOutput warns and falls back to problems-only", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { hookOutput: "quiet" });

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /hookOutput must be "problems-only" or "normal"/);
  assert.equal(countTerminalBoxes(output), 0);
  assert.doesNotMatch(output, /No staged files to check/);
});

test("treats staged TypeScript files as lintable code files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // JS-compatible TS so the default parser lints it without typescript-eslint.
  writeFile(path.join(tempDir, "src", "thing.ts"), "const unused = 1;\n");
  run("git", ["add", "src/thing.ts"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /ESLint issue needing manual fixes/);
  assert.match(output, /missing unit tests/);
});

test("finds a matching .test.ts for a TypeScript source", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "thing.ts"), "export const thing = 1;\n");
  writeFile(path.join(tempDir, "test", "thing.test.ts"), "export {};\n");
  run("git", ["add", "src/thing.ts", "test/thing.test.ts"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("does not flag .d.ts declaration files for missing tests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "types.d.ts"), "export {};\n");
  run("git", ["add", "src/types.d.ts"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("handles a mixed JS and TS commit together", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "a.js"), "export const a = 1;\n");
  writeFile(path.join(tempDir, "src", "b.ts"), "export const b = 1;\n");
  run("git", ["add", "src/a.js", "src/b.ts"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /2 staged source files missing unit tests/);
  assert.match(output, /src\/a\.js/);
  assert.match(output, /src\/b\.ts/);
});

test("does not flag config files for missing tests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "app.config.js"), "export default {};\n");
  run("git", ["add", "app.config.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("does not flag Storybook story files for missing tests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, "src", "Button.stories.js"),
    "export default {};\n",
  );
  run("git", ["add", "src/Button.stories.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("does not flag generated files for missing tests", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, "src", "api.generated.ts"),
    "export const api = 1;\n",
  );
  writeFile(
    path.join(tempDir, "src", "generated", "schema.ts"),
    "export const schema = 1;\n",
  );
  run(
    "git",
    ["add", "src/api.generated.ts", "src/generated/schema.ts"],
    tempDir,
  );

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("honors package.json precommitChecks.testExempt globs", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const pkg = JSON.parse(readFile(tempDir, "package.json"));
  pkg.precommitChecks = {
    showWelcomeOnFirstCommit: false,
    testExempt: ["src/legacy/**"],
  };
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );

  writeFile(
    path.join(tempDir, "src", "legacy", "old.js"),
    "export const old = 1;\n",
  );
  run("git", ["add", "src/legacy/old.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /missing unit tests/);
});

test("problems-only suppresses the no-staged-files info box by default", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Clean working tree, nothing staged.
  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(output.trim(), "");
});

test("normal preserves the no-staged-files info box", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    protectedBranches: [],
  });

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No staged files to check\./);
});

test("shows info when only non-checkable files are staged", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    protectedBranches: [],
  });

  writeFile(path.join(tempDir, "assets", "logo.png"), "not really binary\n");
  run("git", ["add", "assets/logo.png"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /No lintable or formattable files staged\./);
  assert.doesNotMatch(output, /All pre-commit checks passed/);
});

test("distinguishes a deletion-only commit from nothing staged", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    protectedBranches: [],
  });

  run("git", ["rm", "README.md"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /Deletion-only commit/);
  assert.doesNotMatch(output, /Stage changes with git add/);
});

test("deleting a matching test evaluates the resulting source tree", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { protectedBranches: [] });
  writeFile(
    path.join(tempDir, "src", "kept-source.mjs"),
    "export const kept = true;\n",
  );
  writeFile(
    path.join(tempDir, "test", "kept-source.test.mjs"),
    'import test from "node:test";\ntest("kept", () => {});\n',
  );
  run(
    "git",
    ["add", "src/kept-source.mjs", "test/kept-source.test.mjs"],
    tempDir,
  );
  run("git", ["commit", "-m", "add source and test"], tempDir);
  run("git", ["rm", "test/kept-source.test.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /source file missing unit tests/);
  assert.match(output, /src\/kept-source\.mjs/);
});

test("runs staged tests and warns when they fail (opt-in)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const pkg = JSON.parse(readFile(tempDir, "package.json"));
  pkg.precommitChecks = {
    runStagedTests: true,
    showWelcomeOnFirstCommit: false,
  };
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );

  writeFile(
    path.join(tempDir, "test", "thing.test.mjs"),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'test("fails", () => assert.equal(1, 2));\n',
  );
  run("git", ["add", "test/thing.test.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /staged test file.*failing/);
});

test("runs staged tests and stays clean when they pass (opt-in)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const pkg = JSON.parse(readFile(tempDir, "package.json"));
  pkg.precommitChecks = {
    runStagedTests: true,
    showWelcomeOnFirstCommit: false,
  };
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );

  writeFile(
    path.join(tempDir, "test", "thing.test.mjs"),
    'import test from "node:test";\ntest("passes", () => {});\n',
  );
  run("git", ["add", "test/thing.test.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.doesNotMatch(output, /failing/);
});

test("runs tests from staged bytes instead of their unstaged contents", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    protectedBranches: [],
    requireTests: false,
    runStagedTests: true,
  });
  const passing =
    'import test from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    'test("snapshot", () => assert.equal(1, 1));\n';
  const failing =
    'import test from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    'test("snapshot", () => assert.equal(1, 2));\n';
  const testPath = path.join(tempDir, "test", "snapshot.test.mjs");

  writeFile(testPath, passing);
  run("git", ["add", "test/snapshot.test.mjs"], tempDir);
  writeFile(testPath, failing);
  let result = runHook(tempDir);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /test file failing/);

  run("git", ["add", "test/snapshot.test.mjs"], tempDir);
  writeFile(testPath, passing);
  result = runHook(tempDir);
  assert.match(`${result.stdout}${result.stderr}`, /test file failing/);
});

test("checks canonical staged LF bytes when the worktree contains CRLF", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    protectedBranches: [],
    requireTests: false,
  });
  run("git", ["config", "core.autocrlf", "true"], tempDir);
  const file = path.join(tempDir, "src", "line-endings.json");
  const lf = '{\n  "value": true\n}\n';
  const crlf = lf.replaceAll("\n", "\r\n");
  writeFile(file, lf);
  run("git", ["add", "src/line-endings.json"], tempDir);
  fs.writeFileSync(file, crlf);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /Prettier|formatting issue/);
  assert.equal(
    run("git", ["show", ":src/line-endings.json"], tempDir).stdout,
    lf,
  );
  assert.deepEqual(fs.readFileSync(file), Buffer.from(crlf));
});

test("real pre-commit hook reports and commits the exact staged bytes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    protectedBranches: [],
    requireTests: false,
  });
  installRealPrecommitHook(tempDir);
  const file = path.join(tempDir, "src", "partial.json");
  const unformatted = '{"value":1}\n';
  const formatted = '{\n  "value": 1\n}\n';

  writeFile(file, unformatted);
  run("git", ["add", "src/partial.json"], tempDir);
  writeFile(file, formatted);
  let commit = run("git", ["commit", "-m", "staged bad"], tempDir);

  assert.equal(commit.status, 0, commit.stderr);
  assert.match(`${commit.stdout}${commit.stderr}`, /formatting issues/);
  assert.equal(readHeadFile(tempDir, "src/partial.json"), unformatted);
  assert.equal(fs.readFileSync(file, "utf8"), formatted);

  run("git", ["add", "src/partial.json"], tempDir);
  writeFile(file, unformatted);
  commit = run("git", ["commit", "-m", "staged clean"], tempDir);

  assert.equal(commit.status, 0, commit.stderr);
  assert.doesNotMatch(
    `${commit.stdout}${commit.stderr}`,
    /need Prettier formatting|Prettier failed/,
  );
  assert.equal(readHeadFile(tempDir, "src/partial.json"), formatted);
  assert.equal(fs.readFileSync(file, "utf8"), unformatted);
});

test("real pre-commit hook inspects git commit --all's temporary index", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    protectedBranches: [],
    requireTests: false,
  });
  const file = path.join(tempDir, "src", "tracked.json");
  writeFile(file, '{\n  "value": 1\n}\n');
  run("git", ["add", "package.json", "src/tracked.json"], tempDir);
  run("git", ["commit", "--no-verify", "-m", "tracked baseline"], tempDir);
  installRealPrecommitHook(tempDir);

  const unformatted = '{"value":2}\n';
  writeFile(file, unformatted);
  const commit = run(
    "git",
    ["commit", "--all", "-m", "update tracked"],
    tempDir,
  );
  const output = `${commit.stdout}${commit.stderr}`;

  assert.equal(commit.status, 0, commit.stderr);
  assert.match(output, /formatting issues/);
  assert.doesNotMatch(output, /No staged files to check/);
  assert.equal(readHeadFile(tempDir, "src/tracked.json"), unformatted);
});

test("default staged Node tests treat option-like paths as files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    requireTests: false,
    runStagedTests: true,
    protectedBranches: [],
  });
  const testFile = "--test-name-pattern=never.test.mjs";
  writeFile(
    path.join(tempDir, testFile),
    'import test from "node:test";\n' +
      'import assert from "node:assert/strict";\n' +
      'test("option-like path executes", () => assert.fail("sentinel"));\n',
  );
  run("git", ["add", "--", testFile], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /1 staged test file failing/);
});

test("continues (exit 0) when staged files cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "x.js"), "export const x = 1;\n");
  run("git", ["add", "src/x.js"], tempDir);

  const env = fakeGitEnv(tempDir, "--diff-filter=ACMRT");
  const result = runHook(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  // Advisory: it never blocks, even when git is unavailable. The box is a
  // warning (not an error) because the commit continues, matching the
  // pre-push advisory-uninspectable state.
  assert.equal(result.status, 0);
  assert.match(output, /Unable to inspect staged files\./);
  assert.match(output, /warning/);
  assert.doesNotMatch(output, /error/);
});

test("continues advisory when staged pathname output is malformed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "x.js"), "export const x = 1;\n");
  run("git", ["add", "src/x.js"], tempDir);
  const env = fakeGitEnv(
    tempDir,
    "--name-only -z --diff-filter=ACMRT",
    0,
    "src/x.js",
  );

  const result = runHook(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Unable to inspect staged files/);
});

test("continues without claims when the exact staged tree cannot materialize", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "x.js"), "export const x = 1;\n");
  run("git", ["add", "src/x.js"], tempDir);
  const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  run(
    "git",
    ["update-index", "--add", "--cacheinfo", `160000,${head},vendor/submodule`],
    tempDir,
  );

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Unable to inspect the exact staged tree/);
  assert.match(output, /Submodule entry cannot be materialized safely/);
  assert.doesNotMatch(output, /tests passing|formatting clean|lint errors/);

  const jsonResult = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs"), "--json"],
    tempDir,
  );
  assert.equal(jsonResult.status, 0);
  const payload = JSON.parse(jsonResult.stdout);
  assert.equal(payload.status, "advisory");
  assert.equal(
    payload.checks.find((check) => check.id === "staged-tree")?.status,
    "failed",
  );
});

test("reports a timeout when tools exceed the configured limit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A 1ms ceiling forces ESLint and Prettier to be killed before they finish.
  setPrecommitConfig(tempDir, { requireTests: false, timeoutMs: 1 });
  writeFile(path.join(tempDir, "src", "slow.js"), "export const x=1;\n");
  run("git", ["add", "src/slow.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /timed out/);
});

test("missing peer tools stay advisory and never fall back to npx", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  writeFile(path.join(tempDir, "pnpm-lock.yaml"), "");
  writeFile(path.join(tempDir, "src", "local-only.js"), "export const x=1;\n");
  run("git", ["add", "src/local-only.js"], tempDir);

  fs.unlinkSync(path.join(tempDir, "node_modules"));
  fs.mkdirSync(path.join(tempDir, "node_modules"));
  const binDir = path.join(tempDir, ".fakebin");
  const marker = path.join(tempDir, "implicit-npx-was-invoked");
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    "npx",
    `import fs from "node:fs";\nfs.writeFileSync(process.env.NPX_MARKER, "called");\nprocess.exit(99);\n`,
  );
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    NPX_MARKER: marker,
  };
  delete env.npm_config_user_agent;

  const result = runHook(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /ESLint is not installed locally/);
  assert.match(output, /Prettier is not installed locally/);
  assert.match(output, /pnpm add -D eslint@\^9/);
  assert.match(output, /pnpm add -D prettier@\^3/);
  assert.doesNotMatch(output, /Unable to run (ESLint|Prettier)/);
  assert.equal(fs.existsSync(marker), false);
});

test("an explicitly configured npx test command still runs verbatim", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const binDir = path.join(tempDir, ".fakebin");
  const marker = path.join(tempDir, "configured-npx-args.json");
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    "npx",
    `import fs from "node:fs";\nfs.writeFileSync(process.env.NPX_MARKER, JSON.stringify(process.argv.slice(2)));\n`,
  );
  setPrecommitConfig(tempDir, {
    requireTests: false,
    runStagedTests: true,
    testCommand: ["npx", "configured-runner"],
  });
  writeFile(path.join(tempDir, "test", "configured.test.mjs"), "export {};\n");
  run("git", ["add", "test/configured.test.mjs"], tempDir);

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    NPX_MARKER: marker,
  };
  const result = runHook(tempDir, { env });

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), [
    "configured-runner",
    "test/configured.test.mjs",
  ]);
});

test("reports when ESLint cannot complete (broken config)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // An eslint config that throws makes ESLint exit >1 with no JSON results.
  writeFile(
    path.join(tempDir, "eslint.config.js"),
    "throw new Error('broken config');\n",
  );
  setPrecommitConfig(tempDir, { requireTests: false });
  writeFile(path.join(tempDir, "src", "x.js"), "export const x = 1;\n");
  run("git", ["add", "eslint.config.js", "src/x.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /ESLint failed to complete/);
});

test("reports when staged tests cannot run (bad testCommand)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    runStagedTests: true,
    testCommand: ["definitely-not-a-real-binary-xyz"],
  });
  writeFile(
    path.join(tempDir, "test", "thing.test.mjs"),
    'import test from "node:test";\ntest("passes", () => {});\n',
  );
  run("git", ["add", "test/thing.test.mjs"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /Unable to run staged tests/);
});

test("flags auto-fixable ESLint issues (prefer-const)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  // `let` that is never reassigned trips the auto-fixable prefer-const rule.
  writeFile(
    path.join(tempDir, "src", "fixable.js"),
    "let x = 1;\nexport { x };\n",
  );
  run("git", ["add", "src/fixable.js"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /auto-fixable ESLint issue/);
});

test("reports when Prettier cannot complete (unparseable file)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  // Malformed JSON is a format-only file Prettier cannot parse (exit > 1).
  writeFile(path.join(tempDir, "src", "bad.json"), '{"a":}\n');
  run("git", ["add", "src/bad.json"], tempDir);

  const result = runHook(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.match(output, /Prettier failed to complete/);
  // A crash is not a formatting issue, so the amend recommendation and the
  // "N files with formatting issues" counting must not appear.
  assert.doesNotMatch(output, /commit:fix/);
  assert.doesNotMatch(output, /formatting issues/);
});

test("pluralizes the non-checkable info box for multiple files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    protectedBranches: [],
  });

  writeFile(path.join(tempDir, "assets", "a.png"), "x\n");
  writeFile(path.join(tempDir, "assets", "b.png"), "y\n");
  run("git", ["add", "assets"], tempDir);

  const result = runHook(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /2 staged files will be committed/,
  );
});

test("pluralizes auto-fixable ESLint issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  // Two `let`s that are never reassigned trip the auto-fixable prefer-const rule.
  writeFile(
    path.join(tempDir, "src", "fixable.js"),
    "let a = 1;\nlet b = 2;\nexport { a, b };\n",
  );
  run("git", ["add", "src/fixable.js"], tempDir);

  const result = runHook(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /2 auto-fixable ESLint issues/,
  );
});

test("pluralizes manual ESLint issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  // Two unused constants: no-unused-vars is not auto-fixable, so both are manual.
  writeFile(
    path.join(tempDir, "src", "manual.js"),
    "const a = 1;\nconst b = 2;\n",
  );
  run("git", ["add", "src/manual.js"], tempDir);

  const result = runHook(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /2 ESLint issues needing manual fixes/,
  );
});

test("reports a manual ESLint issue that has no rule id (parse error)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  // A syntax error is a fatal parse error: it has a location but no ruleId,
  // exercising the ruleId-less branch of the manual-issue detail formatter.
  writeFile(path.join(tempDir, "src", "oops.js"), "const x = ;\n");
  run("git", ["add", "src/oops.js"], tempDir);

  const result = runHook(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /ESLint issue.*manual fixes/,
  );
});

test("continues (advisory) when the unstaged-file probe fails", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "x.js"), "export const x = 1;\n");
  run("git", ["add", "src/x.js"], tempDir);

  // Fail only the unstaged `git diff --name-only` probe; the staged probe works.
  const env = fakeGitEnv(tempDir, "diff --name-only");
  const result = runHook(tempDir, { env });

  assert.equal(result.status, 0);
});

test("withholds the amend recommendation when the worktree cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A fixable formatting issue would normally recommend commit:fix.
  writeFile(path.join(tempDir, "src", "format-only.json"), '{"alpha":1}\n');
  run("git", ["add", "src/format-only.json"], tempDir);

  // Fail only the unstaged `git diff --name-only` probe; the staged probe works.
  const env = fakeGitEnv(tempDir, "diff --name-only");
  const result = runHook(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not be inspected/);
  assert.doesNotMatch(output, /commit:fix/);
});

test("reports a staged-test timeout", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    requireTests: false,
    runStagedTests: true,
    timeoutMs: 1,
  });
  writeFile(
    path.join(tempDir, "test", "slow.test.mjs"),
    'import test from "node:test";\n' +
      'test("slow", async () => {\n' +
      "  await new Promise((resolve) => setTimeout(resolve, 30_000));\n" +
      "});\n",
  );
  run("git", ["add", "test/slow.test.mjs"], tempDir);

  const result = runHook(tempDir);
  assert.match(`${result.stdout}${result.stderr}`, /Staged tests timed out/);
});

test("pluralizes the failing staged-test count", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { runStagedTests: true });
  const failing =
    'import test from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    'test("fails", () => assert.equal(1, 2));\n';
  writeFile(path.join(tempDir, "test", "a.test.mjs"), failing);
  writeFile(path.join(tempDir, "test", "b.test.mjs"), failing);
  run("git", ["add", "test"], tempDir);

  const result = runHook(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /2 staged test files failing/,
  );
});

test("pluralizes formatting issues across multiple files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { requireTests: false });
  writeFile(path.join(tempDir, "src", "a.json"), '{"x":1}\n');
  writeFile(path.join(tempDir, "src", "b.json"), '{"y":2}\n');
  run("git", ["add", "src"], tempDir);

  const result = runHook(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /2 files with formatting issues/,
  );
});

test("aggregates ESLint and Prettier findings across argument batches", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    requireTests: false,
    protectedBranches: [],
  });
  const fileCount = 240;
  for (let index = 0; index < fileCount; index += 1) {
    const name = `batch-${String(index).padStart(3, "0")}-${"x".repeat(105)}.js`;
    writeFile(
      path.join(tempDir, "src", "batched", name),
      `const unused${index}=${index}\n`,
    );
  }
  run("git", ["add", "src/batched"], tempDir);

  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs"), "--json"],
    tempDir,
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const eslint = payload.checks.find((check) => check.id === "eslint");
  const prettier = payload.checks.find((check) => check.id === "prettier");

  assert.ok(eslint.details.plannedBatchCount > 1);
  assert.equal(eslint.details.batchCount, eslint.details.plannedBatchCount);
  assert.equal(eslint.details.outcome, "nonzero");
  assert.ok(
    eslint.details.batchOutcomes.every(
      (batch) => batch.outcome === "nonzero" && batch.status === 1,
    ),
  );
  assert.ok(prettier.details.plannedBatchCount > 1);
  assert.equal(prettier.details.batchCount, prettier.details.plannedBatchCount);
  assert.equal(prettier.details.outcome, "nonzero");
  assert.ok(
    prettier.details.batchOutcomes.every(
      (batch) => batch.outcome === "nonzero" && batch.status === 1,
    ),
  );
  assert.match(JSON.stringify(payload.findings), /240 ESLint issues/u);
  assert.match(JSON.stringify(payload.findings), /240 files need Prettier/u);
});

test(
  "passes exact NUL-delimited pathological paths to staged tests",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    const selectedPath = path.join(tempDir, "selected-tests.json");
    writeFile(
      path.join(tempDir, "record-tests.mjs"),
      'import fs from "node:fs";\n' +
        `fs.writeFileSync(${JSON.stringify(selectedPath)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    setPrecommitConfig(tempDir, {
      runStagedTests: true,
      testCommand: ["node", "record-tests.mjs"],
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
    run("git", ["add", "--", "record-tests.mjs", source, relatedTest], tempDir);

    const result = runHook(tempDir);

    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(selectedPath, "utf8")), [
      relatedTest,
    ]);
  },
);
