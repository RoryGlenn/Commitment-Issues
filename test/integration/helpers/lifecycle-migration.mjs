// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crossSpawn from "cross-spawn";
import { hookBody, prepareRepairCommand } from "../../../scripts/lib/hooks.mjs";
import {
  hasExactOutputLine,
  isSupportedMigrationManager,
} from "../../../scripts/lib/lifecycle-managers.mjs";

export const MIGRATION_TARBALL_DIGEST_PREFIX =
  "[lifecycle migration] candidate tarball sha256:";

const PACKAGE_NAME = "commitment-issues";
const PACKAGE_BIN = "scripts/cli.mjs";
const PROJECT_PREPARE = "node scripts/project-prepare.mjs";
const LEGACY_DIRECT_PREPARE = `${PROJECT_PREPARE} && commitment-issues doctor --quiet`;
const CANDIDATE_REPAIR = prepareRepairCommand();
const CANDIDATE_PREPARE = `${PROJECT_PREPARE} && ${CANDIDATE_REPAIR}`;
const TOOL_VERSIONS = [
  "eslint@9.39.4",
  "prettier@3.9.5",
  "@eslint/js@9.39.4",
  "globals@17.7.0",
];
const HUSKY_TOOL_VERSIONS = ["husky@9.1.7", "lint-staged@16.2.7"];
const MAX_FIXTURE_BYTES = 5 * 1024 * 1024;
const PASSTHROUGH_ENVIRONMENT_KEYS = [
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TERM",
  "TZ",
  "WINDIR",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function ensurePlainObject(value, label) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

export function validateMigrationManifest(manifest) {
  ensurePlainObject(manifest, "migration manifest");
  assert.equal(manifest.schemaVersion, 1, "unsupported migration schema");
  ensurePlainObject(manifest.package, "migration package metadata");
  assert.deepEqual(manifest.package, {
    name: PACKAGE_NAME,
    bin: PACKAGE_BIN,
  });
  assert.ok(
    Array.isArray(manifest.fixtures) && manifest.fixtures.length >= 2,
    "migration manifest must contain at least two fixtures",
  );

  const ids = new Set();
  const versions = new Set();
  for (const fixture of manifest.fixtures) {
    ensurePlainObject(fixture, "migration fixture");
    assert.match(fixture.id, /^[a-z][a-z0-9-]+$/u);
    assert.ok(!ids.has(fixture.id), `duplicate fixture id: ${fixture.id}`);
    ids.add(fixture.id);
    assert.match(fixture.version, /^\d+\.\d+\.\d+$/u);
    assert.ok(
      !versions.has(fixture.version),
      `duplicate fixture version: ${fixture.version}`,
    );
    versions.add(fixture.version);
    assert.equal(fixture.filename, `${PACKAGE_NAME}-${fixture.version}.tgz`);
    assert.ok(
      Number.isSafeInteger(fixture.size) &&
        fixture.size > 0 &&
        fixture.size <= MAX_FIXTURE_BYTES,
      `fixture size must be at most ${MAX_FIXTURE_BYTES} bytes`,
    );
    assert.match(fixture.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(
      fixture.kind === "husky" || fixture.kind === "native",
      `unsupported fixture kind: ${fixture.kind}`,
    );

    const url = new URL(fixture.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "github.com");
    assert.equal(
      url.pathname,
      `/RoryGlenn/commitment-issues/releases/download/v${fixture.version}/${fixture.filename}`,
    );
  }

  assert.ok(
    manifest.fixtures.some((fixture) => fixture.kind === "husky"),
    "migration fixtures must cover the Husky era",
  );
  assert.ok(
    manifest.fixtures.some((fixture) => fixture.version === "3.3.2"),
    "migration fixtures must cover the latest published baseline",
  );
  return manifest;
}

export function validateFixtureBytes(fixture, bytes) {
  const buffer = Buffer.from(bytes);
  assert.equal(
    buffer.length,
    fixture.size,
    `${fixture.id} fixture size must match the reviewed release asset`,
  );
  assert.equal(
    sha256(buffer),
    fixture.sha256,
    `${fixture.id} fixture digest must match the reviewed release asset`,
  );
  return buffer;
}

export function loadMigrationManifest(root) {
  const manifestPath = path.join(
    root,
    "test",
    "fixtures",
    "lifecycle-migrations.json",
  );
  return validateMigrationManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
  );
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode !== undefined && process.platform !== "win32") {
    fs.chmodSync(filePath, mode);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function comparablePath(filePath) {
  const resolved = fs.realpathSync.native(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function createIsolatedMigrationEnvironment(
  baseDir,
  sourceEnvironment = process.env,
) {
  const home = path.join(baseDir, "home");
  const cache = path.join(baseDir, "package-cache");
  const temp = path.join(baseDir, "process-temp");
  const npmrc = path.join(home, ".npmrc");
  const globalNpmrc = path.join(home, "global.npmrc");
  const gitconfig = path.join(home, ".gitconfig");
  for (const directory of [home, cache, temp]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeFile(
    npmrc,
    [
      "registry=https://registry.npmjs.org/",
      "always-auth=false",
      "audit=false",
      "fund=false",
      "update-notifier=false",
      "",
    ].join("\n"),
  );
  writeFile(globalNpmrc, "");
  writeFile(gitconfig, "");

  const env = {};
  for (const key of PASSTHROUGH_ENVIRONMENT_KEYS) {
    if (sourceEnvironment[key] !== undefined) {
      env[key] = sourceEnvironment[key];
    }
  }

  return {
    ...env,
    APPDATA: path.join(home, "AppData", "Roaming"),
    BUN_INSTALL_CACHE_DIR: path.join(cache, "bun"),
    CI: "1",
    COREPACK_HOME: path.join(cache, "corepack"),
    FORCE_COLOR: "0",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NO_COLOR: "1",
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    USERPROFILE: home,
    XDG_CACHE_HOME: path.join(cache, "xdg"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    YARN_CACHE_FOLDER: path.join(cache, "yarn"),
    YARN_REGISTRY: "https://registry.npmjs.org/",
    npm_config_audit: "false",
    npm_config_cache: cache,
    npm_config_fund: "false",
    npm_config_globalconfig: globalNpmrc,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_store_dir: path.join(cache, "pnpm-store"),
    npm_config_update_notifier: "false",
    npm_config_userconfig: npmrc,
    npm_config_yes: "false",
  };
}

function invoke(
  context,
  command,
  args,
  cwd,
  { extraEnv = {}, allowFailure = false } = {},
) {
  const result = crossSpawn.sync(command, args, {
    cwd,
    env: { ...context.env, ...extraEnv },
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}:\n${output}`,
    );
  }
  return { ...result, output };
}

function runOutput(context, command, args, cwd, options) {
  return invoke(context, command, args, cwd, options).output.trim();
}

function git(context, args, cwd) {
  return runOutput(context, "git", args, cwd);
}

function managerAdd(context, repoDir, specs) {
  const installSpecs = specs.map((spec) =>
    path.isAbsolute(spec) && path.extname(spec) === ".tgz"
      ? `file:${spec}`
      : spec,
  );
  const commands = {
    npm: ["npm", ["install", "--save-dev", "--save-exact", ...installSpecs]],
    pnpm: ["pnpm", ["add", "--save-dev", "--save-exact", ...installSpecs]],
    yarn: ["yarn", ["add", "--dev", "--exact", "--force", ...installSpecs]],
    bun: ["bun", ["add", "--dev", "--exact", ...installSpecs]],
  };
  const [command, args] = commands[context.packageManager];
  invoke(context, command, args, repoDir);
}

function managerRemove(
  context,
  repoDir,
  names,
  { ignoreScripts = false } = {},
) {
  const ignoreScriptArgs = ignoreScripts ? ["--ignore-scripts"] : [];
  const commands = {
    npm: ["npm", ["uninstall", "--save-dev", ...ignoreScriptArgs, ...names]],
    pnpm: ["pnpm", ["remove", ...ignoreScriptArgs, ...names]],
    yarn: ["yarn", ["remove", ...ignoreScriptArgs, ...names]],
    bun: ["bun", ["remove", ...ignoreScriptArgs, ...names]],
  };
  const [command, args] = commands[context.packageManager];
  invoke(context, command, args, repoDir);
}

function managerFrozenInstall(context, repoDir) {
  const commands = {
    npm: ["npm", ["ci"]],
    pnpm: ["pnpm", ["install", "--frozen-lockfile"]],
    yarn: ["yarn", ["install", "--frozen-lockfile"]],
    bun: ["bun", ["install", "--frozen-lockfile"]],
  };
  const [command, args] = commands[context.packageManager];
  invoke(context, command, args, repoDir);
}

function managerExec(context, executable, args, repoDir) {
  const commands = {
    npm: ["npx", ["--no-install", executable, ...args]],
    pnpm: ["pnpm", ["exec", executable, ...args]],
    yarn: ["yarn", ["run", executable, ...args]],
    bun: ["bunx", ["--no-install", executable, ...args]],
  };
  const [command, commandArgs] = commands[context.packageManager];
  return invoke(context, command, commandArgs, repoDir, {
    extraEnv: {
      npm_config_offline: "true",
      npm_config_yes: "false",
    },
  });
}

function managerBin(context, args, repoDir) {
  return managerExec(context, PACKAGE_NAME, args, repoDir);
}

function expectedLockfiles(packageManager) {
  return {
    npm: ["package-lock.json"],
    pnpm: ["pnpm-lock.yaml"],
    yarn: ["yarn.lock"],
    bun: ["bun.lock", "bun.lockb"],
  }[packageManager];
}

function assertManagerLockfile(context, repoDir) {
  const lockfile = expectedLockfiles(context.packageManager).find((name) =>
    fs.existsSync(path.join(repoDir, name)),
  );
  assert.ok(
    lockfile,
    `${context.packageManager} must create its expected lockfile`,
  );
  const contents = fs.readFileSync(path.join(repoDir, lockfile));
  assert.ok(contents.length > 0, `${lockfile} must not be empty`);
  if (lockfile !== "bun.lockb") {
    assert.match(contents.toString("utf8"), /commitment-issues/u);
  }
}

function dependencyTarballPath(repoDir, spec) {
  assert.equal(typeof spec, "string");
  const value = spec.startsWith("file:")
    ? decodeURIComponent(spec.slice("file:".length))
    : spec;
  assert.ok(
    spec.startsWith("file:") || path.isAbsolute(value),
    `expected a local file dependency, found ${spec}`,
  );
  return path.resolve(repoDir, value);
}

function installedPackageDir(repoDir) {
  return path.join(repoDir, "node_modules", PACKAGE_NAME);
}

function stagedTarballPath(repoDir, source, label) {
  return path.join(
    repoDir,
    ".migration-artifacts",
    `${label}-${path.basename(source)}`,
  );
}

function stageTarball(repoDir, source, label) {
  const destination = stagedTarballPath(repoDir, source, label);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (process.platform !== "win32") fs.chmodSync(destination, 0o600);
  assert.equal(sha256File(destination), sha256File(source));
  return `file:.migration-artifacts/${path.basename(destination)}`;
}

function assertInstalledVersion(context, repoDir, version) {
  const installed = readJson(
    path.join(installedPackageDir(repoDir), "package.json"),
  );
  assert.equal(installed.name, PACKAGE_NAME);
  assert.equal(installed.version, version);
  assert.deepEqual(installed.bin, { [PACKAGE_NAME]: PACKAGE_BIN });
  const result = managerBin(context, ["--version"], repoDir);
  assert.equal(result.status, 0);
  assert.ok(
    hasExactOutputLine(result.output, version),
    `installed CLI must report ${version}, found ${JSON.stringify(result.output.trim())}`,
  );
}

function assertCandidateInstalled(context, repoDir) {
  const pkg = readJson(path.join(repoDir, "package.json"));
  const dependency = pkg.devDependencies?.[PACKAGE_NAME];
  const dependencyPath = dependencyTarballPath(repoDir, dependency);
  assert.equal(
    comparablePath(dependencyPath),
    comparablePath(
      stagedTarballPath(repoDir, context.candidate.path, "candidate"),
    ),
    "package.json must resolve commitment-issues to the exact candidate tarball",
  );
  assert.equal(sha256File(dependencyPath), context.candidate.digest);
  assertInstalledVersion(context, repoDir, context.candidate.version);
  assertManagerLockfile(context, repoDir);

  for (const relativePath of ["scripts/cli.mjs", "scripts/lib/hooks.mjs"]) {
    assert.equal(
      sha256File(path.join(installedPackageDir(repoDir), relativePath)),
      context.candidate.sourceDigests[relativePath],
      `${relativePath} must come from the candidate checkout`,
    );
  }
}

function inspectPackageTarball(context, tarball) {
  const rawPackage = runOutput(
    context,
    "tar",
    ["-xOf", tarball, "package/package.json"],
    context.root,
  );
  const pkg = JSON.parse(rawPackage);
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.deepEqual(pkg.bin, { [PACKAGE_NAME]: PACKAGE_BIN });
  return pkg;
}

export async function readBoundedFixtureResponse(fixture, response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    assert.match(contentLength, /^\d+$/u);
    assert.equal(Number(contentLength), fixture.size);
  }
  assert.ok(
    response.body && typeof response.body.getReader === "function",
    `${fixture.id} fixture response must provide a readable body`,
  );

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      assert.ok(
        total <= fixture.size,
        `${fixture.id} fixture response exceeded the reviewed size`,
      );
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return validateFixtureBytes(fixture, Buffer.concat(chunks, total));
}

async function downloadFixture(context, fixture, destinationDir) {
  const response = await context.fetchImpl(fixture.url, {
    redirect: "follow",
    headers: {
      accept: "application/octet-stream",
      "user-agent": "commitment-issues-migration-test",
    },
  });
  assert.ok(
    response.ok,
    `${fixture.id} download failed: HTTP ${response.status}`,
  );
  const finalUrl = new URL(response.url || fixture.url);
  assert.equal(finalUrl.protocol, "https:");
  assert.ok(
    finalUrl.hostname === "github.com" ||
      finalUrl.hostname.endsWith(".githubusercontent.com"),
    `unexpected fixture download host: ${finalUrl.hostname}`,
  );
  const bytes = await readBoundedFixtureResponse(fixture, response);
  const filePath = path.join(destinationDir, fixture.filename);
  writeFile(filePath, bytes, 0o600);
  assert.ok(fs.lstatSync(filePath).isFile());
  const pkg = inspectPackageTarball(context, filePath);
  assert.equal(pkg.version, fixture.version);
  return { ...fixture, path: fs.realpathSync.native(filePath) };
}

async function prepareFixtures(context) {
  const fixtureDir = path.join(context.tempBase, "historical-fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixtures = [];
  for (const fixture of context.manifest.fixtures) {
    fixtures.push(await downloadFixture(context, fixture, fixtureDir));
  }
  return fixtures;
}

function prepareCandidate(context, suppliedTarball) {
  let tarball = suppliedTarball;
  if (!tarball) {
    const candidateDir = path.join(context.tempBase, "candidate");
    fs.mkdirSync(candidateDir, { recursive: true });
    invoke(
      context,
      "npm",
      [
        "pack",
        "--silent",
        "--ignore-scripts",
        "--pack-destination",
        candidateDir,
      ],
      context.root,
    );
    const tarballs = fs
      .readdirSync(candidateDir)
      .filter((entry) => entry.endsWith(".tgz"));
    assert.equal(tarballs.length, 1, "candidate pack must create one tarball");
    tarball = path.join(candidateDir, tarballs[0]);
  }

  const realTarball = fs.realpathSync.native(tarball);
  assert.ok(fs.lstatSync(realTarball).isFile());
  const pkg = inspectPackageTarball(context, realTarball);
  const rootPackage = readJson(path.join(context.root, "package.json"));
  assert.equal(pkg.version, rootPackage.version);
  const digest = sha256File(realTarball);
  console.log(`${MIGRATION_TARBALL_DIGEST_PREFIX} ${digest}`);
  return {
    path: realTarball,
    version: pkg.version,
    digest,
    sourceDigests: Object.fromEntries(
      ["scripts/cli.mjs", "scripts/lib/hooks.mjs"].map((relativePath) => [
        relativePath,
        sha256File(path.join(context.root, relativePath)),
      ]),
    ),
  };
}

function createConsumerRepo(context, fixture) {
  const scenarioRoot = path.join(
    context.tempBase,
    `${fixture.id}-${context.packageManager}`,
  );
  const repoDir = path.join(scenarioRoot, "consumer path café");
  const remoteDir = path.join(scenarioRoot, "remote.git");
  fs.mkdirSync(repoDir, { recursive: true });
  git(context, ["init"], repoDir);
  git(context, ["config", "user.name", "migration-test"], repoDir);
  git(context, ["config", "user.email", "migration-test@example.com"], repoDir);
  git(context, ["branch", "-M", "main"], repoDir);

  writeFile(
    path.join(repoDir, "package.json"),
    `${JSON.stringify(
      {
        name: `commitment-issues-${fixture.id}-consumer`,
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: {
          prepare: PROJECT_PREPARE,
          test: "node --test test/*.test.mjs",
        },
        precommitChecks: {
          advisePushTests: true,
          commitMessage: {
            enabled: true,
            blockOnFailure: false,
          },
          tone: "standard",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFile(
    path.join(repoDir, "scripts", "project-prepare.mjs"),
    [
      'import fs from "node:fs";',
      'const marker = ".project-prepare-count";',
      'const current = fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;',
      "fs.writeFileSync(marker, String(current + 1));",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(repoDir, "eslint.config.js"),
    [
      'import js from "@eslint/js";',
      'import globals from "globals";',
      "",
      "export default [",
      "  js.configs.recommended,",
      "  { languageOptions: { globals: globals.node } },",
      "];",
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(repoDir, "src", "value.mjs"),
    "export const value=()=>1;\n",
  );
  writeFile(
    path.join(repoDir, "test", "value.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "../src/value.mjs";',
      "",
      'test("value", () => assert.equal(value(), 1));',
      "",
    ].join("\n"),
  );
  writeFile(
    path.join(repoDir, ".gitignore"),
    [
      ".custom-pre-commit.log",
      ".migration-artifacts/",
      ".project-prepare-count",
      "node_modules/",
      "",
    ].join("\n"),
  );
  git(context, ["init", "--bare", remoteDir], scenarioRoot);
  git(context, ["remote", "add", "origin", remoteDir], repoDir);
  return { repoDir, remoteDir };
}

function projectPrepareCount(repoDir) {
  const marker = path.join(repoDir, ".project-prepare-count");
  return fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : 0;
}

function assertPrepareScript(repoDir, expected = CANDIDATE_PREPARE) {
  const pkg = readJson(path.join(repoDir, "package.json"));
  assert.equal(pkg.scripts.prepare, expected);
}

function stageScriptOwnershipFixture(repoDir) {
  const packagePath = path.join(repoDir, "package.json");
  const pkg = readJson(packagePath);
  const expected = {
    "commit:fix": "commitment-issues commit-fix",
    "fix:staged": "commitment-issues fix-staged",
    "test:precommit": "commitment-issues precommit",
    doctor: "commitment-issues doctor",
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(
      pkg.scripts[name],
      value,
      `${name} must come from prior setup`,
    );
  }
  pkg.scripts["commit:fix"] = "node scripts/commit-fix.mjs";
  pkg.scripts.doctor = "node scripts/project-doctor.mjs";
  writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

function assertScriptOwnershipMigration(repoDir) {
  const { scripts } = readJson(path.join(repoDir, "package.json"));
  assert.equal(scripts["commit:fix"], "commitment-issues commit-fix");
  assert.equal(scripts["fix:staged"], "commitment-issues fix-staged");
  assert.equal(scripts["test:precommit"], "commitment-issues precommit");
  assert.equal(scripts.doctor, "node scripts/project-doctor.mjs");
}

function gitHookPath(context, repoDir, name) {
  const hookPath = git(
    context,
    ["rev-parse", "--git-path", `hooks/${name}`],
    repoDir,
  );
  return path.resolve(repoDir, hookPath);
}

function hooksPath(context, repoDir) {
  const result = invoke(
    context,
    "git",
    ["config", "--get", "core.hooksPath"],
    repoDir,
    { allowFailure: true },
  );
  assert.ok(result.status === 0 || result.status === 1);
  return result.stdout.trim();
}

function assertCurrentNativeHook(context, repoDir, name) {
  const content = fs.readFileSync(gitHookPath(context, repoDir, name), "utf8");
  assert.equal(content, hookBody(name));
  assert.match(content, /node_modules\/\.bin\/commitment-issues/u);
  assert.doesNotMatch(content, /export PATH="node_modules\/\.bin:\$PATH"/u);
  if (name === "pre-push") assert.match(content, /prepush "\$@"/u);
  return content;
}

function commitAndPush(
  context,
  repoDir,
  revision,
  message,
  { assertHooks = true } = {},
) {
  writeFile(
    path.join(repoDir, "src", "value.mjs"),
    `export const value=()=>${revision};\n`,
  );
  writeFile(
    path.join(repoDir, "test", "value.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { value } from "../src/value.mjs";',
      "",
      `test("value", () => assert.equal(value(), ${revision}));`,
      "",
    ].join("\n"),
  );
  git(context, ["add", "-A"], repoDir);
  const commit = invoke(context, "git", ["commit", "-m", message], repoDir);
  if (assertHooks) {
    assert.match(
      commit.output,
      /Pre-commit|Commitment Issues|suggestions found/iu,
      "a real git commit must execute the installed pre-commit hook",
    );
  }
  const push = invoke(
    context,
    "git",
    ["push", "-u", "origin", "main"],
    repoDir,
  );
  if (assertHooks) {
    assert.match(
      push.output,
      /Running tests for pushed files|All tests passed/iu,
      "a real git push must execute the installed pre-push hook",
    );
  }
  return { commit: commit.output, push: push.output };
}

function installPriorFixture(context, consumer, fixture) {
  const specs = [
    stageTarball(consumer.repoDir, fixture.path, `historical-${fixture.id}`),
    ...TOOL_VERSIONS,
  ];
  if (fixture.kind === "husky") specs.push(...HUSKY_TOOL_VERSIONS);
  managerAdd(context, consumer.repoDir, specs);
  assertInstalledVersion(context, consumer.repoDir, fixture.version);
  assertManagerLockfile(context, consumer.repoDir);
  const result = managerBin(context, ["init"], consumer.repoDir);
  assert.equal(result.status, 0, result.output);
  if (
    fixture.kind === "husky" &&
    hooksPath(context, consumer.repoDir) !== ".husky/_"
  ) {
    const activation = managerExec(context, "husky", [], consumer.repoDir);
    assert.equal(activation.status, 0, activation.output);
  }
  assertPrepareScript(
    consumer.repoDir,
    fixture.version === "3.3.2" ? LEGACY_DIRECT_PREPARE : PROJECT_PREPARE,
  );
  commitAndPush(context, consumer.repoDir, 1, `${fixture.id} baseline`, {
    assertHooks: false,
  });
  return result.output;
}

function installCandidate(context, repoDir) {
  const beforePrepare = projectPrepareCount(repoDir);
  if (context.packageManager === "yarn" || context.packageManager === "bun") {
    managerRemove(context, repoDir, [PACKAGE_NAME], { ignoreScripts: true });
  }
  const candidateSpec = stageTarball(
    repoDir,
    context.candidate.path,
    "candidate",
  );
  managerAdd(context, repoDir, [candidateSpec, ...TOOL_VERSIONS]);
  const init = managerBin(context, ["init"], repoDir);
  assert.equal(init.status, 0, init.output);
  const repeated = managerBin(context, ["init"], repoDir);
  assert.equal(repeated.status, 0, repeated.output);
  assertPrepareScript(repoDir);
  assertCandidateInstalled(context, repoDir);
  managerFrozenInstall(context, repoDir);
  assert.ok(
    projectPrepareCount(repoDir) > beforePrepare,
    "the project-owned prepare command must run during candidate installation",
  );
  assertCandidateInstalled(context, repoDir);
  return init.output;
}

export function runHuskyMigration(context, fixture) {
  const consumer = createConsumerRepo(context, fixture);
  installPriorFixture(context, consumer, fixture);
  assert.equal(hooksPath(context, consumer.repoDir), ".husky/_");

  const generatedPreCommit = path.join(
    consumer.repoDir,
    ".husky",
    "pre-commit",
  );
  assert.equal(
    fs.readFileSync(generatedPreCommit, "utf8"),
    "commitment-issues precommit\n",
  );
  assert.equal(
    fs.readFileSync(path.join(consumer.repoDir, ".husky", "pre-push"), "utf8"),
    "commitment-issues prepush\n",
  );
  const customPrePush = "echo custom legacy push\ncommitment-issues prepush\n";
  const customCommitMessage = "echo custom message policy\n";
  writeFile(
    path.join(consumer.repoDir, ".husky", "pre-push"),
    customPrePush,
    0o755,
  );
  writeFile(
    path.join(consumer.repoDir, ".husky", "commit-msg"),
    customCommitMessage,
    0o755,
  );

  managerRemove(context, consumer.repoDir, ["husky", "lint-staged"]);
  const output = installCandidate(context, consumer.repoDir);
  assert.match(output, /retired husky-era core\.hooksPath/u);
  assert.match(output, /removed legacy \.husky wiring/u);
  assert.match(output, /Leftover \.husky hooks no longer run/u);
  assert.equal(hooksPath(context, consumer.repoDir), "");
  assert.equal(fs.existsSync(generatedPreCommit), false);
  assert.equal(
    fs.readFileSync(path.join(consumer.repoDir, ".husky", "pre-push"), "utf8"),
    customPrePush,
  );
  assert.equal(
    fs.readFileSync(
      path.join(consumer.repoDir, ".husky", "commit-msg"),
      "utf8",
    ),
    customCommitMessage,
  );
  assertCurrentNativeHook(context, consumer.repoDir, "pre-commit");
  assertCurrentNativeHook(context, consumer.repoDir, "pre-push");
  assertCurrentNativeHook(context, consumer.repoDir, "commit-msg");
  commitAndPush(
    context,
    consumer.repoDir,
    2,
    "candidate after Husky migration",
  );
  assert.equal(sha256File(context.candidate.path), context.candidate.digest);
}

export function runNativeMigration(context, fixture) {
  const consumer = createConsumerRepo(context, fixture);
  installPriorFixture(context, consumer, fixture);
  assert.equal(hooksPath(context, consumer.repoDir), "");

  const preCommitPath = gitHookPath(context, consumer.repoDir, "pre-commit");
  const prePushPath = gitHookPath(context, consumer.repoDir, "pre-push");
  const commitMessagePath = gitHookPath(
    context,
    consumer.repoDir,
    "commit-msg",
  );
  const oldPreCommit = fs.readFileSync(preCommitPath, "utf8");
  const oldPrePush = fs.readFileSync(prePushPath, "utf8");
  const oldCommitMessage = fs.existsSync(commitMessagePath)
    ? fs.readFileSync(commitMessagePath, "utf8")
    : null;
  assert.match(oldPreCommit, /export PATH="node_modules\/\.bin:\$PATH"/u);
  assert.match(oldPrePush, /export PATH="node_modules\/\.bin:\$PATH"/u);
  if (oldCommitMessage !== null) {
    assert.match(oldCommitMessage, /export PATH="node_modules\/\.bin:\$PATH"/u);
  }
  const customPreCommit = [
    "#!/bin/sh",
    'printf "custom-pre-commit\\n" >> .custom-pre-commit.log',
    "node_modules/.bin/commitment-issues precommit",
    "",
  ].join("\n");
  const preserveCustomPreCommit = fixture.version === "3.2.0";
  if (preserveCustomPreCommit) {
    writeFile(preCommitPath, customPreCommit, 0o755);
  }
  stageScriptOwnershipFixture(consumer.repoDir);

  installCandidate(context, consumer.repoDir);
  if (preserveCustomPreCommit) {
    assert.equal(fs.readFileSync(preCommitPath, "utf8"), customPreCommit);
  } else {
    const currentPreCommit = assertCurrentNativeHook(
      context,
      consumer.repoDir,
      "pre-commit",
    );
    assert.notEqual(currentPreCommit, oldPreCommit);
  }
  assertScriptOwnershipMigration(consumer.repoDir);
  const currentPrePush = assertCurrentNativeHook(
    context,
    consumer.repoDir,
    "pre-push",
  );
  assert.notEqual(currentPrePush, oldPrePush);
  const currentCommitMessage = assertCurrentNativeHook(
    context,
    consumer.repoDir,
    "commit-msg",
  );
  if (oldCommitMessage !== null) {
    assert.notEqual(currentCommitMessage, oldCommitMessage);
  }
  commitAndPush(
    context,
    consumer.repoDir,
    fixture.version === "3.3.2" ? 4 : 3,
    `candidate after ${fixture.version}`,
  );
  if (preserveCustomPreCommit) {
    assert.match(
      fs.readFileSync(
        path.join(consumer.repoDir, ".custom-pre-commit.log"),
        "utf8",
      ),
      /custom-pre-commit/u,
    );
  }
  assert.equal(sha256File(context.candidate.path), context.candidate.digest);
}

export async function createMigrationContext({
  root,
  packageManager,
  suppliedTarball,
  fetchImpl = fetch,
}) {
  assert.ok(
    isSupportedMigrationManager(packageManager),
    `unsupported migration package manager: ${packageManager}`,
  );
  const [nodeMajor] = process.versions.node.split(".").map(Number);
  assert.ok(nodeMajor >= 24, "migration fixtures require Node 24 or newer");
  const tempBase = fs.mkdtempSync(
    path.join(os.tmpdir(), "commitment-issues-migration-"),
  );
  const context = {
    root,
    packageManager,
    tempBase,
    fetchImpl,
    env: createIsolatedMigrationEnvironment(tempBase),
    manifest: loadMigrationManifest(root),
  };
  try {
    context.candidate = prepareCandidate(context, suppliedTarball);
    context.fixtures = await prepareFixtures(context);
    console.log(
      `[lifecycle migration] package manager: ${packageManager} ${runOutput(
        context,
        packageManager,
        ["--version"],
        root,
      )}`,
    );
    return context;
  } catch (error) {
    fs.rmSync(tempBase, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupMigrationContext(context) {
  fs.rmSync(context.tempBase, { recursive: true, force: true });
}
