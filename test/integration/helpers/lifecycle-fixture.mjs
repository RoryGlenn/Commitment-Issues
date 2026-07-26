// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";
import {
  hasExactOutputLine,
  shouldEnforcePosixPackageModes,
  SUPPLIED_TARBALL_DIGEST_PREFIX,
  YARN_BERRY_VERSION,
  YARN_CLASSIC_VERSION,
} from "../../../scripts/lib/lifecycle-managers.mjs";
import {
  findBrokenMarkdownLinksInDirectory,
  formatBrokenMarkdownLink,
} from "../../../tools/packed-markdown-links.mjs";
import {
  HUSKY_V9_RUNTIME,
  lefthookRunner,
  preCommitRunner,
} from "../../helpers/hook-manager-fixtures.mjs";
import { prepareRepairCommand } from "../../../scripts/lib/hooks.mjs";

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(integrationDir, "..", "..", "..");
const managerDispatchHarnessPath = path.join(
  integrationDir,
  "hook-manager-dispatch-harness.mjs",
);

// Which package manager to exercise end to end. Defaults to npm. Yarn Classic
// and Yarn Berry are separate identities so their versions, commands, layouts,
// and CI evidence cannot accidentally satisfy one another's support claims.
const packageManager = process.env.COMMITMENT_ISSUES_LIFECYCLE_PM ?? "npm";

const yarnClassicCli = path.join(
  root,
  "node_modules",
  "yarn",
  "bin",
  "yarn.js",
);
const yarnBerryFixtureDir = path.join(root, "test", "fixtures", "yarn-berry");
const yarnBerryCli = path.join(
  yarnBerryFixtureDir,
  "node_modules",
  "@yarnpkg",
  "cli-dist",
  "bin",
  "yarn.js",
);
const isYarnBerryLifecycle = packageManager === "yarn-berry";
const packageManagerHint =
  packageManager === "yarn-berry" ? "yarn" : packageManager;

function managerInvocation(args) {
  if (packageManager === "yarn") {
    return [process.execPath, [yarnClassicCli, ...args]];
  }
  if (isYarnBerryLifecycle) {
    return [process.execPath, [yarnBerryCli, ...args]];
  }
  return [packageManager, args];
}

function resolveTarball(input) {
  if (input === undefined) return undefined;

  const resolved = path.resolve(root, input);
  if (path.extname(resolved) !== ".tgz") {
    throw new Error(`Lifecycle tarball must use the .tgz extension: ${input}`);
  }
  try {
    if (!fs.lstatSync(resolved).isFile()) {
      throw new Error(`Lifecycle tarball is not a regular file: ${input}`);
    }
    fs.accessSync(resolved, fs.constants.R_OK);
    return fs.realpathSync.native(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Lifecycle tarball does not exist: ${input}`);
    }
    if (error?.code === "EACCES") {
      throw new Error(`Lifecycle tarball is not readable: ${input}`);
    }
    throw error;
  }
}

// Keep the exact Node 22.11.0 lane on ESLint 9: ESLint 10 and its current
// transitive packages require a newer Node 22 patch. Newer supported runtimes
// exercise ESLint 10 so both declared peer majors stay covered.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const eslintMajor = nodeMajor === 22 && nodeMinor < 13 ? 9 : 10;
const DEV_DEPS = [
  `eslint@^${eslintMajor}`,
  "prettier@^3",
  `@eslint/js@^${eslintMajor}`,
  "globals@^17",
];
const EXISTING_PREPARE = "node scripts/existing-prepare.mjs";
const ROOT_PACKAGE_CONFIG = { tone: "standard" };
const STANDALONE_CONFIG = { commitMessage: { enabled: true } };
const WORKSPACE_GLOBS = ["packages/*", "packages/nested/*"];
const WORKSPACE_PACKAGES = [
  {
    dir: "packages/app",
    name: "@commitment-issues-fixture/app",
    stem: "app-widget",
  },
  {
    dir: "packages/nested/lib",
    name: "@commitment-issues-fixture/nested-lib",
    stem: "nested-widget",
  },
];
const PACKAGE_LOCAL_CONFIG = {
  // This intentionally conflicts with the branches exercised below. A commit
  // started inside the nested package still succeeds because Git runs the
  // shared hook from the repository root, whose config owns the whole repo.
  blockProtectedBranches: true,
  protectedBranches: ["main", "master", "workspace-lifecycle"],
};
const MANAGED_EXPECTED_SCRIPTS = {
  "commit:fix": "commitment-issues commit-fix",
  "fix:staged": "commitment-issues fix-staged",
  "test:precommit": "commitment-issues precommit",
  doctor: "commitment-issues doctor",
};
const EXPECTED_SCRIPTS = {
  prepare: `${EXISTING_PREPARE} && ${prepareRepairCommand()}`,
  ...MANAGED_EXPECTED_SCRIPTS,
};
const HOOK_SUBCOMMANDS = {
  "pre-commit": "precommit",
  "pre-push": "prepush",
  "commit-msg": 'commit-msg "$1"',
};
const LOCAL_MANAGER_BIN = "node_modules/.bin/commitment-issues";
const LOCAL_MANAGER_BIN_CANDIDATES = [
  LOCAL_MANAGER_BIN,
  `${LOCAL_MANAGER_BIN}.exe`,
  `${LOCAL_MANAGER_BIN}.cmd`,
  `${LOCAL_MANAGER_BIN}.bat`,
];

function managerCandidateLoop(command) {
  return `for commitment_issues_bin in ${LOCAL_MANAGER_BIN_CANDIDATES.join(" ")}; do if test -f "$commitment_issues_bin"; then if test -x "$commitment_issues_bin"; then ${command}; fi; fi; done`;
}

function guardedManagerCommand(name, manager) {
  const subcommand = HOOK_SUBCOMMANDS[name].split(" ", 1)[0];
  if (manager === "husky") {
    const suffix =
      name === "pre-push" ? ' "$@"' : name === "commit-msg" ? ' "$1"' : "";
    return managerCandidateLoop(
      `"$commitment_issues_bin" hook ${subcommand}${suffix} || exit $?; break`,
    );
  }
  if (manager === "lefthook") {
    const environment =
      name === "commit-msg" ? "" : "COMMITMENT_ISSUES_LEFTHOOK_FILE={files} ";
    const suffix = name === "commit-msg" ? " --git-path" : "";
    return managerCandidateLoop(
      `${environment}exec "$commitment_issues_bin" hook ${subcommand}${suffix}`,
    );
  }
  return `sh -c '${managerCandidateLoop(
    `exec "$commitment_issues_bin" hook ${subcommand} "$@"`,
  )}' --`;
}

// Yarn Berry's file protocol expects a package identity and has ambiguous
// absolute-drive handling on Windows. Stage the unchanged bytes at a fixed
// sibling path so every OS can resolve the same relative locator.
function yarnBerryTarballSpec(tarball, tempRoot) {
  const artifactDir = path.join(tempRoot, "yarn-berry-artifact");
  const artifact = path.join(artifactDir, "commitment-issues.tgz");
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.copyFileSync(tarball, artifact);
  assertLifecycle(
    sha256(artifact) === sha256(tarball),
    "the staged Yarn Berry tarball must match the packed artifact",
  );
  return "commitment-issues@file:../yarn-berry-artifact/commitment-issues.tgz";
}

// Install the packed tarball plus the peer tools using the selected manager.
function installDevDeps(tarball, tempRoot) {
  switch (packageManager) {
    case "pnpm":
      return [
        "pnpm",
        ["add", "--save-dev", "--workspace-root", tarball, ...DEV_DEPS],
      ];
    case "yarn":
      return managerInvocation([
        "add",
        "--dev",
        "--ignore-workspace-root-check",
        tarball,
        ...DEV_DEPS,
      ]);
    case "yarn-berry":
      return managerInvocation([
        "add",
        "--dev",
        yarnBerryTarballSpec(tarball, tempRoot),
        ...DEV_DEPS,
      ]);
    case "bun":
      return ["bun", ["add", "--dev", tarball, ...DEV_DEPS]];
    default:
      return ["npm", ["install", "-D", tarball, ...DEV_DEPS]];
  }
}

// Reinstall an already-configured checkout. This is the path that must invoke
// composed prepare repair and recreate clone-local .git/hooks files.
function installProject({ ignoreScripts = false } = {}) {
  const scriptArgs = ignoreScripts ? ["--ignore-scripts"] : [];
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", ["install", ...scriptArgs]];
    case "yarn":
      return managerInvocation(["install", ...scriptArgs]);
    case "yarn-berry":
      return managerInvocation([
        "install",
        ...(ignoreScripts ? ["--mode=skip-build"] : []),
      ]);
    case "bun":
      return ["bun", ["install", ...scriptArgs]];
    default:
      return ["npm", ["install", ...scriptArgs]];
  }
}

// Exercise each manager's clean production install surface with
// NODE_ENV=production. npm runs both common --omit=dev forms because its root
// prepare lifecycle is the regression that originally exposed this bug.
function productionInstallCommands() {
  const productionEnv = { ...lifecycleEnv(), NODE_ENV: "production" };
  switch (packageManager) {
    case "pnpm":
      return [["pnpm", ["install", "--prod"], productionEnv]];
    case "yarn":
      return [
        [...managerInvocation(["install", "--production=true"]), productionEnv],
      ];
    case "yarn-berry":
      return [
        [
          ...managerInvocation([
            "workspaces",
            "focus",
            "--all",
            "--production",
          ]),
          productionEnv,
        ],
      ];
    case "bun":
      return [["bun", ["install", "--production"], productionEnv]];
    default:
      return [
        ["npm", ["ci", "--omit=dev"], lifecycleEnv()],
        ["npm", ["install", "--omit=dev"], productionEnv],
      ];
  }
}

