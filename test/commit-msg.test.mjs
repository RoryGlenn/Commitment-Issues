// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  fsFailurePreload,
  readFile,
  run,
  setPrecommitConfig,
  writeCrossPlatformShim,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runCommitMsg(tempDir, args = [], options = {}) {
  const { cwd = tempDir, ...runOptions } = options;
  return run(
    "node",
    [path.join(tempDir, "scripts", "commit-msg.mjs"), ...args],
    cwd,
    runOptions,
  );
}

test("manager-composed commit-msg honors the project-wide skip switch", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  const result = spawnSync(
    process.execPath,
    [path.join(tempDir, "scripts", "cli.mjs"), "hook", "commit-msg"],
    {
      cwd: tempDir,
      encoding: "utf8",
      env: { ...process.env, COMMITMENT_ISSUES: "0" },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`, "");
});

test("explicit commit-msg runs under hook-only skip variables", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  const messagePath = path.join(tempDir, "MESSAGE");
  writeFile(messagePath, "feat: verify direct command\n");
  installFakeCommitlint(tempDir);

  for (const skippedBy of ["COMMITMENT_ISSUES", "HUSKY"]) {
    const logPath = path.join(tempDir, `${skippedBy}.jsonl`);
    const result = spawnSync(
      process.execPath,
      [path.join(tempDir, "scripts", "cli.mjs"), "commit-msg", messagePath],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...process.env,
          COMMITMENT_ISSUES: skippedBy === "COMMITMENT_ISSUES" ? "0" : "1",
          HUSKY: skippedBy === "HUSKY" ? "0" : "1",
          FAKE_COMMITLINT_LOG: logPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(logPath), true);
    const [args] = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(args.slice(-2), ["--edit", messagePath]);
  }
});

function localBinDir(tempDir) {
  const nodeModules = path.join(tempDir, "node_modules");
  if (fs.lstatSync(nodeModules).isSymbolicLink()) {
    fs.unlinkSync(nodeModules);
  }
  const binDir = path.join(nodeModules, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  return binDir;
}

function installFakeCommitlint(tempDir, { withCli = false } = {}) {
  const binDir = localBinDir(tempDir);
  writeCrossPlatformShim(
    binDir,
    "commitlint",
    `import fs from "node:fs";
const args = process.argv.slice(2);
if (process.env.FAKE_COMMITLINT_LOG) {
  fs.appendFileSync(process.env.FAKE_COMMITLINT_LOG, JSON.stringify(args) + "\\n");
}
const delay = Number(process.env.FAKE_COMMITLINT_DELAY_MS || "0");
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}
if (process.env.FAKE_COMMITLINT_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_COMMITLINT_SIGNAL);
}
const status = Number(process.env.FAKE_COMMITLINT_STATUS || "0");
if (process.env.FAKE_COMMITLINT_OUTPUT) {
  process.stderr.write(process.env.FAKE_COMMITLINT_OUTPUT + "\\n");
}
process.exit(status);
`,
  );

  if (withCli) {
    const cliPath = path.join(tempDir, "scripts", "cli.mjs");
    writeCrossPlatformShim(
      binDir,
      "commitment-issues",
      `import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status == null ? 1 : result.status);
