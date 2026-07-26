// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compactTerminalBoxText,
  countTerminalBoxes,
  stripAnsi,
} from "./helpers/output.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  fsFailurePreload,
  readFile,
  repoRoot,
  run,
  setPrecommitConfig,
  writeCrossPlatformShim,
  writeFile,
} from "./helpers/temp-repo.mjs";
import {
  HUSKY_V9_RUNTIME,
  lefthookRunner,
  preCommitRunner,
} from "./helpers/hook-manager-fixtures.mjs";
import {
  hookInvocation,
  hookManagerSnippets,
  prepareRepairCommand,
} from "../scripts/lib/hooks.mjs";

function runDoctor(tempDir, args = [], options = {}) {
  return run(
    "node",
    [path.join(tempDir, "scripts", "doctor.mjs"), ...args],
    tempDir,
    options,
  );
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

function isolatedManagerBinDir(tempDir) {
  const nodeModules = path.join(tempDir, "node_modules");
  if (fs.lstatSync(nodeModules).isSymbolicLink()) {
    fs.unlinkSync(nodeModules);
  }
  fs.mkdirSync(nodeModules, { recursive: true });
  for (const packageName of ["eslint", "prettier"]) {
    const source = path.join(repoRoot, "node_modules", packageName);
    const destination = path.join(nodeModules, packageName);
    fs.symlinkSync(
      source,
      destination,
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  const binDir = path.join(nodeModules, ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  return binDir;
}

test("doctor rejects unknown options before repairing hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runDoctor(tempDir, ["--quite"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unknown doctor option: --quite/);
  assert.match(output, /No hooks were changed/);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("doctor refuses a repository descendant before repairing hooks", (t) => {
  const tempDir = createTempRepo();
  const descendant = path.join(tempDir, "src");
  t.after(() => cleanupTempRepo(tempDir));

  const result = run(
    "node",
    [path.join(tempDir, "scripts", "doctor.mjs")],
    descendant,
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /Project root required/);
  assert.match(output, /Doctor only inspects and repairs from a worktree root/);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

function managerFixture(tempDir, manager) {
  if (manager === "husky") {
    run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
    fs.mkdirSync(path.join(tempDir, ".husky", "_"), { recursive: true });
    const files = {
      ".husky/_/h": HUSKY_V9_RUNTIME,
      ".husky/_/pre-commit": '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
      ".husky/_/pre-push": '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
      ".husky/pre-commit": `${hookInvocation("pre-commit")}\necho custom\n`,
      ".husky/pre-push": `${hookInvocation("pre-push")}\necho still-custom\n`,
    };
    for (const [filePath, content] of Object.entries(files)) {
      writeFile(path.join(tempDir, filePath), content);
      if (filePath.startsWith(".husky/_/") && filePath !== ".husky/_/h") {
        fs.chmodSync(path.join(tempDir, filePath), 0o755);
      }
    }
    return files;
  }
  if (manager === "lefthook") {
    const content = hookManagerSnippets("lefthook", ["pre-commit", "pre-push"])
      .map(({ content: snippet }) => snippet)
      .join("")
      .replace(
        "  commands:\n",
        "  commands:\n    existing:\n      run: echo existing\n",
      );
    writeFile(path.join(tempDir, "lefthook.yml"), content);
    const binDir = isolatedManagerBinDir(tempDir);
    writeCrossPlatformShim(
      binDir,
      process.platform === "win32" ? "lefthook.exe" : "lefthook",
      'process.exit(process.argv[2] === "-h" ? 0 : 17);\n',
    );
    const files = { "lefthook.yml": content };
    for (const name of ["pre-commit", "pre-push"]) {
      const runner = lefthookRunner(name);
      const relativePath = `.git/hooks/${name}`;
      writeFile(path.join(tempDir, relativePath), runner);
      fs.chmodSync(path.join(tempDir, relativePath), 0o755);
      files[relativePath] = runner;
    }
    return files;
  }
  const content = [
    "repos:",
    "  - repo: local",
    "    hooks:",
    "      - id: existing-hook",
    "        name: existing hook",
    "        entry: echo existing",
    "        language: system",
    ...hookManagerSnippets("pre-commit", ["pre-commit", "pre-push"])
      .map(({ content: snippet }) => snippet.trimEnd().split("\n"))
      .flat(),
    "",
  ].join("\n");
  writeFile(path.join(tempDir, ".pre-commit-config.yaml"), content);
  const binDir = isolatedManagerBinDir(tempDir);
  writeCrossPlatformShim(binDir, "python3", "process.exit(0);\n");
  const files = { ".pre-commit-config.yaml": content };
  for (const name of ["pre-commit", "pre-push"]) {
    const runner = preCommitRunner(name, {
      installPython: "node_modules/.bin/python3",
    });
    const relativePath = `.git/hooks/${name}`;
    writeFile(path.join(tempDir, relativePath), runner);
    fs.chmodSync(path.join(tempDir, relativePath), 0o755);
    files[relativePath] = runner;
  }
  return files;
}

for (const manager of ["husky", "lefthook", "pre-commit"]) {
  test(`doctor verifies healthy ${manager} coexistence without mutation`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const managerFiles = managerFixture(tempDir, manager);

    const result = runDoctor(tempDir, [`--integration=${manager}`]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, new RegExp(`${manager} integration is healthy`, "i"));
    assert.match(output, /Manager-owned files were inspected but not changed/);
    for (const [filePath, content] of Object.entries(managerFiles)) {
      assert.equal(
        fs.readFileSync(path.join(tempDir, filePath), "utf8"),
        content,
      );
    }
    assert.equal(
      fs.existsSync(gitHook(tempDir, "pre-commit")),
      manager !== "husky",
    );

    const quiet = runDoctor(tempDir, ["--quiet", `--integration=${manager}`]);
    assert.equal(quiet.status, 0);
    assert.equal(`${quiet.stdout}${quiet.stderr}`.trim(), "");
  });
}

test("doctor recognizes healthy Husky v8 direct hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  run("git", ["config", "core.hooksPath", ".husky"], tempDir);
  const hooksDir = path.join(tempDir, ".husky");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hooks = {
    "pre-commit": `#!/usr/bin/env sh\n${hookInvocation("pre-commit")}\n`,
    "pre-push": `#!/usr/bin/env sh\n${hookInvocation("pre-push")}\n`,
  };
  for (const [name, content] of Object.entries(hooks)) {
    writeFile(path.join(hooksDir, name), content);
    fs.chmodSync(path.join(hooksDir, name), 0o755);
  }

  const result = runDoctor(tempDir, ["--integration=husky"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /husky integration is healthy/i);
  assert.doesNotMatch(output, /missing-runtime|install or prepare command/i);
  for (const [name, content] of Object.entries(hooks)) {
    assert.equal(readFile(tempDir, `.husky/${name}`), content);
  }
});

test("doctor reports coexistence advisories without changing a healthy manager", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const managerFiles = managerFixture(tempDir, "lefthook");
  fs.mkdirSync(path.join(tempDir, ".husky"));
  writeFile(path.join(tempDir, ".lintstagedrc"), '{"*.js":"eslint"}\n');
  fs.mkdirSync(path.join(tempDir, ".pre-commit-config.yaml"));

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Multiple hook-manager owners were detected/);
  assert.match(output, /Also detected: husky/);
  assert.match(output, /lint-staged composition was detected/);
  assert.match(output, /Some manager paths need manual review/);
  for (const [filePath, content] of Object.entries(managerFiles)) {
    assert.equal(
      fs.readFileSync(path.join(tempDir, filePath), "utf8"),
      content,
    );
  }
  assert.equal(readFile(tempDir, ".lintstagedrc"), '{"*.js":"eslint"}\n');
  assert.equal(
    fs.statSync(path.join(tempDir, ".pre-commit-config.yaml")).isDirectory(),
    true,
  );
});

test("doctor distinguishes configured manager entries from installed wrappers", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const files = managerFixture(tempDir, "lefthook");
  fs.rmSync(gitHook(tempDir, "pre-push"));

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /effective hooks do not dispatch to lefthook: pre-push/);
  assert.match(output, /lefthook install/);
  assert.doesNotMatch(output, /Merge the missing entries/);
  assert.equal(
    fs.readFileSync(path.join(tempDir, "lefthook.yml"), "utf8"),
    files["lefthook.yml"],
  );

  const quiet = runDoctor(tempDir, ["--quiet", "--integration=lefthook"]);
  assert.equal(quiet.status, 0);
  assert.match(`${quiet.stdout}${quiet.stderr}`, /integration is incomplete/);
});

test("doctor preserves foreign manager wrappers for manual review", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "lefthook");
  const wrapper = "#!/bin/sh\necho custom-manager-wrapper\n";
  writeFile(gitHook(tempDir, "pre-push"), wrapper);
  fs.chmodSync(gitHook(tempDir, "pre-push"), 0o755);

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;
  const compactOutput = compactTerminalBoxText(output);

  assert.equal(result.status, 1);
  assert.match(
    compactOutput,
    /wrappers are customized or unsupported:\s*pre-push/i,
  );
  assert.match(compactOutput, /review .* wrappers manually/i);
  assert.match(compactOutput, /do not run a manager install command/i);
  assert.doesNotMatch(output, /lefthook install/i);
  assert.equal(readFile(tempDir, ".git/hooks/pre-push"), wrapper);
});