// Remove the package dependency after its own uninstaller has removed only the
// configuration and hook artifacts it owns.
function removeInstalledPackage() {
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", ["remove", "--workspace-root", "commitment-issues"]];
    case "yarn":
      return managerInvocation([
        "remove",
        "--ignore-workspace-root-check",
        "commitment-issues",
      ]);
    case "yarn-berry":
      return managerInvocation(["remove", "commitment-issues"]);
    case "bun":
      return ["bun", ["remove", "commitment-issues"]];
    default:
      return ["npm", ["remove", "commitment-issues"]];
  }
}

function expectedRemoveGuidance() {
  switch (packageManager) {
    case "pnpm":
      return "pnpm remove --workspace-root commitment-issues";
    case "yarn":
      return "yarn remove --ignore-workspace-root-check commitment-issues";
    case "yarn-berry":
      return "yarn remove commitment-issues";
    case "bun":
      return "bun remove commitment-issues";
    default:
      return "npm remove commitment-issues";
  }
}

// Exercise each manager's own workspace traversal before Git hooks run the
// same package tests from changed paths.
function workspaceTestCommand() {
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", ["--recursive", "run", "test"]];
    case "yarn":
      return managerInvocation(["workspaces", "run", "test"]);
    case "yarn-berry":
      return managerInvocation([
        "workspaces",
        "foreach",
        "--all",
        "run",
        "test",
      ]);
    case "bun":
      return ["bun", ["run", "--workspaces", "--if-present", "test"]];
    default:
      return ["npm", ["run", "test", "--workspaces", "--if-present"]];
  }
}

function runWorkspaceTests(repoDir) {
  const [command, args] = workspaceTestCommand();
  const output = runForOutput(command, args, repoDir);
  if (output) {
    console.log(output);
  }
  for (const workspace of WORKSPACE_PACKAGES) {
    assertLifecycle(
      output.includes(`${workspace.name} workspace script passed`),
      `${packageManager} should run the test script for ${workspace.name}`,
    );
  }
}

// Run the installed commitment-issues bin through each manager's offline/local
// execution surface so a missing packed bin cannot be hidden by a download.
function execBin(args) {
  switch (packageManager) {
    case "pnpm":
      return ["pnpm", ["exec", "commitment-issues", ...args]];
    case "yarn":
    case "yarn-berry":
      return managerInvocation(["run", "commitment-issues", ...args]);
    case "bun":
      return ["bunx", ["--no-install", "commitment-issues", ...args]];
    default:
      return ["npx", ["--no-install", "commitment-issues", ...args]];
  }
}

function lifecycleEnv() {
  const env = { ...process.env };
  // CI invokes this integration through an outer npm script. Let manager
  // subprocesses set their own user agent and let Git hooks use the fixture's
  // lockfile instead of inheriting a false npm identity.
  const isolatedKeys = new Set(
    [
      "npm_config_user_agent",
      "HUSKY",
      "LEFTHOOK",
      "LEFTHOOK_BIN",
      "LEFTHOOK_CONFIG",
      "LEFTHOOK_VERBOSE",
      "SKIP",
      "COMMITMENT_ISSUES",
      "COMMITMENT_ISSUES_LIFECYCLE_PM",
      "COMMITMENT_ISSUES_LIFECYCLE_TARBALL",
      "COLUMNS",
    ].map((key) => key.toLowerCase()),
  );
  for (const key of Object.keys(env)) {
    if (isolatedKeys.has(key.toLowerCase())) delete env[key];
  }
  // Captured lifecycle output should use the renderer's stable default width.
  // Narrow-terminal wrapping is exercised separately by the welcome tests.
  return env;
}

function managerLifecycleEnv(repoDir, competingManagerBin) {
  const env = lifecycleEnv();
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const fixtureManagerBin = path.join(repoDir, ".lifecycle-manager-bin");
  const localBin = path.join(repoDir, "node_modules", ".bin");
  const homeDir = path.join(repoDir, ".lifecycle-home");
  const configDir = path.join(homeDir, ".config");
  fs.mkdirSync(configDir, { recursive: true });
  for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"]) {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === name.toLowerCase()) delete env[key];
    }
    env[name] = name === "XDG_CONFIG_HOME" ? configDir : homeDir;
  }
  const inheritedPath = pathKey ? env[pathKey] : undefined;
  env[pathKey ?? "PATH"] = [
    fixtureManagerBin,
    localBin,
    competingManagerBin,
    inheritedPath,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  env.LEFTHOOK_BIN = path.join(fixtureManagerBin, "lefthook");
  return env;
}

function withoutLefthookRuntimeCandidates(env, cwd) {
  const isolated = { ...env };
  for (const key of Object.keys(isolated)) {
    if (key.toLowerCase() === "lefthook_bin") delete isolated[key];
  }
  const pathKey = Object.keys(isolated).find(
    (key) => key.toLowerCase() === "path",
  );
  if (!pathKey) return isolated;
  const candidateNames =
    process.platform === "win32"
      ? ["lefthook.exe", "lefthook.bat"]
      : ["lefthook"];
  isolated[pathKey] = isolated[pathKey]
    .split(path.delimiter)
    .filter((entry) => {
      const directory = entry === "" ? cwd : path.resolve(cwd, entry);
      return !candidateNames.some((name) =>
        fs.existsSync(path.join(directory, name)),
      );
    })
    .join(path.delimiter);
  return isolated;
}

function run(command, args, cwd, env = lifecycleEnv()) {
  const result = crossSpawn.sync(command, args, {
    cwd,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}`,
    );
  }
}

function runForOutput(command, args, cwd, env = lifecycleEnv()) {
  const result = crossSpawn.sync(command, args, {
    cwd,
    env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}: ${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

function runForCombinedOutput(command, args, cwd, env = lifecycleEnv()) {
  const result = crossSpawn.sync(command, args, {
    cwd,
    env,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}: ${output}`,
    );
  }

  return output;
}