`,
    );
  }
  return binDir;
}

test("direct commit-msg uses root config and tools below the root", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  installFakeCommitlint(tempDir);
  const nested = path.join(tempDir, "nested path");
  const message = path.join(nested, "COMMIT_EDITMSG");
  const log = path.join(tempDir, "nested-commitlint.log");
  writeFile(message, "fix: keep nested invocation rooted\n");

  const result = runCommitMsg(tempDir, ["COMMIT_EDITMSG"], {
    cwd: nested,
    env: { ...process.env, FAKE_COMMITLINT_LOG: log },
  });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const [args] = fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(args.slice(-2), ["--edit", fs.realpathSync(message)]);
});

function installStaticGitPathHook(tempDir) {
  const hookPath = path.join(tempDir, ".git", "hooks", "commit-msg");
  writeFile(
    hookPath,
    [
      "#!/bin/sh",
      "node_modules/.bin/commitment-issues commit-msg --git-path",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hookPath, 0o755);
}

function enableStaticGitPathHook(tempDir) {
  installFakeCommitlint(tempDir, { withCli: true });
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  run("git", ["add", "package.json"], tempDir);
  const configured = run(
    "git",
    ["commit", "--no-verify", "-m", "enable message checks"],
    tempDir,
  );
  assert.equal(
    configured.status,
    0,
    `${configured.stdout}${configured.stderr}`,
  );
  installStaticGitPathHook(tempDir);
}

function absoluteGitPath(tempDir, name) {
  const result = run("git", ["rev-parse", "--git-path", name], tempDir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return resolveFromProcessCwd(tempDir, result.stdout.replace(/\r?\n$/u, ""));
}

function childProcessCwd(cwd) {
  const result = run(
    process.execPath,
    ["--eval", "process.stdout.write(process.cwd())"],
    cwd,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

function resolveFromProcessCwd(cwd, relativePath) {
  // Resolve exactly as the hook's child process does. This preserves every
  // byte in Git's relative path record while allowing macOS filesystem aliases
  // and Windows long/8.3 directory spellings to differ from this test process.
  return path.resolve(childProcessCwd(cwd), relativePath);
}

function assertCommitlintEditTarget(log, expectedPath) {
  const args = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.deepEqual(args.slice(0, 3), ["--color=false", "--strict", "--edit"]);
  assert.equal(args.length, 4);

  // Textually different paths can name the same entry on Windows (long paths
  // versus 8.3 aliases). Compare the file when it still exists, or its parent
  // directory plus literal basename after Git has removed a transient file.
  const filesExist = fs.existsSync(args[3]) && fs.existsSync(expectedPath);
  const actualIdentityPath = filesExist ? args[3] : path.dirname(args[3]);
  const expectedIdentityPath = filesExist
    ? expectedPath
    : path.dirname(expectedPath);
  const actual = fs.statSync(actualIdentityPath, { bigint: true });
  const expected = fs.statSync(expectedIdentityPath, { bigint: true });
  assert.equal(actual.dev, expected.dev);
  assert.equal(actual.ino, expected.ino);
  if (!filesExist) {
    const actualName = path.basename(args[3]);
    const expectedName = path.basename(expectedPath);
    assert.equal(
      process.platform === "win32" ? actualName.toLowerCase() : actualName,
      process.platform === "win32" ? expectedName.toLowerCase() : expectedName,
    );
  }
}

function createDivergedTopic(tempDir, topic) {
  const baseBranch = run(
    "git",
    ["branch", "--show-current"],
    tempDir,
  ).stdout.trim();
  let result = run("git", ["switch", "-c", topic], tempDir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  writeFile(path.join(tempDir, `${topic}.txt`), "topic\n");
  run("git", ["add", `${topic}.txt`], tempDir);
  result = run(
    "git",
    ["commit", "--no-verify", "-m", `${topic} change`],
    tempDir,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = run("git", ["switch", baseBranch], tempDir);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  writeFile(path.join(tempDir, `${topic}-base.txt`), "base\n");
  run("git", ["add", `${topic}-base.txt`], tempDir);
  result = run(
    "git",
    ["commit", "--no-verify", "-m", `${topic} base change`],
    tempDir,
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function messageFile(tempDir, name = "COMMIT EDIT;message [猫].txt") {
  const file = path.join(tempDir, "message files", name);
  writeFile(file, "bad: message\n");
  return file;
}

test("commit-msg is silent and does not require a file when disabled", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runCommitMsg(tempDir);
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`, "");
});