test("doctor rejects manager wrappers that do not execute or forward hook arguments", (t) => {
  const lefthookDir = createTempRepo();
  const preCommitDir = createTempRepo();
  t.after(() => cleanupTempRepo(lefthookDir));
  t.after(() => cleanupTempRepo(preCommitDir));

  managerFixture(lefthookDir, "lefthook");
  writeFile(
    gitHook(lefthookDir, "pre-push"),
    '#!/bin/sh\ncall_lefthook run "pre-push"\n',
  );
  fs.chmodSync(gitHook(lefthookDir, "pre-push"), 0o755);
  const lefthookResult = runDoctor(lefthookDir, ["--integration=lefthook"]);
  assert.equal(lefthookResult.status, 1);
  assert.match(
    compactTerminalBoxText(`${lefthookResult.stdout}${lefthookResult.stderr}`),
    /lefthook hook wrappers are customized or unsupported:\s*pre-push/i,
  );
  assert.doesNotMatch(
    `${lefthookResult.stdout}${lefthookResult.stderr}`,
    /lefthook install/i,
  );

  managerFixture(preCommitDir, "pre-commit");
  writeFile(
    gitHook(preCommitDir, "pre-push"),
    [
      "#!/usr/bin/env bash",
      "# File generated by pre-commit: https://pre-commit.com",
      "ARGS=(hook-impl --config=.pre-commit-config.yaml --hook-type=pre-push)",
      'exec pre-commit "${ARGS[@]}"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(gitHook(preCommitDir, "pre-push"), 0o755);
  const preCommitResult = runDoctor(preCommitDir, ["--integration=pre-commit"]);
  assert.equal(preCommitResult.status, 1);
  assert.match(
    compactTerminalBoxText(
      `${preCommitResult.stdout}${preCommitResult.stderr}`,
    ),
    /pre-commit hook wrappers are customized or unsupported:\s*pre-push/i,
  );
  assert.doesNotMatch(
    `${preCommitResult.stdout}${preCommitResult.stderr}`,
    /pre-commit install/i,
  );
});

test("doctor reports exact missing manager snippets but never installs them", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const config = hookManagerSnippets("lefthook", ["pre-push"])[0].content;
  writeFile(path.join(tempDir, "lefthook.yml"), config);

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /lefthook integration needs attention/i);
  assert.match(output, /missing hook entries: pre-commit/);
  assert.match(
    output,
    /run: for commitment_issues_bin[\s\S]*COMMITMENT_ISSUES_LEFTHOOK_FILE=\{files\}[\s\S]*hook precommit/,
  );
  assert.doesNotMatch(
    output,
    /node_modules\/\.bin\/commitment-issues hook prepush/,
  );
  assert.match(output, /Manager-owned files were left unchanged/);
  assert.equal(
    fs.readFileSync(path.join(tempDir, "lefthook.yml"), "utf8"),
    config,
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);

  const quiet = runDoctor(tempDir, ["--quiet", "--integration=lefthook"]);
  assert.equal(quiet.status, 0);
  assert.match(`${quiet.stdout}${quiet.stderr}`, /integration is incomplete/);
  assert.equal(
    fs.readFileSync(path.join(tempDir, "lefthook.yml"), "utf8"),
    config,
  );
});

test("doctor tells users to replace older manager entries in place", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "husky");
  const legacyPrePush =
    'node_modules/.bin/commitment-issues prepush "$@" || exit $?\n';
  writeFile(path.join(tempDir, ".husky", "pre-push"), legacyPrePush);

  const result = runDoctor(tempDir, ["--integration=husky"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /older direct hook entries must be replaced: pre-push/i);
  assert.match(output, /pre-push; replace older entry/i);
  assert.match(output, /do not keep both forms/i);
  assert.match(output, /hook prepush "\$@"/u);
  assert.doesNotMatch(output, /hook precommit/u);
  assert.equal(readFile(tempDir, ".husky/pre-push"), legacyPrePush);
});

test("doctor removes only older duplicates from manager hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "husky");
  const duplicatePrePush = [
    "echo prior",
    'node_modules/.bin/commitment-issues prepush "$@" || exit $?',
    hookInvocation("pre-push"),
    "",
  ].join("\n");
  writeFile(path.join(tempDir, ".husky", "pre-push"), duplicatePrePush);

  const result = runDoctor(tempDir, ["--integration=husky"]);
  const output = compactTerminalBoxText(`${result.stdout}${result.stderr}`);

  assert.equal(result.status, 1);
  assert.match(
    output,
    /duplicate Commitment Issues entries must be reduced to one:.*pre-push/iu,
  );
  assert.match(output, /remove duplicate Commitment Issues entries/i);
  assert.match(output, /keep one exact hook-dispatch\s*entry/iu);
  assert.doesNotMatch(output, /pre-push; replace older entry/i);
  assert.doesNotMatch(output, /pre-push; add missing entry/i);
  assert.equal(readFile(tempDir, ".husky/pre-push"), duplicatePrePush);
});

test("doctor omits Husky-only ordering guidance for Lefthook duplicates", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const files = managerFixture(tempDir, "lefthook");
  const config = files["lefthook.yml"].replace(
    "    commitment-issues:\n",
    [
      "    commitment-issues-old:",
      "      run: node_modules/.bin/commitment-issues precommit",
      "    commitment-issues:",
      "",
    ].join("\n"),
  );
  writeFile(path.join(tempDir, "lefthook.yml"), config);

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = compactTerminalBoxText(`${result.stdout}${result.stderr}`);

  assert.equal(result.status, 1);
  assert.match(output, /duplicate Commitment Issues entries/i);
  assert.match(output, /remove duplicate Commitment Issues entries/i);
  assert.doesNotMatch(output, /first substantive command/i);
  assert.equal(readFile(tempDir, "lefthook.yml"), config);
});

