// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compactTerminalBoxText,
  countTerminalBoxes,
} from "./helpers/output.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  fsFailurePreload,
  mutableProjectFileFailurePreload,
  readFile,
  repoRoot,
  run,
  writeFile,
} from "./helpers/temp-repo.mjs";
import { HUSKY_V9_RUNTIME } from "./helpers/hook-manager-fixtures.mjs";
import { hookInvocation, hookManagerSnippets } from "../scripts/lib/hooks.mjs";

function hookSuggestionPattern(name) {
  const subcommand =
    name === "pre-commit"
      ? "precommit"
      : name === "pre-push"
        ? "prepush"
        : "commit-msg";
  return new RegExp(
    `${name}:\\s*for\\s+commitment_issues_bin\\s+in[\\s\\S]*?hook\\s+${subcommand}`,
    "u",
  );
}

function runInit(tempDir, args = [], options = {}) {
  return run(
    "node",
    [path.join(tempDir, "scripts", "init.mjs"), ...args],
    tempDir,
    options,
  );
}

function writePackage(tempDir, pkg) {
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}

function readPackage(tempDir) {
  return JSON.parse(readFile(tempDir, "package.json"));
}

function hooksPath(tempDir) {
  return run(
    "git",
    ["config", "--get", "core.hooksPath"],
    tempDir,
  ).stdout.trim();
}

function gitHook(tempDir, name) {
  return path.join(tempDir, ".git", "hooks", name);
}

function aliasedRepoPath(t, tempDir, prefix) {
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoAlias = path.join(aliasRoot, "repo");
  fs.symlinkSync(
    tempDir,
    repoAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  return repoAlias;
}

function assertHookClaimsWithheld(output) {
  assert.match(output, /Commitment Issues needs hook wiring/);
  assert.match(output, /Pre-commit and pre-push checks are not active yet/);
  assert.doesNotMatch(output, /Commitment Issues is set up/);
  assert.doesNotMatch(output, /Your next commit runs advisory checks/);
  assert.doesNotMatch(output, /Your next push runs advisory tests/);
}

test("init wires up hooks, scripts, and config; is idempotent", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Start from a bare package.json so init has work to do.
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    private: true,
    type: "module",
  });

  const first = runInit(tempDir);
  assert.equal(first.status, 0);

  const firstOutput = `${first.stdout}${first.stderr}`;
  assert.match(firstOutput, /Added:/);
  assert.match(firstOutput, /- script prepare/);
  assert.match(firstOutput, /- script commit:fix/);
  assert.doesNotMatch(firstOutput, /Added: script prepare, script commit:fix/);

  const pkg = readPackage(tempDir);
  assert.equal(pkg.scripts["commit:fix"], "commitment-issues commit-fix");
  assert.equal(pkg.scripts["fix:staged"], "commitment-issues fix-staged");
  assert.equal(pkg.scripts.doctor, "commitment-issues doctor");
  assert.equal(pkg.scripts.prepare, "commitment-issues doctor --quiet");
  // No hook-runner config is written: staged fixes run through the bin.
  assert.equal("lint-staged" in pkg, false);
  assert.equal(pkg.precommitChecks.advisePushTests, true);

  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    /commitment-issues precommit/,
  );
  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"),
    /commitment-issues prepush "\$@"/,
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);
  // Native wiring: hooks live in .git/hooks with no core.hooksPath set.
  assert.equal(hooksPath(tempDir), "");
  assert.match(readFile(tempDir, ".gitignore"), /\.prettiercache/);

  // Re-running changes nothing.
  const second = runInit(tempDir);
  assert.equal(second.status, 0);
  assert.match(`${second.stdout}${second.stderr}`, /Already configured/);
});

test("init dry run suggests applying only when changes are pending", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    private: true,
    type: "module",
  });

  const pending = runInit(tempDir, ["--dry-run"]);
  const pendingOutput = `${pending.stdout}${pending.stderr}`;
  assert.equal(pending.status, 0);
  assert.match(pendingOutput, /Would add:/);
  assert.match(
    pendingOutput,
    /Run again without --dry-run to apply these changes\./,
  );

  assert.equal(runInit(tempDir).status, 0);

  const configured = runInit(tempDir, ["--dry-run"]);
  const configuredOutput = `${configured.stdout}${configured.stderr}`;
  assert.equal(configured.status, 0);
  assert.match(configuredOutput, /Already configured — nothing to change\./);
  assert.match(configuredOutput, /No files were written\./);
  assert.doesNotMatch(
    configuredOutput,
    /Run again without --dry-run to apply these changes\./,
  );
});

test("init rejects unknown options before changing project or hook state", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
  });
  const packageBefore = readFile(tempDir, "package.json");
  const gitignoreBefore = readFile(tempDir, ".gitignore");

  const result = runInit(tempDir, ["--dry-rn"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unknown init option: --dry-rn/);
  assert.match(output, /No files or hooks were changed/);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init refuses unwritable project files before installing hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
  });
  const packagePath = path.join(tempDir, "package.json");
  const packageBefore = readFile(tempDir, "package.json");
  const preload = fsFailurePreload(tempDir);

  const result = run(
    "node",
    ["--import", preload, path.join(tempDir, "scripts", "init.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        TEST_FS_FAILURE_METHOD: "accessSync",
        TEST_FS_FAILURE_PATH: packagePath,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Could not update package\.json/);
  assert.match(output, /No files or hooks were changed/);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init coexists with Husky without rewriting manager-owned hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "husky-project",
    version: "1.0.0",
    type: "module",
    scripts: { prepare: "husky" },
    devDependencies: { husky: "^9.0.0" },
  });
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  fs.mkdirSync(path.join(tempDir, ".husky", "_"), { recursive: true });
  writeFile(path.join(tempDir, ".husky", "_", "h"), HUSKY_V9_RUNTIME);
  for (const name of ["pre-commit", "pre-push"]) {
    const wrapper = path.join(tempDir, ".husky", "_", name);
    writeFile(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
    fs.chmodSync(wrapper, 0o755);
  }
  const preCommit = `${hookInvocation("pre-commit")}\necho custom-after\n`;
  const prePush = `${hookInvocation("pre-push")}\necho push-after\n`;
  writeFile(path.join(tempDir, ".husky", "pre-commit"), preCommit);
  writeFile(path.join(tempDir, ".husky", "pre-push"), prePush);
  const hooksPathBefore = hooksPath(tempDir);

  const first = runInit(tempDir, ["--integration=husky"]);
  const firstOutput = `${first.stdout}${first.stderr}`;
  assert.equal(first.status, 0);
  assert.match(firstOutput, /Commitment Issues is set up/);
  assert.doesNotMatch(firstOutput, /husky coexistence snippets/i);
  assert.doesNotMatch(firstOutput, /Manager-owned files were not changed/);
  assert.equal(readFile(tempDir, ".husky/pre-commit"), preCommit);
  assert.equal(readFile(tempDir, ".husky/pre-push"), prePush);
  assert.equal(hooksPath(tempDir), hooksPathBefore);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(
    readPackage(tempDir).scripts.prepare,
    "husky && commitment-issues doctor --quiet --integration=husky",
  );

  const packageAfterFirst = readFile(tempDir, "package.json");
  const second = runInit(tempDir, ["--integration=husky"]);
  const secondOutput = `${second.stdout}${second.stderr}`;
  assert.equal(second.status, 0);
  assert.match(secondOutput, /Already configured/);
  assert.doesNotMatch(secondOutput, /husky coexistence snippets/i);
  assert.equal(readFile(tempDir, "package.json"), packageAfterFirst);
  assert.equal(readFile(tempDir, ".husky/pre-commit"), preCommit);
  assert.equal(readFile(tempDir, ".husky/pre-push"), prePush);

  writeFile(path.join(tempDir, ".husky", "pre-push"), "echo user-owned\n");
  const partial = runInit(tempDir, ["--integration=husky"]);
  const partialOutput = `${partial.stdout}${partial.stderr}`;
  assert.equal(partial.status, 0);
  assert.match(partialOutput, /hook prepush/);
  assert.doesNotMatch(partialOutput, /hook precommit/);
  writeFile(path.join(tempDir, ".husky", "pre-push"), prePush);

  const migrateToNative = runInit(tempDir);
  assert.equal(migrateToNative.status, 0);
  assert.equal(
    readPackage(tempDir).scripts.prepare,
    "commitment-issues doctor --quiet",
  );
  assert.equal(hooksPath(tempDir), "");
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-commit")));
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-push")));
  assert.equal(readFile(tempDir, ".husky/pre-commit"), preCommit);
  assert.equal(readFile(tempDir, ".husky/pre-push"), prePush);
});

