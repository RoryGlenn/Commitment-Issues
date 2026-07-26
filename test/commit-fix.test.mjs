// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  addBareRemote,
  cleanupTempRepo,
  createExternalHardlink,
  createHardlinkOrSkip,
  createTempRepo,
  fakeGitEnv,
  installBlockingPrettierFixture,
  installInterruptedFixerFixture,
  installInterruptibleProcessFixture,
  REAL_GIT,
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
import { stripAnsi } from "./helpers/output.mjs";

function runCommitFix(tempDir, options = {}) {
  const { cwd = tempDir, ...runOptions } = options;
  return run(
    "node",
    [path.join(tempDir, "scripts", "commit-fix.mjs")],
    cwd,
    runOptions,
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

function commitFixableJson(tempDir, name, message) {
  const file = `src/${name}.json`;
  writeFile(path.join(tempDir, "src", `${name}.json`), '{"alpha":1}\n');
  run("git", ["add", file], tempDir);
  const committed = run("git", ["commit", "-m", message], tempDir);
  assert.equal(committed.status, 0, committed.stderr);
  return file;
}

function markHiddenIndexState(tempDir, file, state) {
  let result;
  if (state === "core.ignoreStat") {
    result = run("git", ["config", "core.ignoreStat", "true"], tempDir);
    assert.equal(result.status, 0, result.stderr);
    result = run(
      "git",
      ["update-index", "--really-refresh", "--", file],
      tempDir,
    );
  } else {
    result = run("git", ["update-index", `--${state}`, "--", file], tempDir);
  }
  assert.equal(result.status, 0, result.stderr);
  const tag = run("git", ["ls-files", "-v", "--", file], tempDir);
  assert.equal(tag.status, 0, tag.stderr);
  assert.match(tag.stdout, state === "skip-worktree" ? /^S /u : /^h /u);
}

function gitPath(tempDir, name) {
  const result = run("git", ["rev-parse", "--git-path", name], tempDir);
  assert.equal(result.status, 0, result.stderr);
  return path.resolve(tempDir, result.stdout.replace(/\r?\n$/u, ""));
}

function snapshotPath(filePath) {
  if (!fs.existsSync(filePath)) {
    return { type: "missing" };
  }
  const stats = fs.lstatSync(filePath);
  if (stats.isDirectory()) {
    return {
      type: "directory",
      entries: fs
        .readdirSync(filePath)
        .sort()
        .map((entry) => [entry, snapshotPath(path.join(filePath, entry))]),
    };
  }
  if (stats.isSymbolicLink()) {
    return { type: "symlink", target: fs.readlinkSync(filePath) };
  }
  return {
    type: stats.isFile() ? "file" : "other",
    mode: stats.mode,
    content: stats.isFile()
      ? fs.readFileSync(filePath).toString("base64")
      : null,
  };
}

function captureRefusalState(tempDir, operationMarkers) {
  const head = run("git", ["rev-parse", "HEAD"], tempDir);
  const files = run(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    tempDir,
  );
  assert.equal(head.status, 0, head.stderr);
  assert.equal(files.status, 0, files.stderr);
  const worktree = Object.fromEntries(
    [...new Set(files.stdout.split("\0").filter(Boolean))]
      .sort()
      .map((file) => [
        file,
        snapshotPath(path.join(tempDir, ...file.split("/"))),
      ]),
  );
  const operations = Object.fromEntries(
    operationMarkers.map((marker) => [
      marker,
      snapshotPath(gitPath(tempDir, marker)),
    ]),
  );
  return {
    head: head.stdout.trim(),
    index: fs.readFileSync(gitPath(tempDir, "index")).toString("base64"),
    operations,
    worktree,
  };
}

function createOperationFixture(tempDir, marker, kind) {
  const markerPath = gitPath(tempDir, marker);
  if (kind === "directory") {
    fs.mkdirSync(markerPath, { recursive: true });
    writeFile(path.join(markerPath, "state"), `${marker} state\n`);
  } else {
    const head = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
    writeFile(markerPath, `${head}\n`);
  }
}

function addSyntheticSignatureHeader(tempDir, header) {
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const original = run(
    "git",
    ["cat-file", "commit", originalHead],
    tempDir,
  ).stdout;
  const separator = original.indexOf("\n\n");
  assert.ok(separator > 0);
  const signed = `${original.slice(0, separator)}\n${header} -----BEGIN PGP SIGNATURE-----\n synthetic-test-signature\n -----END PGP SIGNATURE-----${original.slice(separator)}`;
  const stored = run(
    "git",
    ["hash-object", "-t", "commit", "-w", "--stdin"],
    tempDir,
    { input: signed },
  );
  assert.equal(stored.status, 0, stored.stderr);
  const signedHead = stored.stdout.trim();
  const updated = run(
    "git",
    ["update-ref", "HEAD", signedHead, originalHead],
    tempDir,
  );
  assert.equal(updated.status, 0, updated.stderr);
  return signedHead;
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

for (const state of ["assume-unchanged", "skip-worktree", "core.ignoreStat"]) {
  test(`commit-fix preserves private edits hidden by ${state}`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const file = commitFixableJson(
      tempDir,
      `hidden-${state.replace(".", "-")}`,
      `add ${state} target`,
    );
    markHiddenIndexState(tempDir, file, state);
    writeFile(path.join(tempDir, file), '{"private":true}\n');
    const hidden = run("git", ["diff", "--name-only", "--", file], tempDir);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.equal(hidden.stdout, "");
    const before = captureRefusalState(tempDir, []);

    const result = runCommitFix(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      state === "skip-worktree"
        ? /skip-worktree index state/
        : /assume-unchanged index state/,
    );
    assert.deepEqual(captureRefusalState(tempDir, []), before);
  });
}

test("commit-fix preserves an unavailable sparse-checkout target", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const hiddenFile = "hidden/sparse.json";
  const visibleFile = "visible/keep.txt";
  writeFile(path.join(tempDir, hiddenFile), '{"alpha":1}\n');
  writeFile(path.join(tempDir, visibleFile), "visible\n");
  run("git", ["add", hiddenFile, visibleFile], tempDir);
  const committed = run("git", ["commit", "-m", "add sparse target"], tempDir);
  assert.equal(committed.status, 0, committed.stderr);
  const initialized = run(
    "git",
    ["sparse-checkout", "init", "--cone"],
    tempDir,
  );
  const selected = run("git", ["sparse-checkout", "set", "visible"], tempDir);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(fs.existsSync(path.join(tempDir, hiddenFile)), false);
  assert.match(
    run("git", ["ls-files", "-v", "--", hiddenFile], tempDir).stdout,
    /^S /u,
  );
  const before = captureRefusalState(tempDir, []);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /skip-worktree index state/);
  assert.deepEqual(captureRefusalState(tempDir, []), before);
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

test("commit-fix resolves committed root paths from a subdirectory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "nested-amend.json"), '{"alpha":1}\n');
  run("git", ["add", "src/nested-amend.json"], tempDir);
  run("git", ["commit", "-m", "nested amend"], tempDir);
  const nested = path.join(tempDir, "nested path", "deeper");
  fs.mkdirSync(nested, { recursive: true });

  const result = runCommitFix(tempDir, { cwd: nested });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(
    readHeadFile(tempDir, "src/nested-amend.json"),
    '{ "alpha": 1 }\n',
  );
});

test("commit-fix breaks a target hardlink without changing external bytes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = "src/hardlinked.json";
  const originalContent = '{"alpha":1}\n';
  const fixedContent = '{ "alpha": 1 }\n';
  const linked = createExternalHardlink(t, tempDir, file, originalContent);
  if (!linked) {
    return;
  }
  run("git", ["add", file], tempDir);
  run("git", ["commit", "-m", "hardlinked target"], tempDir);
  assert.equal(fs.lstatSync(linked.outsidePath).nlink, 2);

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(fs.readFileSync(linked.outsidePath, "utf8"), originalContent);
  assert.equal(fs.lstatSync(linked.outsidePath).nlink, 1);
  assert.equal(fs.readFileSync(linked.projectPath, "utf8"), fixedContent);
  assert.equal(readHeadFile(tempDir, file), fixedContent);
  assert.notDeepEqual(
    [
      fs.lstatSync(linked.projectPath, { bigint: true }).dev,
      fs.lstatSync(linked.projectPath, { bigint: true }).ino,
    ],
    [
      fs.lstatSync(linked.outsidePath, { bigint: true }).dev,
      fs.lstatSync(linked.outsidePath, { bigint: true }).ino,
    ],
  );
});