test("advisory commitlint forwards a literal absolute message path", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const file = messageFile(tempDir);
  const log = path.join(tempDir, "commitlint-args.log");
  const result = runCommitMsg(tempDir, [file], {
    env: {
      ...process.env,
      FAKE_COMMITLINT_LOG: log,
      FAKE_COMMITLINT_STATUS: "1",
      FAKE_COMMITLINT_OUTPUT: "type must be one of feat, fix [type-enum]",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Commit message needs attention/);
  assert.match(output, /Commit will continue/);
  assert.match(output, /type must be one of feat, fix/);
  assert.deepEqual(JSON.parse(readFile(tempDir, "commitlint-args.log")), [
    "--color=false",
    "--strict",
    "--edit",
    path.resolve(file),
  ]);
});

test("--git-path resolves the linked-worktree COMMIT_EDITMSG path", (t) => {
  const originalDir = createTempRepo();
  // Install before moving the repository so the launchers prove that their
  // companion Node shims are located relative to the executable at runtime.
  // Absolute launcher paths go stale here (and can also disagree with an 8.3
  // alias on Windows).
  installFakeCommitlint(originalDir);
  const originalName = path.basename(originalDir);
  const primaryName = `${originalName} primary ! 猫`;
  const tempDir = path.join(
    path.dirname(originalDir),
    process.platform === "win32" ? primaryName : ` ${primaryName} `,
  );
  fs.renameSync(originalDir, tempDir);
  const linkedName = `${originalName} linked worktree ! 猫`;
  const worktreeDir = path.join(
    path.dirname(tempDir),
    process.platform === "win32" ? linkedName : ` ${linkedName} `,
  );
  t.after(() => {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    cleanupTempRepo(tempDir);
  });
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  run("git", ["add", "package.json"], tempDir);
  const configured = run(
    "git",
    ["commit", "--no-verify", "-m", "enable message checks"],
    tempDir,
  );
  assert.equal(configured.status, 0);
  const added = run(
    "git",
    ["worktree", "add", "-b", "linked-message-check", worktreeDir],
    tempDir,
  );
  assert.equal(added.status, 0, `${added.stdout}${added.stderr}`);
  fs.rmSync(path.join(worktreeDir, "node_modules"), {
    recursive: true,
    force: true,
  });
  fs.symlinkSync(
    path.join(tempDir, "node_modules"),
    path.join(worktreeDir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const gitPath = run(
    "git",
    ["rev-parse", "--git-path", "COMMIT_EDITMSG"],
    worktreeDir,
  );
  assert.equal(gitPath.status, 0);
  const resolvedMessagePath = resolveFromProcessCwd(
    worktreeDir,
    gitPath.stdout.trim(),
  );
  writeFile(resolvedMessagePath, "bad: linked message\n");
  // Keep the recorder outside the linked worktree. Git for Windows can expose
  // the same worktree through long and 8.3 path spellings, while this sidecar
  // only needs to prove the argv forwarded to the fake commitlint process.
  const log = path.join(tempDir, "linked-worktree-commitlint-args.log");
  const result = run(
    "node",
    [path.join(tempDir, "scripts", "commit-msg.mjs"), "--git-path"],
    worktreeDir,
    {
      env: {
        ...process.env,
        FAKE_COMMITLINT_LOG: log,
        FAKE_COMMITLINT_STATUS: "1",
        FAKE_COMMITLINT_OUTPUT: "linked message needs attention",
      },
    },
  );

  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /linked message needs attention/u,
  );
  assertCommitlintEditTarget(log, resolvedMessagePath);
});

test(
  "--git-path resolves relative Git paths from a canonical cwd alias",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const aliasDir = path.join(
      path.dirname(tempDir),
      `${path.basename(tempDir)} cwd alias`,
    );
    fs.symlinkSync(tempDir, aliasDir, "dir");
    t.after(() => {
      fs.unlinkSync(aliasDir);
      cleanupTempRepo(tempDir);
    });
    assert.notEqual(path.resolve(aliasDir), fs.realpathSync(aliasDir));
    installFakeCommitlint(tempDir);
    setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

    const gitPath = run(
      "git",
      ["rev-parse", "--git-path", "COMMIT_EDITMSG"],
      aliasDir,
    );
    assert.equal(gitPath.status, 0, `${gitPath.stdout}${gitPath.stderr}`);
    const expectedMessagePath = resolveFromProcessCwd(
      aliasDir,
      gitPath.stdout.replace(/\r?\n$/u, ""),
    );
    writeFile(expectedMessagePath, "bad: canonical cwd\n");
    const log = path.join(childProcessCwd(aliasDir), "canonical-cwd-args.log");

    const result = run(
      "node",
      [path.join(aliasDir, "scripts", "commit-msg.mjs"), "--git-path"],
      aliasDir,
      { env: { ...process.env, FAKE_COMMITLINT_LOG: log } },
    );

    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assertCommitlintEditTarget(log, expectedMessagePath);
  },
);

test("--git-path selects COMMIT_EDITMSG for an ordinary Git commit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  enableStaticGitPathHook(tempDir);
  writeFile(path.join(tempDir, "ordinary.txt"), "ordinary\n");
  run("git", ["add", "ordinary.txt"], tempDir);
  const log = path.join(tempDir, "ordinary-commitlint.log");

  const committed = run("git", ["commit", "-m", "ordinary commit"], tempDir, {
    env: { ...process.env, FAKE_COMMITLINT_LOG: log },
  });

  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
  assertCommitlintEditTarget(log, absoluteGitPath(tempDir, "COMMIT_EDITMSG"));
});

