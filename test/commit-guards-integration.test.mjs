// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

// Subprocess coverage for the advisory commit/push guards: protected-branch
// awareness, commit-shape warnings, and the behind-upstream nudge.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { countTerminalBoxes, stripAnsi } from "./helpers/output.mjs";
import {
  addBareRemote,
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  REAL_GIT,
  run,
  setPrecommitConfig,
  writeCrossPlatformShim,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runPrecommit(tempDir) {
  return run("node", [path.join(tempDir, "scripts", "precommit.mjs")], tempDir);
}

function runPrepush(tempDir, input) {
  return run("node", [path.join(tempDir, "scripts", "prepush.mjs")], tempDir, {
    input,
  });
}

function stageCleanFile(tempDir, name = "clean.md") {
  writeFile(path.join(tempDir, name), "# clean\n");
  run("git", ["add", name], tempDir);
}

function headSha(tempDir) {
  return run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
}

function largeBatchCheckGitEnv(tempDir, targetBytes) {
  const binDir = path.join(tempDir, `.large-batch-check-${targetBytes}`);
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    "git",
    `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const realGit = process.env.FAKE_GIT_REAL || "git";
if (args.includes("cat-file") && args.includes("--batch-check")) {
  const input = fs.readFileSync(0);
  const result = spawnSync(realGit, args, {
    encoding: null,
    input,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status == null ? 1 : result.status);
  }
  const filler = "0".repeat(40) + " blob 0\\n";
  const repeats = Math.max(0, Math.ceil((${targetBytes} - result.stdout.length) / Buffer.byteLength(filler)));
  fs.writeFileSync(1, Buffer.concat([result.stdout, Buffer.from(filler.repeat(repeats))]));
  process.exit(0);
}
const result = spawnSync(realGit, args, { stdio: "inherit" });
process.exit(result.status == null ? 1 : result.status);
`,
  );
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    FAKE_GIT_REAL: REAL_GIT,
  };
}

// The temp repo inherits this repo's package.json, which disables
// protectedBranches for its own trunk-based workflow — so guard tests opt in
// explicitly and the rest of the suite stays quiet on `main`.

test("precommit warns when committing directly to a protected branch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { protectedBranches: ["main", "master"] });
  run("git", ["branch", "-M", "main"], tempDir);
  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Committing directly to protected branch "main"/);
  assert.match(output, /git switch -c/);
});

test("precommit stays quiet about branches that are not protected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { protectedBranches: ["main", "master"] });
  run("git", ["switch", "-c", "feature/guarded"], tempDir);
  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /protected branch/);
});

test("detached HEAD intentionally skips only the branch guard", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
    maxCommitFiles: 1,
  });
  run("git", ["checkout", "--detach"], tempDir);
  writeFile(path.join(tempDir, "first.md"), "# first\n");
  writeFile(path.join(tempDir, "second.md"), "# second\n");
  run("git", ["add", "first.md", "second.md"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /protected branch/);
  assert.match(output, /Large commit: 2 staged files/);
});

test("precommit blocks protected-branch commits only when opted in", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  run("git", ["branch", "-M", "main"], tempDir);
  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Commit blocked: protected branch\./);
  assert.match(output, /git commit --no-verify/);
});

test("precommit blocks deletion-only commits on a protected branch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  run("git", ["branch", "-M", "main"], tempDir);
  run("git", ["rm", "README.md"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Commit blocked: protected branch\./);
  assert.doesNotMatch(output, /Deletion-only commit/);
});

test("precommit blocks allow-empty commits on a protected branch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  run("git", ["branch", "-M", "main"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Commit blocked: protected branch\./);
  assert.doesNotMatch(output, /No staged files to check/);
});

test("precommit blocks the first commit on an unborn protected branch", (t) => {
  const tempDir = createTempRepo({ commit: false });
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  run("git", ["symbolic-ref", "HEAD", "refs/heads/main"], tempDir);
  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Commit blocked: protected branch\./);
  assert.match(output, /Committing to "main"/);
});

test("precommit warns when the branch is behind its upstream", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  // Advance the remote past the local branch via a second clone.
  const cloneDir = fs.mkdtempSync(path.join(tempDir, "clone-"));
  run("git", ["clone", "-b", "main", remoteDir, cloneDir], tempDir);
  run("git", ["config", "user.name", "test"], cloneDir);
  run("git", ["config", "user.email", "test@example.com"], cloneDir);
  writeFile(path.join(cloneDir, "remote-change.md"), "# remote\n");
  run("git", ["add", "remote-change.md"], cloneDir);
  run("git", ["commit", "-m", "remote change"], cloneDir);
  run("git", ["push", "origin", "main"], cloneDir);
  run("git", ["fetch", "origin"], tempDir);

  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Branch is 1 commit behind origin\/main/);
  assert.match(output, /Pull or rebase/);
});

