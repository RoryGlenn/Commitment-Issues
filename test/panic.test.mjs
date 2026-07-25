// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPanicGuide,
  inspectPanicRepository,
  panicGuideMessage,
  parsePanicStatus,
} from "../scripts/lib/panic.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  recordingGitEnv,
  repoRoot,
  run,
  writeFile,
} from "./helpers/temp-repo.mjs";
import { countTerminalBoxes } from "./helpers/output.mjs";

const PLAIN_ENV = { ...process.env, COLUMNS: "140", NO_COLOR: "1" };
delete PLAIN_ENV.FORCE_COLOR;

function cli(tempDir, args = ["panic"], options = {}) {
  const { cwd = tempDir, ...runOptions } = options;
  return run("node", [path.join(tempDir, "scripts", "cli.mjs"), ...args], cwd, {
    env: PLAIN_ENV,
    ...runOptions,
  });
}

function sourceCli(cwd, args = ["panic"], options = {}) {
  return run(
    "node",
    [path.join(repoRoot, "scripts", "cli.mjs"), ...args],
    cwd,
    { env: PLAIN_ENV, ...options },
  );
}

function snapshotTree(root) {
  const entries = [];

  function visit(directory, prefix = "") {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push([relative, "symlink", fs.readlinkSync(absolute)]);
      } else if (entry.isDirectory()) {
        entries.push([relative, "directory"]);
        visit(absolute, relative);
      } else {
        entries.push([
          relative,
          "file",
          fs.readFileSync(absolute).toString("base64"),
        ]);
      }
    }
  }

  visit(root);
  return entries;
}

function assertReadOnlyAndSafe(result, before, tempDir) {
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(countTerminalBoxes(output), 1);
  assert.match(output, /This guide did not change/);
  for (const unsafe of [
    /reset\s+--hard/i,
    /clean\s+-[^\s]*f/i,
    /checkout\s+-f/i,
    /push[^\n]*--force/i,
    /branch[^\n]*-[dD]\b/i,
  ]) {
    assert.doesNotMatch(output, unsafe);
  }
  assert.deepEqual(snapshotTree(tempDir), before);
}

function commitFile(tempDir, relativePath, content, message) {
  writeFile(path.join(tempDir, relativePath), content);
  run("git", ["add", "--", relativePath], tempDir);
  const result = run("git", ["commit", "-m", message], tempDir);
  assert.equal(result.status, 0, result.stderr);
}

function createConflict(operation) {
  const tempDir = createTempRepo();
  commitFile(tempDir, "conflict.txt", "base\n", "add conflict fixture");
  const baseBranch = run(
    "git",
    ["branch", "--show-current"],
    tempDir,
  ).stdout.trim();

  run("git", ["switch", "-c", "panic-topic"], tempDir);
  commitFile(tempDir, "conflict.txt", "topic\n", "topic change");
  const topicCommit = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();

  run("git", ["switch", baseBranch], tempDir);
  commitFile(tempDir, "conflict.txt", "base branch\n", "base branch change");

  let result;
  if (operation === "merge") {
    result = run("git", ["merge", "panic-topic"], tempDir);
  } else if (operation === "rebase") {
    run("git", ["switch", "panic-topic"], tempDir);
    result = run("git", ["rebase", baseBranch], tempDir);
  } else {
    result = run("git", ["cherry-pick", topicCommit], tempDir);
  }
  assert.notEqual(result.status, 0, `${operation} should create a conflict`);
  return tempDir;
}

function completeFacts(overrides = {}) {
  return {
    location: "working-tree",
    inspectionComplete: true,
    branch: "main",
    detached: false,
    hasHead: true,
    operation: null,
    previousBranch: false,
    status: {
      staged: 0,
      unstaged: 0,
      conflicts: 0,
      stagedDeleted: 0,
      unstagedDeleted: 0,
      untracked: 0,
    },
    ...overrides,
  };
}

