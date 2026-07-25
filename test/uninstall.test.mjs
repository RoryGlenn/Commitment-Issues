// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  hookBody,
  hookInvocation,
  hookManagerSnippets,
} from "../scripts/lib/hooks.mjs";
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

function runScript(tempDir, script, args = [], options = {}) {
  return run(
    "node",
    [path.join(tempDir, "scripts", `${script}.mjs`), ...args],
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

function gitHook(tempDir, name) {
  return path.join(tempDir, ".git", "hooks", name);
}

test("uninstall removes generated setup and preserves shared project state", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    scripts: { build: "node build.mjs" },
    devDependencies: { "commitment-issues": "^3.2.0" },
  });

  assert.equal(runScript(tempDir, "init").status, 0);
  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Commitment Issues setup was removed/);
  assert.match(output, /npm remove commitment-issues/);

  const pkg = readPackage(tempDir);
  assert.deepEqual(pkg.scripts, { build: "node build.mjs" });
  assert.equal("precommitChecks" in pkg, false);
  assert.equal(pkg.devDependencies["commitment-issues"], "^3.2.0");

  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
  assert.match(readFile(tempDir, ".gitignore"), /node_modules\//);
  assert.match(readFile(tempDir, ".gitignore"), /\.eslintcache/);

  const second = runScript(tempDir, "uninstall");
  assert.equal(second.status, 0);
  assert.match(
    `${second.stdout}${second.stderr}`,
    /No generated setup was found to remove/,
  );
});

test("uninstall rejects unknown options before removing generated setup", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  assert.equal(runScript(tempDir, "init").status, 0);
  const packageBefore = readFile(tempDir, "package.json");
  const precommitBefore = fs.readFileSync(
    path.join(tempDir, ".git", "hooks", "pre-commit"),
    "utf8",
  );

  const result = runScript(tempDir, "uninstall", ["--dry-rn"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unknown uninstall option: --dry-rn/);
  assert.match(output, /No files or hooks were changed/);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(
    fs.readFileSync(path.join(tempDir, ".git", "hooks", "pre-commit"), "utf8"),
    precommitBefore,
  );
});

test("uninstall refuses an unwritable package before removing hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  assert.equal(runScript(tempDir, "init").status, 0);
  const packagePath = path.join(tempDir, "package.json");
  const packageBefore = readFile(tempDir, "package.json");
  const hookPath = path.join(tempDir, ".git", "hooks", "pre-commit");
  const hookBefore = fs.readFileSync(hookPath, "utf8");
  const preload = fsFailurePreload(tempDir);
  const result = run(
    "node",
    ["--import", preload, path.join(tempDir, "scripts", "uninstall.mjs")],
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
  assert.equal(fs.readFileSync(hookPath, "utf8"), hookBefore);
});

test("uninstall reports a package write failure after preflight", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, ".commitmentrc.json"), "{}\n");
  assert.equal(runScript(tempDir, "init").status, 0);
  const packagePath = path.join(tempDir, "package.json");
  const packageBefore = readFile(tempDir, "package.json");
  const standaloneBefore = readFile(tempDir, ".commitmentrc.json");
  const hookPath = gitHook(tempDir, "pre-commit");
  const hookBefore = fs.readFileSync(hookPath, "utf8");
  const preload = mutableProjectFileFailurePreload(tempDir);

  const result = run(
    "node",
    ["--import", preload, path.join(tempDir, "scripts", "uninstall.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        TEST_FS_FAILURE_METHOD: "writeSync",
        TEST_FS_FAILURE_PATH: packagePath,
        TEST_FS_FAILURE_CODE: "EIO",
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /filesystem write failed before hook cleanup began/i);
  assert.equal(readFile(tempDir, "package.json"), packageBefore);
  assert.equal(readFile(tempDir, ".commitmentrc.json"), standaloneBefore);
  assert.equal(fs.readFileSync(hookPath, "utf8"), hookBefore);
  assert.deepEqual(
    fs
      .readdirSync(tempDir)
      .filter(
        (entry) =>
          entry.includes(".commitment-issues-") && entry.endsWith(".tmp"),
      ),
    [],
  );

  assert.equal(runScript(tempDir, "uninstall").status, 0);
  assert.equal(fs.existsSync(hookPath), false);
  assert.equal(fs.existsSync(path.join(tempDir, ".commitmentrc.json")), false);
});