test("init distinguishes legacy, duplicate, and cross-stage manager entries", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "manager-entry-status-project",
    version: "1.0.0",
    type: "module",
    scripts: { prepare: "husky" },
    devDependencies: { husky: "^9.0.0" },
  });
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  fs.mkdirSync(path.join(tempDir, ".husky", "_"), { recursive: true });
  writeFile(path.join(tempDir, ".husky", "_", "h"), HUSKY_V9_RUNTIME);
  for (const name of ["pre-commit", "pre-push"]) {
    const wrapper = path.join(tempDir, ".husky", "_", name);
    writeFile(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
    fs.chmodSync(wrapper, 0o755);
  }
  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    `${hookInvocation("pre-commit")}\n`,
  );
  const legacyPrePush =
    'node_modules/.bin/commitment-issues prepush "$@" || exit $?\n';
  writeFile(path.join(tempDir, ".husky", "pre-push"), legacyPrePush);

  const legacy = runInit(tempDir, ["--integration=husky"]);
  const legacyOutput = `${legacy.stdout}${legacy.stderr}`;
  assert.equal(legacy.status, 0);
  assert.match(legacyOutput, /older direct entry must be replaced/i);
  assert.match(legacyOutput, /pre-push; replace older entry/u);
  assert.match(legacyOutput, /Replace each labelled older entry in place/u);
  assert.match(legacyOutput, /hook-dispatch forms/u);
  assert.doesNotMatch(legacyOutput, /hook precommit/u);
  assert.equal(readFile(tempDir, ".husky/pre-push"), legacyPrePush);

  const duplicatePrePush = [
    "echo prior",
    legacyPrePush.trimEnd(),
    hookInvocation("pre-push"),
    "",
  ].join("\n");
  writeFile(path.join(tempDir, ".husky", "pre-push"), duplicatePrePush);
  const duplicate = runInit(tempDir, ["--integration=husky"]);
  const duplicateOutput = compactTerminalBoxText(
    `${duplicate.stdout}${duplicate.stderr}`,
  );
  assert.equal(duplicate.status, 0);
  assert.match(duplicateOutput, /duplicate entries must be reduced to one/i);
  assert.match(duplicateOutput, /remove duplicate Commitment Issues entries/i);
  assert.match(duplicateOutput, /keep one exact hook-dispatch\s*entry/iu);
  assert.doesNotMatch(duplicateOutput, /pre-push; replace older entry/i);
  assert.equal(readFile(tempDir, ".husky/pre-push"), duplicatePrePush);

  const crossStagePrePush = [
    hookInvocation("pre-push"),
    "node_modules/.bin/commitment-issues precommit || exit $?",
    "",
  ].join("\n");
  writeFile(path.join(tempDir, ".husky", "pre-push"), crossStagePrePush);
  const crossStage = runInit(tempDir, ["--integration=husky"]);
  const crossOutput = compactTerminalBoxText(
    `${crossStage.stdout}${crossStage.stderr}`,
  );
  assert.equal(crossStage.status, 0);
  assert.match(crossOutput, /command targets another hook stage/i);
  assert.match(crossOutput, /move each Commitment Issues entry/i);
  assert.match(crossOutput, /older direct call.*insert `hook`/i);
  assert.doesNotMatch(crossOutput, /could not be inspected|replace each path/i);
  assert.equal(readFile(tempDir, ".husky/pre-push"), crossStagePrePush);

  writeFile(
    path.join(tempDir, ".husky", "pre-push"),
    "node_modules/.bin/commitment-issues precommit || exit $?\n",
  );
  const crossStageOnly = runInit(tempDir, ["--integration=husky"]);
  const crossStageOnlyOutput = compactTerminalBoxText(
    `${crossStageOnly.stdout}${crossStageOnly.stderr}`,
  );
  assert.equal(crossStageOnly.status, 0);
  assert.match(crossStageOnlyOutput, /command targets another hook stage/i);
  assert.match(crossStageOnlyOutput, /pre-push; add missing entry/i);
  assert.match(crossStageOnlyOutput, /hook prepush/iu);
});

test("init omits Husky-only ordering guidance for Lefthook duplicates", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "lefthook-duplicate-project",
    version: "1.0.0",
    type: "module",
    devDependencies: { lefthook: "2" },
  });
  const config = hookManagerSnippets("lefthook", ["pre-commit", "pre-push"])
    .map(({ content }) => content)
    .join("")
    .replace(
      "    commitment-issues:\n",
      [
        "    commitment-issues-old:",
        "      run: node_modules/.bin/commitment-issues precommit",
        "    commitment-issues:",
        "",
      ].join("\n"),
    );
  writeFile(path.join(tempDir, "lefthook.yml"), config);

  const result = runInit(tempDir, ["--integration=lefthook"]);
  const output = compactTerminalBoxText(`${result.stdout}${result.stderr}`);

  assert.equal(result.status, 0);
  assert.match(output, /duplicate entries must be reduced to one/i);
  assert.match(output, /remove duplicate Commitment Issues entries/i);
  assert.doesNotMatch(output, /first substantive command/i);
  assert.equal(readFile(tempDir, "lefthook.yml"), config);
});

test("init integration dry run prints exact pre-commit entries without writes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "pre-commit-project",
    version: "1.0.0",
    type: "module",
    precommitChecks: { commitMessage: { enabled: true } },
  });
  const managerConfig = [
    "repos:",
    "  - repo: local",
    "    hooks:",
    "      - id: existing-hook",
    "        name: existing hook",
    "        entry: existing-command",
    "        language: system",
    "",
  ].join("\n");
  writeFile(path.join(tempDir, ".pre-commit-config.yaml"), managerConfig);
  const packageBefore = readFile(tempDir, "package.json");
  const gitignoreBefore = readFile(tempDir, ".gitignore");

  const result = runInit(tempDir, ["--dry-run", "--integration=pre-commit"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /pre-commit coexistence snippets/i);
  assert.match(output, /id: commitment-issues-pre-commit/);
  assert.match(output, /id: commitment-issues-pre-push/);
  assert.match(output, /id: commitment-issues-commit-msg/);
  assert.match(output, /pass_filenames: true/);
  assert.match(output, /No files were written/);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
  assert.equal(readFile(tempDir, ".pre-commit-config.yaml"), managerConfig);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init refuses to guess between multiple hook managers", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "ambiguous-project",
    version: "1.0.0",
    type: "module",
    devDependencies: { husky: "9", lefthook: "2" },
  });
  fs.mkdirSync(path.join(tempDir, ".husky"));
  writeFile(path.join(tempDir, "lefthook.yml"), "pre-commit: {}\n");
  const packageBefore = readFile(tempDir, "package.json");
  const gitignoreBefore = readFile(tempDir, ".gitignore");

  const result = runInit(tempDir, ["--integration"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /Multiple hook managers were detected/);
  assert.match(output, /Detected: husky, lefthook/);
  assert.match(output, /No files or hooks were changed/);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init refuses duplicate configuration files for one manager", (t) => {
  for (const [manager, candidates] of [
    ["lefthook", ["lefthook.yml", ".lefthook.yml"]],
    ["pre-commit", [".pre-commit-config.yaml", ".pre-commit-config.yml"]],
  ]) {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    writePackage(tempDir, {
      name: `${manager}-duplicate-config-project`,
      version: "1.0.0",
      type: "module",
    });
    for (const candidate of candidates) {
      writeFile(path.join(tempDir, candidate), "pre-commit: {}\n");
    }
    const packageBefore = readFile(tempDir, "package.json");
    const gitignoreBefore = readFile(tempDir, ".gitignore");

    for (const args of [["--integration"], [`--integration=${manager}`]]) {
      const result = runInit(tempDir, args);
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, `${manager}: ${args.join(" ")}`);
      assert.match(output, /Could not choose .* configuration safely/u);
      for (const candidate of candidates)
        assert.match(output, new RegExp(candidate.replaceAll(".", "\\."), "u"));
      assert.doesNotMatch(output, /coexistence snippets/u);
      assert.match(output, /No files or hooks were changed/u);
      assert.equal(readFile(tempDir, "package.json"), packageBefore);
      assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
      assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
    }
  }
});