test("--git-path selects MERGE_MSG for a direct automatic Git merge", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  enableStaticGitPathHook(tempDir);
  createDivergedTopic(tempDir, "automatic-merge-topic");
  const log = path.join(tempDir, "automatic-merge-commitlint.log");

  const merged = run(
    "git",
    ["merge", "--no-ff", "-m", "automatic merge", "automatic-merge-topic"],
    tempDir,
    { env: { ...process.env, FAKE_COMMITLINT_LOG: log } },
  );

  assert.equal(merged.status, 0, `${merged.stdout}${merged.stderr}`);
  assertCommitlintEditTarget(log, absoluteGitPath(tempDir, "MERGE_MSG"));
});

test("--git-path selects COMMIT_EDITMSG when Git commits a pending merge", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  enableStaticGitPathHook(tempDir);
  createDivergedTopic(tempDir, "manual-merge-topic");
  const prepared = run(
    "git",
    ["merge", "--no-ff", "--no-commit", "manual-merge-topic"],
    tempDir,
  );
  assert.equal(prepared.status, 0, `${prepared.stdout}${prepared.stderr}`);
  assert.ok(fs.statSync(absoluteGitPath(tempDir, "MERGE_HEAD")).isFile());
  const log = path.join(tempDir, "manual-merge-commitlint.log");

  const committed = run("git", ["commit", "-m", "manual merge"], tempDir, {
    env: { ...process.env, FAKE_COMMITLINT_LOG: log },
  });

  assert.equal(committed.status, 0, `${committed.stdout}${committed.stderr}`);
  assertCommitlintEditTarget(log, absoluteGitPath(tempDir, "COMMIT_EDITMSG"));
});

test("--git-path removes only Git's pathname record terminator", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  const relativeMessagePath =
    process.platform === "win32"
      ? "message file 猫 inside.txt"
      : " message file \n";
  const absoluteMessagePath = resolveFromProcessCwd(
    tempDir,
    relativeMessagePath,
  );
  writeFile(absoluteMessagePath, "bad: whitespace path\n");
  const log = path.join(tempDir, "whitespace-path-args.log");

  const result = runCommitMsg(tempDir, ["--git-path"], {
    env: {
      ...fakeGitEnv(
        tempDir,
        "rev-parse --git-path COMMIT_EDITMSG",
        0,
        `${relativeMessagePath}\n`,
      ),
      FAKE_COMMITLINT_LOG: log,
      FAKE_COMMITLINT_STATUS: "0",
    },
  });

  assert.equal(result.status, 0);
  assertCommitlintEditTarget(log, absoluteMessagePath);
});

test("--git-path preserves CRLF-terminated and unterminated pathname records", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  for (const [label, relativeMessagePath, gitOutput] of [
    ["crlf", " CRLF message file ", " CRLF message file \r\n"],
    [
      "unterminated",
      " unterminated message file ",
      " unterminated message file ",
    ],
  ]) {
    const absoluteMessagePath = resolveFromProcessCwd(
      tempDir,
      relativeMessagePath,
    );
    writeFile(absoluteMessagePath, `${label} message\n`);
    const log = path.join(tempDir, `${label}-path-args.log`);
    const result = runCommitMsg(tempDir, ["--git-path"], {
      env: {
        ...fakeGitEnv(
          tempDir,
          "rev-parse --git-path COMMIT_EDITMSG",
          0,
          gitOutput,
        ),
        FAKE_COMMITLINT_LOG: log,
      },
    });

    assert.equal(result.status, 0);
    assertCommitlintEditTarget(log, absoluteMessagePath);
  }
});

test("--git-path reports a Git path-resolution failure without guessing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });

  const result = runCommitMsg(tempDir, ["--git-path"], {
    env: fakeGitEnv(
      tempDir,
      "rev-parse --git-path COMMIT_EDITMSG",
      1,
      "",
      "path unavailable",
    ),
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /could not resolve its COMMIT_EDITMSG path/i,
  );
});

test("--git-path rejects an empty successful Git path probe", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });

  const result = runCommitMsg(tempDir, ["--git-path"], {
    env: fakeGitEnv(tempDir, "rev-parse --git-path COMMIT_EDITMSG", 0, ""),
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /could not resolve its COMMIT_EDITMSG path/i,
  );
});