test("doctor preserves cross-stage manager commands for in-place migration", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "husky");
  const crossStage = [
    hookInvocation("pre-push"),
    "node_modules/.bin/commitment-issues precommit || exit $?",
    "",
  ].join("\n");
  writeFile(path.join(tempDir, ".husky", "pre-push"), crossStage);

  const result = runDoctor(tempDir, ["--integration=husky"]);
  const output = compactTerminalBoxText(`${result.stdout}${result.stderr}`);

  assert.equal(result.status, 1);
  assert.match(output, /commands target the wrong hook stage/i);
  assert.match(output, /move each Commitment Issues entry/i);
  assert.match(output, /older direct call.*insert `hook`/i);
  assert.doesNotMatch(output, /could not be inspected|replace each path/i);
  assert.equal(readFile(tempDir, ".husky/pre-push"), crossStage);
});

test("doctor prints the missing snippet for a cross-stage-only manager hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "lefthook");
  const misplaced = hookManagerSnippets("lefthook", [
    "pre-commit",
  ])[0].content.replace("pre-commit:\n", "pre-push:\n");
  writeFile(path.join(tempDir, "lefthook.yml"), misplaced);

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = compactTerminalBoxText(`${result.stdout}${result.stderr}`);

  assert.equal(result.status, 1);
  assert.match(output, /commands target the wrong hook stage/i);
  assert.match(output, /Merge each missing entry/i);
  assert.match(output, /pre-push; add missing entry/i);
  assert.match(output, /hook prepush/iu);
  assert.equal(readFile(tempDir, "lefthook.yml"), misplaced);
});

test("doctor gives guarded-entry guidance for missing Husky manager hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "husky");
  fs.rmSync(path.join(tempDir, ".husky", "pre-commit"));

  const result = runDoctor(tempDir, ["--integration=husky"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /missing hook entries: pre-commit/i);
  assert.match(
    output,
    /Place each missing guarded entry before unrelated substantive commands/i,
  );
  assert.match(output, /commitment_issues_bin" hook precommit \|\| exit \$\?/);
  assert.doesNotMatch(output, /integration is healthy/i);
  assert.equal(
    fs.existsSync(path.join(tempDir, ".husky", "pre-commit")),
    false,
  );
});

test("doctor refuses ambiguous automatic manager selection", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  managerFixture(tempDir, "husky");
  managerFixture(tempDir, "lefthook");
  const huskyBefore = fs.readFileSync(
    path.join(tempDir, ".husky", "pre-commit"),
    "utf8",
  );
  const lefthookBefore = fs.readFileSync(
    path.join(tempDir, "lefthook.yml"),
    "utf8",
  );
  const runnerBefore = fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8");

  const result = runDoctor(tempDir, ["--integration"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /Could not choose a hook-manager owner safely/);
  assert.match(output, /multiple hook managers were detected/);
  assert.equal(
    fs.readFileSync(path.join(tempDir, ".husky", "pre-commit"), "utf8"),
    huskyBefore,
  );
  assert.equal(
    fs.readFileSync(path.join(tempDir, "lefthook.yml"), "utf8"),
    lefthookBefore,
  );
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    runnerBefore,
  );

  const quiet = runDoctor(tempDir, ["--quiet", "--integration"]);
  assert.equal(quiet.status, 0);
  assert.match(`${quiet.stdout}${quiet.stderr}`, /multiple hook managers/);
});

test("doctor refuses duplicate configuration files for one manager", (t) => {
  for (const [manager, alternate, expectedPaths] of [
    ["lefthook", ".lefthook.yml", ["lefthook.yml", ".lefthook.yml"]],
    [
      "pre-commit",
      ".pre-commit-config.yml",
      [".pre-commit-config.yaml", ".pre-commit-config.yml"],
    ],
  ]) {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const managerFiles = managerFixture(tempDir, manager);
    writeFile(path.join(tempDir, alternate), "pre-commit: {}\n");

    for (const args of [["--integration"], [`--integration=${manager}`]]) {
      const result = runDoctor(tempDir, args);
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1, `${manager}: ${args.join(" ")}`);
      assert.match(output, /Could not choose .* configuration safely/u);
      for (const expectedPath of expectedPaths) {
        assert.match(
          output,
          new RegExp(expectedPath.replaceAll(".", "\\."), "u"),
        );
      }
      assert.doesNotMatch(output, /integration is healthy|Merge the missing/u);
      for (const [relativePath, content] of Object.entries(managerFiles)) {
        assert.equal(readFile(tempDir, relativePath), content);
      }

      const quiet = runDoctor(tempDir, ["--quiet", ...args]);
      assert.equal(quiet.status, 0);
      assert.match(
        `${quiet.stdout}${quiet.stderr}`,
        /multiple recognized .* configuration files/u,
      );
    }
  }
});