test("init rejects one unsupported Lefthook configuration format before writes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "unsupported-lefthook-format",
    version: "1.0.0",
    type: "module",
  });
  const config = '{"pre-commit": {}}\n';
  writeFile(path.join(tempDir, "lefthook.json"), config);
  const packageBefore = readFile(tempDir, "package.json");
  const gitignoreBefore = readFile(tempDir, ".gitignore");

  const result = runInit(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /recognized configuration format is not supported/i);
  assert.match(output, /lefthook\.json/);
  assert.match(output, /use one supported YAML main/i);
  assert.match(output, /No files or hooks were changed/i);
  assert.doesNotMatch(output, /coexistence snippets|lefthook install/i);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
  assert.equal(readFile(tempDir, "lefthook.json"), config);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init automatic integration requires and selects exactly one owner", (t) => {
  const noOwnerDir = createTempRepo();
  const oneOwnerDir = createTempRepo();
  t.after(() => cleanupTempRepo(noOwnerDir));
  t.after(() => cleanupTempRepo(oneOwnerDir));
  writePackage(noOwnerDir, {
    name: "no-manager-project",
    version: "1.0.0",
    type: "module",
  });
  const packageBefore = readFile(noOwnerDir, "package.json");

  const noOwner = runInit(noOwnerDir, ["--integration"]);
  assert.equal(noOwner.status, 1);
  assert.match(
    `${noOwner.stdout}${noOwner.stderr}`,
    /No hook manager could be identified/,
  );
  assert.equal(readFile(noOwnerDir, "package.json"), packageBefore);
  assert.equal(fs.existsSync(gitHook(noOwnerDir, "pre-commit")), false);

  writePackage(oneOwnerDir, {
    name: "one-manager-project",
    version: "1.0.0",
    type: "module",
    devDependencies: { lefthook: "2" },
  });
  const managerConfig = "pre-commit: {}\n";
  writeFile(path.join(oneOwnerDir, "lefthook.yml"), managerConfig);

  const oneOwner = runInit(oneOwnerDir, ["--integration"]);
  assert.equal(oneOwner.status, 0);
  assert.match(`${oneOwner.stdout}${oneOwner.stderr}`, /lefthook coexistence/i);
  assert.equal(
    readPackage(oneOwnerDir).scripts.prepare,
    "commitment-issues doctor --quiet --integration=lefthook",
  );
  assert.equal(readFile(oneOwnerDir, "lefthook.yml"), managerConfig);
  assert.equal(fs.existsSync(gitHook(oneOwnerDir, "pre-commit")), false);
});

test("init prints only missing Lefthook coexistence entries", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "partial-lefthook-project",
    version: "1.0.0",
    type: "module",
    devDependencies: { lefthook: "2" },
  });
  const managerConfig = hookManagerSnippets("lefthook", ["pre-commit"])[0]
    .content;
  writeFile(path.join(tempDir, "lefthook.yml"), managerConfig);

  const result = runInit(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /lefthook coexistence snippets/i);
  assert.match(output, /hook prepush/);
  assert.doesNotMatch(output, /hook precommit/);
  assert.equal(readFile(tempDir, "lefthook.yml"), managerConfig);
});

test("init preserves Lefthook and lint-staged composition", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "lefthook-project",
    version: "1.0.0",
    type: "module",
    "lint-staged": { "*.js": "eslint" },
    devDependencies: { husky: "9", lefthook: "2", "lint-staged": "16" },
    precommitChecks: { commitMessage: { enabled: true } },
  });
  const managerConfig = [
    "pre-commit:",
    "  commands:",
    "    lint-staged:",
    "      run: lint-staged",
    "",
  ].join("\n");
  writeFile(path.join(tempDir, "lefthook.yml"), managerConfig);
  fs.mkdirSync(path.join(tempDir, ".pre-commit-config.yaml"));

  const result = runInit(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /lint-staged was detected and remains unchanged/);
  assert.match(output, /Other hook-manager evidence was also detected: husky/);
  assert.match(output, /possible manager paths could not be safely inspected/);
  assert.match(output, /use_stdin: true/);
  assert.match(output, /commit-msg --git-path/);
  assert.doesNotMatch(output, /\{1\}|\{2\}/);
  assert.equal(readFile(tempDir, "lefthook.yml"), managerConfig);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init replaces its integration suffix without duplicating custom prepare", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "manager-switch-project",
    version: "1.0.0",
    type: "module",
    scripts: {
      prepare:
        "node ./scripts/build-assets.mjs && commitment-issues doctor --quiet --integration=husky",
    },
  });
  writeFile(path.join(tempDir, "lefthook.yml"), "pre-commit: {}\n");

  const result = runInit(tempDir, ["--integration=lefthook"]);

  assert.equal(result.status, 0);
  assert.equal(
    readPackage(tempDir).scripts.prepare,
    "node ./scripts/build-assets.mjs && commitment-issues doctor --quiet --integration=lefthook",
  );

  const pkg = readPackage(tempDir);
  pkg.scripts.prepare = "commitment-issues doctor --quiet --integration=husky";
  writePackage(tempDir, pkg);
  const exactOwned = runInit(tempDir, ["--integration=lefthook"]);
  assert.equal(exactOwned.status, 0);
  assert.equal(
    readPackage(tempDir).scripts.prepare,
    "commitment-issues doctor --quiet --integration=lefthook",
  );
});

test("init reports explicit managers with no active configuration", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runInit(tempDir, ["--integration=pre-commit"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /No active pre-commit configuration was detected/);
  assert.match(output, /effective hooks do not dispatch every active hook/);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init reports inactive Husky ownership without changing its hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "inactive-husky",
    version: "1.0.0",
    type: "module",
    devDependencies: { husky: "9" },
  });
  fs.mkdirSync(path.join(tempDir, ".husky"));
  const hook = `${hookInvocation("pre-commit")}\n`;
  writeFile(path.join(tempDir, ".husky", "pre-commit"), hook);

  const result = runInit(tempDir, ["--integration=husky"]);
  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Husky's hook path is not active in Git/,
  );
  assert.equal(readFile(tempDir, ".husky/pre-commit"), hook);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init withholds setup claims when Husky's effective wrapper is missing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "missing-husky-wrapper",
    version: "1.0.0",
    type: "module",
    devDependencies: { husky: "9" },
  });
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  fs.mkdirSync(path.join(tempDir, ".husky", "_"), { recursive: true });
  writeFile(path.join(tempDir, ".husky", "_", "h"), HUSKY_V9_RUNTIME);
  for (const [name, command] of [
    ["pre-commit", "precommit"],
    ["pre-push", 'prepush "$@"'],
  ]) {
    writeFile(
      path.join(tempDir, ".husky", name),
      `node_modules/.bin/commitment-issues ${command} || exit $?\n`,
    );
  }

  const result = runInit(tempDir, ["--integration=husky"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assertHookClaimsWithheld(output);
  assert.match(output, /effective hooks do not dispatch every active hook/);
  assert.match(output, /Husky install or prepare command/);
  assert.equal(
    fs.existsSync(path.join(tempDir, ".husky", "_", "pre-commit")),
    false,
  );
});

test("init rejects an unsafe Husky manager hook and reports a foreign active path", (t) => {
  const unsafeDir = createTempRepo();
  const inactiveDir = createTempRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "init-husky-manager-"));
  t.after(() => {
    cleanupTempRepo(unsafeDir);
    cleanupTempRepo(inactiveDir);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  for (const tempDir of [unsafeDir, inactiveDir]) {
    writePackage(tempDir, {
      name: "husky-inspection",
      version: "1.0.0",
      type: "module",
      devDependencies: { husky: "9" },
    });
    fs.mkdirSync(path.join(tempDir, ".husky", "_"), { recursive: true });
    writeFile(path.join(tempDir, ".husky", "_", "h"), HUSKY_V9_RUNTIME);
    for (const name of ["pre-commit", "pre-push"]) {
      const wrapper = path.join(tempDir, ".husky", "_", name);
      writeFile(wrapper, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n');
      fs.chmodSync(wrapper, 0o755);
      writeFile(
        path.join(tempDir, ".husky", name),
        `node_modules/.bin/commitment-issues ${name === "pre-commit" ? "precommit" : 'prepush "$@"'} || exit $?\n`,
      );
    }
  }

  run("git", ["config", "core.hooksPath", ".husky/_"], unsafeDir);
  fs.writeFileSync(path.join(outside, "pre-push"), "foreign\n");
  fs.rmSync(path.join(unsafeDir, ".husky", "pre-push"));
  fs.symlinkSync(
    path.join(outside, "pre-push"),
    path.join(unsafeDir, ".husky", "pre-push"),
  );
  const unsafePackage = readFile(unsafeDir, "package.json");
  const unsafeGitignore = readFile(unsafeDir, ".gitignore");
  const unsafeResult = runInit(unsafeDir, ["--integration=husky"]);
  const unsafeOutput = `${unsafeResult.stdout}${unsafeResult.stderr}`;
  assert.equal(unsafeResult.status, 1);
  assert.match(
    unsafeOutput,
    /could not inspect the selected husky configuration safely/i,
  );
  assert.match(unsafeOutput, /no files or hooks were changed/i);
  assert.equal(readFile(unsafeDir, "package.json"), unsafePackage);
  assert.equal(readFile(unsafeDir, ".gitignore"), unsafeGitignore);
  assert.equal(
    fs.readlinkSync(path.join(unsafeDir, ".husky", "pre-push")),
    path.join(outside, "pre-push"),
  );

  run("git", ["config", "core.hooksPath", "custom-hooks"], inactiveDir);
  assert.match(
    `${runInit(inactiveDir, ["--integration=husky"]).stdout}`,
    /core\.hooksPath is set to custom-hooks/,
  );
});

test(
  "init rejects an unsafe Husky owner before changing project files",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "init-husky-root-"));
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    writePackage(tempDir, {
      name: "unsafe-husky-owner",
      version: "1.0.0",
      type: "module",
    });
    writeFile(path.join(outside, "keep"), "outside\n");
    fs.symlinkSync(outside, path.join(tempDir, ".husky"), "dir");
    const packageBefore = readFile(tempDir, "package.json");
    const gitignoreBefore = readFile(tempDir, ".gitignore");

    for (const args of [["--integration=husky"], ["--integration"]]) {
      const result = runInit(tempDir, args);
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1);
      assert.match(output, /could not choose a husky configuration safely/i);
      assert.match(output, /no files or hooks were changed/i);
      assert.doesNotMatch(
        output,
        /install or prepare command|coexistence snippets/i,
      );
      assert.equal(readFile(tempDir, "package.json"), packageBefore);
      assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
      assert.equal(readFile(outside, "keep"), "outside\n");
    }
  },
);