test("uninstall preserves hooks when standalone configuration removal fails", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const standalonePath = path.join(tempDir, ".commitmentrc.json");
  writeFile(standalonePath, "{}\n");
  assert.equal(runScript(tempDir, "init").status, 0);
  const standaloneBefore = fs.readFileSync(standalonePath, "utf8");
  const hookPath = gitHook(tempDir, "pre-commit");
  const hookBefore = fs.readFileSync(hookPath, "utf8");
  const preload = fsFailurePreload(tempDir);

  const result = run(
    "node",
    ["--import", preload, path.join(tempDir, "scripts", "uninstall.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        TEST_FS_FAILURE_METHOD: "rmSync",
        TEST_FS_FAILURE_PATH: standalonePath,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Could not remove \.commitmentrc\.json/);
  assert.match(output, /Hook cleanup did not begin/);
  assert.doesNotThrow(() => JSON.parse(readFile(tempDir, "package.json")));
  assert.equal(fs.readFileSync(standalonePath, "utf8"), standaloneBefore);
  assert.equal(fs.readFileSync(hookPath, "utf8"), hookBefore);

  assert.equal(runScript(tempDir, "uninstall").status, 0);
  assert.equal(fs.existsSync(standalonePath), false);
  assert.equal(fs.existsSync(hookPath), false);
});

for (const fileName of ["package.json", ".commitmentrc.json"]) {
  test(`uninstall refuses a linked ${fileName} before changing project or hook state`, (t) => {
    const tempDir = createTempRepo();
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "commitment-outside-project-"),
    );
    t.after(() => {
      cleanupTempRepo(tempDir);
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    if (fileName === ".commitmentrc.json") {
      writeFile(
        path.join(tempDir, fileName),
        '{\n  "advisePushTests": true\n}\n',
      );
    }
    assert.equal(runScript(tempDir, "init").status, 0);

    const packageBefore = readFile(tempDir, "package.json");
    const hookPath = gitHook(tempDir, "pre-commit");
    const hookBefore = fs.readFileSync(hookPath, "utf8");
    const projectPath = path.join(tempDir, fileName);
    const outsidePath = path.join(outsideDir, fileName.replace(/^\./, ""));
    const outsideContent =
      fileName === "package.json"
        ? packageBefore
        : fs.readFileSync(projectPath, "utf8");
    writeFile(outsidePath, outsideContent);
    fs.rmSync(projectPath);
    fs.symlinkSync(outsidePath, projectPath);

    for (const args of [["--dry-run"], []]) {
      const result = runScript(tempDir, "uninstall", args);
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
      assert.equal(fs.readFileSync(hookPath, "utf8"), hookBefore);
    }
  });
}

test("uninstall --dry-run previews the exact cleanup without writing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "consumer", version: "1.0.0" });
  assert.equal(runScript(tempDir, "init").status, 0);

  const beforePackage = readFile(tempDir, "package.json");
  const beforeCommitHook = readFile(tempDir, ".git/hooks/pre-commit");
  const result = runScript(tempDir, "uninstall", ["--dry-run"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /uninstall preview/i);
  assert.match(output, /Would remove:/);
  assert.match(output, /package scripts: prepare/);
  assert.match(output, /\.git\/hooks\/pre-commit/);
  assert.equal(countTerminalBoxes(output), 1);
  assert.equal(readFile(tempDir, "package.json"), beforePackage);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), beforeCommitHook);
});

test("uninstall previews and removes standalone configuration", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, { name: "consumer", version: "1.0.0" });
  writeFile(
    path.join(tempDir, ".commitmentrc.json"),
    '{\n  "requireTests": false\n}\n',
  );
  assert.equal(runScript(tempDir, "init").status, 0);

  const preview = runScript(tempDir, "uninstall", ["--dry-run"]);
  assert.equal(preview.status, 0);
  assert.match(`${preview.stdout}${preview.stderr}`, /\.commitmentrc\.json/);
  assert.equal(fs.existsSync(path.join(tempDir, ".commitmentrc.json")), true);

  const result = runScript(tempDir, "uninstall");
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /\.commitmentrc\.json/);
  assert.equal(fs.existsSync(path.join(tempDir, ".commitmentrc.json")), false);
  assert.equal("precommitChecks" in readPackage(tempDir), false);
});