test("commit-fix refuses co-selected hardlink aliases before mutation", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const first = path.join(tempDir, "src", "hardlink-first.json");
  const second = path.join(tempDir, "src", "hardlink-second.json");
  const originalContent = '{"alpha":1}\n';
  writeFile(first, originalContent);
  if (!createHardlinkOrSkip(t, first, second)) {
    return;
  }
  run(
    "git",
    ["add", "src/hardlink-first.json", "src/hardlink-second.json"],
    tempDir,
  );
  run("git", ["commit", "-m", "hardlinked targets"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unable to apply automatic fixes safely/,
  );
  assert.equal(fs.readFileSync(first, "utf8"), originalContent);
  assert.equal(fs.readFileSync(second, "utf8"), originalContent);
  assert.equal(fs.lstatSync(first).nlink, 2);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
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

test("refuses every active Git operation before fixer mutation", () => {
  const fixtures = [
    {
      marker: "MERGE_HEAD",
      snapshotMarker: "MERGE_HEAD",
      kind: "file",
      operation: "merge",
    },
    {
      marker: "CHERRY_PICK_HEAD",
      snapshotMarker: "CHERRY_PICK_HEAD",
      kind: "file",
      operation: "cherry-pick",
    },
    {
      marker: "REVERT_HEAD",
      snapshotMarker: "REVERT_HEAD",
      kind: "file",
      operation: "revert",
    },
    {
      marker: "rebase-apply",
      snapshotMarker: "rebase-apply",
      kind: "directory",
      operation: "rebase",
    },
    {
      marker: "rebase-merge",
      snapshotMarker: "rebase-merge",
      kind: "directory",
      operation: "rebase",
    },
    {
      marker: "rebase-apply/applying",
      snapshotMarker: "rebase-apply",
      kind: "file",
      operation: "git am",
    },
    {
      marker: "sequencer",
      snapshotMarker: "sequencer",
      kind: "directory",
      operation: "sequencer",
    },
  ];

  for (const fixture of fixtures) {
    const tempDir = createTempRepo();
    try {
      commitFixableJson(
        tempDir,
        `operation-${fixture.operation.replaceAll(" ", "-")}`,
        `${fixture.operation} operation`,
      );
      createOperationFixture(tempDir, fixture.marker, fixture.kind);
      const before = captureRefusalState(tempDir, [fixture.snapshotMarker]);

      const result = runCommitFix(tempDir);
      const output = `${result.stdout}${result.stderr}`;

      assert.equal(result.status, 1, fixture.marker);
      assert.match(output, /Cannot amend during an active Git operation\./);
      assert.match(
        output,
        new RegExp(`active ${fixture.operation} state`, "u"),
      );
      assert.match(output, /No fixer tools ran/);
      assert.deepEqual(
        captureRefusalState(tempDir, [fixture.snapshotMarker]),
        before,
        fixture.marker,
      );
    } finally {
      cleanupTempRepo(tempDir);
    }
  }
});

test("refuses an empty multi-command revert and preserves continuation", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = "src/revert-sequence.json";
  writeFile(path.join(tempDir, "src", "revert-sequence.json"), '{"step":1}\n');
  run("git", ["add", file], tempDir);
  const first = run("git", ["commit", "-m", "first sequence change"], tempDir);
  assert.equal(first.status, 0, first.stderr);
  const firstCommit = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  writeFile(path.join(tempDir, "src", "revert-sequence.json"), '{"step":2}\n');
  run("git", ["add", file], tempDir);
  const second = run(
    "git",
    ["commit", "-m", "second sequence change"],
    tempDir,
  );
  assert.equal(second.status, 0, second.stderr);
  const secondCommit = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  const started = run(
    "git",
    ["revert", "--no-edit", firstCommit, secondCommit],
    tempDir,
  );
  assert.notEqual(started.status, 0);
  assert.equal(fs.existsSync(gitPath(tempDir, "REVERT_HEAD")), true);
  assert.equal(fs.existsSync(gitPath(tempDir, "sequencer")), true);

  const ours = run("git", ["checkout", "--ours", "--", file], tempDir);
  assert.equal(ours.status, 0, ours.stderr);
  run("git", ["add", "--", file], tempDir);
  assert.equal(
    run("git", ["diff", "--cached", "--quiet", "HEAD"], tempDir).status,
    0,
  );
  assert.equal(run("git", ["diff", "--quiet"], tempDir).status, 0);
  const before = captureRefusalState(tempDir, [
    "REVERT_HEAD",
    "sequencer",
    "MERGE_MSG",
  ]);

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /active revert state/);
  assert.deepEqual(
    captureRefusalState(tempDir, ["REVERT_HEAD", "sequencer", "MERGE_MSG"]),
    before,
  );

  const continued = run("git", ["revert", "--skip"], tempDir);
  assert.equal(continued.status, 0, continued.stderr);
  assert.equal(fs.existsSync(gitPath(tempDir, "REVERT_HEAD")), false);
  assert.equal(fs.existsSync(gitPath(tempDir, "sequencer")), false);
});