test("init rejects manager overrides and unreadable configs before writes", (t) => {
  const overridden = createTempRepo();
  const unreadable = createTempRepo();
  t.after(() => cleanupTempRepo(overridden));
  t.after(() => cleanupTempRepo(unreadable));

  for (const tempDir of [overridden, unreadable]) {
    writePackage(tempDir, {
      name: "lefthook-preflight",
      version: "1.0.0",
      type: "module",
    });
    writeFile(path.join(tempDir, "lefthook.yml"), "pre-commit: {}\n");
  }

  const overriddenPackage = readFile(overridden, "package.json");
  const overrideResult = runInit(overridden, ["--integration=lefthook"], {
    env: { ...process.env, LEFTHOOK_CONFIG: "custom.toml" },
  });
  const overrideOutput = `${overrideResult.stdout}${overrideResult.stderr}`;
  assert.equal(overrideResult.status, 1);
  assert.match(
    overrideOutput,
    /could not choose a lefthook configuration safely/i,
  );
  assert.doesNotMatch(overrideOutput, /lefthook install|coexistence snippets/i);
  assert.equal(readFile(overridden, "package.json"), overriddenPackage);

  const unreadablePackage = readFile(unreadable, "package.json");
  const preload = fsFailurePreload(unreadable);
  const unreadableResult = run(
    "node",
    [
      "--import",
      preload,
      path.join(unreadable, "scripts", "init.mjs"),
      "--integration=lefthook",
    ],
    unreadable,
    {
      env: {
        ...process.env,
        TEST_FS_FAILURE_METHOD: "readFileSync",
        TEST_FS_FAILURE_PATH: path.join(unreadable, "lefthook.yml"),
      },
    },
  );
  const unreadableOutput = `${unreadableResult.stdout}${unreadableResult.stderr}`;
  assert.equal(unreadableResult.status, 1);
  assert.match(
    unreadableOutput,
    /could not choose a lefthook configuration safely/i,
  );
  assert.doesNotMatch(
    unreadableOutput,
    /lefthook install|coexistence snippets/i,
  );
  assert.equal(readFile(unreadable, "package.json"), unreadablePackage);
});

test("init withholds snippets when manager config changes after preflight", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const repoAlias = aliasedRepoPath(t, tempDir, "init-config-alias-");
  writePackage(tempDir, {
    name: "manager-config-race",
    version: "1.0.0",
    type: "module",
  });
  const configPath = path.join(tempDir, "lefthook.yml");
  writeFile(configPath, "pre-commit: {}\n");
  const preloadPath = path.join(tempDir, "mutate-manager-config-preload.mjs");
  writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "function canonical(filePath) {",
      "  const resolved = path.resolve(filePath);",
      "  try {",
      "    return fs.realpathSync.native(resolved);",
      "  } catch {",
      "    return resolved;",
      "  }",
      "}",
      "const target = canonical(process.env.TEST_MUTATE_CONFIG_PATH);",
      "const originalRead = fs.readFileSync.bind(fs);",
      "const originalWrite = fs.writeFileSync.bind(fs);",
      "let targetReads = 0;",
      "fs.readFileSync = (filePath, ...args) => {",
      "  const content = originalRead(filePath, ...args);",
      "  if (",
      "    canonical(String(filePath)) === target &&",
      "    (targetReads += 1) === 3",
      "  ) {",
      '    originalWrite(target, "min_version: 999.0.0\\npre-commit: {}\\n");',
      "  }",
      "  return content;",
      "};",
      "",
    ].join("\n"),
  );

  const result = run(
    "node",
    [
      "--import",
      pathToFileURL(preloadPath).href,
      path.join(tempDir, "scripts", "init.mjs"),
      "--integration=lefthook",
    ],
    tempDir,
    {
      env: {
        ...process.env,
        TEST_MUTATE_CONFIG_PATH: path.join(repoAlias, "lefthook.yml"),
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /pre-commit: could not be inspected/i);
  assert.match(output, /Review and replace the uninspectable configuration/i);
  assert.doesNotMatch(output, /coexistence snippets|lefthook install/i);
  assert.equal(
    readFile(tempDir, "lefthook.yml"),
    "min_version: 999.0.0\npre-commit: {}\n",
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test(
  "init rejects an uninspectable manager dispatcher before writes",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "init-hooks-path-"));
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    writePackage(tempDir, {
      name: "unsafe-manager-dispatcher",
      version: "1.0.0",
      type: "module",
    });
    writeFile(
      path.join(tempDir, "lefthook.yml"),
      hookManagerSnippets("lefthook", ["pre-commit", "pre-push"])
        .map(({ content }) => content)
        .join(""),
    );
    const hooksDir = path.join(tempDir, ".git", "hooks");
    fs.rmSync(hooksDir, { recursive: true });
    writeFile(path.join(outside, "keep"), "outside\n");
    fs.symlinkSync(outside, hooksDir, "dir");
    const packageBefore = readFile(tempDir, "package.json");
    const gitignoreBefore = readFile(tempDir, ".gitignore");

    const result = runInit(tempDir, ["--integration=lefthook"]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(
      output,
      /could not inspect the selected lefthook dispatcher safely/i,
    );
    assert.match(output, /no files or hooks were changed/i);
    assert.equal(readFile(tempDir, "package.json"), packageBefore);
    assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
    assert.equal(readFile(outside, "keep"), "outside\n");
  },
);

test(
  "init rejects a linked Husky wrapper even when the shared runtime is missing",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "init-husky-link-"));
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    writePackage(tempDir, {
      name: "unsafe-husky-dispatcher",
      version: "1.0.0",
      type: "module",
      scripts: { prepare: "husky" },
      devDependencies: { husky: "^9.0.0" },
    });
    run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
    const hooksDir = path.join(tempDir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });
    writeFile(
      path.join(tempDir, ".husky", "pre-commit"),
      `${hookInvocation("pre-commit")}\n`,
    );
    writeFile(
      path.join(tempDir, ".husky", "pre-push"),
      `${hookInvocation("pre-push")}\n`,
    );
    const wrapper = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
    writeFile(path.join(outside, "pre-commit"), wrapper);
    fs.chmodSync(path.join(outside, "pre-commit"), 0o755);
    fs.symlinkSync(
      path.join(outside, "pre-commit"),
      path.join(hooksDir, "pre-commit"),
    );
    writeFile(path.join(hooksDir, "pre-push"), wrapper);
    fs.chmodSync(path.join(hooksDir, "pre-push"), 0o755);
    const packageBefore = readFile(tempDir, "package.json");
    const gitignoreBefore = readFile(tempDir, ".gitignore");

    const result = runInit(tempDir, ["--integration=husky"]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(
      output,
      /could not inspect the selected husky dispatcher safely/i,
    );
    assert.match(output, /no files or hooks were changed/i);
    assert.equal(readFile(tempDir, "package.json"), packageBefore);
    assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
    assert.equal(
      fs.lstatSync(path.join(hooksDir, "pre-commit")).isSymbolicLink(),
      true,
    );
  },
);

test(
  "init rejects a linked Husky runtime even when effective wrappers are missing",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "init-husky-runtime-"),
    );
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    writePackage(tempDir, {
      name: "unsafe-husky-runtime",
      version: "1.0.0",
      type: "module",
      scripts: { prepare: "husky" },
      devDependencies: { husky: "^9.0.0" },
    });
    run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
    const hooksDir = path.join(tempDir, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });
    writeFile(
      path.join(tempDir, ".husky", "pre-commit"),
      `${hookInvocation("pre-commit")}\n`,
    );
    writeFile(
      path.join(tempDir, ".husky", "pre-push"),
      `${hookInvocation("pre-push")}\n`,
    );
    writeFile(path.join(outside, "h"), "# foreign runtime\n");
    fs.symlinkSync(path.join(outside, "h"), path.join(hooksDir, "h"));
    const packageBefore = readFile(tempDir, "package.json");
    const gitignoreBefore = readFile(tempDir, ".gitignore");

    const result = runInit(tempDir, ["--integration=husky"]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(
      output,
      /could not inspect the selected husky dispatcher safely/i,
    );
    assert.match(output, /no files or hooks were changed/i);
    assert.equal(readFile(tempDir, "package.json"), packageBefore);
    assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
    assert.equal(fs.existsSync(path.join(hooksDir, "pre-commit")), false);
    assert.equal(fs.existsSync(path.join(hooksDir, "pre-push")), false);
  },
);