test("uninstall rejects malformed standalone config before cleanup", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    scripts: { doctor: "commitment-issues doctor" },
  });
  writeFile(path.join(tempDir, ".commitmentrc.json"), "[invalid\n");
  const beforePackage = readFile(tempDir, "package.json");

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Invalid \.commitmentrc\.json/);
  assert.match(output, /No files were changed/);
  assert.equal(readFile(tempDir, "package.json"), beforePackage);
  assert.equal(readFile(tempDir, ".commitmentrc.json"), "[invalid\n");
});

test("uninstall previews and removes an owned commit-msg hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    precommitChecks: {
      commitMessage: { enabled: true, blockOnFailure: true },
    },
  });
  assert.equal(runScript(tempDir, "init").status, 0);
  const before = readFile(tempDir, ".git/hooks/commit-msg");

  const preview = runScript(tempDir, "uninstall", ["--dry-run"]);
  assert.equal(preview.status, 0);
  assert.match(
    `${preview.stdout}${preview.stderr}`,
    /\.git\/hooks\/commit-msg/,
  );
  assert.equal(readFile(tempDir, ".git/hooks/commit-msg"), before);

  const result = runScript(tempDir, "uninstall");
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /\.git\/hooks\/commit-msg/);
  assert.equal(fs.existsSync(gitHook(tempDir, "commit-msg")), false);
});

test("uninstall preserves customized commit-msg hooks for manual cleanup", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    precommitChecks: { commitMessage: { enabled: true } },
  });
  const customHook = `#!/bin/sh\n${hookInvocation("commit-msg")}\necho custom\n`;
  writeFile(gitHook(tempDir, "commit-msg"), customHook);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /commit-msg is customized/);
  assert.equal(countTerminalBoxes(output), 1);
  assert.equal(readFile(tempDir, ".git/hooks/commit-msg"), customHook);
});

test("uninstall reports a displaced managed dispatcher in a native hook", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const customHook = `#!/bin/sh\necho custom\n${hookInvocation("pre-commit")}\n`;
  writeFile(gitHook(tempDir, "pre-commit"), customHook);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Manual cleanup still needed/);
  assert.match(output, /\.git\/hooks\/pre-commit is customized/);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), customHook);
});

test("uninstall reports legacy local hook commands for manual cleanup", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const legacyHook =
    "#!/bin/sh\nnode_modules/.bin/commitment-issues precommit || exit $?\necho custom\n";
  writeFile(gitHook(tempDir, "pre-commit"), legacyHook);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /pre-commit is customized/);
  assert.match(output, /remove its commitment-issues command manually/i);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), legacyHook);
});

test("uninstall dry-run consolidates customized-hook cleanup", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const hook = gitHook(tempDir, "pre-commit");
  const customHook = `#!/bin/sh\n${hookInvocation("pre-commit")}\necho custom\n`;
  writeFile(hook, customHook);

  const result = runScript(tempDir, "uninstall", ["--dry-run"]);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /uninstall preview/i);
  assert.match(output, /Manual cleanup would still be needed/);
  assert.equal(countTerminalBoxes(output), 1);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), customHook);
});

test("uninstall removes an appended prepare repair and preserves prepare", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    scripts: { prepare: "node build-assets.mjs" },
  });
  assert.equal(runScript(tempDir, "init").status, 0);
  assert.equal(
    readPackage(tempDir).scripts.prepare,
    "node build-assets.mjs && commitment-issues doctor --quiet",
  );

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;
  const pkg = readPackage(tempDir);

  assert.equal(result.status, 0);
  assert.deepEqual(pkg.scripts, { prepare: "node build-assets.mjs" });
  assert.match(output, /package\.json prepare repair/);
});