function inspectWith(overrides = {}) {
  const results = new Map([
    ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true\n" }],
    [
      "status --porcelain=v1 -z --untracked-files=all",
      { status: 0, stdout: "" },
    ],
    ["symbolic-ref --quiet --short HEAD", { status: 0, stdout: "main\n" }],
    ["rev-parse --verify --quiet HEAD", { status: 0, stdout: "abc\n" }],
    ["rev-parse --verify --quiet MERGE_HEAD", { status: 1, stdout: "" }],
    ["rev-parse --verify --quiet REBASE_HEAD", { status: 1, stdout: "" }],
    ["rev-parse --verify --quiet CHERRY_PICK_HEAD", { status: 1, stdout: "" }],
    [
      "rev-parse --verify --quiet --symbolic-full-name @{-1}",
      { status: 1, stdout: "" },
    ],
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    results.set(key, value);
  }
  return inspectPanicRepository((args) => results.get(args.join(" ")));
}

test("panic status parsing counts every relevant state without parsing paths as lines", () => {
  const output =
    [
      "M  staged.txt",
      " M unstaged.txt",
      "D  staged-delete.txt",
      " D unstaged-delete.txt",
      "UU conflicted.txt",
      "?? untracked\nwith-control.txt",
      "!! ignored.txt",
      "R  renamed.txt",
      "old name.txt",
      "C  copied.txt",
      "copy source.txt",
    ].join("\0") + "\0";

  assert.deepEqual(parsePanicStatus(output), {
    staged: 4,
    unstaged: 2,
    conflicts: 1,
    stagedDeleted: 1,
    unstagedDeleted: 1,
    untracked: 1,
  });
  assert.deepEqual(parsePanicStatus(""), {
    staged: 0,
    unstaged: 0,
    conflicts: 0,
    stagedDeleted: 0,
    unstagedDeleted: 0,
    untracked: 0,
  });
  for (const malformed of [
    "M  missing-nul",
    "bad\0",
    "M  \0",
    "R  renamed-without-source\0",
    "R  renamed-with-empty-source\0\0",
    "BAD!\0",
  ]) {
    assert.equal(parsePanicStatus(malformed), null);
  }
  assert.equal(parsePanicStatus(null), null);
});

test("panic inspector uses a fixed read-only probe set and models repository facts", () => {
  const calls = [];
  const results = new Map([
    ["rev-parse --is-inside-work-tree", { status: 0, stdout: "true\n" }],
    [
      "status --porcelain=v1 -z --untracked-files=all",
      { status: 0, stdout: "M  staged.txt\0" },
    ],
    ["symbolic-ref --quiet --short HEAD", { status: 0, stdout: "main\r\n" }],
    ["rev-parse --verify --quiet HEAD", { status: 0, stdout: "abc\n" }],
    ["rev-parse --verify --quiet MERGE_HEAD", { status: 1, stdout: "" }],
    ["rev-parse --verify --quiet REBASE_HEAD", { status: 1, stdout: "" }],
    ["rev-parse --verify --quiet CHERRY_PICK_HEAD", { status: 1, stdout: "" }],
    [
      "rev-parse --verify --quiet --symbolic-full-name @{-1}",
      { status: 0, stdout: "refs/heads/topic\n" },
    ],
  ]);
  const facts = inspectPanicRepository((args) => {
    const key = args.join(" ");
    calls.push(key);
    return results.get(key);
  });

  assert.deepEqual(calls, [...results.keys()]);
  assert.deepEqual(facts, {
    location: "working-tree",
    inspectionComplete: true,
    status: {
      staged: 1,
      unstaged: 0,
      conflicts: 0,
      stagedDeleted: 0,
      unstagedDeleted: 0,
      untracked: 0,
    },
    branch: "main",
    detached: false,
    hasHead: true,
    operation: null,
    previousBranch: true,
  });
});

test("panic inspector fails closed at every unavailable probe boundary", () => {
  assert.deepEqual(
    inspectPanicRepository(() => undefined),
    { location: "unknown", inspectionComplete: false },
  );
  assert.deepEqual(
    inspectWith({
      "rev-parse --is-inside-work-tree": { status: 0, stdout: "false\n" },
    }),
    { location: "not-working-tree", inspectionComplete: true },
  );
  assert.deepEqual(
    inspectWith({
      "rev-parse --is-inside-work-tree": { status: 0 },
    }),
    { location: "not-working-tree", inspectionComplete: true },
  );

  const unavailableCases = [
    "status --porcelain=v1 -z --untracked-files=all",
    "symbolic-ref --quiet --short HEAD",
    "rev-parse --verify --quiet HEAD",
    "rev-parse --verify --quiet MERGE_HEAD",
    "rev-parse --verify --quiet REBASE_HEAD",
    "rev-parse --verify --quiet CHERRY_PICK_HEAD",
    "rev-parse --verify --quiet --symbolic-full-name @{-1}",
  ];
  for (const probe of unavailableCases) {
    const facts = inspectWith({ [probe]: { status: 2, stdout: "" } });
    assert.equal(facts.location, "working-tree", probe);
    assert.equal(facts.inspectionComplete, false, probe);
  }

  const erroredReference = inspectWith({
    "rev-parse --verify --quiet HEAD": {
      status: 1,
      error: new Error("unavailable"),
    },
  });
  assert.equal(erroredReference.inspectionComplete, false);

  const malformedStatus = inspectWith({
    "status --porcelain=v1 -z --untracked-files=all": {
      status: 0,
      stdout: "malformed",
    },
  });
  assert.equal(malformedStatus.inspectionComplete, false);

  const detached = inspectWith({
    "symbolic-ref --quiet --short HEAD": { status: 1, stdout: "" },
    "rev-parse --verify --quiet HEAD": { status: 1, stdout: "" },
    "rev-parse --verify --quiet --symbolic-full-name @{-1}": {
      status: 0,
      stdout: "abc123\n",
    },
  });
  assert.equal(detached.detached, true);
  assert.equal(detached.hasHead, false);
  assert.equal(detached.previousBranch, false);
  assert.equal(detached.inspectionComplete, true);
});

test("panic guide refuses mutation guidance when inspection is incomplete or conflicted", () => {
  const incomplete = buildPanicGuide({
    location: "unknown",
    inspectionComplete: false,
  });
  assert.equal(incomplete.exitCode, 1);
  assert.deepEqual(
    incomplete.steps.map(({ command }) => command),
    ["git status"],
  );

  const conflicted = buildPanicGuide(
    completeFacts({
      operation: "merge",
      previousBranch: true,
      status: {
        staged: 1,
        unstaged: 0,
        conflicts: 1,
        stagedDeleted: 0,
        unstagedDeleted: 0,
        untracked: 0,
      },
    }),
  );
  assert.ok(conflicted.steps.every(({ kind }) => kind === "inspection"));
  assert.match(conflicted.currentState, /merge in progress/);
  assert.match(
    panicGuideMessage(conflicted).lines.join("\n"),
    /git diff --name-only --diff-filter=U/,
  );

  const unborn = buildPanicGuide(
    completeFacts({
      hasHead: false,
      status: {
        staged: 1,
        unstaged: 0,
        conflicts: 0,
        stagedDeleted: 0,
        unstagedDeleted: 0,
        untracked: 0,
      },
    }),
  );
  assert.doesNotMatch(
    unborn.steps.map(({ command }) => command).join("\n"),
    /restore/,
  );

  const pluralFallback = buildPanicGuide(
    completeFacts({
      branch: null,
      status: {
        staged: 0,
        unstaged: 0,
        conflicts: 0,
        stagedDeleted: 0,
        unstagedDeleted: 0,
        untracked: 2,
      },
    }),
  );
  assert.match(pluralFallback.currentState, /a Git working tree/);
  assert.match(pluralFallback.currentState, /2 untracked files/);
});

test("panic outside a repository gives one safe starting point", (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "panic-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const result = sourceCli(outside);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.equal(countTerminalBoxes(output), 1);
  assert.match(
    output,
    /Current state: this location is not inside a Git working tree/,
  );
  assert.match(output, /git status/);
  assert.match(output, /without changing them/);
  assert.doesNotMatch(output, /Reversible options/);
});

test("panic is deterministic and read-only in a clean repository", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const before = snapshotTree(tempDir);

  const first = cli(tempDir);
  const second = cli(tempDir);

  assert.equal(first.status, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.match(
    first.stdout,
    /Current state: branch ".+"; the working tree is clean/,
  );
  assert.match(first.stdout, /git status/);
  assert.match(first.stdout, /git reflog -n 10 --oneline/);
  assertReadOnlyAndSafe(first, before, tempDir);
});

test("panic describes staged, deleted, untracked, and hostile paths without interpolating them", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  commitFile(
    tempDir,
    "staged-delete.txt",
    "delete me\n",
    "add staged deletion",
  );
  commitFile(
    tempDir,
    "unstaged-delete.txt",
    "delete me too\n",
    "add unstaged deletion",
  );

  // Windows rejects control characters in filenames, so keep its hostile
  // fixture to legal metacharacters while POSIX also exercises a newline.
  const hostile =
    process.platform === "win32"
      ? "quote';$() semi;colon ü file.txt"
      : "quote';$() semi;colon ü\nfile.txt";
  writeFile(path.join(tempDir, hostile), "staged hostile path\n");
  run("git", ["add", "--", hostile], tempDir);
  fs.unlinkSync(path.join(tempDir, "staged-delete.txt"));
  run("git", ["add", "--", "staged-delete.txt"], tempDir);
  fs.unlinkSync(path.join(tempDir, "unstaged-delete.txt"));
  writeFile(path.join(tempDir, "untracked notes.txt"), "keep me\n");
  const before = snapshotTree(tempDir);

  const result = cli(tempDir);
  const output = result.stdout;

  assert.equal(result.status, 0);
  assert.match(output, /staged deletion/);
  assert.match(output, /unstaged deletion/);
  assert.match(output, /untracked file/);
  assert.match(output, /git diff --cached/);
  assert.match(output, /git diff/);
  assert.match(
    output,
    /git ls-files --others --exclude-standard --full-name -- :\//,
  );
  assert.match(output, /git restore --staged -- :\//);
  assert.doesNotMatch(output, /quote|semi;colon|untracked notes/);
  assertReadOnlyAndSafe(result, before, tempDir);
});

test("panic keeps its untracked inspection repository-wide from a subdirectory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const nestedDir = path.join(tempDir, "nested");
  fs.mkdirSync(nestedDir);
  writeFile(path.join(tempDir, "outside.txt"), "keep me\n");
  const before = snapshotTree(tempDir);

  const result = sourceCli(nestedDir);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /untracked file/);
  assert.match(
    result.stdout,
    /git ls-files --others --exclude-standard --full-name -- :\//,
  );
  const inspection = run(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"],
    nestedDir,
  );
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(inspection.stdout.trim(), "outside.txt");
  assertReadOnlyAndSafe(result, before, tempDir);
});

