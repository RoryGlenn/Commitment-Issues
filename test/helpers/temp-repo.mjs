// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { withoutGitLocalEnvironment } from "../../scripts/lib/process.mjs";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(helpersDir, "..", "..");

// Absolute path to the real git, captured once (before any PATH override) so
// the fake-git shim can delegate non-failing invocations to it. `which` is
// POSIX-only, so use `where` on Windows.
export const REAL_GIT = (() => {
  const finder = process.platform === "win32" ? "where" : "which";
  const out = spawnSync(finder, ["git"], { encoding: "utf8" }).stdout || "";
  return out.split(/\r?\n/)[0].trim() || "git";
})();

export function run(command, args, cwd, options = {}) {
  // CI sets COMMITMENT_ISSUES=0 (hooks honor HUSKY=0 too, for pre-3.0 compat)
  // to skip hook runs in the outer repo. The doctor/cli tests need hooks to
  // actually wire up and fire, so strip the skip vars from the subprocess env
  // (whether inherited or caller-provided) to keep the tests hermetic
  // regardless of the outer environment.
  const env = withoutGitLocalEnvironment(options.env ?? process.env);
  delete env.HUSKY;
  delete env.COMMITMENT_ISSUES;
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options,
    env,
  });
}

export function runAsync(command, args, cwd, options = {}) {
  const env = withoutGitLocalEnvironment(options.env ?? process.env);
  delete env.HUSKY;
  delete env.COMMITMENT_ISSUES;
  const child = spawn(command, args, {
    cwd,
    ...options,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ status: null, signal: null, stdout, stderr, error });
    });
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

export async function waitForPath(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

export function installBlockingPrettierFixture(tempDir) {
  const nodeModules = path.join(tempDir, "node_modules");
  const current = fs.lstatSync(nodeModules);
  if (current.isSymbolicLink()) {
    fs.unlinkSync(nodeModules);
  } else {
    fs.rmSync(nodeModules, { recursive: true });
  }
  writeFile(
    path.join(nodeModules, "prettier", "package.json"),
    `${JSON.stringify({ name: "prettier", bin: "bin/prettier.mjs" })}\n`,
  );
  writeFile(
    path.join(nodeModules, "prettier", "bin", "prettier.mjs"),
    [
      'import fs from "node:fs";',
      'import { setTimeout as delay } from "node:timers/promises";',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      "for await (const chunk of process.stdin) input += chunk;",
      'fs.writeFileSync(process.env.FIXER_READY, "ready");',
      "while (!fs.existsSync(process.env.FIXER_RELEASE)) await delay(10);",
      "process.stdout.write(process.env.FIXER_OUTPUT ?? input);",
      "",
    ].join("\n"),
  );
}

export function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

export function fsFailurePreload(tempDir) {
  const preloadPath = path.join(tempDir, "fs-failure-preload.mjs");
  writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "function canonical(filePath) {",
      "  const resolved = path.resolve(filePath);",
      "  let current = resolved;",
      "  const missingSegments = [];",
      "  let canonicalPath = resolved;",
      "  for (;;) {",
      "    try {",
      "      canonicalPath = path.join(",
      "        fs.realpathSync.native(current),",
      "        ...missingSegments,",
      "      );",
      "      break;",
      "    } catch {",
      "      const parent = path.dirname(current);",
      "      if (parent === current) break;",
      "      missingSegments.unshift(path.basename(current));",
      "      current = parent;",
      "    }",
      "  }",
      '  return process.platform === "win32"',
      "    ? canonicalPath.toLowerCase()",
      "    : canonicalPath;",
      "}",
      "const method = process.env.TEST_FS_FAILURE_METHOD;",
      "const target = canonical(process.env.TEST_FS_FAILURE_PATH);",
      "const original = fs[method].bind(fs);",
      "fs[method] = (filePath, ...args) => {",
      '  if (typeof filePath === "string" && canonical(filePath) === target) {',
      '    throw Object.assign(new Error("injected filesystem failure"), { code: "EACCES" });',
      "  }",
      "  return original(filePath, ...args);",
      "};",
      "",
    ].join("\n"),
  );
  return pathToFileURL(preloadPath).href;
}