test("uninstall preserves customized scripts and hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    scripts: {
      prepare: "node build-assets.mjs",
      doctor: "node custom-doctor.mjs",
      "fix:staged": "commitment-issues fix-staged",
    },
    precommitChecks: { tone: "fun" },
  });
  fs.mkdirSync(path.join(tempDir, ".git", "hooks"), { recursive: true });
  const customHook = `#!/bin/sh\n${hookInvocation("pre-commit")}\necho custom check\n`;
  fs.writeFileSync(gitHook(tempDir, "pre-commit"), customHook);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  const pkg = readPackage(tempDir);
  assert.equal(pkg.scripts.prepare, "node build-assets.mjs");
  assert.equal(pkg.scripts.doctor, "node custom-doctor.mjs");
  assert.equal("fix:staged" in pkg.scripts, false);
  assert.equal("precommitChecks" in pkg, false);
  assert.equal(readFile(tempDir, ".git/hooks/pre-commit"), customHook);
  assert.match(output, /Manual cleanup still needed/);
  assert.match(output, /pre-commit is customized/);
  assert.equal(countTerminalBoxes(output), 1);
});

test("uninstall inspects an active custom hooks directory safely", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const customHooks = path.join(tempDir, "githooks");
  fs.mkdirSync(customHooks, { recursive: true });
  fs.writeFileSync(
    path.join(customHooks, "pre-commit"),
    hookBody("pre-commit"),
  );
  fs.writeFileSync(
    path.join(customHooks, "pre-push"),
    `#!/bin/sh\n${hookInvocation("pre-push")}\necho custom push\n`,
  );
  run("git", ["config", "core.hooksPath", "githooks"], tempDir);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(customHooks, "pre-commit")), false);
  assert.equal(
    readFile(tempDir, "githooks/pre-push"),
    `#!/bin/sh\n${hookInvocation("pre-push")}\necho custom push\n`,
  );
  assert.match(output, /githooks\/pre-push is customized/);
});

test("uninstall inspects the repository root for a configured empty hooksPath", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const rootHook = path.join(tempDir, "pre-commit");
  fs.writeFileSync(rootHook, hookBody("pre-commit"));
  const set = run("git", ["config", "core.hooksPath", ""], tempDir);
  assert.equal(set.status, 0, `${set.stdout}${set.stderr}`);

  const result = runScript(tempDir, "uninstall");

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(rootHook), false);
  assert.equal(
    run("git", ["config", "--get", "core.hooksPath"], tempDir).status,
    0,
  );
});

test("uninstall resolves a tilde-based active hooks directory through Git", (t) => {
  const tempDir = createTempRepo();
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-home-"));
  t.after(() => cleanupTempRepo(tempDir));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));

  const hooksDir = path.join(homeDir, "shared hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const name of ["pre-commit", "pre-push"]) {
    fs.writeFileSync(path.join(hooksDir, name), hookBody(name));
    fs.chmodSync(path.join(hooksDir, name), 0o755);
  }
  run("git", ["config", "core.hooksPath", "~/shared hooks"], tempDir);

  const result = runScript(tempDir, "uninstall", [], {
    env: { ...process.env, HOME: homeDir },
  });

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(hooksDir, "pre-commit")), false);
  assert.equal(fs.existsSync(path.join(hooksDir, "pre-push")), false);
});

test("uninstall displays absolute hook paths outside the project", (t) => {
  const tempDir = createTempRepo();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-hooks-"));
  t.after(() => cleanupTempRepo(tempDir));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));

  fs.writeFileSync(path.join(external, "pre-commit"), hookBody("pre-commit"));
  fs.chmodSync(path.join(external, "pre-commit"), 0o755);
  run("git", ["config", "core.hooksPath", external], tempDir);

  const result = runScript(tempDir, "uninstall", ["--dry-run"]);

  assert.equal(result.status, 0);
  const expectedPath = external.replace(/\\/g, "/");
  assert.match(
    compactTerminalBoxText(`${result.stdout}${result.stderr}`),
    new RegExp(expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("uninstall reports legacy commands in an active Husky directory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, ".husky", "pre-commit"),
    `#!/bin/sh\n${hookInvocation("pre-commit")}\n`,
  );
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(
    readFile(tempDir, ".husky/pre-commit"),
    `#!/bin/sh\n${hookInvocation("pre-commit")}\n`,
  );
  assert.match(output, /\.husky\/pre-commit is customized/);
});

