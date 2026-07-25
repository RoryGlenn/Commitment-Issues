// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  addBareRemote,
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  installBlockingPrettierFixture,
  REAL_GIT,
  readFile,
  readHeadFile,
  run,
  runAsync,
  setPrecommitConfig,
  waitForPath,
  writeCrossPlatformShim,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runCommitFix(tempDir, options = {}) {
  return run(
    "node",
    [path.join(tempDir, "scripts", "commit-fix.mjs")],
    tempDir,
    options,
  );
}

async function runCommitFixDuringPrettier(tempDir, mutate, env = {}) {
  const ready = path.join(tempDir, "fixer-ready");
  const release = path.join(tempDir, "fixer-release");
  const execution = runAsync(
    process.execPath,
    [path.join(tempDir, "scripts", "commit-fix.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        ...env,
        FIXER_OUTPUT: '{ "alpha": 1 }\n',
        FIXER_READY: ready,
        FIXER_RELEASE: release,
      },
    },
  );
  try {
    await waitForPath(ready);
    await mutate();
  } finally {
    writeFile(release, "release\n");
  }
  return execution.completed;
}

function prepareBlockingCommit(tempDir, file = "src/race.json") {
  installBlockingPrettierFixture(tempDir);
  run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);
  writeFile(path.join(tempDir, ...file.split("/")), '{"alpha":1}\n');
  run("git", ["add", file], tempDir);
  run("git", ["commit", "-m", "unformatted target"], tempDir);
  return file;
}

function hideNodeModules(tempDir) {
  fs.unlinkSync(path.join(tempDir, "node_modules"));
  fs.mkdirSync(path.join(tempDir, "node_modules"));
}

function failMatchingGitAfterEnv(tempDir, matchSubstring, allowedCalls) {
  const binDir = path.join(tempDir, ".fakebin-sequence");
  const counter = path.join(tempDir, ".fake-git-count");
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    "git",
    `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
if (args.join(" ").includes(process.env.FAKE_GIT_MATCH)) {
  const count = fs.existsSync(process.env.FAKE_GIT_COUNTER)
    ? Number(fs.readFileSync(process.env.FAKE_GIT_COUNTER, "utf8"))
    : 0;
  fs.writeFileSync(process.env.FAKE_GIT_COUNTER, String(count + 1));
  if (count >= Number(process.env.FAKE_GIT_ALLOWED_CALLS)) process.exit(1);
}
const result = spawnSync(process.env.FAKE_GIT_REAL, args, { stdio: "inherit" });
process.exit(result.status == null ? 1 : result.status);
`,
  );
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    FAKE_GIT_ALLOWED_CALLS: String(allowedCalls),
    FAKE_GIT_COUNTER: counter,
    FAKE_GIT_MATCH: matchSubstring,
    FAKE_GIT_REAL: REAL_GIT,
  };
}