test("init preserves a foreign manager dispatcher before writes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "foreign-manager-dispatcher",
    version: "1.0.0",
    type: "module",
  });
  writeFile(path.join(tempDir, "lefthook.yml"), "pre-commit: {}\n");
  const wrapper = "#!/bin/sh\necho custom-manager-wrapper\n";
  writeFile(gitHook(tempDir, "pre-commit"), wrapper);
  fs.chmodSync(gitHook(tempDir, "pre-commit"), 0o644);
  const packageBefore = readFile(tempDir, "package.json");
  const gitignoreBefore = readFile(tempDir, ".gitignore");

  const result = runInit(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /dispatcher is customized or unsupported/i);
  assert.match(output, /review .* wrapper manually/i);
  assert.doesNotMatch(output, /lefthook install|coexistence snippets/i);
  assert.match(output, /no files or hooks were changed/i);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), wrapper);
});

test("init rejects unsafe manager config content before writes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "lefthook-content-preflight",
    version: "1.0.0",
    type: "module",
  });
  writeFile(
    path.join(tempDir, "lefthook.yml"),
    "min_version: 999.0.0\npre-commit: {}\n",
  );
  const packageBefore = readFile(tempDir, "package.json");
  const gitignoreBefore = readFile(tempDir, ".gitignore");

  for (const args of [["--integration=lefthook"], ["--integration"]]) {
    const result = runInit(tempDir, args);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /could not inspect.*lefthook configuration safely/is);
    assert.match(output, /no files or hooks were changed/i);
    assert.equal(readFile(tempDir, "package.json"), packageBefore);
    assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
  }
});

test("init validates integration option cardinality before writes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const packageBefore = readFile(tempDir, "package.json");

  const unsupported = runInit(tempDir, ["--integration=unknown"]);
  assert.equal(unsupported.status, 1);
  assert.match(
    `${unsupported.stdout}${unsupported.stderr}`,
    /Unknown init option: --integration=unknown/,
  );
  const duplicate = runInit(tempDir, [
    "--integration=husky",
    "--integration=lefthook",
  ]);
  assert.equal(duplicate.status, 1);
  assert.match(
    `${duplicate.stdout}${duplicate.stderr}`,
    /may be supplied only once/,
  );
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
});

for (const fileName of ["package.json", ".gitignore", ".commitmentrc.json"]) {
  test(`init refuses a linked ${fileName} before changing project or hook state`, (t) => {
    const tempDir = createTempRepo();
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "commitment-outside-project-"),
    );
    t.after(() => {
      cleanupTempRepo(tempDir);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    const packageBefore = readFile(tempDir, "package.json");
    const gitignoreBefore = readFile(tempDir, ".gitignore");
    const outsidePath = path.join(outsideDir, fileName.replace(/^\./, ""));
    const outsideContent =
      fileName === "package.json"
        ? packageBefore
        : fileName === ".gitignore"
          ? "outside-only/\n"
          : "{}\n";
    writeFile(outsidePath, outsideContent);

    const projectPath = path.join(tempDir, fileName);
    fs.rmSync(projectPath, { force: true });
    fs.symlinkSync(outsidePath, projectPath);

    const result = runInit(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.ok(output.includes(`Unsafe project file: ${fileName}.`));
    assert.match(output, /symbolic link/);
    assert.match(output, /No files or hooks were changed/);
    assert.equal(fs.readFileSync(outsidePath, "utf8"), outsideContent);
    assert.equal(fs.lstatSync(projectPath).isSymbolicLink(), true);
    if (fileName !== "package.json") {
      assert.equal(readFile(tempDir, "package.json"), packageBefore);
    }
    if (fileName !== ".gitignore") {
      assert.equal(readFile(tempDir, ".gitignore"), gitignoreBefore);
    }
    assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
    assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
  });
}

test("init dry-run reports a linked project file without mutating it", (t) => {
  const tempDir = createTempRepo();
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "commitment-outside-project-"),
  );
  t.after(() => {
    cleanupTempRepo(tempDir);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const packagePath = path.join(tempDir, "package.json");
  const outsidePath = path.join(outsideDir, "package.json");
  const outsideContent = readFile(tempDir, "package.json");
  writeFile(outsidePath, outsideContent);
  fs.rmSync(packagePath);
  fs.symlinkSync(outsidePath, packagePath);

  const result = runInit(tempDir, ["--dry-run"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unsafe project file: package\.json/);
  assert.match(output, /No files or hooks were changed/);
  assert.equal(fs.readFileSync(outsidePath, "utf8"), outsideContent);
  assert.equal(fs.lstatSync(packagePath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init repairs a partially installed setup on rerun", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  assert.equal(runInit(tempDir).status, 0);
  fs.rmSync(gitHook(tempDir, "pre-push"));

  const repaired = runInit(tempDir);
  const output = `${repaired.stdout}${repaired.stderr}`;

  assert.equal(repaired.status, 0);
  assert.match(output, /Added:/);
  assert.match(output, /\.git\/hooks\/pre-push/);
  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"),
    /commitment-issues prepush "\$@"/,
  );
});

test("init wires commit-msg only for an explicit commitMessage opt-in", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    precommitChecks: {
      commitMessage: { enabled: true, blockOnFailure: false },
    },
  });

  const preview = runInit(tempDir, ["--dry-run"]);
  assert.equal(preview.status, 0);
  assert.match(
    `${preview.stdout}${preview.stderr}`,
    /\.git\/hooks\/commit-msg/,
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /advisory project commitlint feedback/);
  assert.match(
    fs.readFileSync(gitHook(tempDir, "commit-msg"), "utf8"),
    /commitment-issues commit-msg "\$1"/,
  );
  if (process.platform !== "win32") {
    assert.ok(fs.statSync(gitHook(tempDir, "commit-msg")).mode & 0o111);
  }
  assert.deepEqual(readPackage(tempDir).precommitChecks.commitMessage, {
    enabled: true,
    blockOnFailure: false,
  });
});

test("init preserves custom commit-msg hooks and requires safe forwarding", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    precommitChecks: { commitMessage: { enabled: true } },
  });
  writeFile(gitHook(tempDir, "commit-msg"), "echo custom message policy\n");
  fs.chmodSync(gitHook(tempDir, "commit-msg"), 0o755);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Hook wiring needs your attention/);
  assert.match(
    compactTerminalBoxText(output),
    hookSuggestionPattern("commit-msg"),
  );
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "commit-msg"), "utf8"),
    "echo custom message policy\n",
  );

  fs.writeFileSync(
    gitHook(tempDir, "commit-msg"),
    `${hookInvocation("commit-msg")}\necho custom\n`,
  );
  fs.chmodSync(gitHook(tempDir, "commit-msg"), 0o755);
  const safe = runInit(tempDir);
  assert.equal(safe.status, 0);
  assert.match(`${safe.stdout}${safe.stderr}`, /Already configured/);
});

test("init diagnoses invalid nested commitMessage config without wiring it", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    precommitChecks: {
      commitMessage: { enable: true, blockOnFailure: "yes" },
    },
  });

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Configuration needs attention/);
  assert.match(output, /commitMessage\.enable/);
  assert.match(output, /commitMessage\.blockOnFailure/);
  assert.equal(countTerminalBoxes(output), 1);
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);
});

test("init upgrades a legacy 1.x (vendored) setup to the bin", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
    scripts: {
      prepare: "husky",
      "commit:fix": "node scripts/commit-fix.mjs",
      "fix:staged": "node scripts/fix-staged.mjs",
      "test:precommit": "node scripts/precommit-unified.mjs",
      doctor: "node scripts/doctor.mjs",
    },
  });
  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    "node scripts/precommit-unified.mjs\n",
  );
  writeFile(
    path.join(tempDir, ".husky", "pre-push"),
    "node scripts/prepush.mjs\n",
  );

  const result = runInit(tempDir);
  assert.equal(result.status, 0);

  const pkg = readPackage(tempDir);
  assert.equal(pkg.scripts.prepare, "commitment-issues doctor --quiet");
  assert.equal(pkg.scripts["commit:fix"], "commitment-issues commit-fix");
  assert.equal(pkg.scripts.doctor, "commitment-issues doctor");
  assert.equal(pkg.precommitChecks.advisePushTests, true);

  // The vendored-era .husky hook files are ours — cleaned up, replaced by
  // native hooks.
  assert.match(`${result.stdout}${result.stderr}`, /removed legacy \.husky/);
  assert.equal(fs.existsSync(path.join(tempDir, ".husky")), false);
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-commit")));
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-push")));
});