test("active-operation refusals honor fun tone", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { tone: "fun" });
  run("git", ["add", "package.json"], tempDir);
  commitFixableJson(tempDir, "fun-operation", "fun operation");
  createOperationFixture(tempDir, "MERGE_HEAD", "file");

  const result = runCommitFix(tempDir);
  const output = stripAnsi(`${result.stdout}${result.stderr}`);

  assert.equal(result.status, 1);
  assert.match(output, /Git is already in a complicated relationship\./);
  assert.match(output, /merge is still in progress\./);
  assert.match(output, /left exactly where it[\s│]+was/);
});

test("fails closed when active Git operations cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  commitFixableJson(tempDir, "operation-inspection", "operation inspection");
  const env = fakeGitEnv(tempDir, "rev-parse --git-path rebase-apply/applying");
  const before = captureRefusalState(tempDir, []);

  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to inspect active Git operations\./);
  assert.match(output, /No fixer tools ran/);
  assert.deepEqual(captureRefusalState(tempDir, []), before);
});

test("refuses to amend a detached commit without moving it", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  commitFixableJson(tempDir, "detached", "detached target");
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  run("git", ["switch", "--detach", "HEAD"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Cannot amend a detached commit\./);
  assert.match(output, /reachable only through Git's reflog/);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(run("git", ["branch", "--show-current"], tempDir).stdout, "");
});

test("refuses a symbolic HEAD that is not a local branch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const env = fakeGitEnv(
    tempDir,
    "symbolic-ref --quiet HEAD",
    0,
    "refs/custom/current\n",
  );

  const result = runCommitFix(tempDir, { env });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Cannot amend a detached commit\./,
  );
});