test("behind-upstream advisory can be disabled", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));

  const cloneDir = fs.mkdtempSync(path.join(tempDir, "clone-"));
  run("git", ["clone", "-b", "main", remoteDir, cloneDir], tempDir);
  run("git", ["config", "user.name", "test"], cloneDir);
  run("git", ["config", "user.email", "test@example.com"], cloneDir);
  writeFile(path.join(cloneDir, "remote-change.md"), "# remote\n");
  run("git", ["add", "remote-change.md"], cloneDir);
  run("git", ["commit", "-m", "remote change"], cloneDir);
  run("git", ["push", "origin", "main"], cloneDir);
  run("git", ["fetch", "origin"], tempDir);

  setPrecommitConfig(tempDir, { adviseBehindUpstream: false });
  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /behind origin\/main/);
});

test("precommit warns on commits exceeding the file-count limit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { maxCommitFiles: 2 });
  for (const name of ["a.md", "b.md", "c.md"]) {
    writeFile(path.join(tempDir, "docs-batch", name), `# ${name}\n`);
  }
  run("git", ["add", "docs-batch"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Large commit: 3 staged files \(limit 2\)/);
  assert.match(output, /splitting/);
});

test("precommit warns on commits exceeding the changed-line limit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { maxCommitLines: 10 });
  writeFile(path.join(tempDir, "big.md"), `# big\n${"line\n".repeat(30)}`);
  run("git", ["add", "big.md"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Large commit: 31 changed lines \(limit 10\)/);
});

test("precommit warns about staged files over the size threshold", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    maxFileSizeMb: 1,
    protectedBranches: [],
    scanSecrets: false,
  });
  fs.writeFileSync(
    path.join(tempDir, "huge.bin"),
    Buffer.alloc(2 * 1024 * 1024, 1),
  );
  run("git", ["add", "huge.bin"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /1 staged file over 1 MB/);
  assert.match(output, /2\.0 MB {2}huge\.bin/);
  assert.match(output, /Git LFS/);
});

test("precommit keeps the large-file guard above spawnSync's default buffer", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { maxFileSizeMb: 1 });
  fs.writeFileSync(
    path.join(tempDir, "huge.bin"),
    Buffer.alloc(2 * 1024 * 1024, 1),
  );
  run("git", ["add", "huge.bin"], tempDir);

  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    { env: largeBatchCheckGitEnv(tempDir, 2 * 1024 * 1024) },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /1 staged file over 1 MB/);
  assert.doesNotMatch(output, /file-size check unavailable/);
});

test("precommit reports blob metadata beyond the bounded inspection ceiling", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    maxFileSizeMb: 1,
    protectedBranches: [],
    scanSecrets: false,
  });
  stageCleanFile(tempDir, "clean.bin");

  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    { env: largeBatchCheckGitEnv(tempDir, 17 * 1024 * 1024) },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Staged file-size check unavailable/);
  assert.match(output, /bounded inspection buffer/);
});

test("precommit warns about staged generated files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "dist", "bundle.js"), "var x=1;\n");
  run("git", ["add", "-f", "dist/bundle.js"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /1 generated file staged/);
  assert.match(output, /dist\/bundle\.js/);
});

test("commit guards keep the fun tone", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    tone: "fun",
  });
  run("git", ["branch", "-M", "main"], tempDir);
  stageCleanFile(tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /"main" deserves a feature branch/);
});

test("clean commits on unprotected branches still pass every guard", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    protectedBranches: [],
  });

  run("git", ["switch", "-c", "feature/tidy"], tempDir);
  writeFile(path.join(tempDir, "note.md"), "# note\n");
  run("git", ["add", "note.md"], tempDir);

  const result = runPrecommit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /All pre-commit checks passed/);
});