test("uninstall preserves package-identical hooks in an active Husky directory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const name of ["pre-commit", "pre-push"]) {
    writeFile(path.join(tempDir, ".husky", name), hookBody(name));
    fs.chmodSync(path.join(tempDir, ".husky", name), 0o755);
  }
  run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  for (const name of ["pre-commit", "pre-push"]) {
    assert.equal(readFile(tempDir, `.husky/${name}`), hookBody(name));
    assert.match(output, new RegExp(`\\.husky/${name} is Husky-owned`));
  }
});

test(
  "uninstall preserves a symbolic-link .husky directory and its external target",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "uninstall-husky-link-"),
    );
    t.after(() => cleanupTempRepo(tempDir));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

    fs.writeFileSync(path.join(outside, "pre-commit"), hookBody("pre-commit"));
    fs.symlinkSync(outside, path.join(tempDir, ".husky"), "dir");
    run("git", ["config", "core.hooksPath", ".husky/_"], tempDir);

    const result = runScript(tempDir, "uninstall");
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0);
    assert.match(output, /symbolic link|could not be safely inspected/i);
    assert.match(output, /left unchanged|manual/i);
    assert.equal(
      fs.readFileSync(path.join(outside, "pre-commit"), "utf8"),
      hookBody("pre-commit"),
    );
  },
);

test("uninstall does not inspect the native hooks directory twice", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  assert.equal(runScript(tempDir, "init").status, 0);
  run("git", ["config", "core.hooksPath", ".git/hooks"], tempDir);

  const result = runScript(tempDir, "uninstall");

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  assert.equal(fs.existsSync(gitHook(tempDir, "pre-push")), false);
});

test("uninstall preserves a hook path it cannot inspect", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  fs.mkdirSync(gitHook(tempDir, "pre-commit"), { recursive: true });
  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal(fs.statSync(gitHook(tempDir, "pre-commit")).isDirectory(), true);
  assert.match(output, /pre-commit could not be inspected/);
  assert.match(output, /left unchanged/);
});

test("uninstall leaves hooks untouched when core.hooksPath cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  assert.equal(runScript(tempDir, "init").status, 0);
  const preCommit = fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8");
  const env = fakeGitEnv(tempDir, "--get core.hooksPath", 128);

  const result = runScript(tempDir, "uninstall", [], { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not determine core\.hooksPath/i);
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    preCommit,
  );
  assert.equal("precommitChecks" in readPackage(tempDir), false);
});

test("uninstall leaves hooks untouched when the native hooks directory cannot be resolved", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  assert.equal(runScript(tempDir, "init").status, 0);
  const preCommit = fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8");
  const env = fakeGitEnv(tempDir, "rev-parse --git-common-dir", 128);

  const result = runScript(tempDir, "uninstall", [], { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not locate the hooks directory/i);
  assert.equal(
    fs.readFileSync(gitHook(tempDir, "pre-commit"), "utf8"),
    preCommit,
  );
});

test("uninstall leaves configured hooks untouched when their directory cannot be resolved", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const customDir = path.join(tempDir, "custom-hooks");
  fs.mkdirSync(customDir);
  const preCommit = path.join(customDir, "pre-commit");
  fs.writeFileSync(preCommit, hookBody("pre-commit"));
  fs.chmodSync(preCommit, 0o755);
  assert.equal(
    run("git", ["config", "core.hooksPath", "custom-hooks"], tempDir).status,
    0,
  );
  const env = fakeGitEnv(tempDir, "rev-parse --git-path hooks", 128);

  const result = runScript(tempDir, "uninstall", [], { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /could not resolve the configured hooks directory/i);
  assert.equal(fs.readFileSync(preCommit, "utf8"), hookBody("pre-commit"));
});

test("uninstall cleans package.json outside a git repository and warns", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-nongit-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    scripts: { doctor: "commitment-issues doctor" },
    precommitChecks: { advisePushTests: true },
  });

  const result = run(
    "node",
    [path.join(repoRoot, "scripts", "uninstall.mjs")],
    tempDir,
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal("scripts" in readPackage(tempDir), false);
  assert.equal("precommitChecks" in readPackage(tempDir), false);
  assert.match(output, /not a git repository/);
});