test("refuses when attached-HEAD state cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const env = fakeGitEnv(tempDir, "symbolic-ref --quiet HEAD", 2);

  const result = runCommitFix(tempDir, { env });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unable to prove the latest commit is safe to amend\./,
  );
});

test("refuses a commit retained by a local tag", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  commitFixableJson(tempDir, "tagged", "tagged target");
  run("git", ["tag", "reviewed-snapshot"], tempDir);

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /retained by a protected Git reference/);
  assert.match(output, /refs\/tags\/reviewed-snapshot/);
});

test("refuses a commit retained by a custom known remote ref", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  commitFixableJson(tempDir, "custom-ref", "custom ref target");
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  run(
    "git",
    ["update-ref", "refs/remotes/origin/reviews/accepted", originalHead],
    tempDir,
  );

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /refs\/remotes\/origin\/reviews\/accepted/);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
});

test("refuses to amend a commit retained by a remote-tracking ref", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const remoteDir = addBareRemote(tempDir); // HEAD now exists on origin/main
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  const result = runCommitFix(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /retained by a protected Git reference/);
  assert.match(output, /refs\/remotes\/origin\/main/);
});

test("limits the offline proof to local tags and remote-tracking refs", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));
  commitFixableJson(tempDir, "remote-only-tag", "remote-only tag target");
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const pushed = run(
    "git",
    ["push", "origin", "HEAD:refs/tags/remote-only-snapshot"],
    tempDir,
  );
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(
    run(
      "git",
      ["show-ref", "--verify", "--quiet", "refs/tags/remote-only-snapshot"],
      tempDir,
    ).status,
    1,
  );

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.notEqual(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(
    run(
      "git",
      ["--git-dir", remoteDir, "rev-parse", "refs/tags/remote-only-snapshot"],
      tempDir,
    ).stdout.trim(),
    originalHead,
  );
});