test("init migrates a husky-era 2.x setup to native hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
    scripts: { prepare: "commitment-issues doctor --quiet" },
  });
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  writeFile(path.join(tempDir, ".husky", "_", "h"), "# husky shim\n");
  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    "commitment-issues precommit\n",
  );
  writeFile(
    path.join(tempDir, ".husky", "pre-push"),
    "commitment-issues prepush\n",
  );

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);

  assert.match(output, /retired husky-era core\.hooksPath/);
  assert.match(output, /removed legacy \.husky wiring/);
  assert.equal(hooksPath(tempDir), "");
  assert.equal(fs.existsSync(path.join(tempDir, ".husky")), false);
  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    /commitment-issues precommit/,
  );
  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"),
    /commitment-issues prepush/,
  );
});

test("init keeps user-authored .husky hooks and warns they no longer run", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  writeFile(path.join(tempDir, ".husky", "_", "h"), "# husky shim\n");
  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    "commitment-issues precommit\n",
  );
  writeFile(
    path.join(tempDir, ".husky", "commit-msg"),
    "echo custom message check\n",
  );

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);

  // Our exact-match wiring is cleaned up; the user's hook is preserved and
  // reported as stranded.
  assert.equal(
    fs.existsSync(path.join(tempDir, ".husky", "pre-commit")),
    false,
  );
  assert.equal(
    readFile(tempDir, ".husky/commit-msg"),
    "echo custom message check\n",
  );
  assert.match(output, /Hook wiring needs your attention/);
  assert.match(output, /\.husky\/commit-msg/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("init warns and keeps .husky when the hooksPath unset fails", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  writeFile(path.join(tempDir, ".husky", "_", "h"), "# husky shim\n");
  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    "commitment-issues precommit\n",
  );

  // `git config --unset` fails, so git keeps running hooks from `.husky/_`.
  const env = fakeGitEnv(tempDir, "config --unset");
  const result = runInit(tempDir, [], { env });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);

  assert.match(output, /Hook wiring needs your attention/);
  assert.match(output, /core\.hooksPath is still set/);
  assertHookClaimsWithheld(output);
  // The wiring git still runs must not be deleted out from under it.
  assert.ok(fs.existsSync(path.join(tempDir, ".husky", "pre-commit")));
  assert.ok(fs.existsSync(path.join(tempDir, ".husky", "_")));
  assert.doesNotMatch(output, /removed legacy \.husky wiring/);
});

test("init preserves explicit push blocking config", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
    precommitChecks: {
      blockPushOnTestFailure: true,
    },
  });

  const result = runInit(tempDir);
  assert.equal(result.status, 0);

  const pkg = readPackage(tempDir);
  assert.equal(pkg.precommitChecks.blockPushOnTestFailure, true);
  assert.equal("advisePushTests" in pkg.precommitChecks, false);
});

test("init uses an existing standalone file as the configuration target", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    '{\n  "tone": "fun"\n}\n',
  );

  const preview = runInit(tempDir, ["--dry-run"]);
  assert.equal(preview.status, 0);
  assert.match(
    `${preview.stdout}${preview.stderr}`,
    /pre-push advisory config \(\.commitmentrc\.json\)/,
  );
  assert.deepEqual(JSON.parse(readFile(tempDir, ".commitmentrc.json")), {
    tone: "fun",
  });
  assert.equal("precommitChecks" in readPackage(tempDir), false);

  const result = runInit(tempDir);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(readFile(tempDir, ".commitmentrc.json")), {
    tone: "fun",
    advisePushTests: true,
  });
  assert.equal("precommitChecks" in readPackage(tempDir), false);
});

test("init wires commit-msg from standalone config in dry-run and normal modes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    `${JSON.stringify(
      {
        commitMessage: { enabled: true, blockOnFailure: true },
      },
      null,
      2,
    )}\n`,
  );

  const preview = runInit(tempDir, ["--dry-run"]);
  const previewOutput = `${preview.stdout}${preview.stderr}`;
  assert.equal(preview.status, 0);
  assert.match(previewOutput, /\.git\/hooks\/commit-msg/);
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);
  assert.equal("precommitChecks" in readPackage(tempDir), false);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(
    output,
    /Commit messages must pass your project commitlint rules/,
  );
  assert.match(
    fs.readFileSync(gitHook(tempDir, "commit-msg"), "utf8"),
    /commitment-issues commit-msg "\$1"/,
  );
  assert.deepEqual(JSON.parse(readFile(tempDir, ".commitmentrc.json")), {
    commitMessage: { enabled: true, blockOnFailure: true },
    advisePushTests: true,
  });
  assert.equal("precommitChecks" in readPackage(tempDir), false);

  const repeated = runInit(tempDir);
  assert.equal(repeated.status, 0);
  assert.match(`${repeated.stdout}${repeated.stderr}`, /Already configured/);
});

test("standalone commitMessage values override package hook wiring", (t) => {
  const disabledDir = createTempRepo();
  const invalidDir = createTempRepo();
  t.after(() => cleanupTempRepo(disabledDir));
  t.after(() => cleanupTempRepo(invalidDir));

  for (const tempDir of [disabledDir, invalidDir]) {
    writePackage(tempDir, {
      name: "x",
      version: "1.0.0",
      precommitChecks: {
        tone: "standard",
        commitMessage: { enabled: true, blockOnFailure: true },
      },
    });
  }

  writeFile(
    path.join(disabledDir, ".commitmentrc.json"),
    '{\n  "commitMessage": { "enabled": false }\n}\n',
  );
  const disabled = runInit(disabledDir);
  assert.equal(disabled.status, 0);
  assert.equal(fs.existsSync(gitHook(disabledDir, "commit-msg")), false);
  assert.doesNotMatch(
    `${disabled.stdout}${disabled.stderr}`,
    /project commitlint/,
  );

  writeFile(
    path.join(invalidDir, ".commitmentrc.json"),
    '{\n  "advisePushTests": "yes",\n  "commitMessage": { "enabled": "yes" }\n}\n',
  );
  const invalid = runInit(invalidDir);
  const invalidOutput = `${invalid.stdout}${invalid.stderr}`;
  const compactInvalidOutput = compactTerminalBoxText(invalidOutput);
  assert.equal(invalid.status, 0);
  assert.equal(fs.existsSync(gitHook(invalidDir, "commit-msg")), false);
  assert.match(compactInvalidOutput, /advisePushTests must be a boolean/);
  assert.match(
    compactInvalidOutput,
    /commitMessage\.enabled must be a\s*boolean/,
  );
  assert.match(compactInvalidOutput, /\.commitmentrc\.json/);
  assert.deepEqual(JSON.parse(readFile(invalidDir, ".commitmentrc.json")), {
    advisePushTests: "yes",
    commitMessage: { enabled: "yes" },
  });
});

test("init respects an effective package blocking mode with a standalone file", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    precommitChecks: { blockPushOnTestFailure: true },
  });
  writeFile(path.join(tempDir, ".commitmentrc.json"), "{}\n");

  const result = runInit(tempDir);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(readFile(tempDir, ".commitmentrc.json")), {});
  assert.deepEqual(readPackage(tempDir).precommitChecks, {
    blockPushOnTestFailure: true,
  });
});

test("init rejects malformed standalone config before writing anything", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0" });
  writeFile(path.join(tempDir, ".commitmentrc.json"), "{ invalid\n");
  const beforePackage = readFile(tempDir, "package.json");
  const beforeGitignore = readFile(tempDir, ".gitignore");

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Invalid \.commitmentrc\.json/);
  assert.match(output, /contains invalid JSON/);
  assert.match(output, /No files were changed/);
  assert.equal(readFile(tempDir, "package.json"), beforePackage);
  assert.equal(readFile(tempDir, ".gitignore"), beforeGitignore);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init preserves an unrelated prepare and appends repair", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
    scripts: {
      prepare: "node ./scripts/build-assets.mjs",
    },
  });

  const preview = runInit(tempDir, ["--dry-run"]);
  assert.equal(preview.status, 0);
  assert.match(`${preview.stdout}${preview.stderr}`, /- script prepare repair/);
  assert.equal(
    readPackage(tempDir).scripts.prepare,
    "node ./scripts/build-assets.mjs",
  );

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);

  const pkg = readPackage(tempDir);
  assert.equal(
    pkg.scripts.prepare,
    "node ./scripts/build-assets.mjs && commitment-issues doctor --quiet",
  );
  assert.equal(pkg.scripts.doctor, "commitment-issues doctor");
  assert.match(output, /- script prepare repair/);

  const second = runInit(tempDir);
  assert.equal(second.status, 0);
  assert.match(`${second.stdout}${second.stderr}`, /Already configured/);
});

test("init preserves postprepare while composing repair into prepare", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
    scripts: {
      prepare: "node ./scripts/build-assets.mjs",
      postprepare: "node ./scripts/announce-build.mjs",
    },
  });

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  const pkg = readPackage(tempDir);
  assert.equal(
    pkg.scripts.prepare,
    "node ./scripts/build-assets.mjs && commitment-issues doctor --quiet",
  );
  assert.equal(pkg.scripts.postprepare, "node ./scripts/announce-build.mjs");
  assert.match(output, /- script prepare repair/);
});

test("init leaves an existing lint-staged config exactly as the user wrote it", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A user may keep running lint-staged themselves; init neither adopts nor
  // edits their config.
  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    type: "module",
    "lint-staged": {
      "*.md": ["prettier --check"],
    },
  });

  const result = runInit(tempDir);
  assert.equal(result.status, 0);

  const pkg = readPackage(tempDir);
  assert.deepEqual(pkg["lint-staged"], { "*.md": ["prettier --check"] });
  assert.equal(pkg.scripts["fix:staged"], "commitment-issues fix-staged");
});

test("init leaves customized hooks untouched", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  fs.mkdirSync(path.join(tempDir, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(gitHook(tempDir, "pre-commit"), "echo custom commit\n");
  fs.writeFileSync(gitHook(tempDir, "pre-push"), "echo custom push\n");
  fs.chmodSync(gitHook(tempDir, "pre-commit"), 0o755);
  fs.chmodSync(gitHook(tempDir, "pre-push"), 0o755);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  // Existing hook bodies are the user's — never clobbered.
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    "echo custom commit\n",
  );
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"),
    "echo custom push\n",
  );
  assertHookClaimsWithheld(output);
  assert.match(output, /Existing git hooks were left unchanged/);
  const compactOutput = compactTerminalBoxText(output);
  assert.match(compactOutput, hookSuggestionPattern("pre-commit"));
  assert.match(compactOutput, hookSuggestionPattern("pre-push"));
  assert.equal(countTerminalBoxes(output), 1);
});

test("init accepts customized hooks that invoke commitment-issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  fs.mkdirSync(path.join(tempDir, ".git", "hooks"), { recursive: true });
  const preCommit = `#!/bin/sh\n${hookInvocation("pre-commit")}\necho custom commit\n`;
  const prePush = `#!/bin/sh\n${hookInvocation("pre-push")}\necho custom push\n`;
  fs.writeFileSync(gitHook(tempDir, "pre-commit"), preCommit);
  fs.writeFileSync(gitHook(tempDir, "pre-push"), prePush);
  fs.chmodSync(gitHook(tempDir, "pre-commit"), 0o755);
  fs.chmodSync(gitHook(tempDir, "pre-push"), 0o755);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Commitment Issues is set up/);
  assert.match(output, /Your next commit runs advisory checks/);
  assert.match(output, /Your next push runs advisory tests/);
  assert.doesNotMatch(output, /Hook wiring needs your attention/);
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    preCommit,
  );
  assert.equal(fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"), prePush);
});