test("panic ignores inherited Git routing and inspects the current repository", (t) => {
  const tempDir = createTempRepo();
  const routedDir = createTempRepo();
  t.after(() => {
    cleanupTempRepo(tempDir);
    cleanupTempRepo(routedDir);
  });
  writeFile(path.join(tempDir, "current-repository.txt"), "keep me\n");
  const before = snapshotTree(tempDir);
  const routedBefore = snapshotTree(routedDir);

  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "cli.mjs"), "panic"],
    {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        ...PLAIN_ENV,
        GIT_DIR: path.join(routedDir, ".git"),
        GIT_WORK_TREE: routedDir,
        GIT_INDEX_FILE: path.join(routedDir, ".git", "index"),
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /untracked file/);
  assertReadOnlyAndSafe(result, before, tempDir);
  assert.deepEqual(snapshotTree(routedDir), routedBefore);
});

test("panic offers verified previous-branch guidance for branch switches and detached HEAD", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const original = run(
    "git",
    ["branch", "--show-current"],
    tempDir,
  ).stdout.trim();

  run("git", ["switch", "-c", "panic-recent"], tempDir);
  run("git", ["switch", original], tempDir);
  let before = snapshotTree(tempDir);
  let result = cli(tempDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /git switch -/);
  assert.match(result.stdout, /previously checked-out branch/);
  assert.match(result.stdout, /git reflog -n 10 --oneline/);
  assertReadOnlyAndSafe(result, before, tempDir);

  run("git", ["switch", "--detach", "HEAD"], tempDir);
  before = snapshotTree(tempDir);
  result = cli(tempDir);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Current state: detached HEAD/);
  assert.match(result.stdout, /git log -1 --oneline --decorate/);
  assert.match(result.stdout, /git switch -/);
  assertReadOnlyAndSafe(result, before, tempDir);
});