test("refuses to amend when protected refs cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const env = fakeGitEnv(
    tempDir,
    "for-each-ref --format=%(refname) --contains",
  );
  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to prove the latest commit is safe to amend\./);
});

test("refuses when commit metadata cannot be inspected", (t) => {
  for (const fixture of [
    { name: "failed query", status: 1, stdout: "" },
    { name: "malformed commit", status: 0, stdout: "tree malformed\n" },
  ]) {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const env = fakeGitEnv(
      tempDir,
      "cat-file commit",
      fixture.status,
      fixture.stdout,
    );

    const result = runCommitFix(tempDir, { env });

    assert.equal(result.status, 1, fixture.name);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Unable to prove the latest commit is safe to amend\./,
      fixture.name,
    );
  }
});

for (const header of ["gpgsig", "gpgsig-sha256"]) {
  test(`refuses a commit carrying a ${header} signature header`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    commitFixableJson(tempDir, `synthetic-${header}`, "signed target");
    const signedHead = addSyntheticSignatureHeader(tempDir, header);

    const result = runCommitFix(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /Cannot automatically amend a signed commit\./);
    assert.match(output, /No index or history was changed\./);
    assert.equal(
      run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
      signedHead,
    );
  });
}

test("inspects signed commit metadata without replacement objects", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  commitFixableJson(tempDir, "replace-hidden-signature", "signed target");
  const unsignedReplacement = run(
    "git",
    ["rev-parse", "HEAD"],
    tempDir,
  ).stdout.trim();
  const signedHead = addSyntheticSignatureHeader(tempDir, "gpgsig");
  const replaced = run(
    "git",
    ["replace", signedHead, unsignedReplacement],
    tempDir,
  );
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.doesNotMatch(
    run("git", ["cat-file", "commit", signedHead], tempDir).stdout,
    /gpgsig /u,
  );
  assert.match(
    run(
      "git",
      ["--no-replace-objects", "cat-file", "commit", signedHead],
      tempDir,
    ).stdout,
    /gpgsig /u,
  );

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Cannot automatically amend a signed commit\./,
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    signedHead,
  );
});

test("refuses a real SSH-signed commit when Git supports SSH signing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const signingKey = path.join(tempDir, "commit-fix-signing-key");
  const generated = run(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-f", signingKey],
    tempDir,
  );
  if (generated.error || generated.status !== 0) {
    t.skip("ssh-keygen is unavailable on this host");
    return;
  }

  const file = "src/ssh-signed.json";
  writeFile(path.join(tempDir, ...file.split("/")), '{"alpha":1}\n');
  run("git", ["add", file], tempDir);
  const committed = run(
    "git",
    [
      "-c",
      "gpg.format=ssh",
      "-c",
      `user.signingkey=${signingKey}`,
      "-c",
      "commit.gpgsign=true",
      "commit",
      "-m",
      "SSH signed target",
    ],
    tempDir,
  );
  if (committed.status !== 0) {
    t.skip(`Git SSH signing is unavailable: ${committed.stderr.trim()}`);
    return;
  }
  const signedHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  assert.match(
    run("git", ["cat-file", "commit", "HEAD"], tempDir).stdout,
    /BEGIN SSH SIGNATURE/,
  );

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Cannot automatically amend a signed commit\./,
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    signedHead,
  );
});

test("refuses a real OpenPGP-signed commit when GPG is available", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const gpgHome = fs.mkdtempSync(path.join(os.tmpdir(), "commit-fix-gpg-"));
  fs.chmodSync(gpgHome, 0o700);
  t.after(() => fs.rmSync(gpgHome, { recursive: true, force: true }));
  const env = { ...process.env, GNUPGHOME: gpgHome };
  const generated = run(
    "gpg",
    [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      "Commit Fix Test <commit-fix@example.invalid>",
      "rsa2048",
      "sign",
      "0",
    ],
    tempDir,
    { env },
  );
  if (generated.error || generated.status !== 0) {
    t.skip("GPG key generation is unavailable on this host");
    return;
  }
  const listed = run(
    "gpg",
    ["--batch", "--with-colons", "--list-secret-keys"],
    tempDir,
    { env },
  );
  const fingerprint = listed.stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];
  if (!fingerprint) {
    t.skip("GPG did not expose the generated signing key");
    return;
  }

  const file = "src/openpgp-signed.json";
  writeFile(path.join(tempDir, ...file.split("/")), '{"alpha":1}\n');
  run("git", ["add", file], tempDir);
  const committed = run(
    "git",
    [
      "-c",
      "gpg.format=openpgp",
      "-c",
      "gpg.program=gpg",
      "-c",
      `user.signingkey=${fingerprint}`,
      "-c",
      "commit.gpgsign=true",
      "commit",
      "-m",
      "OpenPGP signed target",
    ],
    tempDir,
    { env },
  );
  if (committed.status !== 0) {
    t.skip(`Git OpenPGP signing is unavailable: ${committed.stderr.trim()}`);
    return;
  }
  const signedHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  assert.match(
    run("git", ["cat-file", "commit", "HEAD"], tempDir).stdout,
    /BEGIN PGP SIGNATURE/,
  );

  const result = runCommitFix(tempDir);

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Cannot automatically amend a signed commit\./,
  );
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    signedHead,
  );
});