test("init reports customized hooks that still use unguarded or direct commands", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  const preCommit =
    "#!/bin/sh\nnode_modules/.bin/commitment-issues precommit || exit $?\necho custom commit\n";
  const prePush =
    '#!/bin/sh\nnode_modules/.bin/commitment-issues hook prepush "$@" || exit $?\necho custom push\n';
  fs.writeFileSync(gitHook(tempDir, "pre-commit"), preCommit);
  fs.writeFileSync(gitHook(tempDir, "pre-push"), prePush);
  fs.chmodSync(gitHook(tempDir, "pre-commit"), 0o755);
  fs.chmodSync(gitHook(tempDir, "pre-push"), 0o755);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assertHookClaimsWithheld(output);
  const compactOutput = compactTerminalBoxText(output);
  assert.match(
    compactOutput,
    /unguarded or direct commands outside the current\s*managed\s*hook contract/,
  );
  assert.match(compactOutput, hookSuggestionPattern("pre-commit"));
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    preCommit,
  );
  assert.equal(fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"), prePush);
});

test("init distinguishes configured package settings from inactive hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const first = runInit(tempDir);
  assert.equal(first.status, 0);
  fs.writeFileSync(gitHook(tempDir, "pre-push"), "#!/bin/sh\necho custom\n");
  fs.chmodSync(gitHook(tempDir, "pre-push"), 0o755);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(
    output,
    /Package settings are configured; hook wiring still needs attention/,
  );
  assertHookClaimsWithheld(output);
});

test("init refreshes the exact path-fallback generated pre-push hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  runInit(tempDir);
  const hookPath = gitHook(tempDir, "pre-push");
  const current = fs.readFileSync(hookPath, "utf8");
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh
# Installed by commitment-issues. Recreate anytime with: commitment-issues doctor
if [ "$COMMITMENT_ISSUES" = "0" ] || [ "$HUSKY" = "0" ]; then
  exit 0
fi
export PATH="node_modules/.bin:$PATH"
if ! command -v commitment-issues >/dev/null 2>&1; then
  echo "commitment-issues: command not found; skipping pre-push checks." >&2
  exit 0
fi
commitment-issues prepush
`,
  );

  const result = runInit(tempDir);

  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /updated \.git\/hooks\/pre-push/,
  );
  assert.equal(fs.readFileSync(hookPath, "utf8"), current);
});

test("init warns about a foreign core.hooksPath and leaves it alone", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  fs.mkdirSync(path.join(tempDir, "githooks"), { recursive: true });
  run("git", ["config", "core.hooksPath", "githooks"], tempDir);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);

  assert.match(output, /Hook wiring needs your attention/);
  assert.match(output, /core\.hooksPath is set to githooks/);
  assertHookClaimsWithheld(output);
  assert.equal(countTerminalBoxes(output), 1);
  // The user's configuration is untouched and no shadowed hooks are written.
  assert.equal(hooksPath(tempDir), "githooks");
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("init preserves a configured empty hooksPath instead of writing shadowed hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  const set = run("git", ["config", "core.hooksPath", ""], tempDir);
  assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /core\.hooksPath is set to ""/);
  assertHookClaimsWithheld(output);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "pre-commit")), false);
  assert.equal(
    run("git", ["config", "--get", "core.hooksPath"], tempDir).status,
    0,
  );
});

test("init withholds hook claims when core.hooksPath cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  const env = fakeGitEnv(tempDir, "--get core.hooksPath", 128);
  const result = runInit(tempDir, [], { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not determine core\.hooksPath/i);
  assertHookClaimsWithheld(output);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init withholds manager activation when core.hooksPath cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const config = "pre-commit: {}\n";
  writeFile(path.join(tempDir, "lefthook.yml"), config);

  const env = fakeGitEnv(tempDir, "--get core.hooksPath", 128);
  const result = runInit(tempDir, ["--integration=lefthook"], { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not determine core\.hooksPath/i);
  assert.match(output, /manager activation could not/i);
  assert.match(output, /be verified/i);
  assert.doesNotMatch(output, /lefthook install/i);
  assertHookClaimsWithheld(output);
  assert.equal(readFile(tempDir, "lefthook.yml"), config);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init reports an unresolved common hooks directory without crashing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  const env = fakeGitEnv(tempDir, "rev-parse --git-common-dir", 128);
  const result = runInit(tempDir, [], { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not locate the git hooks directory/i);
  assertHookClaimsWithheld(output);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("init preserves an uninspectable hook path and reports manual repair", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  fs.mkdirSync(gitHook(tempDir, "pre-commit"), { recursive: true });

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not be inspected/i);
  assertHookClaimsWithheld(output);
  assert.equal(fs.statSync(gitHook(tempDir, "pre-commit")).isDirectory(), true);
});

for (const fileName of ["package.json", ".commitmentrc.json", ".gitignore"]) {
  test(`init keeps ${fileName} complete when its staged write fails`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    writePackage(tempDir, {
      name: "project-write-failure",
      version: "1.0.0",
      type: "module",
    });
    if (fileName === ".commitmentrc.json") {
      writeFile(path.join(tempDir, fileName), "{}\n");
    }
    const projectPath = path.join(tempDir, fileName);
    const projectBefore = fs.readFileSync(projectPath, "utf8");
    const customHook = gitHook(tempDir, "pre-commit");
    const customHookBefore = "#!/bin/sh\necho custom\n";
    writeFile(customHook, customHookBefore);
    const preload = mutableProjectFileFailurePreload(tempDir);

    const result = run(
      "node",
      ["--import", preload, path.join(tempDir, "scripts", "init.mjs")],
      tempDir,
      {
        env: {
          ...process.env,
          TEST_FS_FAILURE_METHOD: "writeSync",
          TEST_FS_FAILURE_PATH: projectPath,
          TEST_FS_FAILURE_CODE: "ENOSPC",
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /Could not update the project files/i);
    assert.match(
      output,
      /filesystem write failed before hook installation began/i,
    );
    assert.doesNotMatch(output, /node:fs|ENOSPC|\s+at .*init\.mjs/);
    assert.equal(fs.readFileSync(projectPath, "utf8"), projectBefore);
    assert.doesNotThrow(() => JSON.parse(readFile(tempDir, "package.json")));
    if (fs.existsSync(path.join(tempDir, ".commitmentrc.json"))) {
      assert.doesNotThrow(() =>
        JSON.parse(readFile(tempDir, ".commitmentrc.json")),
      );
    }
    assert.equal(fs.readFileSync(customHook, "utf8"), customHookBefore);
    assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
    assert.deepEqual(
      fs
        .readdirSync(tempDir)
        .filter(
          (entry) =>
            entry.includes(".commitment-issues-") && entry.endsWith(".tmp"),
        ),
      [],
    );

    assert.equal(runInit(tempDir).status, 0);
    assert.doesNotThrow(() => JSON.parse(readFile(tempDir, "package.json")));
    assert.equal(fs.readFileSync(customHook, "utf8"), customHookBefore);
  });
}

test("init reports hook write failures without a raw exception", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const repoAlias = aliasedRepoPath(t, tempDir, "init-write-alias-");

  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });
  const preload = fsFailurePreload(tempDir);
  const result = run(
    "node",
    ["--import", preload, path.join(tempDir, "scripts", "init.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        TEST_FS_FAILURE_METHOD: "writeFileSync",
        TEST_FS_FAILURE_PATH: path.join(
          repoAlias,
          ".git",
          "hooks",
          "pre-commit",
        ),
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /hook files could not be written/i);
  assertHookClaimsWithheld(output);
  assert.doesNotMatch(output, /node:fs|EEXIST|ENOTDIR/);
});

test("init never claims local commit hooks are active in a bare repository", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-bare-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(run("git", ["init", "--bare"], dir).status, 0);
  writePackage(dir, { name: "x", version: "1.0.0", type: "module" });

  const result = run("node", [path.join(repoRoot, "scripts", "init.mjs")], dir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /bare git repository/i);
  assertHookClaimsWithheld(output);
  assert.equal(fs.existsSync(path.join(dir, "hooks", "pre-commit")), false);
  assert.equal(fs.existsSync(path.join(dir, "hooks", "pre-push")), false);
});

test("init warns when run outside a git repository", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-nongit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "x", version: "1.0.0" }, null, 2)}\n`,
  );

  const result = run("node", [path.join(repoRoot, "scripts", "init.mjs")], dir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /not a git repository/);
  assertHookClaimsWithheld(output);
  // Scripts and config are still written so a later `git init` + doctor works.
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json")));
  assert.equal(pkg.scripts.doctor, "commitment-issues doctor");
});