test("--git-path ignores a stale merge environment when MERGE_HEAD is absent", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  const expected = absoluteGitPath(tempDir, "COMMIT_EDITMSG");
  writeFile(expected, "ordinary message\n");
  const log = path.join(
    childProcessCwd(tempDir),
    "stale-merge-environment.log",
  );

  const result = runCommitMsg(tempDir, ["--git-path"], {
    env: {
      ...process.env,
      [`GITHEAD_${"a".repeat(40)}`]: "stale topic",
      FAKE_COMMITLINT_LOG: log,
    },
  });

  assert.equal(result.status, 0);
  assertCommitlintEditTarget(log, expected);
});

test("--git-path fails safely when a signaled merge path probe fails", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });

  const result = runCommitMsg(tempDir, ["--git-path"], {
    env: {
      ...fakeGitEnv(
        tempDir,
        "rev-parse --git-path MERGE_HEAD",
        1,
        "",
        "path unavailable",
      ),
      [`GITHEAD_${"b".repeat(40)}`]: "topic",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /could not verify its MERGE_HEAD path/i,
  );
});

test("--git-path fails safely when a signaled MERGE_HEAD cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  const mergeHead = absoluteGitPath(tempDir, "MERGE_HEAD");
  writeFile(mergeHead, `${"c".repeat(40)}\n`);
  const preload = fsFailurePreload(tempDir);

  const result = run(
    "node",
    [
      "--import",
      preload,
      path.join(tempDir, "scripts", "commit-msg.mjs"),
      "--git-path",
    ],
    tempDir,
    {
      env: {
        ...process.env,
        [`GITHEAD_${"c".repeat(40)}`]: "topic",
        TEST_FS_FAILURE_METHOD: "lstatSync",
        TEST_FS_FAILURE_PATH: mergeHead,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /MERGE_HEAD path could not be inspected safely/i,
  );
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /node:fs|\s+at /u);
});

test("--git-path rejects a non-regular signaled MERGE_HEAD", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  fs.mkdirSync(absoluteGitPath(tempDir, "MERGE_HEAD"));

  const result = runCommitMsg(tempDir, ["--git-path"], {
    env: {
      ...process.env,
      [`GITHEAD_${"d".repeat(64)}`]: "topic",
    },
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /MERGE_HEAD path is not a regular file/i,
  );
});

test("blocking commitlint rejects the same reported problem", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });

  const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
    env: {
      ...process.env,
      FAKE_COMMITLINT_STATUS: "1",
      FAKE_COMMITLINT_OUTPUT: "subject may not be empty [subject-empty]",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Commit blocked/);
  assert.match(output, /git commit --no-verify/);
});