test("fails closed when protected refs cannot be revalidated", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "publication.json"), '{"alpha":1}\n');
  run("git", ["add", "src/publication.json"], tempDir);
  run("git", ["commit", "-m", "publication check"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const env = failMatchingGitAfterEnv(
    tempDir,
    "for-each-ref --format=%(refname) --contains",
    1,
  );

  const result = runCommitFix(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to revalidate commit history safety/);
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
});

for (const probe of [
  {
    command: "symbolic-ref --quiet HEAD",
    message: /Repository state changed while automatic fixes/,
  },
  {
    command: "cat-file commit",
    message: /Unable to revalidate commit history safety/,
  },
]) {
  test(`fails closed when ${probe.command} cannot be revalidated`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    commitFixableJson(tempDir, "history-revalidation", "history check");
    const originalHead = run(
      "git",
      ["rev-parse", "HEAD"],
      tempDir,
    ).stdout.trim();
    const env = failMatchingGitAfterEnv(tempDir, probe.command, 1);

    const result = runCommitFix(tempDir, { env });

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, probe.message);
    assert.equal(
      run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
      originalHead,
    );
  });
}

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

test(
  "commit-fix cancels formatter descendants before exiting on SIGTERM",
  { skip: process.platform === "win32" },
  async (t) => {
    const tempDir = createTempRepo();
    const target = path.join(tempDir, "src", "interrupt.json");
    const original = '{"safe":true}\n';
    const mutation = '{"survivor":true}\n';
    const fixture = installInterruptibleProcessFixture(tempDir, {
      target,
      mutation,
      asPrettier: true,
    });
    run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);
    writeFile(target, original);
    run("git", ["add", "src/interrupt.json"], tempDir);
    run("git", ["commit", "-m", "interrupt target"], tempDir);
    const headBefore = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
    const execution = runAsync(
      process.execPath,
      [path.join(tempDir, "scripts", "commit-fix.mjs")],
      tempDir,
      { env: { ...process.env, ...fixture.env } },
    );
    t.after(() => {
      execution.child.kill("SIGKILL");
      fixture.cleanup();
      cleanupTempRepo(tempDir);
    });

    await Promise.race([
      waitForPath(fixture.ready),
      execution.completed.then((result) => {
        throw new Error(
          `commit-fix exited before the fixture started: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    execution.child.kill("SIGTERM");
    const result = await waitForCompletion(
      execution.completed,
      "commit-fix did not finish cancellation",
    );
    const bytesAtExit = readFile(tempDir, "src/interrupt.json");

    fixture.release();
    await delay(250);

    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(bytesAtExit, original);
    assert.equal(readFile(tempDir, "src/interrupt.json"), original);
    assert.equal(readHeadFile(tempDir, "src/interrupt.json"), original);
    assert.equal(
      run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
      headBefore,
    );
  },
);

test("commit-fix reports truncate-then-timeout targets without amending", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { timeoutMs: 1200 });
  run("git", ["add", "package.json"], tempDir);
  run("git", ["commit", "-m", "configure fixer timeout"], tempDir);
  const fixture = installInterruptedFixerFixture(tempDir, {
    interruptTool: "prettier",
    partialContent: "export const partial =",
  });
  run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);

  const files = ["src/first.js", "src/second.js"];
  const originals = new Map([
    [files[0], "export const first = 1;\n"],
    [files[1], "export const second = 2;\n"],
  ]);
  for (const [file, content] of originals) {
    writeFile(path.join(tempDir, file), content);
  }
  run("git", ["add", "--", ...files], tempDir);
  run("git", ["commit", "-m", "add interrupted targets"], tempDir);
  const headBefore = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const indexBefore = fs.readFileSync(gitPath(tempDir, "index"));
  const objectsBefore = run("git", ["count-objects", "-v"], tempDir).stdout;

  const result = runCommitFix(tempDir, { env: fixture.env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Automatic fixes were interrupted/);
  assert.match(output, /Prettier timed out/);
  assert.match(output, /No interrupted output was staged or amended/);
  for (const file of files) {
    assert.match(output, new RegExp(file.replace(".", "\\.")));
    assert.equal(readFile(tempDir, file), "export const partial =");
    assert.equal(readHeadFile(tempDir, file), originals.get(file));
  }
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    headBefore,
  );
  assert.deepEqual(fs.readFileSync(gitPath(tempDir, "index")), indexBefore);
  assert.equal(
    run("git", ["count-objects", "-v"], tempDir).stdout,
    objectsBefore,
  );
  assert.equal(fs.readFileSync(fixture.cacheFile, "utf8"), "cache-before\n");
  const phases = new Set(
    fs.readFileSync(fixture.phaseLog, "utf8").trim().split("\n"),
  );
  assert.deepEqual(
    phases,
    new Set([
      ...files.map((file) => `eslint:${file}`),
      ...files.map((file) => `prettier:${file}`),
    ]),
  );
});

test("commit-fix refuses unexpected tracked writes from an interrupted tool", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { timeoutMs: 900 });
  const unrelated = path.join(tempDir, "notes.txt");
  writeFile(unrelated, "user notes\n");
  run("git", ["add", "package.json", "notes.txt"], tempDir);
  run("git", ["commit", "-m", "configure interrupted fixture"], tempDir);
  const fixture = installInterruptedFixerFixture(tempDir, {
    interruptTool: "prettier",
    partialContent: "export const partial =",
    unexpectedTarget: unrelated,
    unexpectedContent: "tool side effect\n",
  });
  run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);
  const file = "src/input.js";
  writeFile(path.join(tempDir, file), "export const input = 1;\n");
  run("git", ["add", file], tempDir);
  run("git", ["commit", "-m", "add interruption target"], tempDir);
  const headBefore = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  const indexBefore = fs.readFileSync(gitPath(tempDir, "index"));

  const result = runCommitFix(tempDir, { env: fixture.env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.equal(readFile(tempDir, file), "export const partial =");
  assert.equal(readFile(tempDir, "notes.txt"), "tool side effect\n");
  assert.equal(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    headBefore,
  );
  assert.deepEqual(fs.readFileSync(gitPath(tempDir, "index")), indexBefore);
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
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Automatic fixes were interrupted/,
    );
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

test("refuses an operation that starts while fixer tools run", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  prepareBlockingCommit(tempDir);
  let activeState;

  const result = await runCommitFixDuringPrettier(tempDir, () => {
    createOperationFixture(tempDir, "MERGE_HEAD", "file");
    activeState = captureRefusalState(tempDir, ["MERGE_HEAD"]);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.match(output, /latest commit was not amended/i);
  fs.rmSync(path.join(tempDir, "fixer-release"), { force: true });
  assert.deepEqual(captureRefusalState(tempDir, ["MERGE_HEAD"]), activeState);
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

for (const attachmentChange of ["detached HEAD", "another branch"]) {
  test(`refuses when HEAD moves to ${attachmentChange} at the same commit`, async (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    prepareBlockingCommit(tempDir);
    const originalHead = run(
      "git",
      ["rev-parse", "HEAD"],
      tempDir,
    ).stdout.trim();

    const result = await runCommitFixDuringPrettier(tempDir, () => {
      const switched =
        attachmentChange === "detached HEAD"
          ? run("git", ["switch", "--detach", "HEAD"], tempDir)
          : run("git", ["switch", "-c", "concurrent-branch"], tempDir);
      assert.equal(switched.status, 0, switched.stderr);
    });

    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Repository state changed while automatic fixes/,
    );
    assert.equal(
      run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
      originalHead,
    );
  });
}

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