export function mutableProjectFileFailurePreload(tempDir) {
  const preloadPath = path.join(
    tempDir,
    "mutable-project-file-failure-preload.mjs",
  );
  writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const target = path.resolve(process.env.TEST_FS_FAILURE_PATH);",
      "const targetDirectory = fs.realpathSync.native(path.dirname(target));",
      "const stagePrefix = `.${path.basename(target)}.commitment-issues-`;",
      "const method = process.env.TEST_FS_FAILURE_METHOD;",
      'const code = process.env.TEST_FS_FAILURE_CODE || "EIO";',
      "const originalOpen = fs.openSync;",
      "const originalWrite = fs.writeSync;",
      "const originalChmod = fs.fchmodSync;",
      "const originalSync = fs.fsyncSync;",
      "const originalClose = fs.closeSync;",
      "const originalRename = fs.renameSync;",
      "const originalLink = fs.linkSync;",
      "let stagedDescriptor;",
      "function injected() {",
      '  return Object.assign(new Error("injected mutable project file failure"), { code });',
      "}",
      "function isTargetStage(filePath) {",
      '  if (typeof filePath !== "string") return false;',
      "  const resolved = path.resolve(filePath);",
      "  const directory = fs.realpathSync.native(path.dirname(resolved));",
      "  return directory === targetDirectory &&",
      "    path.basename(resolved).startsWith(stagePrefix) &&",
      '    path.basename(resolved).endsWith(".tmp");',
      "}",
      "fs.openSync = (filePath, ...args) => {",
      '  if (method === "openSync" && isTargetStage(filePath)) throw injected();',
      "  const descriptor = originalOpen(filePath, ...args);",
      "  if (isTargetStage(filePath)) stagedDescriptor = descriptor;",
      "  return descriptor;",
      "};",
      "fs.writeSync = (descriptor, buffer, offset, length, position) => {",
      '  if (method === "writeSync" && descriptor === stagedDescriptor) {',
      "    originalWrite(",
      "      descriptor,",
      "      buffer,",
      "      offset,",
      "      Math.min(length, 4),",
      "      position,",
      "    );",
      "    throw injected();",
      "  }",
      "  return originalWrite(descriptor, buffer, offset, length, position);",
      "};",
      "fs.fchmodSync = (descriptor, mode) => {",
      '  if (method === "fchmodSync" && descriptor === stagedDescriptor) {',
      "    throw injected();",
      "  }",
      "  return originalChmod(descriptor, mode);",
      "};",
      "fs.fsyncSync = (descriptor) => {",
      '  if (method === "fsyncSync" && descriptor === stagedDescriptor) {',
      "    throw injected();",
      "  }",
      "  return originalSync(descriptor);",
      "};",
      "fs.closeSync = (descriptor) => {",
      '  if (method === "closeSync" && descriptor === stagedDescriptor) {',
      "    originalClose(descriptor);",
      "    throw injected();",
      "  }",
      "  return originalClose(descriptor);",
      "};",
      "fs.renameSync = (source, destination) => {",
      '  if (method === "renameSync" &&',
      "      isTargetStage(source)) {",
      "    throw injected();",
      "  }",
      "  return originalRename(source, destination);",
      "};",
      "fs.linkSync = (source, destination) => {",
      '  if (method === "linkSync" &&',
      "      isTargetStage(source)) {",
      "    throw injected();",
      "  }",
      "  return originalLink(source, destination);",
      "};",
      "",
    ].join("\n"),
  );
  return pathToFileURL(preloadPath).href;
}

export function readFile(tempDir, relativePath) {
  return fs.readFileSync(path.join(tempDir, relativePath), "utf8");
}

export function readHeadFile(tempDir, relativePath) {
  const result = run("git", ["show", `HEAD:${relativePath}`], tempDir);
  return result.stdout;
}