test("doctor rejects one unsupported Lefthook configuration format", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const config = '{"pre-commit": {}}\n';
  writeFile(path.join(tempDir, "lefthook.json"), config);

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /configuration format requires manual review/i);
  assert.match(output, /lefthook\.json/);
  assert.match(output, /use one supported YAML main/i);
  assert.doesNotMatch(output, /coexistence snippets|lefthook install/i);
  assert.equal(readFile(tempDir, "lefthook.json"), config);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("doctor withholds snippets and install commands for unsafe manager content", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const config = "min_version: 999.0.0\npre-commit: {}\n";
  writeFile(path.join(tempDir, "lefthook.yml"), config);

  const result = runDoctor(tempDir, ["--integration=lefthook"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /manager configuration could not be inspected safely/i);
  assert.match(output, /Review the uninspectable configuration/i);
  assert.doesNotMatch(
    output,
    /node_modules\/.bin\/commitment-issues|lefthook install/i,
  );
  assert.equal(readFile(tempDir, "lefthook.yml"), config);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("doctor automatic integration requires and selects exactly one owner", (t) => {
  const noOwnerDir = createTempRepo();
  const oneOwnerDir = createTempRepo();
  t.after(() => cleanupTempRepo(noOwnerDir));
  t.after(() => cleanupTempRepo(oneOwnerDir));

  const noOwner = runDoctor(noOwnerDir, ["--integration"]);
  assert.equal(noOwner.status, 1);
  assert.match(
    `${noOwner.stdout}${noOwner.stderr}`,
    /no hook manager was detected/,
  );
  assert.equal(fs.existsSync(gitHook(noOwnerDir, "pre-commit")), false);

  const quiet = runDoctor(noOwnerDir, ["--quiet", "--integration"]);
  assert.equal(quiet.status, 0);
  assert.match(
    `${quiet.stdout}${quiet.stderr}`,
    /no hook manager was detected/,
  );

  const managerFiles = managerFixture(oneOwnerDir, "lefthook");
  const oneOwner = runDoctor(oneOwnerDir, ["--integration"]);
  assert.equal(oneOwner.status, 0);
  assert.match(
    `${oneOwner.stdout}${oneOwner.stderr}`,
    /lefthook integration is healthy/i,
  );
  assert.equal(
    fs.readFileSync(path.join(oneOwnerDir, "lefthook.yml"), "utf8"),
    managerFiles["lefthook.yml"],
  );
  assert.equal(fs.existsSync(gitHook(oneOwnerDir, "pre-commit")), true);
});

test("doctor does not call a Husky hook healthy while its hooksPath is inactive", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const files = managerFixture(tempDir, "husky");
  run("git", ["config", "--unset", "core.hooksPath"], tempDir);

  const result = runDoctor(tempDir, ["--integration=husky"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /Husky's \.husky\/_ path is not active/);
  assert.equal(
    fs.readFileSync(path.join(tempDir, ".husky", "pre-commit"), "utf8"),
    files[".husky/pre-commit"],
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("doctor never trims a whitespace-bearing hooksPath into Husky's path", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const files = managerFixture(tempDir, "husky");

  for (const configured of [" .husky", ".husky ", ".husky\n"]) {
    const set = run("git", ["config", "core.hooksPath", configured], tempDir);
    assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);
    const result = runDoctor(tempDir, ["--integration=husky"]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /Husky's \.husky\/_ path is not active/);
    assert.doesNotMatch(output, /Husky integration is healthy/i);
  }

  assert.equal(
    fs.readFileSync(path.join(tempDir, ".husky", "pre-commit"), "utf8"),
    files[".husky/pre-commit"],
  );
});

for (const scenario of ["missing", "foreign"]) {
  test(`doctor fails closed when a Husky effective wrapper is ${scenario}`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const files = managerFixture(tempDir, "husky");
    const wrapper = path.join(tempDir, ".husky", "_", "pre-push");
    if (scenario === "missing") {
      fs.rmSync(wrapper);
    } else {
      fs.writeFileSync(wrapper, "#!/bin/sh\necho foreign-wrapper\n", {
        mode: 0o755,
      });
    }

    const result = runDoctor(tempDir, ["--integration=husky"]);
    const output = `${result.stdout}${result.stderr}`;
    const compactOutput = compactTerminalBoxText(output);
    assert.equal(result.status, 1);
    if (scenario === "missing") {
      assert.match(
        compactOutput,
        /effective hooks do not dispatch to husky: pre-push/i,
      );
      assert.match(output, /Husky install or prepare command/);
    } else {
      assert.match(
        compactOutput,
        /husky hook wrappers are customized or unsupported:\s*pre-push/i,
      );
      assert.match(compactOutput, /review .* wrappers manually/i);
      assert.doesNotMatch(output, /Husky install or prepare command/);
    }
    assert.doesNotMatch(output, /integration is healthy/i);
    assert.equal(
      fs.readFileSync(path.join(tempDir, ".husky", "pre-push"), "utf8"),
      files[".husky/pre-push"],
    );
    assert.equal(
      fs.existsSync(wrapper),
      scenario === "foreign",
      "doctor must not create or replace Husky's wrapper",
    );
  });
}

test(
  "doctor fails closed when a Husky effective wrapper is non-executable",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    managerFixture(tempDir, "husky");
    const wrapper = path.join(tempDir, ".husky", "_", "pre-push");
    fs.chmodSync(wrapper, 0o644);

    const result = runDoctor(tempDir, ["--integration=husky"]);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1);
    assert.match(output, /effective hooks do not dispatch to husky: pre-push/i);
    assert.doesNotMatch(output, /integration is healthy/i);
    assert.equal(fs.statSync(wrapper).mode & 0o111, 0);
  },
);

test("doctor explains every manager activation failure without writing", (t) => {
  const dirs = Array.from({ length: 6 }, () => createTempRepo());
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "doctor-manager-runner-"),
  );
  t.after(() => {
    dirs.forEach(cleanupTempRepo);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  managerFixture(dirs[0], "husky");
  run("git", ["config", "core.hooksPath", "custom-hooks"], dirs[0]);
  assert.match(
    `${runDoctor(dirs[0], ["--integration=husky"]).stdout}`,
    /core\.hooksPath is set to custom-hooks/,
  );

  managerFixture(dirs[1], "lefthook");
  fs.rmSync(path.join(dirs[1], "lefthook.yml"));
  fs.writeFileSync(path.join(outside, "lefthook.yml"), "pre-commit: {}\n");
  fs.symlinkSync(
    path.join(outside, "lefthook.yml"),
    path.join(dirs[1], "lefthook.yml"),
  );
  assert.match(
    `${runDoctor(dirs[1], ["--integration=lefthook"]).stdout}`,
    /manager configuration could not be inspected safely/,
  );

  assert.match(
    `${runDoctor(dirs[2], ["--integration=pre-commit"]).stdout}`,
    /no active pre-commit configuration was detected/,
  );

  managerFixture(dirs[3], "lefthook");
  fs.rmSync(gitHook(dirs[3], "pre-push"));
  fs.writeFileSync(path.join(outside, "pre-push"), "foreign\n");
  fs.symlinkSync(path.join(outside, "pre-push"), gitHook(dirs[3], "pre-push"));
  assert.match(
    `${runDoctor(dirs[3], ["--integration=lefthook"]).stdout}`,
    /effective lefthook hook wrappers could not be inspected safely/i,
  );

  managerFixture(dirs[4], "pre-commit");
  fs.rmSync(gitHook(dirs[4], "pre-push"));
  assert.match(
    `${runDoctor(dirs[4], ["--integration=pre-commit"]).stdout}`,
    /pre-commit install --hook-type pre-commit --hook-type pre-push/,
  );

  const files = managerFixture(dirs[5], "lefthook");
  const preCommitRunLine = hookManagerSnippets("lefthook", [
    "pre-commit",
  ])[0].content.match(/^\s*run: .+$/mu)?.[0];
  assert.ok(preCommitRunLine);
  writeFile(
    path.join(dirs[5], "lefthook.yml"),
    files["lefthook.yml"].replace(preCommitRunLine, "      run: echo other"),
  );
  const configOnly = `${runDoctor(dirs[5], ["--integration=lefthook"]).stdout}`;
  assert.match(configOnly, /missing hook entries: pre-commit/);
  assert.doesNotMatch(
    configOnly,
    /Install or refresh the manager's Git hook wrappers/,
  );
});

test("doctor validates integration option cardinality", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const unsupported = runDoctor(tempDir, ["--integration=unknown"]);
  assert.equal(unsupported.status, 1);
  assert.match(
    `${unsupported.stdout}${unsupported.stderr}`,
    /Unknown doctor option: --integration=unknown/,
  );
  const duplicate = runDoctor(tempDir, [
    "--integration=husky",
    "--integration=lefthook",
  ]);
  assert.equal(duplicate.status, 1);
  assert.match(
    `${duplicate.stdout}${duplicate.stderr}`,
    /may be supplied only once/,
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

// Simulate the wiring a pre-3.0 (husky-era) setup leaves behind: hooksPath
// pointing at husky's shim dir plus our generated `.husky` hook files. With
// `live: true` a husky package stub is installed (the "user deliberately
// keeps husky" case); the default simulates the v3 upgrade path, where husky
// is already pruned from node_modules and the wiring is a dead end.
function wireHuskyEra(tempDir, { live = false } = {}) {
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);
  fs.mkdirSync(path.join(tempDir, ".husky", "_"), { recursive: true });
  fs.writeFileSync(path.join(tempDir, ".husky", "_", "h"), "# husky shim\n");
  fs.writeFileSync(
    path.join(tempDir, ".husky", "pre-commit"),
    live
      ? "node_modules/.bin/commitment-issues precommit || exit $?\n"
      : "commitment-issues precommit\n",
  );
  fs.writeFileSync(
    path.join(tempDir, ".husky", "pre-push"),
    live
      ? 'node_modules/.bin/commitment-issues prepush "$@" || exit $?\n'
      : "commitment-issues prepush\n",
  );
  fs.chmodSync(path.join(tempDir, ".husky", "pre-commit"), 0o755);
  fs.chmodSync(path.join(tempDir, ".husky", "pre-push"), 0o755);
  if (live) {
    // Swap the node_modules symlink (which points at the real repo, where
    // husky is no longer installed) for a real dir: a husky stub plus
    // symlinks for the peer tools so the missing-tools advisory stays quiet.
    fs.unlinkSync(path.join(tempDir, "node_modules"));
    fs.mkdirSync(path.join(tempDir, "node_modules", "husky"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, "node_modules", "husky", "package.json"),
      '{"name":"husky","version":"9.0.0"}\n',
    );
    for (const tool of ["eslint", "prettier"]) {
      fs.symlinkSync(
        path.join(repoRoot, "node_modules", tool),
        path.join(tempDir, "node_modules", tool),
      );
    }
  }
}

test("doctor wires up native hooks in a fresh repo", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Repaired the git hook wiring/);
  assert.equal(hooksPath(tempDir), "");
  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    /commitment-issues precommit/,
  );
  assert.match(
    fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"),
    /commitment-issues prepush/,
  );
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);
});

