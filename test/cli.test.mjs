// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  cleanupTempRepo,
  createTempRepo,
  repoRoot,
  run,
  setPrecommitConfig,
  writeFile,
} from "./helpers/temp-repo.mjs";
import {
  compactTerminalBoxText,
  countTerminalBoxes,
  stripAnsi,
} from "./helpers/output.mjs";

function cli(tempDir, args, options = {}) {
  const { cwd = tempDir, ...runOptions } = options;
  return run(
    "node",
    [path.join(tempDir, "scripts", "cli.mjs"), ...args],
    cwd,
    runOptions,
  );
}

function sourceCli(cwd, args, options = {}) {
  return run(
    "node",
    [path.join(repoRoot, "scripts", "cli.mjs"), ...args],
    cwd,
    options,
  );
}

function combinedOutput(result) {
  return `${result.stdout}${result.stderr}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMMAND_HELP = [
  {
    name: "init",
    usage: "init [--dry-run | -n]",
    summary: "Install Git hooks in this repository",
    option: "-n, --dry-run",
  },
  {
    name: "uninstall",
    usage: "uninstall [--dry-run | -n]",
    summary: "Remove Commitment Issues from this repository",
    option: "-n, --dry-run",
  },
  {
    name: "doctor",
    usage: "doctor [--quiet]",
    summary: "Check and repair the installation",
    option: "--quiet",
  },
  {
    name: "commit-msg",
    usage: "commit-msg <message-file> | --git-path",
    summary: "Check a commit message when invoked automatically by Git",
    option: "--git-path",
  },
  {
    name: "precommit",
    usage: "precommit [--json]",
    summary: "Check staged changes now",
    option: "--json",
  },
  {
    name: "prepush",
    usage: "prepush [remote-name] [remote-url] [--json]",
    summary: "Check changes that would be pushed",
    option: "--json",
  },
  {
    name: "panic",
    usage: "panic",
    summary: "Show a safe starting point after a Git mistake",
  },
  {
    name: "commit-fix",
    usage: "commit-fix",
    summary: "Safely amend an attached commit using local ref checks",
  },
  {
    name: "fix-staged",
    usage: "fix-staged",
    summary: "Fix files currently staged for commit",
  },
  {
    name: "fix-staged-js",
    usage: "fix-staged-js [files...]",
    summary: "Fix explicit files supplied by package wiring",
  },
];

function snapshotWorktree(tempDir) {
  const entries = [];

  function visit(directory, prefix = "") {
    const children = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const relativePath = prefix ? path.join(prefix, child.name) : child.name;
      if (relativePath === ".git") continue;

      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) {
        entries.push([relativePath, "symlink", fs.readlinkSync(absolutePath)]);
      } else if (child.isDirectory()) {
        entries.push([relativePath, "directory"]);
        visit(absolutePath, relativePath);
      } else {
        entries.push([
          relativePath,
          "file",
          fs.readFileSync(absolutePath).toString("base64"),
        ]);
      }
    }
  }

  visit(tempDir);
  return entries;
}

function snapshotRepositoryState(tempDir) {
  const hooksDir = path.join(tempDir, ".git", "hooks");
  const hooks = fs
    .readdirSync(hooksDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => [
      entry.name,
      entry.isFile()
        ? fs.readFileSync(path.join(hooksDir, entry.name)).toString("base64")
        : entry.isDirectory()
          ? "directory"
          : "other",
    ]);

  return {
    worktree: snapshotWorktree(tempDir),
    status: run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      tempDir,
    ).stdout,
    config: fs.readFileSync(path.join(tempDir, ".git", "config"), "utf8"),
    head: fs.readFileSync(path.join(tempDir, ".git", "HEAD"), "utf8"),
    hooks,
  };
}

test("cli prints action-oriented global help and exits 0", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["--help"]);
  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version;

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    new RegExp(`Commitment Issues v${expectedVersion}`),
  );
  assert.match(
    result.stdout,
    /Catch mistakes locally—before CI makes them expensive\./,
  );
  assert.match(result.stdout, /commitment-issues <command> \[options\]/);

  for (const { name, summary } of COMMAND_HELP.filter(({ name }) =>
    [
      "init",
      "doctor",
      "uninstall",
      "commit-msg",
      "precommit",
      "prepush",
      "panic",
      "fix-staged",
      "commit-fix",
    ].includes(name),
  )) {
    assert.match(
      result.stdout,
      new RegExp(`\\b${escapeRegExp(name)}\\s+${escapeRegExp(summary)}`),
    );
  }

  for (const omitted of ["fix-staged-js", "vows"]) {
    assert.doesNotMatch(
      result.stdout,
      new RegExp(`\\b${escapeRegExp(omitted)}\\b`),
    );
  }

  const setupIndex = result.stdout.indexOf("Setup:");
  const checksIndex = result.stdout.indexOf("Checks:");
  const fixesIndex = result.stdout.indexOf("Fixes:");
  const integrationIndex = result.stdout.indexOf("Integration:");
  assert.ok(
    setupIndex < checksIndex &&
      checksIndex < fixesIndex &&
      fixesIndex < integrationIndex,
  );
  assert.ok(
    result.stdout.indexOf("init", setupIndex) <
      result.stdout.indexOf("doctor", setupIndex),
  );
  assert.ok(
    result.stdout.indexOf("doctor", setupIndex) <
      result.stdout.indexOf("uninstall", setupIndex),
  );
  assert.match(result.stdout, /-v, --version\s+Show the installed version/);
  assert.match(result.stdout, /commitment-issues help <command>/);
  assert.match(result.stdout, /commitment-issues init --dry-run/);
  assert.match(
    result.stdout,
    /https:\/\/github\.com\/RoryGlenn\/commitment-issues/,
  );
});

test("cli prints command help through both conventional forms without side effects", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const before = snapshotRepositoryState(tempDir);

  for (const { name, usage, summary, option } of COMMAND_HELP) {
    const helpCommand = cli(tempDir, ["help", name]);
    const helpFlag = cli(tempDir, [name, "--help"]);

    for (const result of [helpCommand, helpFlag]) {
      assert.equal(result.status, 0, name);
      assert.equal(result.stderr, "", name);
      assert.match(result.stdout, new RegExp(escapeRegExp(`${summary}.`)));
      assert.ok(
        result.stdout.includes(`  commitment-issues ${usage}`),
        `${name} usage`,
      );
      assert.match(result.stdout, /--help\s+Show help for this command/);
      if (option) assert.ok(result.stdout.includes(option), `${name} option`);
    }

    assert.equal(helpCommand.stdout, helpFlag.stdout, name);
  }

  assert.deepEqual(snapshotRepositoryState(tempDir), before);
});

test("cli keeps the Easter egg hidden from command help", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const helpCommand = cli(tempDir, ["help", "vows"]);
  const helpFlag = cli(tempDir, ["vows", "--help"]);

  assert.equal(helpCommand.status, 1);
  assert.match(helpCommand.stderr, /unknown command 'vows'/);
  assert.doesNotMatch(helpCommand.stderr, /Show the Commitment Issues vows/);
  assert.equal(helpFlag.status, 1);
  assert.match(helpFlag.stderr, /expected no arguments/);
  assert.doesNotMatch(helpFlag.stderr, /Show the Commitment Issues vows/);
});

test("cli treats bare help as global help and rejects extra help targets", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const globalHelp = cli(tempDir, ["help"]);
  const extraTarget = cli(tempDir, ["help", "init", "doctor"]);

  assert.equal(globalHelp.status, 0);
  assert.match(globalHelp.stdout, /Commitment Issues v/);
  assert.match(globalHelp.stdout, /Setup:/);
  assert.equal(extraTarget.status, 1);
  assert.match(extraTarget.stderr, /expected one command; received 2/);
});

test("cli prints the package version for --version and -v", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version;

  for (const flag of ["--version", "-v"]) {
    const result = cli(tempDir, [flag]);
    assert.equal(result.status, 0);
    assert.equal(combinedOutput(result).trim(), expectedVersion);
  }
});

test("cli errors on an unknown command", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const name of ["bogus", "__proto__", "constructor", "toString"]) {
    const result = cli(tempDir, [name]);
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), /unknown command/);
    assert.doesNotMatch(combinedOutput(result), /TypeError|at path\.join/);
  }
});

test("hook dispatch is hidden, validated, and owns bypass handling", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const help = cli(tempDir, ["help", "hook"]);
  assert.equal(help.status, 1);
  assert.match(combinedOutput(help), /unknown command 'hook'/);

  const missing = cli(tempDir, ["hook"]);
  assert.equal(missing.status, 1);
  assert.match(
    combinedOutput(missing),
    /expected precommit, prepush, or commit-msg; received ''/,
  );

  for (const invalidName of [
    "bogus\nname",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    const invalid = cli(tempDir, ["hook", invalidName]);
    assert.equal(invalid.status, 1);
    assert.match(
      combinedOutput(invalid),
      /expected precommit, prepush, or commit-msg/,
    );
    assert.doesNotMatch(combinedOutput(invalid), /TypeError|at path\.join/);
  }

  for (const args of [
    ["hook", "commit-msg", "message-one", "message-two"],
    ["hook", "commit-msg", "--bogus"],
  ]) {
    const invalid = cli(tempDir, args);
    assert.equal(invalid.status, 1);
    assert.match(
      combinedOutput(invalid),
      /expected one message-file argument|unknown option '--bogus'/,
    );
  }

  const env = { ...process.env, COMMITMENT_ISSUES: "0" };
  const invoke = (args, childEnv = env) =>
    spawnSync(
      process.execPath,
      [path.join(tempDir, "scripts", "cli.mjs"), ...args],
      { cwd: tempDir, encoding: "utf8", env: childEnv },
    );
  const direct = invoke(["precommit", "--unknown"]);
  assert.equal(direct.status, 1);
  assert.match(combinedOutput(direct), /unknown option '--unknown'/);
  const hook = invoke(["hook", "precommit", "--unknown"]);
  assert.equal(hook.status, 0);
  assert.equal(combinedOutput(hook), "");

  const invalidWhileBypassed = invoke(["hook", "bogus\nname"]);
  const invalidWhileBypassedOutput = combinedOutput(invalidWhileBypassed);
  assert.equal(invalidWhileBypassed.status, 1);
  assert.match(invalidWhileBypassedOutput, /bogus\\nname/);
  assert.doesNotMatch(invalidWhileBypassedOutput, /bogus\nname/);
  assert.doesNotMatch(
    invalidWhileBypassedOutput,
    /TypeError|ERR_|at path\.join|\s+at /,
  );

  for (const skippedBy of ["COMMITMENT_ISSUES", "HUSKY"]) {
    const skippedEnv = {
      ...process.env,
      COMMITMENT_ISSUES: skippedBy === "COMMITMENT_ISSUES" ? "0" : "1",
      HUSKY: skippedBy === "HUSKY" ? "0" : "1",
    };
    for (const args of [
      ["hook", "commit-msg", "message-one", "message-two"],
      ["hook", "commit-msg", "--bogus"],
    ]) {
      const skipped = invoke(args, skippedEnv);
      assert.equal(skipped.status, 0, skippedBy);
      assert.equal(combinedOutput(skipped), "", skippedBy);
    }
  }
});

test("cli suggests the closest command for a likely typo", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const [typo, expected] of [
    ["docter", "doctor"],
    ["precommt", "precommit"],
    ["fix-stagged", "fix-staged"],
  ]) {
    const result = cli(tempDir, [typo]);
    assert.equal(result.status, 1);
    assert.match(
      combinedOutput(result),
      new RegExp(`Did you mean '${escapeRegExp(expected)}'\\?`),
    );
  }
});

test("cli bounds typo suggestions for accidentally pasted commands", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const pasted = "x".repeat(65);

  const result = cli(tempDir, [pasted]);

  assert.equal(result.status, 1);
  assert.match(combinedOutput(result), new RegExp(pasted));
  assert.doesNotMatch(combinedOutput(result), /Did you mean/);
});

test("cli preserves shell-sensitive unknown command tokens", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const token of [
    "has space",
    "quote'file",
    "semi;colon",
    "glob*value",
    String.raw`windows\\path`,
  ]) {
    const result = cli(tempDir, [token]);
    assert.equal(result.status, 1);
    assert.match(combinedOutput(result), new RegExp(escapeRegExp(token)));
  }
});

test("cli visibly escapes controls in an unknown command", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const result = cli(tempDir, [
    "evil\rFAKE SUCCESS\n\t\b\u001b[31mRED\u001b[39m",
  ]);
  const output = combinedOutput(result);

  assert.equal(result.status, 1);
  assert.match(output, /evil\\rFAKE SUCCESS\\n\\t\\x08RED/);
  assert.doesNotMatch(output, /\r|\t|\x08|\u001b/);
});

test("cli dispatches to init", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["init"]);
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /Commitment Issues is set up/);
});

test("cli dispatches to uninstall", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["uninstall"]);
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /Commitment Issues setup was removed/);
});

test("cli dispatches to doctor", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["doctor"]);
  assert.equal(result.status, 0);
  assert.match(
    combinedOutput(result),
    /Repaired the git hook wiring|Git hooks are healthy/,
  );
});

test("cli dispatches to precommit", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Nothing is staged in a fresh temp repo, so precommit is a clean no-op.
  const result = cli(tempDir, ["precommit"]);
  assert.equal(result.status, 0);
});

test("cli dispatches commit-msg and forwards the message file", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  const messageFile = path.join(tempDir, "message file.txt");
  writeFile(messageFile, "feat: literal path\n");

  const result = cli(tempDir, ["commit-msg", messageFile]);
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /project-local commitlint CLI/);
  assert.doesNotMatch(
    combinedOutput(result),
    /Unable to read the commit message/,
  );
});

test("cli dispatches to prepush", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    blockPushOnTestFailure: true,
    hookOutput: "normal",
    protectedBranches: [],
  });

  const result = cli(tempDir, ["prepush"], {
    env: { ...process.env, COMMITMENT_ISSUES_ASSUME_TTY: "1" },
  });
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /No tests to run before push/);
});

test("cli dispatches to commit-fix", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["commit-fix"]);
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /Latest commit already clean/);
});

test("cli dispatches to fix-staged", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["fix-staged"]);
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /No staged files to fix/);
});

test("cli dispatches to fix-staged-js", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["fix-staged-js"]);
  assert.equal(result.status, 0);
  assert.equal(combinedOutput(result).trim(), "");
});

test("cli dispatches to panic", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["panic"], {
    env: { ...process.env, COLUMNS: "140", NO_COLOR: "1" },
  });
  assert.equal(result.status, 0);
  assert.match(combinedOutput(result), /Current state:/);
  assert.match(combinedOutput(result), /git status/);
});

test("cli dispatches the deterministic, read-only vows Easter egg", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const env = { ...process.env, COLUMNS: "80", NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const before = snapshotRepositoryState(tempDir);

  const first = cli(tempDir, ["vows"], { env });
  const second = cli(tempDir, ["vows"], { env });
  const json = cli(tempDir, ["vows", "--json"], { env });

  assert.equal(first.status, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);
  assert.equal(countTerminalBoxes(first.stdout), 1);
  for (const line of [
    "💍 The commitment-issues vows",
    "Warn before blocking.",
    "Fix only with consent.",
    "Keep your code local.",
    "Never rewrite what we cannot prove is safe.",
  ]) {
    assert.ok(first.stdout.includes(line));
  }
  assert.equal(json.status, 1);
  assert.equal(json.stdout, "");
  assert.match(json.stderr, /--json is only supported by/);
  assert.equal(countTerminalBoxes(json.stderr), 0);
  assert.deepEqual(snapshotRepositoryState(tempDir), before);
});

test("vows uses color when enabled and honors NO_COLOR", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const colorEnv = { ...process.env, COLUMNS: "80", FORCE_COLOR: "1" };
  delete colorEnv.NO_COLOR;
  const noColorEnv = { ...process.env, COLUMNS: "80", NO_COLOR: "1" };
  delete noColorEnv.FORCE_COLOR;

  const colored = cli(tempDir, ["vows"], { env: colorEnv });
  const plain = cli(tempDir, ["vows"], { env: noColorEnv });

  assert.equal(colored.status, 0);
  assert.notEqual(colored.stdout, stripAnsi(colored.stdout));
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout, stripAnsi(plain.stdout));
});

test("vows remains readable in a narrow terminal", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const env = { ...process.env, COLUMNS: "24", NO_COLOR: "1" };
  delete env.FORCE_COLOR;

  const result = cli(tempDir, ["vows"], { env });
  const output = stripAnsi(result.stdout).trim();
  const compact = compactTerminalBoxText(output).replace(/\s/g, "");

  assert.equal(result.status, 0);
  assert.equal(countTerminalBoxes(output), 1);
  assert.ok(output.split(/\r?\n/).every((line) => line.length <= 24));
  for (const vow of [
    "Warn before blocking.",
    "Fix only with consent.",
    "Keep your code local.",
    "Never rewrite what we cannot prove is safe.",
  ]) {
    assert.ok(compact.includes(vow.replace(/\s/g, "")));
  }
});

test("cli forwards arguments to the subcommand", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  cli(tempDir, ["doctor"]); // establish healthy wiring
  const result = cli(tempDir, ["doctor", "--quiet"]);
  assert.equal(result.status, 0);
  // `--quiet` reached doctor: silent when already healthy.
  assert.equal(combinedOutput(result).trim(), "");
});

test("cli rejects arguments outside each command contract", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const [args, expected] of [
    [["commit-fix", "unexpected"], /expected no arguments/],
    [["fix-staged", "unexpected"], /expected no arguments/],
    [["panic", "unexpected"], /expected no arguments/],
    [
      ["commit-msg", "message-one", "message-two"],
      /expected one message-file argument/,
    ],
    [["commit-msg", "--unknown"], /unknown option '--unknown'/],
    [["precommit", "--bogus"], /unknown option '--bogus'/],
    [
      ["prepush", "origin", "url", "unexpected"],
      /expected at most 2 positional arguments/,
    ],
  ]) {
    const result = cli(tempDir, args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(combinedOutput(result), expected);
  }
});

test("cli precommit uses root config and staged paths from a subdirectory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const branch = run(
    "git",
    ["branch", "--show-current"],
    tempDir,
  ).stdout.trim();
  setPrecommitConfig(tempDir, {
    blockProtectedBranches: true,
    protectedBranches: [branch],
    requireTests: false,
  });
  writeFile(
    path.join(tempDir, "src", "needs formatting.json"),
    '{"nested":true}\n',
  );
  run("git", ["add", "src/needs formatting.json"], tempDir);
  const nested = path.join(tempDir, "nested path", "deeper");
  fs.mkdirSync(nested, { recursive: true });

  const blocked = cli(tempDir, ["precommit"], { cwd: nested });
  const blockedOutput = combinedOutput(blocked);

  assert.equal(blocked.status, 1);
  assert.match(blockedOutput, /protected branch/i);

  setPrecommitConfig(tempDir, {
    protectedBranches: [],
    requireTests: false,
  });
  const checked = cli(tempDir, ["precommit"], { cwd: nested });
  const checkedOutput = combinedOutput(checked);

  assert.equal(checked.status, 0);
  assert.match(checkedOutput, /1 file with formatting issues/);
  assert.match(checkedOutput, /src\/needs formatting\.json/);
  assert.doesNotMatch(checkedOutput, /Prettier failed to complete/);
});

test("setup commands refuse a repository subdirectory without changes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const nested = path.join(tempDir, "nested package");
  fs.mkdirSync(nested);
  const packagePath = path.join(nested, "package.json");
  const original = '{"name":"nested-package","private":true}\n';
  fs.writeFileSync(packagePath, original);

  for (const args of [
    ["init", "--dry-run"],
    ["doctor"],
    ["uninstall", "--dry-run"],
  ]) {
    const result = cli(tempDir, args, { cwd: nested });
    assert.equal(result.status, 1, args.join(" "));
    assert.match(combinedOutput(result), /Project root required/);
    assert.match(combinedOutput(result), /Run this command from:/);
  }
  assert.equal(fs.readFileSync(packagePath, "utf8"), original);
});

test("cli help works outside a git repo and node project", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "commitment-cli-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const globalHelp = sourceCli(tempDir, ["--help"]);
  assert.equal(globalHelp.status, 0);
  assert.match(globalHelp.stdout, /commitment-issues <command>/);

  for (const { name, usage } of COMMAND_HELP) {
    for (const args of [
      ["help", name],
      [name, "--help"],
    ]) {
      const result = sourceCli(tempDir, args);
      assert.equal(result.status, 0, args.join(" "));
      assert.ok(
        result.stdout.includes(`commitment-issues ${usage}`),
        args.join(" "),
      );
    }
  }
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test("cli reports subcommand errors outside a node project", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "commitment-cli-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const result = sourceCli(tempDir, ["doctor"]);
  assert.equal(result.status, 1);
  assert.match(combinedOutput(result), /No package.json found/);
});

test("cli prints usage to stderr and exits 1 when given no command", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, []);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /commitment-issues <command>/);
});

test("cli treats -h like --help", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = cli(tempDir, ["-h"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /commitment-issues <command>/);
});