test("a successful project-local commitlint run stays silent", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
    env: { ...process.env, FAKE_COMMITLINT_STATUS: "0" },
  });
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`, "");
});

test("commit-msg applies the configured fun tone", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, {
    tone: "fun",
    commitMessage: { enabled: true },
  });

  const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
    env: {
      ...process.env,
      FAKE_COMMITLINT_STATUS: "1",
      FAKE_COMMITLINT_OUTPUT: "type-enum needs attention",
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Commit message sent mixed signals/);
  assert.match(output, /relationship note/);
});

test("missing project-local commitlint never falls back to npx", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const advisory = runCommitMsg(tempDir, [messageFile(tempDir)]);
  const advisoryOutput = `${advisory.stdout}${advisory.stderr}`;
  assert.equal(advisory.status, 0);
  assert.match(advisoryOutput, /project-local commitlint CLI is not installed/);
  assert.match(advisoryOutput, /No npx, network, or global-tool fallback/);
  assert.match(advisoryOutput, /npm install -D @commitlint\/cli/);

  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  const blocking = runCommitMsg(tempDir, [
    messageFile(tempDir, "blocking.txt"),
  ]);
  assert.equal(blocking.status, 1);
  assert.match(`${blocking.stdout}${blocking.stderr}`, /Commit blocked/);
});

test("missing consumer commitlint config is distinct from lint findings", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  const env = {
    ...process.env,
    FAKE_COMMITLINT_STATUS: "9",
    FAKE_COMMITLINT_OUTPUT: "Please add rules to your commitlint.config.js",
  };

  const advisory = runCommitMsg(tempDir, [messageFile(tempDir)], { env });
  assert.equal(advisory.status, 0);
  assert.match(
    `${advisory.stdout}${advisory.stderr}`,
    /configuration not found/i,
  );
  assert.match(
    `${advisory.stdout}${advisory.stderr}`,
    /No built-in Conventional Commits rules were substituted/,
  );

  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  const blocking = runCommitMsg(tempDir, [messageFile(tempDir, "config.txt")], {
    env,
  });
  assert.equal(blocking.status, 1);
});

test("strict-mode empty-rules output keeps the missing-config diagnosis", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
    env: {
      ...process.env,
      FAKE_COMMITLINT_STATUS: "3",
      FAKE_COMMITLINT_OUTPUT:
        "Please add rules to your commitlint.config.js [empty-rules]",
    },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Commitlint configuration not found/);
  assert.match(output, /No built-in Conventional Commits rules/);
  assert.doesNotMatch(output, /Commit message needs attention/);
});

test("commitlint uses the shared configurable timeout", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, {
    timeoutMs: 5,
    commitMessage: { enabled: true },
  });

  const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
    env: { ...process.env, FAKE_COMMITLINT_DELAY_MS: "100" },
  });
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Commitlint timed out/);
});

test("missing message-file arguments follow advisory and blocking modes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const advisory = runCommitMsg(tempDir);
  assert.equal(advisory.status, 0);
  assert.match(
    `${advisory.stdout}${advisory.stderr}`,
    /No message file was provided/,
  );

  setPrecommitConfig(tempDir, {
    commitMessage: { enabled: true, blockOnFailure: true },
  });
  const blocking = runCommitMsg(tempDir, ["missing message file.txt"]);
  assert.equal(blocking.status, 1);
  assert.match(`${blocking.stdout}${blocking.stderr}`, /Could not open/);
});

test("commit-msg rejects a directory in place of a message file", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const result = runCommitMsg(tempDir, [tempDir]);

  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /Not a file:/);
});

test(
  "commit-msg reports a project-local tool terminated by a signal",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    installFakeCommitlint(tempDir);
    setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

    const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
      env: {
        ...process.env,
        FAKE_COMMITLINT_SIGNAL: "SIGKILL",
      },
    });

    assert.equal(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /check unavailable/i);
  },
);

test(
  "commit-msg reports a project-local tool that cannot be spawned",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const binDir = localBinDir(tempDir);
    fs.writeFileSync(path.join(binDir, "commitlint"), "not executable\n", {
      mode: 0o644,
    });
    setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

    const result = runCommitMsg(tempDir, [messageFile(tempDir)]);

    assert.equal(result.status, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /EACCES|permission denied/i,
    );
  },
);

test("commit-msg supplies a status fallback when commitlint writes nothing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir);
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const result = runCommitMsg(tempDir, [messageFile(tempDir)], {
    env: { ...process.env, FAKE_COMMITLINT_STATUS: "2" },
  });

  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /exited with status 2/);
});

test("nested config diagnostics run even when a typo leaves the check disabled", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enable: true, blockOnFailure: "yes" },
  });

  const result = runCommitMsg(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /commitMessage\.enable/);
  assert.match(output, /commitMessage\.blockOnFailure must be a boolean/);
});

test("generated commit-msg hook blocks normally and --no-verify bypasses it", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  installFakeCommitlint(tempDir, { withCli: true });
  setPrecommitConfig(tempDir, {
    requireTests: false,
    protectedBranches: [],
    commitMessage: { enabled: true, blockOnFailure: true },
  });

  const init = run("node", ["scripts/init.mjs"], tempDir);
  assert.equal(init.status, 0);
  const hookPath = path.join(tempDir, ".git", "hooks", "commit-msg");
  assert.match(fs.readFileSync(hookPath, "utf8"), /commit-msg "\$1"/);
  if (process.platform !== "win32") {
    assert.ok(fs.statSync(hookPath).mode & 0o111);
  }

  writeFile(path.join(tempDir, "bypass.txt"), "content\n");
  run("git", ["add", "bypass.txt"], tempDir);
  const log = path.join(tempDir, "hook-commitlint.log");
  const env = {
    ...process.env,
    FAKE_COMMITLINT_LOG: log,
    FAKE_COMMITLINT_STATUS: "1",
    FAKE_COMMITLINT_OUTPUT: "invalid commit message",
  };

  const blocked = run("git", ["commit", "-m", "bad message"], tempDir, { env });
  assert.equal(blocked.status, 1);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /Commit blocked/);
  assert.equal(
    readFile(tempDir, "hook-commitlint.log").trim().split("\n").length,
    1,
  );

  const bypassed = run(
    "git",
    ["commit", "--no-verify", "-m", "bad bypassed message"],
    tempDir,
    { env },
  );
  assert.equal(bypassed.status, 0);
  assert.equal(
    readFile(tempDir, "hook-commitlint.log").trim().split("\n").length,
    1,
  );
});