test("doctor wires and fresh-clone repairs opt-in commit-msg hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });

  const first = runDoctor(tempDir);
  const firstOutput = `${first.stdout}${first.stderr}`;
  assert.equal(first.status, 0);
  assert.match(firstOutput, /Commit-message linting is not ready/);
  assert.match(firstOutput, /project-local commitlint CLI is not installed/);
  assert.match(
    fs.readFileSync(gitHook(tempDir, "commit-msg"), "utf8"),
    /commitment-issues commit-msg "\$1"/,
  );

  fs.rmSync(gitHook(tempDir, "commit-msg"));
  const repaired = runDoctor(tempDir, ["--quiet"]);
  const repairedOutput = `${repaired.stdout}${repaired.stderr}`;
  assert.equal(repaired.status, 0);
  assert.match(repairedOutput, /repaired git hooks/);
  assert.match(repairedOutput, /commit-msg/);
  assert.match(repairedOutput, /project-local commitlint is missing/);
  assert.ok(fs.existsSync(gitHook(tempDir, "commit-msg")));
});

test("doctor preserves custom commit-msg hooks and requires safe forwarding", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, { commitMessage: { enabled: true } });
  runDoctor(tempDir);
  writeFile(gitHook(tempDir, "commit-msg"), "echo custom message hook\n");

  const unwired = runDoctor(tempDir);
  const unwiredOutput = `${unwired.stdout}${unwired.stderr}`;
  assert.equal(unwired.status, 1);
  assert.match(unwiredOutput, /commit-msg/);
  assert.match(
    compactTerminalBoxText(unwiredOutput),
    /commitment_issues_bin"\s*hook\s*commit-msg\s*"\$1"\s*\|\|\s*exit\s*\$\?/,
  );
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "commit-msg"), "utf8"),
    "echo custom message hook\n",
  );

  fs.writeFileSync(
    gitHook(tempDir, "commit-msg"),
    `${hookInvocation("commit-msg")}\necho custom\n`,
  );
  const safe = runDoctor(tempDir);
  assert.equal(safe.status, 0);
  assert.match(`${safe.stdout}${safe.stderr}`, /Git hooks are healthy/);
});

test("doctor diagnoses invalid commitMessage config without requiring a hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  setPrecommitConfig(tempDir, {
    commitMessage: { enable: true, enabled: "yes" },
  });

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Configuration needs attention/);
  assert.match(output, /commitMessage\.enable/);
  assert.match(output, /commitMessage\.enabled must be a boolean/);
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);
});

test("doctor reports healthy once everything is wired", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // first run repairs
  const result = runDoctor(tempDir); // second run: nothing to fix
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Git hooks are healthy/);
});

test("doctor recreates a missing hook file", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring + hook files
  fs.rmSync(gitHook(tempDir, "pre-push"), { force: true });

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Repaired the git hook wiring/);
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-push")));
});

test("doctor refreshes the exact path-fallback generated pre-push hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir);
  const hookPath = gitHook(tempDir, "pre-push");
  const current = fs.readFileSync(hookPath, "utf8");
  const stale = `#!/bin/sh
# Installed by commitment-issues. Recreate anytime with: commitment-issues doctor
if [ "$COMMITMENT_ISSUES" = "0" ] || [ "$HUSKY" = "0" ]; then
  exit 0
fi
export PATH="node_modules/.bin:$PATH"
if ! command -v commitment-issues >/dev/null 2>&1; then
  echo "commitment-issues: command not found; skipping pre-push checks." >&2
  exit 0
fi
commitment-issues prepush "$@"
`;
  fs.writeFileSync(hookPath, stale);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Repaired the git hook wiring/);
  assert.match(output, /outdated generated hook file\(s\): pre-push/);
  assert.equal(fs.readFileSync(hookPath, "utf8"), current);
});

test("doctor reports and preserves a customized pre-push hook without forwarded args", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir);
  const hookPath = gitHook(tempDir, "pre-push");
  const custom = "#!/bin/sh\necho custom\ncommitment-issues prepush\n";
  fs.writeFileSync(hookPath, custom);

  const result = runDoctor(tempDir);

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /does not invoke/);
  assert.equal(fs.readFileSync(hookPath, "utf8"), custom);
});

test("doctor requires live husky-era wiring to adopt managed bypasses", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir, { live: true }); // husky still installed and wired

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.doesNotMatch(output, /Git hooks are healthy/);
  assert.match(output, /core\.hooksPath points somewhere else/);
  assert.match(output, /commitment-issues init/);
  assert.equal(hooksPath(tempDir), ".husky/_");
  assert.ok(fs.existsSync(path.join(tempDir, ".husky", "pre-commit")));
});

test("doctor recognizes managed live husky-era wiring", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir, { live: true });
  fs.writeFileSync(
    path.join(tempDir, ".husky", "pre-commit"),
    `${hookInvocation("pre-commit")}\n`,
  );
  fs.writeFileSync(
    path.join(tempDir, ".husky", "pre-push"),
    `${hookInvocation("pre-push")}\n`,
  );

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Git hooks are healthy/);
  assert.match(output, /This is husky-era wiring/);
  assert.match(output, /npx commitment-issues init/);
  assert.equal(hooksPath(tempDir), ".husky/_");
});

test("doctor reports live husky-era hooks that never invoke commitment-issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir, { live: true });
  fs.writeFileSync(
    path.join(tempDir, ".husky", "pre-commit"),
    "echo my own hook\n",
  );

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /core\.hooksPath points somewhere else/);
  assert.match(output, /\.husky\/pre-commit/);
  assert.match(output, /commitment-issues init/);
  // Never rewired or deleted behind the user's back.
  assert.equal(hooksPath(tempDir), ".husky/_");
});

test("doctor migrates dead husky-era wiring to native hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // The v3 upgrade path: hooksPath still points at husky's shim dir, but the
  // husky package is gone, so nothing maintains that wiring anymore.
  wireHuskyEra(tempDir);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Repaired the git hook wiring/);
  assert.match(output, /husky-era core\.hooksPath/);
  assert.equal(hooksPath(tempDir), "");
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-commit")));
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-push")));
  // Doctor migrates wiring but never deletes files; our exact-match legacy
  // hooks are not the user's work, so they are not reported either.
  assert.ok(fs.existsSync(path.join(tempDir, ".husky", "pre-commit")));
  assert.doesNotMatch(output, /Leftover \.husky hooks/);
});

test("doctor warns about user-authored .husky hooks that no longer run", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir);
  fs.writeFileSync(
    path.join(tempDir, ".husky", "commit-msg"),
    "echo custom message check\n",
  );

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Leftover \.husky hooks no longer run/);
  assert.match(output, /\.husky\/commit-msg/);
  assert.equal(countTerminalBoxes(output), 1);
  // Advisory only: the user's file is never deleted.
  assert.ok(fs.existsSync(path.join(tempDir, ".husky", "commit-msg")));
});

test("doctor --quiet warns in one line about stranded .husky hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // healthy native wiring
  fs.mkdirSync(path.join(tempDir, ".husky"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, ".husky", "commit-msg"),
    "echo custom message check\n",
  );

  const result = runDoctor(tempDir, ["--quiet"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /\.husky\/commit-msg no longer run/);
});