test("uninstall cleans package.json in a bare repository without inspecting hooks", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-bare-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  assert.equal(run("git", ["init", "--bare"], tempDir).status, 0);
  writePackage(tempDir, {
    name: "consumer",
    version: "1.0.0",
    scripts: { doctor: "commitment-issues doctor" },
    precommitChecks: { advisePushTests: true },
  });

  const result = run(
    "node",
    [path.join(repoRoot, "scripts", "uninstall.mjs")],
    tempDir,
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.equal("scripts" in readPackage(tempDir), false);
  assert.equal("precommitChecks" in readPackage(tempDir), false);
  assert.match(output, /bare git repository/i);
  assert.equal(fs.existsSync(path.join(tempDir, "hooks", "pre-commit")), false);
});

test("uninstall errors clearly without a valid package.json", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uninstall-errors-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const missing = run(
    "node",
    [path.join(repoRoot, "scripts", "uninstall.mjs")],
    tempDir,
  );
  assert.equal(missing.status, 1);
  assert.match(`${missing.stdout}${missing.stderr}`, /No package\.json found/);

  writeFile(path.join(tempDir, "package.json"), "{ invalid\n");
  const invalid = run(
    "node",
    [path.join(repoRoot, "scripts", "uninstall.mjs")],
    tempDir,
  );
  assert.equal(invalid.status, 1);
  assert.match(`${invalid.stdout}${invalid.stderr}`, /Invalid package\.json/);
});

const coexistenceFixtures = {
  husky: {
    file: ".husky/pre-commit",
    content: `#!/bin/sh\n${hookInvocation("pre-commit")}\necho custom\necho preserved\n`,
    legacyContent:
      "#!/bin/sh\nnode_modules/.bin/commitment-issues precommit || exit $?\necho custom\necho preserved\n",
  },
  lefthook: {
    file: "lefthook.yml",
    content: hookManagerSnippets("lefthook", ["pre-commit", "pre-push"])
      .map(({ content }) => content)
      .join(""),
    legacyContent: [
      "pre-commit:",
      "  commands:",
      "    commitment-issues:",
      "      run: node_modules/.bin/commitment-issues precommit",
      "pre-push:",
      "  commands:",
      "    commitment-issues:",
      "      run: node_modules/.bin/commitment-issues prepush",
      "      use_stdin: true",
      "",
    ].join("\n"),
  },
  "pre-commit": {
    file: ".pre-commit-config.yaml",
    content: `repos:\n  - repo: local\n    hooks:\n${
      hookManagerSnippets("pre-commit", ["pre-commit"])[0].content
    }`,
    legacyContent: [
      "repos:",
      "  - repo: local",
      "    hooks:",
      "      - id: commitment-issues-pre-commit",
      "        name: commitment-issues pre-commit",
      "        entry: node_modules/.bin/commitment-issues precommit",
      "        language: system",
      "        pass_filenames: false",
      "        always_run: true",
      "        stages: [pre-commit]",
      "",
    ].join("\n"),
  },
};