test("init errors and exits when there is no package.json", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "init-nopkg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Run the real script (resolves its own lib/ imports) from a dir with no
  // package.json to hit the early "run this from your project root" guard.
  const result = run("node", [path.join(repoRoot, "scripts", "init.mjs")], dir);

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /No package\.json found/);
});

test("init errors clearly when package.json is invalid JSON", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "package.json"), "{ invalid json\n");

  const result = runInit(tempDir);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /Invalid package\.json/);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Fix package\.json so it contains valid JSON/,
  );
});

const invalidContainerShapes = [
  ["null", null],
  ["a string", "unexpected-string"],
  ["a number", 42],
  ["a boolean", true],
  ["an array", []],
];

for (const [description, value] of invalidContainerShapes) {
  test(`init rejects ${description} as the package.json root without writing`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    writePackage(tempDir, value);
    const before = readFile(tempDir, "package.json");
    const result = runInit(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /Invalid package\.json structure/);
    assert.match(output, /root value/);
    assert.match(output, /No files were changed/);
    assert.doesNotMatch(output, /TypeError|\s+at .*init\.mjs/);
    assert.equal(readFile(tempDir, "package.json"), before);
  });
}

for (const property of ["scripts", "precommitChecks"]) {
  for (const [description, value] of invalidContainerShapes) {
    test(`init rejects ${description} as package.json ${property} without writing`, (t) => {
      const tempDir = createTempRepo();
      t.after(() => cleanupTempRepo(tempDir));

      writePackage(tempDir, {
        name: "x",
        version: "1.0.0",
        [property]: value,
      });
      const before = readFile(tempDir, "package.json");
      const result = runInit(tempDir);
      const output = `${result.stdout}${result.stderr}`;

      assert.equal(result.status, 1);
      assert.match(output, /Invalid package\.json structure/);
      assert.match(output, new RegExp(`property .*${property}`));
      assert.match(output, /No files were changed/);
      assert.doesNotMatch(output, /TypeError|\s+at .*init\.mjs/);
      assert.equal(readFile(tempDir, "package.json"), before);
    });
  }
}

test("init accepts empty scripts and precommitChecks objects", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    scripts: {},
    precommitChecks: {},
  });

  const result = runInit(tempDir);
  assert.equal(result.status, 0);
  const pkg = readPackage(tempDir);
  assert.equal(pkg.scripts.prepare, "commitment-issues doctor --quiet");
  assert.equal(pkg.precommitChecks.advisePushTests, true);
});

test("init rejects inert command mentions in executable custom hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "x", version: "1.0.0" });
  const bodies = {
    "pre-commit": "#!/bin/sh\n# commitment-issues precommit\n",
    "pre-push": "#!/bin/sh\nprintf '%s\\n' 'commitment-issues prepush'\n",
  };
  for (const [name, body] of Object.entries(bodies)) {
    fs.writeFileSync(gitHook(tempDir, name), body);
    fs.chmodSync(gitHook(tempDir, name), 0o755);
  }

  const result = runInit(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assertHookClaimsWithheld(output);
  const compactOutput = compactTerminalBoxText(output);
  assert.match(compactOutput, hookSuggestionPattern("pre-commit"));
  assert.match(compactOutput, hookSuggestionPattern("pre-push"));
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(fs.readFileSync(gitHook(tempDir, name), "utf8"), body);
  }
});

test(
  "init reports a non-executable custom hook without changing it",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    writePackage(tempDir, { name: "x", version: "1.0.0" });
    const body = "#!/bin/sh\ncommitment-issues precommit\n";
    fs.writeFileSync(gitHook(tempDir, "pre-commit"), body);
    fs.chmodSync(gitHook(tempDir, "pre-commit"), 0o644);

    const result = runInit(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assertHookClaimsWithheld(output);
    assert.match(output, /not executable/);
    assert.match(output, /chmod \+x \.git\/hooks\/pre-commit/);
    assert.equal(fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"), body);
    assert.equal(fs.statSync(gitHook(tempDir, "pre-commit")).mode & 0o111, 0);
  },
);

test("init creates a .gitignore when none exists", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  fs.rmSync(path.join(tempDir, ".gitignore"), { force: true });
  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });

  const result = runInit(tempDir);
  assert.equal(result.status, 0);
  assert.match(readFile(tempDir, ".gitignore"), /\.eslintcache/);
});

test("init appends caches to a .gitignore with no trailing newline", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, ".gitignore"), "dist");
  writePackage(tempDir, { name: "x", version: "1.0.0", type: "module" });

  const result = runInit(tempDir);
  assert.equal(result.status, 0);
  assert.match(readFile(tempDir, ".gitignore"), /dist\n\.eslintcache/);
});

test("init --dry-run previews changes without writing files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "x",
    version: "1.0.0",
    private: true,
    type: "module",
  });

  const beforePackage = readPackage(tempDir);
  fs.rmSync(path.join(tempDir, ".gitignore"), { force: true });
  // A husky-era setup that a real run would migrate.
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  writeFile(path.join(tempDir, ".husky", "_", "h"), "# husky shim\n");
  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    "commitment-issues precommit\n",
  );

  const result = runInit(tempDir, ["--dry-run"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /dry run preview/i);
  assert.match(output, /Would add:/);
  // The preview must cover everything a real run would change, including the
  // hook files, migration steps, and .gitignore defaults that are only
  // written outside dry-run.
  assert.match(output, /\.git\/hooks\/pre-commit/);
  assert.match(output, /\.git\/hooks\/pre-push/);
  assert.match(output, /retired husky-era core\.hooksPath/);
  assert.match(output, /removed legacy \.husky wiring/);
  assert.match(output, /\.gitignore defaults/);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(hooksPath(tempDir), ".husky/_");
  assert.ok(fs.existsSync(path.join(tempDir, ".husky", "pre-commit")));
  assert.equal(fs.existsSync(path.join(tempDir, ".gitignore")), false);
  assert.deepEqual(readPackage(tempDir), beforePackage);
});

test(
  "init preserves a symbolic-link .husky directory and its external target",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "init-husky-link-"));
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

    fs.mkdirSync(path.join(outside, "_"));
    fs.writeFileSync(path.join(outside, "_", "keep"), "outside\n");
    fs.writeFileSync(
      path.join(outside, "pre-commit"),
      "commitment-issues precommit\n",
    );
    fs.symlinkSync(outside, path.join(tempDir, ".husky"), "dir");
    run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);

    const result = runInit(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /symbolic link|could not be safely inspected/i);
    assert.match(output, /left unchanged|manual/i);
    assert.equal(
      fs.readFileSync(path.join(outside, "_", "keep"), "utf8"),
      "outside\n",
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "pre-commit"), "utf8"),
      "commitment-issues precommit\n",
    );
  },
);