test("doctor rejects legacy unguarded or direct custom hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring + exact hook bodies
  // A direct public command still runs, but it cannot honor the managed
  // fail-open and hook-only-bypass contract.
  fs.writeFileSync(
    gitHook(tempDir, "pre-commit"),
    "node_modules/.bin/commitment-issues precommit || exit $?\necho running my own lint step\n",
  );

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.doesNotMatch(output, /Git hooks are healthy/);
  assert.match(output, /outdated unguarded or direct wiring/i);
  assert.match(output, /package removal fails open/i);
  assert.match(compactTerminalBoxText(output), /hook\s*precommit/);
});

test("doctor rejects inert command mentions without changing custom hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish executable hook files
  const bodies = {
    "pre-commit": "#!/bin/sh\necho 'commitment-issues precommit'\n",
    "pre-push": '#!/bin/sh\nexample="commitment-issues prepush"\n',
  };
  for (const [name, body] of Object.entries(bodies)) {
    fs.writeFileSync(gitHook(tempDir, name), body);
  }

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /does not invoke commitment-issues/);
  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(fs.readFileSync(gitHook(tempDir, name), "utf8"), body);
  }
});

test(
  "doctor reports a non-executable custom hook without changing it",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    runDoctor(tempDir);
    const hookPath = gitHook(tempDir, "pre-commit");
    const body = "#!/bin/sh\ncommitment-issues precommit\n";
    fs.writeFileSync(hookPath, body);
    fs.chmodSync(hookPath, 0o644);

    const result = runDoctor(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /not executable/);
    assert.match(output, /Run: chmod \+x '\.git\/hooks\/pre-commit'/);
    assert.match(output, /\.git\/hooks\/pre-commit/);
    assert.equal(fs.readFileSync(hookPath, "utf8"), body);
    assert.equal(fs.statSync(hookPath).mode & 0o111, 0);
  },
);

test(
  "doctor shell-quotes a non-executable foreign hook path",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    const configuredHooksPath = "-hooks with spaces;$(touch injected)'quoted";
    const hookPath = path.join(tempDir, configuredHooksPath, "pre-commit");
    const hookBody = "#!/bin/sh\ncommitment-issues precommit\n";
    writeFile(hookPath, hookBody);
    fs.chmodSync(hookPath, 0o644);
    run("git", ["config", "core.hooksPath", configuredHooksPath], tempDir);

    const result = runDoctor(tempDir);
    const output = `${result.stdout}${result.stderr}`;
    const quotedPath = `'./-hooks with spaces;$(touch injected)'"'"'quoted/pre-commit'`;
    const fixCommand = `chmod +x ${quotedPath}`;

    assert.equal(result.status, 1);
    assert.ok(output.includes(fixCommand));
    assert.equal(fs.readFileSync(hookPath, "utf8"), hookBody);
    assert.equal(fs.statSync(hookPath).mode & 0o111, 0);
    assert.equal(fs.existsSync(path.join(tempDir, "injected")), false);

    const fixed = run("sh", ["-c", fixCommand], tempDir);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.notEqual(fs.statSync(hookPath).mode & 0o111, 0);
    assert.equal(fs.existsSync(path.join(tempDir, "injected")), false);
  },
);

test("doctor reports a pre-commit hook that never invokes commitment-issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring
  fs.writeFileSync(gitHook(tempDir, "pre-commit"), "echo my own hook\n");

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /does not invoke commitment-issues/);
  assert.match(output, /\.git\/hooks\/pre-commit/);
  // The user's own hook body must never be overwritten.
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    "echo my own hook\n",
  );
});

test("doctor reports a pre-push hook that never invokes commitment-issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring
  fs.writeFileSync(gitHook(tempDir, "pre-push"), "echo my own hook\n");

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /does not invoke commitment-issues/);
  assert.match(output, /\.git\/hooks\/pre-push/);
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-push"), "utf8"),
    "echo my own hook\n",
  );
});

test("doctor --quiet warns but exits 0 when a hook does not invoke commitment-issues", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring
  fs.writeFileSync(gitHook(tempDir, "pre-commit"), "echo my own hook\n");

  const result = runDoctor(tempDir, ["--quiet"]);
  const output = `${result.stdout}${result.stderr}`;

  // Never break an install, but do not silently claim health either.
  assert.equal(result.status, 0);
  assert.match(output, /do not invoke commitment-issues/);
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    "echo my own hook\n",
  );
});

test("doctor --quiet stays silent when the wiring is healthy", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring
  const result = runDoctor(tempDir, ["--quiet"]);

  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.trim(), "");
});

test("doctor refuses to call a broken or displaced prepare repair healthy", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  assert.equal(runDoctor(tempDir).status, 0);
  const commitHook = readFile(tempDir, ".git/hooks/pre-commit");
  const pushHook = readFile(tempDir, ".git/hooks/pre-push");
  const repair = prepareRepairCommand();
  const pkg = JSON.parse(readFile(tempDir, "package.json"));

  pkg.scripts.prepare = `node --version; && ${repair}`;
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  const broken = runDoctor(tempDir);
  const brokenOutput = `${broken.stdout}${broken.stderr}`;
  assert.equal(broken.status, 1);
  assert.match(brokenOutput, /install-time repair is not healthy/i);
  assert.match(brokenOutput, /Run .* init to rewrite/);
  assert.match(brokenOutput, /No hooks were changed/);
  assert.doesNotMatch(brokenOutput, /Git hooks are healthy/);

  const quiet = runDoctor(tempDir, ["--quiet"]);
  const quietOutput = `${quiet.stdout}${quiet.stderr}`.trim();
  assert.equal(quiet.status, 0);
  assert.match(quietOutput, /broken repair composition/);
  assert.equal(quietOutput.split(/\r?\n/u).length, 1);

  pkg.scripts.prepare = `node --version && ${repair} && node --version`;
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  const ambiguous = runDoctor(tempDir);
  const ambiguousOutput = `${ambiguous.stdout}${ambiguous.stderr}`;
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguousOutput, /install-time repair is ambiguous/i);
  assert.match(
    ambiguousOutput,
    /Remove only the displaced Commitment Issues repair/,
  );
  assert.doesNotMatch(ambiguousOutput, /Git hooks are healthy/);
  const ambiguousQuiet = runDoctor(tempDir, ["--quiet"]);
  const ambiguousQuietOutput =
    `${ambiguousQuiet.stdout}${ambiguousQuiet.stderr}`.trim();
  assert.equal(ambiguousQuiet.status, 0);
  assert.match(ambiguousQuietOutput, /ambiguous repair composition/);
  assert.equal(ambiguousQuietOutput.split(/\r?\n/u).length, 1);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), commitHook);
  assert.equal(readFile(tempDir, ".git/hooks/pre-push"), pushHook);
});

test("doctor leaves prepare ownership to existing invalid-package diagnostics", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  assert.equal(runDoctor(tempDir).status, 0);
  writeFile(path.join(tempDir, "package.json"), "{ invalid json\n");

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Configuration needs attention/);
  assert.match(output, /package\.json contains/);
  assert.match(output, /invalid JSON/);
  assert.match(output, /Git hooks are healthy/);
});

test("doctor warns about malformed standalone config without blocking repair", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  fs.writeFileSync(
    path.join(tempDir, ".commitmentrc.json"),
    "{ invalid json\n",
  );

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Configuration needs attention/);
  assert.match(output, /\.commitmentrc\.json/);
  assert.match(output, /contains invalid JSON/);
  assert.match(output, /Repaired the git hook wiring/);
  assert.equal(countTerminalBoxes(output), 1);
  assert.equal(
    fs.readFileSync(path.join(tempDir, ".commitmentrc.json"), "utf8"),
    "{ invalid json\n",
  );
});