for (const [manager, fixture] of Object.entries(coexistenceFixtures)) {
  test(`uninstall preserves user-owned ${manager} integration content`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    writePackage(tempDir, {
      name: `${manager}-consumer`,
      version: "1.0.0",
      scripts: {
        prepare: `setup-manager && commitment-issues doctor --quiet --integration=${manager}`,
        doctor: "commitment-issues doctor",
      },
      precommitChecks: { advisePushTests: true },
      devDependencies: { [manager === "pre-commit" ? "tool" : manager]: "1" },
    });
    if (manager === "husky") {
      fs.mkdirSync(path.join(tempDir, ".husky"), { recursive: true });
    }
    writeFile(path.join(tempDir, fixture.file), fixture.content);

    const preview = runScript(tempDir, "uninstall", ["--dry-run"]);
    assert.equal(preview.status, 0);
    assert.match(
      `${preview.stdout}${preview.stderr}`,
      new RegExp(`${manager} configuration is user-owned`, "i"),
    );
    assert.equal(readFile(tempDir, fixture.file), fixture.content);
    assert.match(
      readPackage(tempDir).scripts.prepare,
      /commitment-issues doctor --quiet --integration=/,
    );

    const result = runScript(tempDir, "uninstall");
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, /Manual cleanup still needed/);
    assert.match(
      output,
      new RegExp(`${manager} configuration is user-owned`, "i"),
    );
    assert.equal(readFile(tempDir, fixture.file), fixture.content);
    assert.deepEqual(readPackage(tempDir).scripts, {
      prepare: "setup-manager",
    });
    assert.equal(fs.existsSync(gitHook(tempDir, "pre-commit")), false);
  });

  test(`uninstall reports pre-dispatch ${manager} entries without changing them`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    writePackage(tempDir, {
      name: `${manager}-legacy-consumer`,
      version: "1.0.0",
      scripts: {
        prepare: `setup-manager && commitment-issues doctor --quiet --integration=${manager}`,
        doctor: "commitment-issues doctor",
      },
      precommitChecks: { advisePushTests: true },
      devDependencies: { [manager === "pre-commit" ? "tool" : manager]: "1" },
    });
    if (manager === "husky") {
      fs.mkdirSync(path.join(tempDir, ".husky"), { recursive: true });
    }
    writeFile(path.join(tempDir, fixture.file), fixture.legacyContent);

    const preview = runScript(tempDir, "uninstall", ["--dry-run"]);
    assert.equal(preview.status, 0);
    assert.match(
      `${preview.stdout}${preview.stderr}`,
      new RegExp(`${manager} configuration is user-owned`, "i"),
    );
    assert.equal(readFile(tempDir, fixture.file), fixture.legacyContent);

    const result = runScript(tempDir, "uninstall");
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0);
    assert.match(output, /Manual cleanup still needed/);
    assert.match(
      output,
      new RegExp(`${manager} configuration is user-owned`, "i"),
    );
    assert.equal(readFile(tempDir, fixture.file), fixture.legacyContent);
    assert.deepEqual(readPackage(tempDir).scripts, {
      prepare: "setup-manager",
    });
  });
}

test("uninstall reports a displaced dispatcher in inactive Husky hooks", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "inactive-husky-consumer",
    version: "1.0.0",
    devDependencies: { husky: "9.1.7" },
  });
  const customHook = `#!/bin/sh\necho custom\n${hookInvocation("pre-commit")}\n`;
  writeFile(path.join(tempDir, ".husky", "pre-commit"), customHook);

  const result = runScript(tempDir, "uninstall");
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0);
  assert.match(output, /Manual cleanup still needed/);
  assert.match(output, /husky configuration is user-owned/i);
  assert.match(output, /pre-commit entry manually/i);
  assert.equal(readFile(tempDir, ".husky/pre-commit"), customHook);
});

test("uninstall preserves ambiguous manager configuration for manual cleanup", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writePackage(tempDir, {
    name: "ambiguous-lefthook-consumer",
    version: "1.0.0",
    scripts: {
      prepare: "commitment-issues doctor --quiet --integration=lefthook",
    },
    devDependencies: { lefthook: "2" },
  });
  const yml = "pre-commit: {}\n";
  const yaml = "pre-push: {}\n";
  writeFile(path.join(tempDir, "lefthook.yml"), yml);
  writeFile(path.join(tempDir, "lefthook.yaml"), yaml);

  const preview = runScript(tempDir, "uninstall", ["--dry-run"]);
  assert.equal(preview.status, 0);
  const previewOutput = compactTerminalBoxText(
    `${preview.stdout}${preview.stderr}`,
  );
  assert.match(
    previewOutput,
    /lefthook configuration could not be inspected safely and was left/i,
  );
  assert.match(previewOutput, /unchanged/i);
  assert.equal(readFile(tempDir, "lefthook.yml"), yml);
  assert.equal(readFile(tempDir, "lefthook.yaml"), yaml);

  const result = runScript(tempDir, "uninstall");
  assert.equal(result.status, 0);
  const output = compactTerminalBoxText(`${result.stdout}${result.stderr}`);
  assert.match(
    output,
    /lefthook configuration could not be inspected safely and was left/i,
  );
  assert.match(output, /unchanged/i);
  assert.equal(readFile(tempDir, "lefthook.yml"), yml);
  assert.equal(readFile(tempDir, "lefthook.yaml"), yaml);
  assert.equal(readPackage(tempDir).scripts, undefined);
});