function mutateAfterIndexInstallEnv(tempDir, targetFile) {
  const preload = path.join(tempDir, "mutate-after-index-install.mjs");
  writeFile(
    preload,
    `import fs from "node:fs";
import path from "node:path";
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
  const result = originalRename(source, destination);
  if (
    path.basename(String(source)) === "index.lock" &&
    path.basename(String(destination)) === "index"
  ) {
    fs.writeFileSync(process.env.FIXER_LATE_MUTATION, "late user edit\\n");
  }
  return result;
};
`,
  );
  return {
    ...process.env,
    FIXER_LATE_MUTATION: path.join(tempDir, targetFile),
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(preload).href}`,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

test("refuses to amend when tracked worktree changes exist", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "README.md"), "dirty\n");

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Cannot safely amend the latest commit\./);
});

test("shows info when the latest commit has no fixable files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "notes.txt"), "hello\n");
  run("git", ["add", "notes.txt"], tempDir);
  run("git", ["commit", "-m", "notes"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No fixable files in the latest commit\./);
});

test("amends the latest commit when all fixes are automatic", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "amend.json"), '{"alpha":1}\n');
  run("git", ["add", "src/amend.json"], tempDir);
  run("git", ["commit", "-m", "amend"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Latest commit amended with automatic fixes\./);
  assert.equal(readHeadFile(tempDir, "src/amend.json"), '{ "alpha": 1 }\n');
});

test("amends the latest commit and warns when lint issues remain", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "warn.js"), "const value=1\n");
  run("git", ["add", "src/warn.js"], tempDir);
  run("git", ["commit", "-m", "warn"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Latest commit amended with available fixes\./);
  assert.match(output, /no-unused-vars/);
  assert.equal(readHeadFile(tempDir, "src/warn.js"), "const value = 1;\n");
});

test("errors when there is no commit to inspect", (t) => {
  const tempDir = createTempRepo({ commit: false });
  t.after(() => cleanupTempRepo(tempDir));

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to inspect the latest commit\./);
});

test("refuses to amend a commit that has already been pushed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  addBareRemote(tempDir); // HEAD now exists on origin/main

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /already been pushed/);
});

test("refuses to amend when the pushed check cannot run", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Fail only `git branch -r --contains HEAD`; the command must fail closed
  // rather than assume the commit is unpushed.
  const env = fakeGitEnv(tempDir, "branch -r --contains");
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to verify the latest commit is unpushed\./);
});

test("fails closed when publication state cannot be revalidated", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "publication.json"), '{"alpha":1}\n');
  run("git", ["add", "src/publication.json"], tempDir);
  run("git", ["commit", "-m", "publication check"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const env = failMatchingGitAfterEnv(tempDir, "branch -r --contains", 1);

  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to revalidate publication state/);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
});

test("fails closed when the worktree cannot be revalidated", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "worktree.json"), '{"alpha":1}\n');
  run("git", ["add", "src/worktree.json"], tempDir);
  run("git", ["commit", "-m", "worktree check"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const env = failMatchingGitAfterEnv(tempDir, "diff --name-only -z", 1);

  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to revalidate the working tree/);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
});

test("refuses when HEAD changes before fixer inputs are captured", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "head.json"), '{"alpha":1}\n');
  run("git", ["add", "src/head.json"], tempDir);
  run("git", ["commit", "-m", "head check"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const env = fakeGitEnv(
    tempDir,
    "rev-parse --verify --quiet HEAD",
    0,
    `${"0".repeat(40)}\n`,
  );

  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
});

test("reports the latest commit is already clean when nothing changes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "clean.js"), "export const x = 1;\n");
  run("git", ["add", "src/clean.js"], tempDir);
  run("git", ["commit", "-m", "clean"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Latest commit already clean\./);
});

test("errors when the working tree cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Fail the unstaged `git diff --name-only` probe; earlier calls succeed.
  const env = fakeGitEnv(tempDir, "diff --name-only");
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to inspect the current working tree\./);
});

test("errors when the latest commit's files cannot be listed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const env = fakeGitEnv(tempDir, "diff-tree");
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to inspect files from the latest commit\./);
});

test("errors when the latest commit pathname output is malformed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "x.json"), '{"x":1}\n');
  run("git", ["add", "src/x.json"], tempDir);
  run("git", ["commit", "-m", "x"], tempDir);
  const env = fakeGitEnv(tempDir, "diff-tree", 0, "src/x.json");

  const result = runCommitFix(tempDir, { env });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unable to inspect files from the latest commit/,
  );
});

test("errors when the exact fixed index cannot be prepared", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "amend.json"), '{"alpha":1}\n');
  run("git", ["add", "src/amend.json"], tempDir);
  run("git", ["commit", "-m", "amend"], tempDir);

  const env = fakeGitEnv(tempDir, "update-index -z --index-info");
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to prepare exact staged fixes/);
});

test("errors when fixed content cannot be stored as an exact blob", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "amend.json"), '{"alpha":1}\n');
  run("git", ["add", "src/amend.json"], tempDir);
  run("git", ["commit", "-m", "amend"], tempDir);

  const env = fakeGitEnv(tempDir, "hash-object -w --stdin");
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to store fixed content/);
});

test("warns when a format-only file cannot be fixed automatically", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Malformed JSON: Prettier fails to parse it, so no automatic fix lands.
  writeFile(path.join(tempDir, "src", "bad.json"), '{"a":}\n');
  run("git", ["add", "src/bad.json"], tempDir);
  run("git", ["commit", "-m", "bad json"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Manual attention still needed\./);
});

test("reports local install guidance when committed-file tools are missing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "missing.js"), "export const x=1;\n");
  hideNodeModules(tempDir);
  run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);
  run("git", ["add", "src/missing.js"], tempDir);
  run("git", ["commit", "-m", "missing tools"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /missing local tool\(s\): eslint, prettier/i);
  assert.match(output, /npm install -D eslint@\^9 prettier@\^3/);
});

test("commit-fix timeout cleans up fixer descendants", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { timeoutMs: 1500 });
  writeFile(path.join(tempDir, "src", "slow.js"), "export const slow = 1;\n");

  // Replace the shared dependency link with local fixture packages. The fake
  // ESLint starts a heartbeat grandchild and hangs; Prettier exits cleanly so
  // the timeout path remains isolated to one tool.
  fs.unlinkSync(path.join(tempDir, "node_modules"));
  const heartbeat = path.join(tempDir, "fixer-heartbeat");
  const parentPidFile = path.join(tempDir, "fixer-parent-pid");
  const childPidFile = path.join(tempDir, "fixer-child-pid");
  const worker = [
    'const fs = require("node:fs");',
    "let beat = 0;",
    "fs.writeFileSync(process.env.FIXER_CHILD_PID, String(process.pid));",
    "fs.writeFileSync(process.env.FIXER_HEARTBEAT, String(beat));",
    "setInterval(() => fs.writeFileSync(process.env.FIXER_HEARTBEAT, String(++beat)), 40);",
  ].join("\n");
  writeFile(
    path.join(tempDir, "node_modules", "eslint", "package.json"),
    `${JSON.stringify({ name: "eslint", bin: "bin/eslint.mjs" })}\n`,
  );
  writeFile(
    path.join(tempDir, "node_modules", "eslint", "bin", "eslint.mjs"),
    [
      'import fs from "node:fs";',
      'import { spawn } from "node:child_process";',
      "process.stdout.destroy();",
      "process.stderr.destroy();",
      "fs.writeFileSync(process.env.FIXER_PARENT_PID, String(process.pid));",
      `spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "ignore" });`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  writeFile(
    path.join(tempDir, "node_modules", "prettier", "package.json"),
    `${JSON.stringify({ name: "prettier", bin: "bin/prettier.mjs" })}\n`,
  );
  writeFile(
    path.join(tempDir, "node_modules", "prettier", "bin", "prettier.mjs"),
    "process.stdin.pipe(process.stdout);\n",
  );
  // The fixture repo tracks its original node_modules symlink. Remove that
  // link from the index in this commit; the replacement directory stays
  // ignored, leaving commit-fix a clean worktree to inspect.
  run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);
  run("git", ["add", "src/slow.js", "package.json"], tempDir);
  run("git", ["commit", "-m", "slow fixer"], tempDir);

  const env = {
    ...process.env,
    FIXER_HEARTBEAT: heartbeat,
    FIXER_PARENT_PID: parentPidFile,
    FIXER_CHILD_PID: childPidFile,
  };
  let heartbeatContinued = false;
  let cleanupNeeded = true;
  try {
    const result = runCommitFix(tempDir, { env });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /Manual attention/);
    assert.equal(fs.existsSync(childPidFile), true, "grandchild should start");

    const beatAtTimeout = fs.readFileSync(heartbeat, "utf8");
    await delay(300);
    const beatAfterTimeout = fs.readFileSync(heartbeat, "utf8");
    heartbeatContinued = beatAfterTimeout !== beatAtTimeout;
    cleanupNeeded = heartbeatContinued;
  } finally {
    for (const pidFile of cleanupNeeded ? [parentPidFile, childPidFile] : []) {
      if (!fs.existsSync(pidFile)) {
        continue;
      }
      try {
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
      } catch {
        // Expected after successful process-tree cleanup.
      }
    }
  }

  assert.equal(heartbeatContinued, false, "fixer grandchild survived timeout");
});

test("errors when the amend itself fails", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A fixable file so fixers change it and the flow reaches the amend step.
  writeFile(path.join(tempDir, "src", "amend.json"), '{"alpha":1}\n');
  run("git", ["add", "src/amend.json"], tempDir);
  run("git", ["commit", "-m", "amend"], tempDir);

  const env = fakeGitEnv(tempDir, "commit --amend");
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /could not be amended/);
});

test("already-clean summary pluralizes for multiple files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "a.js"), "export const a = 1;\n");
  writeFile(path.join(tempDir, "src", "b.js"), "export const b = 2;\n");
  run("git", ["add", "src/a.js", "src/b.js"], tempDir);
  run("git", ["commit", "-m", "clean"], tempDir);

  const result = runCommitFix(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Checked 2 files from the latest commit/,
  );
});

test("amend summary pluralizes for multiple updated files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "a.json"), '{"a":1}\n');
  writeFile(path.join(tempDir, "src", "b.json"), '{"b":2}\n');
  run("git", ["add", "src/a.json", "src/b.json"], tempDir);
  run("git", ["commit", "-m", "unformatted"], tempDir);

  const result = runCommitFix(tempDir);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Updated 2 files from the latest commit/,
  );
});

test("guides the user when the fixes would empty the commit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Base commit with a clean file, then a commit whose ONLY change is a
  // formatting issue (a trailing space) that Prettier reverts — so amending
  // after the fix would leave an empty commit.
  writeFile(path.join(tempDir, "src", "ws.js"), "export const x = 1;\n");
  run("git", ["add", "src/ws.js"], tempDir);
  run("git", ["commit", "-m", "base"], tempDir);
  writeFile(path.join(tempDir, "src", "ws.js"), "export const x = 1; \n");
  run("git", ["add", "src/ws.js"], tempDir);
  run("git", ["commit", "-m", "whitespace only"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /emptied the latest commit/);
  assert.match(output, /git reset --soft HEAD\^/);
});

test(
  "amends the exact committed path containing legal whitespace and Unicode",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    const file = "src/ leading\t猫\ntrailing /data.json";
    writeFile(path.join(tempDir, ...file.split("/")), '{"alpha":1}\n');
    run("git", ["add", "--", file], tempDir);
    run("git", ["commit", "-m", "pathological path"], tempDir);

    const result = runCommitFix(tempDir);

    assert.equal(result.status, 0);
    assert.equal(readHeadFile(tempDir, file), '{ "alpha": 1 }\n');
  },
);

test("refuses a concurrent target auto-save without amending it", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = prepareBlockingCommit(tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const concurrent = '{"user":true}\n';

  const result = await runCommitFixDuringPrettier(tempDir, () => {
    writeFile(path.join(tempDir, file), concurrent);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.match(output, /latest commit was not amended/i);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(readFile(tempDir, file), concurrent);
  assert.equal(readHeadFile(tempDir, file), '{"alpha":1}\n');
});

test("preserves unrelated tracked worktree changes during fixer execution", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  prepareBlockingCommit(tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const concurrent = "unrelated user edit\n";

  const result = await runCommitFixDuringPrettier(tempDir, () => {
    writeFile(path.join(tempDir, "README.md"), concurrent);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.equal(readFile(tempDir, "README.md"), concurrent);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
});

test("revalidates the worktree immediately before amend", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "late.json"), '{"alpha":1}\n');
  run("git", ["add", "src/late.json"], tempDir);
  run("git", ["commit", "-m", "late guard"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const result = runCommitFix(tempDir, {
    env: mutateAfterIndexInstallEnv(tempDir, "README.md"),
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.equal(readFile(tempDir, "README.md"), "late user edit\n");
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(
    run("git", ["show", ":src/late.json"], tempDir).stdout,
    '{ "alpha": 1 }\n',
  );
});

test("refuses concurrent committed-target deletion and type replacement", async (t) => {
  for (const replacement of ["missing", "directory"]) {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const file = prepareBlockingCommit(
      tempDir,
      `src/${replacement}-commit.json`,
    );
    const target = path.join(tempDir, file);
    const originalHead = run(
      "git",
      ["rev-parse", "HEAD"],
      tempDir,
    ).stdout.trim();

    const result = await runCommitFixDuringPrettier(tempDir, () => {
      fs.rmSync(target);
      if (replacement === "directory") {
        fs.mkdirSync(target);
      }
    });

    assert.equal(result.status, 1);
    assert.equal(
      run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
      originalHead,
    );
    assert.equal(fs.existsSync(target), replacement === "directory");
    if (replacement === "directory") {
      assert.equal(fs.lstatSync(target).isDirectory(), true);
    }
  }
});

test("preserves a concurrent index update instead of amending it", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  prepareBlockingCommit(tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const result = await runCommitFixDuringPrettier(tempDir, () => {
    writeFile(path.join(tempDir, "concurrent.txt"), "user index work\n");
    run("git", ["add", "concurrent.txt"], tempDir);
  });

  assert.equal(result.status, 1);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(
    run("git", ["show", ":concurrent.txt"], tempDir).stdout,
    "user index work\n",
  );
});

test("refuses when HEAD moves before the amend", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  prepareBlockingCommit(tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const result = await runCommitFixDuringPrettier(tempDir, () => {
    run("git", ["commit", "--allow-empty", "-m", "concurrent head"], tempDir);
  });
  const movedHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  assert.equal(result.status, 1);
  assert.notEqual(movedHead, originalHead);
  assert.equal(
    run("git", ["log", "-1", "--format=%s"], tempDir).stdout.trim(),
    "concurrent head",
  );
});

test("refuses a publication during the run with the fun tone", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));
  prepareBlockingCommit(tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  writeFile(path.join(tempDir, ".commitmentrc.json"), '{"tone":"fun"}\n');

  const result = await runCommitFixDuringPrettier(tempDir, () => {
    const pushed = run("git", ["push", "origin", "HEAD:main"], tempDir);
    assert.equal(pushed.status, 0);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /changed the relationship status mid-fix/);
  assert.match(output, /latest commit was left out of the drama/i);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(
    run(
      "git",
      ["rev-parse", "refs/remotes/origin/main"],
      tempDir,
    ).stdout.trim(),
    originalHead,
  );
});