test("doctor --quiet reports malformed standalone config in one line", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir);
  fs.writeFileSync(path.join(tempDir, ".commitmentrc.json"), "[]\n");

  const result = runDoctor(tempDir, ["--quiet"]);
  const output = `${result.stdout}${result.stderr}`.trim();

  assert.equal(result.status, 0);
  assert.match(output, /\.commitmentrc\.json/);
  assert.match(output, /must contain a JSON object/);
  assert.equal(output.split(/\r?\n/).length, 1);
});

test("doctor treats a wired foreign core.hooksPath as healthy", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // The user manages their own hooks dir but invokes us from it.
  fs.mkdirSync(path.join(tempDir, "githooks"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "githooks", "pre-commit"),
    `${hookInvocation("pre-commit")}\n`,
  );
  fs.writeFileSync(
    path.join(tempDir, "githooks", "pre-push"),
    `${hookInvocation("pre-push")}\n`,
  );
  fs.chmodSync(path.join(tempDir, "githooks", "pre-commit"), 0o755);
  fs.chmodSync(path.join(tempDir, "githooks", "pre-push"), 0o755);
  run("git", ["config", "core.hooksPath", "githooks"], tempDir);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Git hooks are healthy/);
  assert.match(output, /githooks/);
  // The user's configuration is never rewired.
  assert.equal(hooksPath(tempDir), "githooks");
});

test("doctor resolves a tilde-based core.hooksPath through Git", (t) => {
  const tempDir = createTempRepo();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-home-"));
  t.after(() => cleanupTempRepo(tempDir));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const hooksDir = path.join(homeDir, "shared hooks");
  for (const name of ["pre-commit", "pre-push"]) {
    writeFile(
      path.join(hooksDir, name),
      `#!/bin/sh\n${hookInvocation(name)}\n`,
    );
    fs.chmodSync(path.join(hooksDir, name), 0o755);
  }
  run("git", ["config", "core.hooksPath", "~/shared hooks"], tempDir);

  const result = runDoctor(tempDir, [], {
    env: { ...process.env, HOME: homeDir },
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Git hooks are healthy/);
  assert.match(output, /~\/shared hooks/);
});

test("doctor reports an unwired foreign core.hooksPath without touching it", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  fs.mkdirSync(path.join(tempDir, "githooks"), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, "githooks", "pre-commit"),
    "echo my own hook\n",
  );
  fs.chmodSync(path.join(tempDir, "githooks", "pre-commit"), 0o755);
  run("git", ["config", "core.hooksPath", "githooks"], tempDir);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /core\.hooksPath points somewhere else/);
  assert.match(output, /commitment_issues_bin" hook precommit/);
  assert.equal(hooksPath(tempDir), "githooks");
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
});

test("doctor treats a configured empty hooksPath as the repository root", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const set = run("git", ["config", "core.hooksPath", ""], tempDir);
  assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /core\.hooksPath points somewhere else/);
  assert.match(output, /core\.hooksPath is set to ""/);
  assert.doesNotMatch(output, /Git hooks are healthy/);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(path.join(tempDir, "pre-commit")), false);
  assert.equal(
    run("git", ["config", "--get", "core.hooksPath"], tempDir).status,
    0,
  );
});

test("doctor --quiet warns but exits 0 for an unwired foreign core.hooksPath", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  fs.mkdirSync(path.join(tempDir, "githooks"), { recursive: true });
  run("git", ["config", "core.hooksPath", "githooks"], tempDir);

  const result = runDoctor(tempDir, ["--quiet"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /core\.hooksPath is set to githooks/);
  assert.equal(hooksPath(tempDir), "githooks");
});

test(
  "doctor --quiet escapes controls in a configured hooks path",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const configured = "hooks\rFAKE SUCCESS\n\t\b\u001b[31mRED\u001b[39m";
    fs.mkdirSync(path.join(tempDir, configured), { recursive: true });
    run("git", ["config", "core.hooksPath", configured], tempDir);

    const result = runDoctor(tempDir, ["--quiet"]);
    const output = `${result.stdout}${result.stderr}`;
    const visibleOutput = stripAnsi(output);

    assert.equal(result.status, 0);
    assert.match(visibleOutput, /hooks\\rFAKE SUCCESS\\n\\t\\x08RED/);
    assert.doesNotMatch(visibleOutput, /\r|\t|\x08|\u001b/);
    assert.doesNotMatch(output, /FAKE SUCCESS.*\u001b\[31mRED/s);
  },
);

test("doctor reports an uninspectable hook in a foreign core.hooksPath", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const customDir = path.join(tempDir, "custom-hooks");
  fs.mkdirSync(path.join(customDir, "pre-commit"), { recursive: true });
  assert.equal(
    run("git", ["config", "core.hooksPath", "custom-hooks"], tempDir).status,
    0,
  );

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /pre-commit.*could not be inspected/i);
  assert.equal(
    fs.statSync(path.join(customDir, "pre-commit")).isDirectory(),
    true,
  );
});

// Detach the node_modules symlink (createTempRepo points it at the real repo's,
// where every peer tool resolves) and leave an empty directory in its place, so
// the required tools no longer resolve. Wiring is already on disk from the first
// run, so the next run stays healthy and performs no repair.
function hideNodeModules(tempDir) {
  fs.unlinkSync(path.join(tempDir, "node_modules"));
  fs.mkdirSync(path.join(tempDir, "node_modules"));
}

test("doctor warns (interactive) when required tools are not installed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring while the tools resolve
  hideNodeModules(tempDir);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  // Advisory: missing tools never fail an otherwise-healthy repo.
  assert.equal(result.status, 0);
  assert.match(output, /Git hooks are healthy/);
  assert.match(output, /Some required tools are not installed/);
  for (const tool of ["eslint", "prettier"]) {
    assert.match(output, new RegExp(tool));
  }
  assert.match(output, /npm install -D/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("doctor --quiet warns about missing tools in one line but exits 0", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  runDoctor(tempDir); // establish healthy wiring first
  hideNodeModules(tempDir);

  const result = runDoctor(tempDir, ["--quiet"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /missing required tool\(s\)/);
  assert.match(output, /eslint/);
  assert.match(output, /npm install -D/);
});

test("doctor --quiet repairs and reports in one line", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runDoctor(tempDir, ["--quiet"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /repaired git hooks/);
  assert.ok(fs.existsSync(gitHook(tempDir, "pre-commit")));
});

test("doctor --quiet never breaks an install outside a git repo", (t) => {
  // Simulates `prepare` running during `npm install` in CI/Docker with no .git.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-nongit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}\n');

  const result = run(
    "node",
    [path.join(repoRoot, "scripts", "doctor.mjs"), "--quiet"],
    dir,
  );

  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.trim(), "");
});

test("doctor treats a bare repository as unsupported local-hook wiring", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bare-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(run("git", ["init", "--bare"], dir).status, 0);
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"x"}\n');

  const interactive = run(
    "node",
    [path.join(repoRoot, "scripts", "doctor.mjs")],
    dir,
  );
  const quiet = run(
    "node",
    [path.join(repoRoot, "scripts", "doctor.mjs"), "--quiet"],
    dir,
  );

  assert.equal(interactive.status, 1);
  assert.match(
    `${interactive.stdout}${interactive.stderr}`,
    /bare git repository/i,
  );
  assert.equal(quiet.status, 0);
  assert.equal(`${quiet.stdout}${quiet.stderr}`.trim(), "");
  assert.equal(fs.existsSync(path.join(dir, "hooks", "pre-commit")), false);
});