export function createTempRepo({ commit = true, suppressWelcome = true } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-checks-"));

  run("git", ["init"], tempDir);
  // Keep byte-for-byte filesystem assertions isolated from Git's detached
  // automatic maintenance, whose transient lock can outlive the command that
  // created the fixture repository.
  run("git", ["config", "maintenance.auto", "false"], tempDir);
  run("git", ["config", "user.name", "test"], tempDir);
  run("git", ["config", "user.email", "test@example.com"], tempDir);

  // Copy the repo's own package.json, but drop its personal `tone` preference.
  // Behavior tests assert on the default (standard) advisory wording; the
  // fun-tone variants are covered separately by tests that opt in explicitly
  // via setPrecommitConfig. Without this, the repo choosing `tone: "fun"` for
  // its own commits would silently rewrite those assertions.
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  if (rootPkg.precommitChecks && typeof rootPkg.precommitChecks === "object") {
    delete rootPkg.precommitChecks.tone;
    if (suppressWelcome) {
      // Most fixtures target an established hook state. Keep the new
      // once-per-clone onboarding box out of unrelated output assertions;
      // welcome-specific tests opt back into the production default.
      rootPkg.precommitChecks.showWelcomeOnFirstCommit = false;
    } else {
      delete rootPkg.precommitChecks.showWelcomeOnFirstCommit;
    }
  }
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(rootPkg, null, 2)}\n`,
  );
  writeFile(
    path.join(tempDir, "eslint.config.js"),
    fs.readFileSync(path.join(repoRoot, "eslint.config.js"), "utf8"),
  );
  writeFile(
    path.join(tempDir, "README.md"),
    fs.readFileSync(path.join(repoRoot, "README.md"), "utf8"),
  );
  // Symlink (instead of copy) the real scripts so subprocess runs resolve to
  // the repo's actual files. Node attributes V8 coverage to a module's realpath,
  // so this lets the entry-script subprocesses count toward the coverage report
  // (a copy would attribute coverage to the ephemeral temp path instead).
  fs.symlinkSync(path.join(repoRoot, "scripts"), path.join(tempDir, "scripts"));
  fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(tempDir, "node_modules"),
  );

  writeFile(path.join(tempDir, ".gitignore"), "node_modules/\nscripts/\n");
  if (commit) {
    run("git", ["add", "."], tempDir);
    run("git", ["commit", "-m", "init"], tempDir);
  }

  return tempDir;
}

export function cleanupTempRepo(tempDir) {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// Overwrite the temp repo's precommitChecks config block.
export function setPrecommitConfig(
  tempDir,
  precommitChecks,
  { suppressWelcome = true } = {},
) {
  const pkg = JSON.parse(readFile(tempDir, "package.json"));
  pkg.precommitChecks = {
    ...(suppressWelcome ? { showWelcomeOnFirstCommit: false } : {}),
    ...precommitChecks,
  };
  writeFile(
    path.join(tempDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}

// Give the temp repo an upstream (bare remote + tracking branch on `main`) so
// commands that fall back to `@{u}` have something to diff against.
export function addBareRemote(tempDir) {
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-remote-"));
  run("git", ["init", "--bare"], remoteDir);
  run("git", ["branch", "-M", "main"], tempDir);
  run("git", ["remote", "add", "origin", remoteDir], tempDir);
  run("git", ["push", "-u", "origin", "main"], tempDir);
  return remoteDir;
}

// Write a cross-platform executable `name` into binDir that runs a Node shim
// with the same arguments: a shebang launcher for POSIX shells plus a matching
// `.cmd` for Windows (cross-spawn resolves `.cmd` there via PATHEXT).
export function writeCrossPlatformShim(binDir, name, shimBody) {
  const shimPath = path.join(binDir, `${name}-shim.mjs`);
  fs.writeFileSync(shimPath, shimBody);
  const unix = path.join(binDir, name);
  fs.writeFileSync(unix, '#!/bin/sh\nexec node "${0}-shim.mjs" "$@"\n');
  fs.chmodSync(unix, 0o755);
  fs.writeFileSync(
    path.join(binDir, `${name}.cmd`),
    [
      "@echo off",
      "setlocal DisableDelayedExpansion",
      'node "%~dpn0-shim.mjs" %*',
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n"),
  );
}

// Build an env that puts a fake `git` first on PATH. The shim exits with
// `exitCode` (default 1) for any invocation whose joined args contain
// `matchSubstring` — without running git — and delegates to the real git
// otherwise. Optional stdout is base64-encoded through the environment so test
// fixtures can include NUL-delimited Git output. Used to exercise defensive Git
// failure/malformed-output branches without corrupting a real repository.
// Cross-platform: a Node shim behind `git`/`git.cmd` launchers.
export function fakeGitEnv(
  tempDir,
  matchSubstring,
  exitCode = 1,
  stdout = "",
  stderr = "",
) {
  const binDir = path.join(tempDir, ".fakebin");
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    "git",
    `import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const match = process.env.FAKE_GIT_MATCH || "";
if (match && args.join(" ").includes(match)) {
  const stdout = process.env.FAKE_GIT_STDOUT_BASE64 || "";
  if (stdout) {
    process.stdout.write(Buffer.from(stdout, "base64"));
  }
  const stderr = process.env.FAKE_GIT_STDERR_BASE64 || "";
  if (stderr) {
    process.stderr.write(Buffer.from(stderr, "base64"));
  }
  process.exit(Number(process.env.FAKE_GIT_EXIT ?? "1"));
}
const result = spawnSync(process.env.FAKE_GIT_REAL || "git", args, {
  stdio: "inherit",
});
process.exit(result.status == null ? 1 : result.status);
`,
  );
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    FAKE_GIT_MATCH: matchSubstring,
    FAKE_GIT_EXIT: String(exitCode),
    FAKE_GIT_STDOUT_BASE64: Buffer.from(stdout).toString("base64"),
    FAKE_GIT_STDERR_BASE64: Buffer.from(stderr).toString("base64"),
    FAKE_GIT_REAL: REAL_GIT,
  };
}

// Build an env whose `git` appends each invocation's argv (one space-joined
// line per call) to `logPath` before delegating to the real git, so a test can
// assert exactly how a script invoked git (e.g. that it forced
// core.quotePath=false). Cross-platform: a Node shim behind `git`/`git.cmd`.
export function recordingGitEnv(tempDir, logPath) {
  const binDir = path.join(tempDir, ".fakebin");
  fs.mkdirSync(binDir, { recursive: true });
  writeCrossPlatformShim(
    binDir,
    "git",
    `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GIT_LOG_FILE, args.join(" ") + "\\n");
const result = spawnSync(process.env.FAKE_GIT_REAL || "git", args, {
  stdio: "inherit",
});
process.exit(result.status == null ? 1 : result.status);
`,
  );
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    GIT_LOG_FILE: logPath,
    FAKE_GIT_REAL: REAL_GIT,
  };
}