function assertLifecycle(condition, message) {
  if (!condition) {
    throw new Error(`[lifecycle integration] ${message}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertPackedModes(metadata) {
  // npm creates executable package bins on every platform, but npm's tarball
  // metadata on Windows does not expose authoritative POSIX mode information.
  // The Ubuntu release producer and every POSIX lifecycle lane enforce the
  // archive-mode contract; Windows still exercises every semantic CLI check.
  if (!shouldEnforcePosixPackageModes()) {
    console.log(
      "[lifecycle integration] POSIX package modes: enforced by the Ubuntu/macOS lanes\n",
    );
    return;
  }

  const executableFiles = metadata.files
    .filter((file) => (file.mode & 0o111) !== 0)
    .map((file) => file.path)
    .sort();
  assertLifecycle(
    JSON.stringify(executableFiles) === JSON.stringify(["scripts/cli.mjs"]),
    `only scripts/cli.mjs should be executable, found ${JSON.stringify(executableFiles)}`,
  );
  const cli = metadata.files.find((file) => file.path === "scripts/cli.mjs");
  assertLifecycle(
    cli?.mode === 0o755,
    `scripts/cli.mjs should have packed mode 0755, found ${cli?.mode ?? "missing"}`,
  );
  const nonCliModeDrift = metadata.files
    .filter((file) => file.path !== "scripts/cli.mjs" && file.mode !== 0o644)
    .map((file) => `${file.path}:${file.mode}`);
  assertLifecycle(
    nonCliModeDrift.length === 0,
    `non-CLI files should have packed mode 0644, found ${nonCliModeDrift.join(", ")}`,
  );
}

function inspectPackedTarball(tarball) {
  const output = runForOutput(
    "npm",
    ["pack", tarball, "--dry-run", "--json", "--ignore-scripts"],
    root,
  );
  let records;
  try {
    records = JSON.parse(output);
  } catch {
    throw new Error("npm did not return valid JSON metadata for the tarball");
  }

  assertLifecycle(
    Array.isArray(records) && records.length === 1,
    "npm should report metadata for exactly one packed artifact",
  );
  const metadata = records[0];
  assertLifecycle(
    metadata.name === "commitment-issues" &&
      typeof metadata.version === "string",
    "packed metadata should identify commitment-issues and its version",
  );
  assertLifecycle(
    Array.isArray(metadata.files),
    "packed metadata should include the exact file inventory",
  );

  assertPackedModes(metadata);

  return metadata;
}

function assertInstalledCli(repoDir, packedMetadata) {
  const packageDir = path.join(repoDir, "node_modules", "commitment-issues");
  const installedPackage = readJson(path.join(packageDir, "package.json"));
  assertLifecycle(
    installedPackage.name === packedMetadata.name &&
      installedPackage.version === packedMetadata.version,
    "the installed package identity should match the supplied tarball metadata",
  );
  assertLifecycle(
    JSON.stringify(installedPackage.bin) ===
      JSON.stringify({ "commitment-issues": "scripts/cli.mjs" }),
    "the packed package bin should point only to scripts/cli.mjs",
  );

  const cliSource = fs.readFileSync(
    path.join(packageDir, "scripts", "cli.mjs"),
    "utf8",
  );
  assertLifecycle(
    cliSource.startsWith("#!/usr/bin/env node\n"),
    "scripts/cli.mjs should start with the exact Node shebang",
  );

  const [versionCommand, versionArgs] = execBin(["--version"]);
  const versionOutput = runForOutput(versionCommand, versionArgs, repoDir);
  assertLifecycle(
    hasExactOutputLine(versionOutput, packedMetadata.version),
    `packed CLI should report ${packedMetadata.version} on its own line, found ${JSON.stringify(versionOutput)}`,
  );
}

function assertFileContains(filePath, expected) {
  assertLifecycle(fs.existsSync(filePath), `${filePath} should exist`);
  const content = fs.readFileSync(filePath, "utf8");
  assertLifecycle(
    content.includes(expected),
    `${filePath} should include ${JSON.stringify(expected)}`,
  );
}

function gitCommonDir(repoDir) {
  const commonDir = runForOutput(
    "git",
    ["rev-parse", "--git-common-dir"],
    repoDir,
  );
  return path.resolve(repoDir, commonDir);
}

function hookPath(repoDir, name) {
  return path.join(gitCommonDir(repoDir), "hooks", name);
}

function welcomeMarkerPath(repoDir) {
  return path.join(gitCommonDir(repoDir), "commitment-issues", "welcome-v1");
}

function comparablePath(filePath) {
  const resolved = fs.realpathSync.native(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFilesystemEntry(leftPath, rightPath) {
  const left = fs.statSync(leftPath, { bigint: true });
  const right = fs.statSync(rightPath, { bigint: true });

  // File identity avoids false mismatches between Windows short (8.3) and
  // long spellings of the same Git directory. Some filesystems report zero
  // identifiers, so retain canonical path comparison as a portable fallback.
  if (
    (left.dev !== 0n || left.ino !== 0n) &&
    left.dev === right.dev &&
    left.ino === right.ino
  ) {
    return true;
  }

  return comparablePath(leftPath) === comparablePath(rightPath);
}

function assertHookWired(repoDir, name) {
  const resolvedHookPath = hookPath(repoDir, name);
  const subcommand = HOOK_SUBCOMMANDS[name];
  assertFileContains(resolvedHookPath, `commitment-issues ${subcommand}`);

  // Git for Windows runs hook files through its bundled shell, but POSIX mode
  // bits are not a reliable signal on that filesystem. Keep the executable-bit
  // check where it is meaningful and rely on the real commit/push below on
  // Windows to prove the hooks actually run.
  if (process.platform !== "win32") {
    assertLifecycle(
      Boolean(fs.statSync(resolvedHookPath).mode & 0o111),
      `${resolvedHookPath} should be executable`,
    );
  }
}

function assertPackageJsonConfigured(repoDir) {
  const pkg = readJson(path.join(repoDir, "package.json"));

  for (const [name, value] of Object.entries(EXPECTED_SCRIPTS)) {
    assertLifecycle(
      pkg.scripts?.[name] === value,
      `package.json script ${name} should be ${JSON.stringify(value)}`,
    );
  }

  assertLifecycle(
    JSON.stringify(pkg.precommitChecks) === JSON.stringify(ROOT_PACKAGE_CONFIG),
    "package.json should preserve package-owned config without copying standalone keys",
  );

  const standalone = readJson(path.join(repoDir, ".commitmentrc.json"));
  assertLifecycle(
    standalone.advisePushTests === true,
    ".commitmentrc.json should enable advisory pre-push tests by default",
  );
  assertLifecycle(
    standalone.commitMessage?.enabled === true,
    ".commitmentrc.json should preserve the opt-in commit-message configuration",
  );
}

function assertWorkspaceConfigured(repoDir) {
  const rootPackage = readJson(path.join(repoDir, "package.json"));
  assertLifecycle(
    JSON.stringify(rootPackage.workspaces) === JSON.stringify(WORKSPACE_GLOBS),
    `root package.json should keep workspaces ${JSON.stringify(WORKSPACE_GLOBS)}`,
  );

  for (const workspace of WORKSPACE_PACKAGES) {
    const workspacePackage = readJson(
      path.join(repoDir, workspace.dir, "package.json"),
    );
    assertLifecycle(
      workspacePackage.name === workspace.name,
      `${workspace.dir}/package.json should keep its package name`,
    );
    assertLifecycle(
      JSON.stringify(workspacePackage.precommitChecks) ===
        JSON.stringify(PACKAGE_LOCAL_CONFIG),
      `${workspace.dir}/package.json should keep package-local config untouched`,
    );
    assertLifecycle(
      !Object.hasOwn(
        workspacePackage.devDependencies ?? {},
        "commitment-issues",
      ),
      `${workspace.dir} should not own the commitment-issues install`,
    );
  }

  if (packageManager === "pnpm") {
    assertFileContains(
      path.join(repoDir, "pnpm-workspace.yaml"),
      '  - "packages/nested/*"',
    );
  }

  if (isYarnBerryLifecycle) {
    assertLifecycle(
      rootPackage.packageManager === `yarn@${YARN_BERRY_VERSION}`,
      `Yarn Berry projects should pin yarn@${YARN_BERRY_VERSION}`,
    );
    assertFileContains(
      path.join(repoDir, ".yarnrc.yml"),
      "nodeLinker: node-modules",
    );
    assertLifecycle(
      fs.existsSync(path.join(repoDir, "node_modules")),
      "Yarn Berry node-modules mode should create node_modules",
    );
    assertLifecycle(
      !fs.existsSync(path.join(repoDir, ".pnp.cjs")),
      "the supported Yarn Berry fixture must not generate Plug'n'Play state",
    );
  }
}

function assertGitignoreConfigured(repoDir) {
  const gitignore = fs.readFileSync(path.join(repoDir, ".gitignore"), "utf8");
  for (const entry of [".eslintcache", ".prettiercache", "node_modules/"]) {
    assertLifecycle(
      gitignore.split("\n").includes(entry),
      `.gitignore should include ${entry}`,
    );
  }
}

function assertGeneratedSetupRemoved(repoDir) {
  const pkg = readJson(path.join(repoDir, "package.json"));
  assertLifecycle(
    pkg.scripts?.prepare === EXISTING_PREPARE,
    "the project's original prepare script should be preserved",
  );
  for (const name of Object.keys(MANAGED_EXPECTED_SCRIPTS)) {
    assertLifecycle(
      !Object.hasOwn(pkg.scripts ?? {}, name),
      `package.json script ${name} should be removed`,
    );
  }
  assertLifecycle(
    !Object.hasOwn(pkg, "precommitChecks"),
    "package.json precommitChecks should be removed",
  );
  assertLifecycle(
    !fs.existsSync(path.join(repoDir, ".commitmentrc.json")),
    ".commitmentrc.json should be removed",
  );
  assertLifecycle(
    Object.hasOwn(pkg.devDependencies ?? {}, "commitment-issues"),
    "the package dependency should remain until the manager removes it",
  );
  for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
    assertLifecycle(
      !fs.existsSync(hookPath(repoDir, name)),
      `${name} should be removed from the common git hooks directory`,
    );
  }
}

function assertPackageDependencyRemoved(repoDir) {
  const pkg = readJson(path.join(repoDir, "package.json"));
  assertLifecycle(
    !Object.hasOwn(pkg.devDependencies ?? {}, "commitment-issues"),
    `${packageManager} should remove commitment-issues from devDependencies`,
  );
  assertLifecycle(
    !fs.existsSync(path.join(repoDir, "node_modules", "commitment-issues")),
    `${packageManager} should remove the installed commitment-issues package`,
  );

  const binDir = path.join(repoDir, "node_modules", ".bin");
  const bunWindowsShim =
    packageManager === "bun" && process.platform === "win32";
  const suffixes = ["", ".cmd", ".bat", ".com", ".ps1"];
  if (!bunWindowsShim) suffixes.push(".exe", ".bunx");

  for (const suffix of suffixes) {
    assertLifecycle(
      !fs.existsSync(path.join(binDir, `commitment-issues${suffix}`)),
      `${packageManager} should remove the local commitment-issues${suffix} bin`,
    );
  }

  // Bun's Windows launcher is a generic .exe paired with .bunx target
  // metadata. Windows can retain that pair after `bun remove` even though the
  // package itself is gone. Prove the residual launcher is inert instead of
  // treating Bun's package-manager cleanup behavior as product behavior.
  if (bunWindowsShim) {
    const launcher = path.join(binDir, "commitment-issues.exe");
    if (fs.existsSync(launcher)) {
      const result = crossSpawn.sync(launcher, ["--version"], {
        cwd: repoDir,
        env: lifecycleEnv(),
        encoding: "utf8",
      });
      assertLifecycle(
        result.error !== undefined || result.status !== 0,
        "Bun's residual generic commitment-issues.exe shim should be inert",
      );
    }
  }
}

function assertProductionDependencyOmitted(repoDir) {
  const pkg = readJson(path.join(repoDir, "package.json"));
  assertLifecycle(
    Object.hasOwn(pkg.devDependencies ?? {}, "commitment-issues"),
    "production installation should preserve the declared development dependency",
  );
  assertLifecycle(
    !fs.existsSync(path.join(repoDir, "node_modules", "commitment-issues")),
    `${packageManager} production installation should omit commitment-issues`,
  );
  assertLifecycle(
    !LOCAL_MANAGER_BIN_CANDIDATES.some((candidate) =>
      fs.existsSync(path.join(repoDir, candidate)),
    ),
    `${packageManager} production installation should omit every commitment-issues bin`,
  );
}

function assertManagerLockfile(repoDir) {
  const expectedLockfiles = {
    npm: ["package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    "yarn-berry": ["yarn.lock"],
    bun: ["bun.lock", "bun.lockb"],
  };
  const candidates = expectedLockfiles[packageManager];
  assertLifecycle(
    candidates.some((file) => fs.existsSync(path.join(repoDir, file))),
    `${packageManager} should create one of: ${candidates.join(", ")}`,
  );
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeWorkspaceFixture(repoDir) {
  for (const workspace of WORKSPACE_PACKAGES) {
    writeFile(
      path.join(repoDir, workspace.dir, "package.json"),
      `${JSON.stringify(
        {
          name: workspace.name,
          version: "1.0.0",
          private: true,
          type: "module",
          scripts: {
            test: "node scripts/workspace.test.mjs",
          },
          precommitChecks: PACKAGE_LOCAL_CONFIG,
        },
        null,
        2,
      )}\n`,
    );
    writeFile(
      path.join(repoDir, workspace.dir, "src", `${workspace.stem}.mjs`),
      `export const value = () => ${workspace.stem.length};\n`,
    );
    writeFile(
      path.join(repoDir, workspace.dir, "src", `${workspace.stem}.test.mjs`),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        `import { value } from "./${workspace.stem}.mjs";`,
        "",
        `test("${workspace.stem}", () => assert.equal(value(), ${workspace.stem.length}));`,
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(repoDir, workspace.dir, "scripts", "workspace.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        `import { value } from "../src/${workspace.stem}.mjs";`,
        "",
        `assert.equal(value(), ${workspace.stem.length});`,
        `console.log("${workspace.name} workspace script passed");`,
        "",
      ].join("\n"),
    );
  }

  if (packageManager === "pnpm") {
    writeFile(
      path.join(repoDir, "pnpm-workspace.yaml"),
      `packages:\n${WORKSPACE_GLOBS.map((glob) => `  - "${glob}"`).join("\n")}\n`,
    );
  }
}

function updateNestedWorkspace(repoDir, revision) {
  const workspace = WORKSPACE_PACKAGES[1];
  writeFile(
    path.join(repoDir, workspace.dir, "src", `${workspace.stem}.mjs`),
    `export const value = () => ${revision};\n`,
  );
  writeFile(
    path.join(repoDir, workspace.dir, "src", `${workspace.stem}.test.mjs`),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      `import { value } from "./${workspace.stem}.mjs";`,
      "",
      `test("${workspace.stem}", () => assert.equal(value(), ${revision}));`,
      "",
    ].join("\n"),
  );
}

export function createLifecycleIntegration() {
  const suppliedTarball = resolveTarball(
    process.env.COMMITMENT_ISSUES_LIFECYCLE_TARBALL,
  );
  const tempBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "commitment-issues-lifecycle-"),
  );
  const tempRoot = path.join(tempBase, "path with spaces café");
  const packDir = path.join(tempRoot, "pack");
  const repoDir = path.join(tempRoot, "repo");
  const cloneDir = path.join(tempRoot, "clone");
  const worktreeDir = path.join(tempRoot, "worktree");
  const remoteDir = path.join(tempRoot, "remote.git");

  let tarball;
  let initialTarballHash;
  let packedMetadata;
  let nestedWorkspaceDir;
  let projectInstallCommand;
  let projectInstallArgs;

  fs.mkdirSync(repoDir, { recursive: true });

  const phases = [
    {
      name: "select the package manager",
      run() {
        console.log(
          `\n[lifecycle integration] package manager: ${packageManager}\n`,
        );
        if (isYarnBerryLifecycle) {
          assertLifecycle(
            fs.existsSync(yarnBerryCli),
            `install the pinned Yarn Berry fixture with npm ci --ignore-scripts --prefix ${path.relative(root, yarnBerryFixtureDir)}`,
          );
        }
        const [managerVersionCommand, managerVersionArgs] = managerInvocation([
          "--version",
        ]);
        const managerVersion = runForOutput(
          managerVersionCommand,
          managerVersionArgs,
          root,
        );
        console.log(
          `[lifecycle integration] ${packageManager} version: ${managerVersion}\n`,
        );
        if (packageManager === "yarn" || isYarnBerryLifecycle) {
          const expectedVersion = isYarnBerryLifecycle
            ? YARN_BERRY_VERSION
            : YARN_CLASSIC_VERSION;
          assertLifecycle(
            hasExactOutputLine(managerVersion, expectedVersion),
            `${packageManager} should resolve exact version ${expectedVersion}`,
          );
        }
      },
    },
    {
      name: "pack and inspect the exact artifact",
      run() {
        tarball = suppliedTarball;
        if (tarball) {
          console.log(`[lifecycle integration] supplied tarball: ${tarball}\n`);
        } else {
          fs.mkdirSync(packDir, { recursive: true });
          run("npm", ["pack", "--pack-destination", packDir], root);
          const tarballs = fs
            .readdirSync(packDir)
            .filter((file) => file.endsWith(".tgz"))
            .map((file) => path.join(packDir, file));
          if (tarballs.length !== 1) {
            throw new Error(
              `npm pack should produce exactly one tarball, found ${tarballs.length}`,
            );
          }
          [tarball] = tarballs;
        }

        if (!tarball) {
          throw new Error("npm pack did not produce a tarball");
        }
        initialTarballHash = sha256(tarball);
        if (suppliedTarball) {
          console.log(
            `${SUPPLIED_TARBALL_DIGEST_PREFIX} ${initialTarballHash}\n`,
          );
        }
        packedMetadata = inspectPackedTarball(tarball);
      },
    },
    {
      name: "install the packed artifact and discover workspaces",
      run() {
        run("git", ["init"], repoDir);
        run("git", ["config", "user.name", "commitment-issues-ci"], repoDir);
        run(
          "git",
          ["config", "user.email", "commitment-issues-ci@example.com"],
          repoDir,
        );

        writeFile(
          path.join(repoDir, "package.json"),
          `${JSON.stringify(
            {
              name: "commitment-issues-lifecycle-integration",
              version: "1.0.0",
              type: "module",
              private: true,
              ...(isYarnBerryLifecycle
                ? { packageManager: `yarn@${YARN_BERRY_VERSION}` }
                : {}),
              workspaces: WORKSPACE_GLOBS,
              scripts: { prepare: EXISTING_PREPARE },
              precommitChecks: ROOT_PACKAGE_CONFIG,
            },
            null,
            2,
          )}\n`,
        );
        writeFile(
          path.join(repoDir, "scripts", "existing-prepare.mjs"),
          'process.stdout.write("existing prepare ran\\n");\n',
        );
        writeFile(
          path.join(repoDir, ".commitmentrc.json"),
          `${JSON.stringify(STANDALONE_CONFIG, null, 2)}\n`,
        );
        if (isYarnBerryLifecycle) {
          writeFile(
            path.join(repoDir, ".yarnrc.yml"),
            "nodeLinker: node-modules\n",
          );
        }
        writeWorkspaceFixture(repoDir);

        const [installCommand, installArgs] = installDevDeps(tarball, tempRoot);
        run(installCommand, installArgs, repoDir);
        assertInstalledCli(repoDir, packedMetadata);
        const installedPackage = path.join(
          repoDir,
          "node_modules",
          "commitment-issues",
        );
        const brokenInstalledLinks =
          findBrokenMarkdownLinksInDirectory(installedPackage);
        assertLifecycle(
          brokenInstalledLinks.length === 0,
          `installed package has broken relative Markdown links:\n${brokenInstalledLinks
            .map(formatBrokenMarkdownLink)
            .join("\n")}`,
        );
        assertManagerLockfile(repoDir);
        assertWorkspaceConfigured(repoDir);
        if (isYarnBerryLifecycle) {
          const [configCommand, configArgs] = managerInvocation([
            "config",
            "get",
            "nodeLinker",
          ]);
          assertLifecycle(
            hasExactOutputLine(
              runForOutput(configCommand, configArgs, repoDir),
              "node-modules",
            ),
            "Yarn Berry should resolve nodeLinker to node-modules",
          );
        }
        runWorkspaceTests(repoDir);
      },
    },
    {
      name: "exercise hook-manager coexistence",
      run() {
        // Exercise snippet-first coexistence from the installed tarball before
        // the native lifecycle. Each manager gets its own real runner layout;
        // every manager file is fixture-owned and must remain byte-for-byte
        // unchanged through dry-run, init, doctor, and uninstall.
        const packageBeforeIntegration = fs.readFileSync(
          path.join(repoDir, "package.json"),
          "utf8",
        );
        const standaloneBeforeIntegration = fs.readFileSync(
          path.join(repoDir, ".commitmentrc.json"),
          "utf8",
        );
        const managerFiles = {
          ".husky/pre-commit": `#!/usr/bin/env sh\n${guardedManagerCommand("pre-commit", "husky")}\n.lifecycle-manager-bin/lifecycle-husky-probe husky pre-commit "$@"\n`,
          ".husky/pre-push": `#!/usr/bin/env sh\n${guardedManagerCommand("pre-push", "husky")}\n.lifecycle-manager-bin/lifecycle-husky-probe husky pre-push "$@"\n`,
          ".husky/commit-msg": `#!/usr/bin/env sh\n${guardedManagerCommand("commit-msg", "husky")}\n.lifecycle-manager-bin/lifecycle-husky-probe husky commit-msg "$@"\n`,
          "lefthook.yml": [
            "pre-commit:",
            "  commands:",
            "    commitment-issues:",
            `      run: ${guardedManagerCommand("pre-commit", "lefthook")}`,
            "      files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
            "pre-push:",
            "  commands:",
            "    commitment-issues:",
            `      run: ${guardedManagerCommand("pre-push", "lefthook")}`,
            "      files: node -- node_modules/commitment-issues/scripts/lefthook-files.mjs",
            "      use_stdin: true",
            "commit-msg:",
            "  commands:",
            "    commitment-issues:",
            `      run: ${guardedManagerCommand("commit-msg", "lefthook")}`,
            "",
          ].join("\n"),
          ".pre-commit-config.yaml": [
            "repos:",
            "  - repo: local",
            "    hooks:",
            ...["pre-commit", "pre-push", "commit-msg"].flatMap((name) => [
              `      - id: commitment-issues-${name}`,
              `        name: commitment-issues ${name}`,
              `        entry: ${guardedManagerCommand(name, "pre-commit")}`,
              "        language: system",
              `        pass_filenames: ${name === "commit-msg" ? "true" : "false"}`,
              "        always_run: true",
              `        stages: [${name}]`,
            ]),
            "",
          ].join("\n"),
        };

        // Place a deterministic competing manager ahead of the inherited outer
        // PATH and prove the consumer-local bin remains the first resolution.
        const competingManagerBin = path.join(
          tempRoot,
          "competing-manager-bin",
        );
        const competingLefthook = path.join(competingManagerBin, "lefthook");
        writeFile(
          competingLefthook,
          '#!/bin/sh\nif [ "$1" = "-h" ]; then exit 0; fi\nexit 97\n',
        );
        fs.chmodSync(competingLefthook, 0o755);
        writeFile(
          path.join(competingManagerBin, "lefthook.cmd"),
          '@if "%~1"=="-h" exit /b 0\r\n@exit /b 97\r\n',
        );
        writeFile(
          path.join(competingManagerBin, "commitment-issues"),
          '#!/bin/sh\nprintf global-fallback > "$COMMITMENT_ISSUES_LIFECYCLE_CLI_LOG"\nexit 98\n',
        );
        fs.chmodSync(
          path.join(competingManagerBin, "commitment-issues"),
          0o755,
        );

        const probeSource = [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          'if (args.length === 1 && args[0] === "-h") process.exit(0);',
          'const fs = process.getBuiltinModule("node:fs");',
          "const log = process.env.COMMITMENT_ISSUES_LIFECYCLE_HOOK_LOG;",
          "if (!log) process.exit(91);",
          "fs.appendFileSync(log, `${JSON.stringify(args)}\\n`);",
          "const exitCode = Number(process.env.COMMITMENT_ISSUES_LIFECYCLE_HOOK_EXIT);",
          "process.exit(Number.isInteger(exitCode) ? exitCode : 0);",
          "",
        ].join("\n");
        const managerDispatchHarness = fs.readFileSync(
          managerDispatchHarnessPath,
          "utf8",
        );
        const probeFiles = {
          ".lifecycle-manager-bin/lifecycle-husky-probe": probeSource,
          ".lifecycle-manager-bin/lefthook": managerDispatchHarness,
          ".lifecycle-manager-bin/lefthook.bat": '@node "%~dp0lefthook" %*\r\n',
          ".lifecycle-manager-bin/python3": managerDispatchHarness,
          "node_modules/lefthook/bin/index.js": [
            "#!/bin/sh",
            'printf "index.js\\n" > "$COMMITMENT_ISSUES_LIFECYCLE_LEFTHOOK_FALLBACK_LOG"',
            'exec .lifecycle-manager-bin/lefthook "$@"',
            "",
          ].join("\n"),
        };
        const cliTracePath = path.join(repoDir, ".lifecycle-cli-trace.mjs");
        const cliTraceSource = [
          'import fs from "node:fs";',
          'import path from "node:path";',
          "const normalize = (value) =>",
          '  process.platform === "win32" ? value.toLowerCase() : value;',
          "try {",
          "  const invokedAs = process.argv[1];",
          "  const executable = fs.realpathSync.native(invokedAs);",
          "  const expected = fs.realpathSync.native(",
          '    path.join(process.cwd(), "node_modules", "commitment-issues", "scripts", "cli.mjs"),',
          "  );",
          "  if (normalize(executable) === normalize(expected)) {",
          "    const log = process.env.COMMITMENT_ISSUES_LIFECYCLE_CLI_LOG;",
          '    if (!log) throw new Error("CLI trace log is required");',
          "    fs.appendFileSync(",
          "      log,",
          "      `${JSON.stringify({ invokedAs, executable, args: process.argv.slice(2) })}\\n`,",
          "    );",
          "  }",
          "} catch (error) {",
          "  if (process.env.COMMITMENT_ISSUES_LIFECYCLE_CLI_LOG) throw error;",
          "}",
          "",
        ].join("\n");
        writeFile(cliTracePath, cliTraceSource);
        for (const [relativePath, content] of Object.entries(managerFiles)) {
          writeFile(path.join(repoDir, relativePath), content);
        }
        for (const [relativePath, content] of Object.entries(probeFiles)) {
          writeFile(path.join(repoDir, relativePath), content);
          fs.chmodSync(path.join(repoDir, relativePath), 0o755);
        }

        const configureManagerRunner = (manager) => {
          const runnerFiles = {};
          let hooksPath;
          if (manager === "husky") {
            hooksPath = ".husky/_";
            runnerFiles[`${hooksPath}/h`] = HUSKY_V9_RUNTIME;
            for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
              runnerFiles[`${hooksPath}/${name}`] =
                '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n';
            }
          } else {
            hooksPath = `.lifecycle-hooks/${manager}`;
            for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
              runnerFiles[`${hooksPath}/${name}`] =
                manager === "lefthook"
                  ? lefthookRunner(name)
                  : preCommitRunner(name, {
                      installPython: ".lifecycle-manager-bin/python3",
                      windowsLauncher: process.platform === "win32",
                    });
            }
          }

          for (const [relativePath, content] of Object.entries(runnerFiles)) {
            writeFile(path.join(repoDir, relativePath), content);
            fs.chmodSync(path.join(repoDir, relativePath), 0o755);
          }
          run("git", ["config", "core.hooksPath", hooksPath], repoDir);
          return { hooksPath, runnerFiles };
        };

        const assertFilesUnchanged = (files, operation) => {
          for (const [relativePath, content] of Object.entries(files)) {
            assertLifecycle(
              fs.readFileSync(path.join(repoDir, relativePath), "utf8") ===
                content,
              `${operation} should preserve ${relativePath}`,
            );
          }
        };

        const executeManagerRunners = (manager, hooksPath) => {
          for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
            const logPath = path.join(
              repoDir,
              `.lifecycle-${manager}-${name}.jsonl`,
            );
            fs.rmSync(logPath, { force: true });
            const forwardedArgs = [
              `lifecycle ${name} argument`,
              `--sentinel=${manager}-${name}`,
            ];
            const wrapperPath = path.join(repoDir, hooksPath, name);
            const shell = manager === "pre-commit" ? "bash" : "sh";
            const result = crossSpawn.sync(
              shell,
              [wrapperPath, ...forwardedArgs],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: {
                  ...managerLifecycleEnv(repoDir, competingManagerBin),
                  COMMITMENT_ISSUES: "0",
                  COMMITMENT_ISSUES_LIFECYCLE_HOOK_EXIT: "23",
                  COMMITMENT_ISSUES_LIFECYCLE_HOOK_LOG: logPath,
                  COMMITMENT_ISSUES_LIFECYCLE_HOOK_MODE: "probe",
                },
              },
            );
            if (result.error) throw result.error;
            assertLifecycle(
              result.status === 23,
              `${manager} ${name} should propagate exit 23, found ${result.status}: ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
            );

            const records = fs
              .readFileSync(logPath, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            assertLifecycle(
              records.length === 1,
              `${manager} ${name} should invoke exactly one manager probe`,
            );
            const [record] = records;
            if (manager === "husky") {
              assertLifecycle(
                JSON.stringify(record) ===
                  JSON.stringify(["husky", name, ...forwardedArgs]),
                `Husky ${name} should forward the hook name and arguments`,
              );
            } else if (manager === "lefthook") {
              assertLifecycle(
                JSON.stringify(record) ===
                  JSON.stringify(["run", name, ...forwardedArgs]),
                `Lefthook ${name} should forward the hook name and arguments`,
              );
            } else {
              assertLifecycle(
                record[0] === "-mpre_commit" &&
                  record[1] === "hook-impl" &&
                  record[2] === "--config=.pre-commit-config.yaml" &&
                  record[3] === `--hook-type=${name}` &&
                  record[4] === "--hook-dir" &&
                  record[6] === "--" &&
                  JSON.stringify(record.slice(7)) ===
                    JSON.stringify(forwardedArgs),
                `pre-commit ${name} should forward config, hook type, and arguments`,
              );
              assertLifecycle(
                sameFilesystemEntry(record[5], path.dirname(wrapperPath)),
                `pre-commit ${name} should forward its real hook directory`,
              );
            }
            fs.rmSync(logPath);
          }
        };

        const readJsonLines = (logPath) =>
          fs
            .readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));

        const executeDiscoveredLefthookRuntime = (hooksPath) => {
          const embeddedRuntime = path.join(
            repoDir,
            "node_modules",
            ".bin",
            process.platform === "win32" ? "lefthook.exe" : "lefthook",
          );
          assertLifecycle(
            !fs.existsSync(embeddedRuntime),
            "the Lefthook discovery probe should not use the embedded launcher",
          );
          const wrapperPath = path.join(repoDir, hooksPath, "pre-commit");
          const logPath = path.join(
            repoDir,
            ".lifecycle-lefthook-discovery.jsonl",
          );
          const fallbackLogPath = path.join(
            repoDir,
            ".lifecycle-lefthook-fallback.log",
          );
          fs.rmSync(logPath, { force: true });
          fs.rmSync(fallbackLogPath, { force: true });
          const forwardedArgs = [
            "runtime discovery argument",
            "--sentinel=lefthook-discovery",
          ];
          const env = withoutLefthookRuntimeCandidates(
            managerLifecycleEnv(repoDir, competingManagerBin),
            repoDir,
          );
          const result = crossSpawn.sync(
            "sh",
            [wrapperPath, ...forwardedArgs],
            {
              cwd: repoDir,
              encoding: "utf8",
              env: {
                ...env,
                COMMITMENT_ISSUES: "0",
                COMMITMENT_ISSUES_LIFECYCLE_HOOK_EXIT: "23",
                COMMITMENT_ISSUES_LIFECYCLE_HOOK_LOG: logPath,
                COMMITMENT_ISSUES_LIFECYCLE_HOOK_MODE: "probe",
                COMMITMENT_ISSUES_LIFECYCLE_LEFTHOOK_FALLBACK_LOG:
                  fallbackLogPath,
              },
            },
          );
          if (result.error) throw result.error;
          assertLifecycle(
            result.status === 23,
            `Lefthook's discovered runtime should propagate exit 23, found ${result.status}: ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
          );
          assertLifecycle(
            fs.readFileSync(fallbackLogPath, "utf8") === "index.js\n",
            "Lefthook should use its canonical repo-local index.js fallback",
          );
          assertLifecycle(
            JSON.stringify(readJsonLines(logPath)) ===
              JSON.stringify([["run", "pre-commit", ...forwardedArgs]]),
            "Lefthook's discovered runtime should forward exact hook arguments",
          );
          fs.rmSync(logPath);
          fs.rmSync(fallbackLogPath);
        };

        const executeConfiguredManagerEntries = (manager, hooksPath) => {
          const configPath = path.join(repoDir, ".commitmentrc.json");
          const configBeforeContract = fs.readFileSync(configPath, "utf8");
          const currentBranch = runForOutput(
            "git",
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            repoDir,
          );
          const blockedPushBranch = "lifecycle-protected";
          const missingMessagePath = path.join(
            repoDir,
            `.lifecycle-${manager}-missing-message.txt`,
          );
          const gitMessagePath = path.resolve(
            repoDir,
            runForOutput(
              "git",
              ["rev-parse", "--git-path", "COMMIT_EDITMSG"],
              repoDir,
            ),
          );
          const pushInput = `refs/heads/${currentBranch} ${"1".repeat(40)} refs/heads/${blockedPushBranch} ${"0".repeat(40)}\n`;
          const installedCli = path.join(
            repoDir,
            "node_modules",
            "commitment-issues",
            "scripts",
            "cli.mjs",
          );

          writeFile(
            configPath,
            `${JSON.stringify(
              {
                ...JSON.parse(configBeforeContract),
                blockProtectedBranches: true,
                protectedBranches: [currentBranch, blockedPushBranch],
                commitMessage: { enabled: true, blockOnFailure: true },
              },
              null,
              2,
            )}\n`,
          );
          fs.rmSync(missingMessagePath, { force: true });
          fs.rmSync(gitMessagePath, { force: true });

          try {
            for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
              const managerLogPath = path.join(
                repoDir,
                `.lifecycle-${manager}-${name}-manager.jsonl`,
              );
              const cliLogPath = path.join(
                repoDir,
                `.lifecycle-${manager}-${name}-cli.jsonl`,
              );
              fs.rmSync(managerLogPath, { force: true });
              fs.rmSync(cliLogPath, { force: true });

              const hookArgs =
                name === "pre-push"
                  ? ["origin", "https://example.invalid/lifecycle.git"]
                  : name === "commit-msg"
                    ? [missingMessagePath]
                    : [];
              const input = name === "pre-push" ? pushInput : "";
              const wrapperPath = path.join(repoDir, hooksPath, name);
              const shell = manager === "pre-commit" ? "bash" : "sh";
              const contractEnv = {
                ...managerLifecycleEnv(repoDir, competingManagerBin),
                COMMITMENT_ISSUES_LIFECYCLE_CLI_LOG: cliLogPath,
                COMMITMENT_ISSUES_LIFECYCLE_HOOK_LOG: managerLogPath,
                NODE_OPTIONS: `--import=${pathToFileURL(cliTracePath).href}`,
              };
              delete contractEnv.COMMITMENT_ISSUES_LIFECYCLE_HOOK_EXIT;
              delete contractEnv.COMMITMENT_ISSUES_LIFECYCLE_HOOK_MODE;
              const result = crossSpawn.sync(
                shell,
                [wrapperPath, ...hookArgs],
                {
                  cwd: repoDir,
                  encoding: "utf8",
                  env: contractEnv,
                  input,
                },
              );
              if (result.error) throw result.error;
              const output = [result.stdout, result.stderr]
                .filter(Boolean)
                .join("\n");
              assertLifecycle(
                result.status === 1,
                `${manager} ${name} should propagate the packed CLI's blocking exit 1, found ${result.status}: ${output}`,
              );
              if (name === "pre-commit") {
                assertLifecycle(
                  output.includes("Commit blocked: protected branch"),
                  `${manager} pre-commit should execute the packed blocking policy`,
                );
              } else if (name === "pre-push") {
                assertLifecycle(
                  output.includes(`Pushing to "${blockedPushBranch}"`),
                  `${manager} pre-push should deliver the protected ref input to the packed CLI`,
                );
              } else {
                const expectedMessage =
                  manager === "lefthook"
                    ? "COMMIT_EDITMSG"
                    : path.basename(missingMessagePath);
                assertLifecycle(
                  output.includes(expectedMessage),
                  `${manager} commit-msg should deliver ${expectedMessage} to the packed CLI`,
                );
              }

              const expectedCliArgs =
                manager === "lefthook"
                  ? name === "commit-msg"
                    ? ["hook", "commit-msg", "--git-path"]
                    : ["hook", HOOK_SUBCOMMANDS[name]]
                  : manager === "pre-commit"
                    ? name === "commit-msg"
                      ? ["hook", "commit-msg", ...hookArgs]
                      : ["hook", HOOK_SUBCOMMANDS[name]]
                    : name === "pre-push"
                      ? ["hook", "prepush", ...hookArgs]
                      : name === "commit-msg"
                        ? ["hook", "commit-msg", ...hookArgs]
                        : ["hook", "precommit"];
              const cliRecords = readJsonLines(cliLogPath);
              assertLifecycle(
                cliRecords.length === 1,
                `${manager} ${name} should execute exactly one packed CLI`,
              );
              assertLifecycle(
                sameFilesystemEntry(cliRecords[0].executable, installedCli),
                `${manager} ${name} should execute the installed package CLI`,
              );
              assertLifecycle(
                JSON.stringify(cliRecords[0].args) ===
                  JSON.stringify(expectedCliArgs),
                `${manager} ${name} should invoke the packed CLI with ${JSON.stringify(expectedCliArgs)}`,
              );

              if (manager === "husky") {
                assertLifecycle(
                  !fs.existsSync(managerLogPath),
                  `Husky ${name} should stop before the later probe after the packed CLI blocks`,
                );
              } else {
                const managerRecords = readJsonLines(managerLogPath);
                assertLifecycle(
                  managerRecords.length === 1,
                  `${manager} ${name} should dispatch exactly one configured entry`,
                );
                const [record] = managerRecords;
                assertLifecycle(
                  record.manager === manager && record.hook === name,
                  `${manager} ${name} should dispatch the matching config block`,
                );
                assertLifecycle(
                  record.command === "node_modules/.bin/commitment-issues",
                  `${manager} ${name} should use the packed bin command from its config entry`,
                );
                assertLifecycle(
                  JSON.stringify(record.args) ===
                    JSON.stringify(expectedCliArgs),
                  `${manager} ${name} should derive packed CLI argv from its config entry`,
                );
                assertLifecycle(
                  record.managerInput === input,
                  `${manager} ${name} should receive the original hook input`,
                );
                assertLifecycle(
                  record.entryInput ===
                    (manager === "lefthook" && name === "pre-push"
                      ? pushInput
                      : ""),
                  `${manager} ${name} should apply its configured stdin contract`,
                );
                if (manager === "lefthook" && name !== "commit-msg") {
                  assertLifecycle(
                    record.entryEnv.COMMITMENT_ISSUES_LEFTHOOK_FILE ===
                      "node_modules/commitment-issues/package.json",
                    `Lefthook ${name} should force empty operations with only the fixed installed-package sentinel`,
                  );
                }
                if (manager === "pre-commit" && name === "pre-push") {
                  assertLifecycle(
                    record.entryEnv.PRE_COMMIT_LOCAL_BRANCH ===
                      `refs/heads/${currentBranch}` &&
                      record.entryEnv.PRE_COMMIT_TO_REF === "1".repeat(40) &&
                      record.entryEnv.PRE_COMMIT_REMOTE_BRANCH ===
                        `refs/heads/${blockedPushBranch}` &&
                      record.entryEnv.PRE_COMMIT_FROM_REF === "0".repeat(40) &&
                      record.entryEnv.PRE_COMMIT_REMOTE_NAME === "origin" &&
                      record.entryEnv.PRE_COMMIT_REMOTE_URL ===
                        "https://example.invalid/lifecycle.git",
                    "pre-commit pre-push should translate consumed stdin and hook arguments into its documented environment",
                  );
                }
              }

              fs.rmSync(cliLogPath);
              fs.rmSync(managerLogPath, { force: true });
            }
          } finally {
            writeFile(configPath, configBeforeContract);
          }
        };

        const executeManagerBypasses = (manager, hooksPath) => {
          for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
            const managerLogPath = path.join(
              repoDir,
              `.lifecycle-${manager}-${name}-bypass-manager.jsonl`,
            );
            const cliLogPath = path.join(
              repoDir,
              `.lifecycle-${manager}-${name}-bypass-cli.jsonl`,
            );
            fs.rmSync(managerLogPath, { force: true });
            fs.rmSync(cliLogPath, { force: true });
            const wrapperPath = path.join(repoDir, hooksPath, name);
            const hookArgs =
              name === "pre-push"
                ? ["origin", "https://example.invalid/lifecycle.git"]
                : name === "commit-msg"
                  ? [path.join(repoDir, ".lifecycle-bypass-message")]
                  : [];
            const bypassEnv = {
              ...managerLifecycleEnv(repoDir, competingManagerBin),
              COMMITMENT_ISSUES_LIFECYCLE_CLI_LOG: cliLogPath,
              COMMITMENT_ISSUES_LIFECYCLE_HOOK_LOG: managerLogPath,
              NODE_OPTIONS: `--import=${pathToFileURL(cliTracePath).href}`,
            };
            if (manager === "husky") bypassEnv.HUSKY = "0";
            else if (manager === "lefthook") bypassEnv.LEFTHOOK = "0";
            else bypassEnv.SKIP = `commitment-issues-${name}`;

            const result = crossSpawn.sync(
              manager === "pre-commit" ? "bash" : "sh",
              [wrapperPath, ...hookArgs],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: bypassEnv,
              },
            );
            if (result.error) throw result.error;
            assertLifecycle(
              result.status === 0,
              `${manager} ${name} native bypass should exit zero, found ${result.status}`,
            );
            assertLifecycle(
              !fs.existsSync(cliLogPath),
              `${manager} ${name} native bypass should not execute the packed CLI`,
            );
            assertLifecycle(
              !fs.existsSync(managerLogPath),
              `${manager} ${name} native bypass should stop before manager dispatch`,
            );
          }
        };

        const executeMissingManagerBin = (manager, hooksPath) => {
          const wrapperPath = path.join(repoDir, hooksPath, "pre-commit");
          const localBin = path.join(
            repoDir,
            "node_modules",
            ".bin",
            "commitment-issues",
          );
          const parkedCandidates = ["", ".exe", ".cmd", ".bat"]
            .map((suffix) => `${localBin}${suffix}`)
            .filter((candidate) => fs.existsSync(candidate))
            .map((candidate) => ({
              candidate,
              parked: `${candidate}.lifecycle-parked`,
            }));
          assertLifecycle(
            parkedCandidates.length > 0,
            `${manager} should begin with an installed permitted local launcher`,
          );
          const managerLogPath = path.join(
            repoDir,
            `.lifecycle-${manager}-missing-bin-manager.jsonl`,
          );
          const cliLogPath = path.join(
            repoDir,
            `.lifecycle-${manager}-missing-bin-cli.jsonl`,
          );
          fs.rmSync(managerLogPath, { force: true });
          fs.rmSync(cliLogPath, { force: true });
          for (const { candidate, parked } of parkedCandidates) {
            fs.renameSync(candidate, parked);
          }
          try {
            const result = crossSpawn.sync(
              manager === "pre-commit" ? "bash" : "sh",
              [wrapperPath],
              {
                cwd: repoDir,
                encoding: "utf8",
                env: {
                  ...managerLifecycleEnv(repoDir, competingManagerBin),
                  COMMITMENT_ISSUES_LIFECYCLE_CLI_LOG: cliLogPath,
                  COMMITMENT_ISSUES_LIFECYCLE_HOOK_LOG: managerLogPath,
                  NODE_OPTIONS: `--import=${pathToFileURL(cliTracePath).href}`,
                },
              },
            );
            if (result.error) throw result.error;
            assertLifecycle(
              result.status === 0,
              `${manager} should fail open when every permitted project-local launcher is absent, found ${result.status}: ${[result.stdout, result.stderr].filter(Boolean).join("\n")}`,
            );
            assertLifecycle(
              !fs.existsSync(cliLogPath),
              `${manager} should not execute a PATH/global fallback when its project-local launchers are absent`,
            );
            assertLifecycle(
              fs.existsSync(managerLogPath),
              `${manager} should still reach its reviewed wrapper before the guarded entry fails open`,
            );
          } finally {
            for (const { candidate, parked } of parkedCandidates) {
              fs.renameSync(parked, candidate);
            }
            fs.rmSync(managerLogPath, { force: true });
            fs.rmSync(cliLogPath, { force: true });
          }
        };

        for (const manager of ["husky", "lefthook", "pre-commit"]) {
          const { hooksPath, runnerFiles } = configureManagerRunner(manager);
          const ownedFiles = {
            ...managerFiles,
            ...probeFiles,
            ...runnerFiles,
          };
          const [previewCommand, previewArgs] = execBin([
            "init",
            "--dry-run",
            `--integration=${manager}`,
          ]);
          const preview = runForCombinedOutput(
            previewCommand,
            previewArgs,
            repoDir,
            managerLifecycleEnv(repoDir, competingManagerBin),
          );
          assertLifecycle(
            !preview.includes(`${manager} coexistence snippets`),
            `${manager} dry-run should not reprint already-wired snippets`,
          );
          assertFilesUnchanged(ownedFiles, `${manager} dry-run`);

          const [initCommand, initArgs] = execBin([
            "init",
            `--integration=${manager}`,
          ]);
          run(
            initCommand,
            initArgs,
            repoDir,
            managerLifecycleEnv(repoDir, competingManagerBin),
          );
          const integratedPackage = readJson(
            path.join(repoDir, "package.json"),
          );
          assertLifecycle(
            integratedPackage.scripts?.prepare ===
              `${EXISTING_PREPARE} && ${prepareRepairCommand(manager)}`,
            `${manager} coexistence should compose owner-specific prepare verification`,
          );
          for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
            assertLifecycle(
              !fs.existsSync(hookPath(repoDir, name)),
              `${manager} coexistence should not write native ${name}`,
            );
          }
          assertFilesUnchanged(ownedFiles, `${manager} init`);

          const packageAfterIntegration = fs.readFileSync(
            path.join(repoDir, "package.json"),
            "utf8",
          );
          run(
            initCommand,
            initArgs,
            repoDir,
            managerLifecycleEnv(repoDir, competingManagerBin),
          );
          assertLifecycle(
            fs.readFileSync(path.join(repoDir, "package.json"), "utf8") ===
              packageAfterIntegration,
            `${manager} coexistence init should be idempotent`,
          );
          assertFilesUnchanged(ownedFiles, `${manager} repeated init`);

          const [doctorCommand, doctorArgs] = execBin([
            "doctor",
            `--integration=${manager}`,
          ]);
          const doctorEnv =
            manager === "lefthook"
              ? withoutLefthookRuntimeCandidates(
                  managerLifecycleEnv(repoDir, competingManagerBin),
                  repoDir,
                )
              : managerLifecycleEnv(repoDir, competingManagerBin);
          run(doctorCommand, doctorArgs, repoDir, doctorEnv);
          assertFilesUnchanged(ownedFiles, `${manager} doctor`);
          executeManagerRunners(manager, hooksPath);
          if (manager === "lefthook") {
            executeDiscoveredLefthookRuntime(hooksPath);
          }
          executeConfiguredManagerEntries(manager, hooksPath);
          executeManagerBypasses(manager, hooksPath);
          executeMissingManagerBin(manager, hooksPath);

          const [integrationUninstallCommand, integrationUninstallArgs] =
            execBin(["uninstall"]);
          const integrationUninstall = runForOutput(
            integrationUninstallCommand,
            integrationUninstallArgs,
            repoDir,
            managerLifecycleEnv(repoDir, competingManagerBin),
          );
          for (const detectedManager of ["husky", "lefthook", "pre-commit"]) {
            assertLifecycle(
              integrationUninstall.includes(
                `${detectedManager} configuration is user-owned`,
              ),
              `uninstall should report manual ${detectedManager} cleanup`,
            );
          }
          assertFilesUnchanged(ownedFiles, `${manager} uninstall`);
          assertGeneratedSetupRemoved(repoDir);

          // Restore the pristine consumer files before the next isolated
          // manager scenario. The manager-owned files remain in place so the
          // next explicit selection still proves safe ambiguity handling.
          writeFile(
            path.join(repoDir, "package.json"),
            packageBeforeIntegration,
          );
          writeFile(
            path.join(repoDir, ".commitmentrc.json"),
            standaloneBeforeIntegration,
          );
        }

        // Remove only the fixture-owned manager artifacts, then continue
        // through the native real-commit/push/clone/worktree lifecycle in the
        // same packed installation.
        fs.rmSync(path.join(repoDir, ".husky"), { recursive: true });
        fs.rmSync(path.join(repoDir, ".lifecycle-hooks"), { recursive: true });
        fs.rmSync(path.join(repoDir, "lefthook.yml"));
        fs.rmSync(path.join(repoDir, ".pre-commit-config.yaml"));
        fs.rmSync(path.join(repoDir, ".lifecycle-manager-bin"), {
          recursive: true,
        });
        fs.rmSync(path.join(repoDir, "node_modules", "lefthook"), {
          recursive: true,
        });
        fs.rmSync(cliTracePath);
        run("git", ["config", "--unset", "core.hooksPath"], repoDir);
      },
    },
    {
      name: "initialize and wire the hooks",
      run() {
        const [helpCommand, helpArgs] = execBin(["--help"]);
        run(helpCommand, helpArgs, repoDir);
        const [panicCommand, panicArgs] = execBin(["panic"]);
        const panicOutput = runForOutput(panicCommand, panicArgs, repoDir);
        assertLifecycle(
          panicOutput.includes("Current state:") &&
            panicOutput.includes("git status") &&
            panicOutput.includes("This guide did not change"),
          "the packed panic command should provide one read-only recovery guide",
        );
        const [initCommand, initArgs] = execBin(["init"]);
        run(initCommand, initArgs, repoDir);
        // A repeated setup must remain idempotent under the manager's real
        // local runner, not only in the unit fixture.
        run(initCommand, initArgs, repoDir);

        assertPackageJsonConfigured(repoDir);
        assertWorkspaceConfigured(repoDir);
        assertGitignoreConfigured(repoDir);
        assertHookWired(repoDir, "pre-commit");
        assertHookWired(repoDir, "pre-push");
        assertHookWired(repoDir, "commit-msg");
      },
    },
    {
      name: "commit and defer the first-run welcome",
      run() {
        writeFile(
          path.join(repoDir, "eslint.config.js"),
          [
            'import js from "@eslint/js";',
            'import globals from "globals";',
            "",
            "export default [",
            "  js.configs.recommended,",
            "  {",
            "    languageOptions: {",
            "      globals: globals.node,",
            "    },",
            "  },",
            "];",
            "",
          ].join("\n"),
        );

        nestedWorkspaceDir = path.join(repoDir, WORKSPACE_PACKAGES[1].dir);

        // Guarantee a fixable staged finding so the manager-specific recovery
        // hint is observable instead of depending on formatter drift.
        writeFile(
          path.join(
            repoDir,
            WORKSPACE_PACKAGES[0].dir,
            "src",
            "app-widget.mjs",
          ),
          "export const value=()=>10;\n",
        );
        run("git", ["add", "-A"], repoDir);
        const [firstCheckCommand, firstCheckArgs] = execBin(["precommit"]);
        const firstCheck = runForOutput(
          firstCheckCommand,
          firstCheckArgs,
          repoDir,
        );
        assertLifecycle(
          firstCheck.includes(`${packageManagerHint} run commit:fix`),
          `pre-commit guidance should use ${packageManagerHint}'s run command`,
        );
        assertLifecycle(
          !fs.existsSync(welcomeMarkerPath(repoDir)),
          "a new clone should not start with a welcome marker",
        );
        // Starting Git commands below the workspace root must still run the
        // root-owned hooks and config for files in both workspace depths.
        const checkedCommit = runForCombinedOutput(
          "git",
          ["commit", "-m", "first checked workspace commit"],
          nestedWorkspaceDir,
        );
        if (checkedCommit) {
          console.log(checkedCommit);
        }
        assertLifecycle(
          checkedCommit.includes("Pre-commit suggestions found"),
          "a real git commit should execute the installed pre-commit hook",
        );
        assertLifecycle(
          checkedCommit.includes("Commit-message check unavailable"),
          "a real git commit should execute the installed commit-msg hook",
        );
        assertLifecycle(
          !fs.existsSync(welcomeMarkerPath(repoDir)),
          "a first commit with findings should defer the welcome marker",
        );

        const [precommitCommand, precommitArgs] = execBin(["precommit"]);
        const deferredWelcome = runForOutput(
          precommitCommand,
          precommitArgs,
          repoDir,
        );
        if (deferredWelcome) {
          console.log(deferredWelcome);
        }
        assertLifecycle(
          deferredWelcome.includes("Commitment Issues is active here."),
          "the next eligible pre-commit invocation should show the deferred welcome",
        );
        assertLifecycle(
          deferredWelcome.includes(
            `Verify or repair the hooks anytime: ${packageManagerHint} run doctor`,
          ),
          "the welcome should name hook repair with the detected package manager",
        );
        assertLifecycle(
          fs.existsSync(welcomeMarkerPath(repoDir)),
          "the deferred welcome should create the shared marker",
        );
      },
    },
    {
      name: "push through the real pre-push hook",
      run() {
        run("git", ["init", "--bare", remoteDir], tempRoot);
        run("git", ["branch", "-M", "main"], repoDir);
        run("git", ["remote", "add", "origin", remoteDir], repoDir);
        const checkedPush = runForCombinedOutput(
          "git",
          ["push", "-u", "origin", "main"],
          nestedWorkspaceDir,
        );
        if (checkedPush) {
          console.log(checkedPush);
        }
        assertLifecycle(
          checkedPush.includes("Running tests for pushed files") &&
            checkedPush.includes("All tests passed: 4 passed, 0 failed."),
          "a real git push should execute the installed pre-push hook",
        );
      },
    },
    {
      name: "repair a fresh clone",
      run() {
        // .git/hooks is clone-local. A scripts-disabled install leaves hooks
        // absent while keeping the CLI available; explicit doctor works for
        // every manager. A normal install also runs the consumer-owned repair
        // except under Yarn Berry's documented lifecycle boundary.
        run(
          "git",
          ["clone", "--branch", "main", remoteDir, cloneDir],
          tempRoot,
        );
        for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
          assertLifecycle(
            !fs.existsSync(hookPath(cloneDir, name)),
            `fresh clone should start without a ${name} hook`,
          );
        }
        const [ignoredInstallCommand, ignoredInstallArgs] = installProject({
          ignoreScripts: true,
        });
        run(ignoredInstallCommand, ignoredInstallArgs, cloneDir);
        for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
          assertLifecycle(
            !fs.existsSync(hookPath(cloneDir, name)),
            `--ignore-scripts should leave ${name} absent until explicit repair`,
          );
        }
        const [cloneHelpCommand, cloneHelpArgs] = execBin(["--help"]);
        run(cloneHelpCommand, cloneHelpArgs, cloneDir);
        const [cloneDoctorCommand, cloneDoctorArgs] = execBin(["doctor"]);
        run(cloneDoctorCommand, cloneDoctorArgs, cloneDir);
        for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
          assertHookWired(cloneDir, name);
          fs.rmSync(hookPath(cloneDir, name));
        }

        [projectInstallCommand, projectInstallArgs] = installProject();
        run(projectInstallCommand, projectInstallArgs, cloneDir);
        if (isYarnBerryLifecycle) {
          for (const name of Object.keys(HOOK_SUBCOMMANDS)) {
            assertLifecycle(
              !fs.existsSync(hookPath(cloneDir, name)),
              `a normal Yarn Berry install should leave ${name} absent until explicit repair`,
            );
          }
          run(cloneDoctorCommand, cloneDoctorArgs, cloneDir);
        }
        assertPackageJsonConfigured(cloneDir);
        assertWorkspaceConfigured(cloneDir);
        assertHookWired(cloneDir, "pre-commit");
        assertHookWired(cloneDir, "pre-push");
        assertHookWired(cloneDir, "commit-msg");
      },
    },
    {
      name: "survive production install and direct dependency removal",
      run() {
        fs.rmSync(path.join(cloneDir, "node_modules"), {
          recursive: true,
          force: true,
        });
        for (const [command, args, env] of productionInstallCommands()) {
          run(command, args, cloneDir, env);
          assertProductionDependencyOmitted(cloneDir);
          assertPackageJsonConfigured(cloneDir);
        }

        const [removeCommand, removeArgs] = removeInstalledPackage();
        run(removeCommand, removeArgs, cloneDir);
        assertPackageDependencyRemoved(cloneDir);
        assertPackageJsonConfigured(cloneDir);

        const [installCommand, installArgs] = installProject();
        run(installCommand, installArgs, cloneDir);
        assertPackageDependencyRemoved(cloneDir);
        assertPackageJsonConfigured(cloneDir);
      },
    },
    {
      name: "exercise a linked worktree",
      run() {
        // Dependencies remain worktree-local, while native hooks and the
        // welcome marker live in the shared common Git directory.
        run(
          "git",
          ["worktree", "add", "-b", "workspace-lifecycle", worktreeDir, "main"],
          repoDir,
        );
        assertLifecycle(
          sameFilesystemEntry(gitCommonDir(worktreeDir), gitCommonDir(repoDir)),
          "linked worktree should use the primary checkout's common Git directory",
        );
        assertLifecycle(
          sameFilesystemEntry(
            welcomeMarkerPath(worktreeDir),
            welcomeMarkerPath(repoDir),
          ),
          "linked worktrees should share the once-per-clone welcome marker",
        );
        assertHookWired(worktreeDir, "pre-commit");
        assertHookWired(worktreeDir, "pre-push");

        run(projectInstallCommand, projectInstallArgs, worktreeDir);
        assertPackageJsonConfigured(worktreeDir);
        assertWorkspaceConfigured(worktreeDir);
        assertHookWired(worktreeDir, "pre-commit");
        assertHookWired(worktreeDir, "pre-push");

        updateNestedWorkspace(worktreeDir, 42);
        run(
          "git",
          [
            "add",
            `${WORKSPACE_PACKAGES[1].dir}/src/${WORKSPACE_PACKAGES[1].stem}.mjs`,
            `${WORKSPACE_PACKAGES[1].dir}/src/${WORKSPACE_PACKAGES[1].stem}.test.mjs`,
          ],
          worktreeDir,
        );
        run(
          "git",
          ["commit", "-m", "check nested package from linked worktree"],
          path.join(worktreeDir, WORKSPACE_PACKAGES[1].dir),
        );
      },
    },
    {
      name: "preview uninstall and remove owned setup",
      run() {
        const [uninstallPreviewCommand, uninstallPreviewArgs] = execBin([
          "uninstall",
          "--dry-run",
        ]);
        run(uninstallPreviewCommand, uninstallPreviewArgs, repoDir);
        assertPackageJsonConfigured(repoDir);
        assertWorkspaceConfigured(repoDir);
        assertHookWired(repoDir, "pre-commit");
        assertHookWired(repoDir, "pre-push");
        assertHookWired(repoDir, "commit-msg");

        const [uninstallCommand, uninstallArgs] = execBin(["uninstall"]);
        const uninstallOutput = runForOutput(
          uninstallCommand,
          uninstallArgs,
          repoDir,
        );
        const [removeCommand, removeArgs] = removeInstalledPackage();
        const removeGuidance = expectedRemoveGuidance();
        assertLifecycle(
          uninstallOutput.includes(removeGuidance),
          `uninstall guidance should use ${packageManager}'s workspace-aware remove command`,
        );
        assertGeneratedSetupRemoved(repoDir);
        assertWorkspaceConfigured(repoDir);
        assertGitignoreConfigured(repoDir);
        run(removeCommand, removeArgs, repoDir);
        assertPackageDependencyRemoved(repoDir);
        assertManagerLockfile(repoDir);
        assertLifecycle(
          sha256(tarball) === initialTarballHash,
          "the lifecycle integration must not modify the supplied tarball",
        );
      },
    },
  ];

  return {
    phases,
    cleanup() {
      fs.rmSync(tempBase, { recursive: true, force: true });
    },
  };
}