test("doctor fails safely when core.hooksPath cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const env = fakeGitEnv(tempDir, "--get core.hooksPath", 128);
  const interactive = runDoctor(tempDir, [], { env });
  const quiet = runDoctor(tempDir, ["--quiet"], { env });

  assert.equal(interactive.status, 1);
  assert.match(
    `${interactive.stdout}${interactive.stderr}`,
    /Could not determine core\.hooksPath/,
  );
  assert.equal(quiet.status, 0);
  assert.match(`${quiet.stdout}${quiet.stderr}`, /could not wire up git hooks/);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("doctor fails safely when the configured hooks directory cannot be resolved", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  assert.equal(
    run("git", ["config", "core.hooksPath", "custom-hooks"], tempDir).status,
    0,
  );
  const env = fakeGitEnv(tempDir, "rev-parse --git-path hooks", 128);
  const interactive = runDoctor(tempDir, [], { env });
  const quiet = runDoctor(tempDir, ["--quiet"], { env });

  assert.equal(interactive.status, 1);
  assert.match(
    `${interactive.stdout}${interactive.stderr}`,
    /Could not locate the configured git hooks directory/,
  );
  assert.equal(quiet.status, 0);
  assert.match(`${quiet.stdout}${quiet.stderr}`, /could not wire up git hooks/);
});

test("doctor reports an uninspectable hook instead of crashing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  fs.mkdirSync(gitHook(tempDir, "pre-commit"), { recursive: true });
  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /could not be inspected/i);
  assert.equal(fs.statSync(gitHook(tempDir, "pre-commit")).isDirectory(), true);
});

test(
  "doctor never follows a dangling hook symlink during repair",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    const outsideTarget = path.join(tempDir, "outside-hook-target");
    fs.symlinkSync(outsideTarget, gitHook(tempDir, "pre-commit"));

    const result = runDoctor(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /could not be inspected/i);
    assert.equal(fs.existsSync(outsideTarget), false);
    assert.equal(
      fs.lstatSync(gitHook(tempDir, "pre-commit")).isSymbolicLink(),
      true,
    );
  },
);

test(
  "doctor reports and preserves a symbolic-link .husky directory",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "doctor-husky-link-"),
    );
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

    const result = runDoctor(tempDir);
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

    const quiet = runDoctor(tempDir, ["--quiet"]);
    assert.equal(quiet.status, 0);
    assert.match(
      `${quiet.stdout}${quiet.stderr}`,
      /could not be safely inspected.*left unchanged/i,
    );
  },
);

test(
  "doctor never recommends installing an unsafe Husky owner",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "doctor-husky-root-"),
    );
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    writeFile(path.join(outside, "keep"), "outside\n");
    fs.symlinkSync(outside, path.join(tempDir, ".husky"), "dir");

    for (const args of [["--integration=husky"], ["--integration"]]) {
      const result = runDoctor(tempDir, args);
      const output = `${result.stdout}${result.stderr}`;
      assert.equal(result.status, 1);
      assert.match(output, /could not choose a husky configuration safely/i);
      assert.doesNotMatch(output, /install or prepare command/i);
      assert.equal(readFile(outside, "keep"), "outside\n");
    }
  },
);

test("doctor rejects LEFTHOOK_CONFIG without an install hint", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "lefthook.yml"), "pre-commit: {}\n");
  const result = runDoctor(tempDir, ["--integration=lefthook"], {
    env: { ...process.env, LEFTHOOK_CONFIG: "custom.toml" },
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /could not choose a lefthook configuration safely/i);
  assert.doesNotMatch(output, /lefthook install/i);
});

test("doctor errors (interactive) when there is no package.json", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-nopkg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // No --quiet: the "not applicable" guard prints a box and exits 1.
  const result = run(
    "node",
    [path.join(repoRoot, "scripts", "doctor.mjs")],
    dir,
  );

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /No package\.json found/);
});

test("doctor reports failure when the husky-era hooksPath cannot be unset", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir);

  // `git config --unset core.hooksPath` fails; the migration cannot complete.
  const env = fakeGitEnv(tempDir, "config --unset");
  const result = runDoctor(tempDir, [], { env });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Could not repair the git hook wiring/,
  );
});

test("doctor --quiet warns but never fails when repair cannot complete", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir);

  const env = fakeGitEnv(tempDir, "config --unset");
  const result = runDoctor(tempDir, ["--quiet"], { env });

  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /could not wire up git hooks/,
  );
});

test("doctor reports when the wiring is still broken after repair", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  wireHuskyEra(tempDir);

  // `git config --unset` "succeeds" as a silent no-op, so hooksPath survives
  // and the post-repair verification still finds the wiring broken.
  const env = fakeGitEnv(tempDir, "config --unset", 0);
  const result = runDoctor(tempDir, [], { env });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /still looks broken after repair/,
  );
});

test("doctor reports failure when the hook files cannot be written", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const repoAlias = aliasedRepoPath(t, tempDir, "doctor-write-alias-");
  const preload = fsFailurePreload(tempDir);
  const result = run(
    "node",
    ["--import", preload, path.join(tempDir, "scripts", "doctor.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        TEST_FS_FAILURE_METHOD: "writeFileSync",
        // Match a not-yet-created hook through a different spelling of the
        // repository, like macOS' /var/folders -> /private/var/folders alias.
        TEST_FS_FAILURE_PATH: path.join(
          repoAlias,
          ".git",
          "hooks",
          "pre-commit",
        ),
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Could not repair the git hook wiring/,
  );
});

test("doctor reports when Git cannot resolve the common hooks directory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runDoctor(tempDir, [], {
    env: fakeGitEnv(tempDir, "rev-parse --git-common-dir"),
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Could not locate the git hooks directory/,
  );
});

test("doctor reports successful repairs alongside an unwired custom hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(gitHook(tempDir, "pre-push"), "#!/bin/sh\necho custom push\n");
  fs.chmodSync(gitHook(tempDir, "pre-push"), 0o755);

  const result = runDoctor(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /does not invoke commitment-issues/);
  assert.match(output, /Also repaired: \.git\/hooks\/pre-commit/);
});

test("doctor displays absolute paths for hooks outside the project", (t) => {
  const tempDir = createTempRepo();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "external-hooks-"));
  t.after(() => cleanupTempRepo(tempDir));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));

  writeFile(path.join(external, "pre-commit"), "#!/bin/sh\necho external\n");
  fs.chmodSync(path.join(external, "pre-commit"), 0o755);
  run("git", ["config", "core.hooksPath", external], tempDir);

  const result = runDoctor(tempDir);

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    new RegExp(external.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("doctor displays shared worktree hooks outside the checkout", (t) => {
  const tempDir = createTempRepo();
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-worktree-"));
  fs.rmSync(worktree, { recursive: true, force: true });
  t.after(() => {
    run("git", ["worktree", "remove", "--force", worktree], tempDir);
    fs.rmSync(worktree, { recursive: true, force: true });
    cleanupTempRepo(tempDir);
  });

  const added = run(
    "git",
    ["worktree", "add", "--detach", worktree, "HEAD"],
    tempDir,
  );
  assert.equal(added.status, 0);

  const result = runDoctor(worktree);
  // Git and Node may spell the same Windows/macOS temp parent differently
  // (8.3 names or /private/var), but the owning repo basename is stable and
  // distinguishes the shared hooks directory from the linked worktree.
  const expectedHooks = `${path.basename(tempDir)}/.git/hooks`;

  assert.equal(result.status, 0);
  assert.match(
    compactTerminalBoxText(`${result.stdout}${result.stderr}`),
    new RegExp(expectedHooks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