test("prepush warns when pushing to a protected branch (advisory)", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { protectedBranches: ["main"] });
  const sha = headSha(tempDir);

  const result = runPrepush(
    tempDir,
    `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Push allowed with 1 warning/);
  assert.match(output, /Direct push to protected branch/);
  assert.match(output, /"main"/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("prepush escapes controls in a protected ref", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const branch = "evil\bFAKE\u001b[31mRED\u001b[39m";
  setPrecommitConfig(tempDir, { protectedBranches: [branch] });
  const sha = headSha(tempDir);
  const ref = `refs/heads/${branch}`;

  const result = runPrepush(
    tempDir,
    `${ref} ${sha} ${ref} ${"0".repeat(40)}\n`,
  );
  const output = `${result.stdout}${result.stderr}`;
  const visibleOutput = stripAnsi(output);

  assert.equal(result.status, 0);
  assert.match(visibleOutput, /evil\\x08FAKERED/);
  assert.doesNotMatch(visibleOutput, /\x08|\u001b/);
  assert.doesNotMatch(output, /FAKE\u001b\[31mRED/);
});

test("prepush consolidates multiple protected targets into one warning", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main", "release/*"],
  });
  const sha = headSha(tempDir);
  const zero = "0".repeat(40);
  const result = runPrepush(
    tempDir,
    `refs/heads/main ${sha} refs/heads/main ${zero}\n` +
      `refs/heads/release/next ${sha} refs/heads/release/next ${zero}\n`,
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Push allowed with 1 warning/);
  assert.match(output, /protected branches "main", "release\/next"/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("prepush blocks protected-branch pushes only when opted in", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  const sha = headSha(tempDir);

  const result = runPrepush(
    tempDir,
    `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Push blocked: protected branch\./);
  assert.match(output, /git push --no-verify/);
});

test("prepush ignores non-branch refs and unprotected branches", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  const sha = headSha(tempDir);

  const result = runPrepush(
    tempDir,
    `refs/heads/feature/x ${sha} refs/heads/feature/x ${"0".repeat(40)}\n` +
      `refs/tags/v1.0.0 ${sha} refs/tags/v1.0.0 ${"0".repeat(40)}\n`,
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /protected branch/);
});

// ---- Guard resilience: a failing git probe must degrade to a skipped ----
// ---- guard, never to a blocked or crashed commit.                    ----

test("commit proceeds fail-open when the branch cannot be identified", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Even with blocking enabled: an unidentifiable branch must not wedge
  // every commit — warn-and-continue is the failure-mode contract.
  setPrecommitConfig(tempDir, {
    protectedBranches: ["main"],
    blockProtectedBranches: true,
  });
  run("git", ["branch", "-M", "main"], tempDir);
  stageCleanFile(tempDir);

  const env = fakeGitEnv(tempDir, "rev-parse --abbrev-ref HEAD", 0, "HEAD\n");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    { env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /Commit blocked/);
  assert.doesNotMatch(output, /protected branch/);
});

test("a failing numstat skips the size guard but keeps other guards", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { maxCommitFiles: 1 });
  writeFile(path.join(tempDir, "dist", "bundle.js"), "var x=1;\n");
  writeFile(path.join(tempDir, "extra.md"), "# extra\n");
  run("git", ["add", "-f", "dist/bundle.js", "extra.md"], tempDir);

  const env = fakeGitEnv(
    tempDir,
    "diff-tree --no-commit-id --no-renames -r --numstat",
  );
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    { env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /Large commit/);
  assert.match(output, /1 generated file staged/);
});

test("a failing cat-file reports the unavailable guard without blocking", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    maxFileSizeMb: 1,
    protectedBranches: [],
    scanSecrets: false,
  });
  fs.writeFileSync(
    path.join(tempDir, "huge.bin"),
    Buffer.alloc(2 * 1024 * 1024, 1),
  );
  run("git", ["add", "huge.bin"], tempDir);

  const env = fakeGitEnv(tempDir, "cat-file --batch-check");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    { env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /over 1 MB/);
  assert.match(output, /Staged file-size check unavailable/);
  assert.match(output, /retry after restoring Git/);
  assert.match(output, /access\./);
});

test("a failing behind-count probe skips the upstream guard", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const remoteDir = addBareRemote(tempDir);
  t.after(() => fs.rmSync(remoteDir, { recursive: true, force: true }));
  setPrecommitConfig(tempDir, {
    hookOutput: "normal",
    protectedBranches: [],
  });

  stageCleanFile(tempDir);

  const env = fakeGitEnv(tempDir, "rev-list --count");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "precommit.mjs")],
    tempDir,
    { env },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.doesNotMatch(output, /behind/);
  assert.match(output, /All pre-commit checks passed/);
});