for (const operation of ["merge", "rebase", "cherry-pick"]) {
  test(`panic limits ${operation} conflicts to inspection guidance`, (t) => {
    const tempDir = createConflict(operation);
    t.after(() => cleanupTempRepo(tempDir));
    const before = snapshotTree(tempDir);

    const result = cli(tempDir);
    const output = result.stdout;

    assert.equal(result.status, 0);
    assert.match(output, new RegExp(`${operation} in progress`));
    assert.match(output, /unresolved path/);
    assert.match(output, /git status/);
    assert.match(output, /git diff --name-only --diff-filter=U/);
    assert.doesNotMatch(output, /Reversible options/);
    assertReadOnlyAndSafe(result, before, tempDir);
  });
}

test("panic invokes only allowlisted read-only Git probes", (t) => {
  const tempDir = createTempRepo();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "panic-git-log-"));
  const logPath = path.join(logDir, "git.log");
  t.after(() => cleanupTempRepo(tempDir));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const env = recordingGitEnv(tempDir, logPath);

  const result = cli(tempDir, ["panic"], {
    env: { ...env, COLUMNS: "140", NO_COLOR: "1" },
  });
  assert.equal(result.status, 0);

  const prefix = "--no-pager --no-optional-locks -c core.quotePath=false ";
  const invocations = fs.readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  assert.deepEqual(invocations, [
    "-c core.quotePath=false rev-parse --show-toplevel",
    `${prefix}rev-parse --is-inside-work-tree`,
    `${prefix}status --porcelain=v1 -z --untracked-files=all`,
    `${prefix}symbolic-ref --quiet --short HEAD`,
    `${prefix}rev-parse --verify --quiet HEAD`,
    `${prefix}rev-parse --verify --quiet MERGE_HEAD`,
    `${prefix}rev-parse --verify --quiet REBASE_HEAD`,
    `${prefix}rev-parse --verify --quiet CHERRY_PICK_HEAD`,
    `${prefix}rev-parse --verify --quiet --symbolic-full-name @{-1}`,
  ]);
});

test("panic rejects arguments and the unsupported JSON mode before inspection", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const before = snapshotTree(tempDir);

  const json = cli(tempDir, ["panic", "--json"]);
  assert.equal(json.status, 1);
  assert.equal(json.stdout, "");
  assert.match(
    json.stderr,
    /--json is only supported by 'precommit' and 'prepush'/,
  );

  const direct = run(
    "node",
    [path.join(tempDir, "scripts", "panic.mjs"), "bad\nargument"],
    tempDir,
    { env: PLAIN_ENV },
  );
  assert.equal(direct.status, 1);
  assert.equal(countTerminalBoxes(`${direct.stdout}${direct.stderr}`), 1);
  assert.match(direct.stdout, /bad\\nargument/);
  assert.match(direct.stdout, /No Git commands were run/);
  assert.deepEqual(snapshotTree(tempDir), before);
});
