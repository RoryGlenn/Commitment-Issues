// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import spawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import { loadPrecommitConfig, MAX_TIMEOUT_MS } from "./config.mjs";

// Default ceiling for any tool the hooks spawn, so a hung tool can never wedge a
// commit indefinitely. Override with precommitChecks.timeoutMs (positive number
// no greater than Node's maximum timer delay).
export const DEFAULT_TOOL_TIMEOUT_MS = 120000;

/**
 * Resolve the configured tool deadline when a command is ready to run. Keeping
 * this lazy lets entrypoints anchor cwd to the owning worktree before config is
 * read, while help and version output stay free of repository probes.
 * @param {string} [cwd] - Project root containing the configuration.
 * @returns {number} Positive timeout in milliseconds.
 */
export function toolTimeoutMs(cwd = process.cwd()) {
  const configuredTimeout = Number(loadPrecommitConfig(cwd).timeoutMs);
  return Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TOOL_TIMEOUT_MS;
}

// Keep argv comfortably below the launchers supported by the project. Windows
// uses UTF-16 command-line units and must leave room for cross-spawn's `.cmd`
// wrapper; POSIX uses UTF-8 bytes and leaves ample room for the environment
// below the supported hosts' execve limits. These are argument budgets, not
// file-count limits: path length and configured options determine batch size.
export const WINDOWS_ARGUMENT_BUDGET_UNITS = 6_000;
export const POSIX_ARGUMENT_BUDGET_BYTES = 24_000;

/**
 * Conservative argument budget for one supported-platform process launch.
 * @param {NodeJS.Platform} [platform] - Platform whose launcher is targeted.
 * @returns {number} UTF-16 units on Windows, UTF-8 bytes elsewhere.
 */
export function processArgumentBudget(platform = process.platform) {
  return platform === "win32"
    ? WINDOWS_ARGUMENT_BUDGET_UNITS
    : POSIX_ARGUMENT_BUDGET_BYTES;
}

/**
 * Estimate one no-shell command's argument pressure in platform-native units.
 * Windows doubles content as a safety allowance for quotes, backslashes, and
 * cross-spawn metacharacter escaping. POSIX counts each UTF-8 argv string and
 * its terminating NUL.
 * @param {string} command - Executable path/name.
 * @param {string[]} args - Arguments passed to the executable.
 * @param {NodeJS.Platform} [platform] - Platform whose launcher is targeted.
 * @returns {number} Conservative command units.
 */
export function estimatedProcessArgumentUnits(
  command,
  args,
  platform = process.platform,
) {
  const values = [command, ...args];
  if (platform === "win32") {
    return values.reduce(
      (total, value, index) =>
        total + String(value).length * 2 + 2 + (index === 0 ? 0 : 1),
      0,
    );
  }
  return values.reduce(
    (total, value) => total + Buffer.byteLength(String(value), "utf8") + 1,
    0,
  );
}

/**
 * Partition variable argument items without exceeding one platform budget.
 * Fixed arguments are present in every batch; one item may expand to multiple
 * argv entries through `itemArguments`.
 * @template T
 * @param {string} command - Executable path/name.
 * @param {string[]} fixedArgs - Arguments repeated for every batch.
 * @param {T[]} items - Variable items to partition.
 * @param {object} [options] - Platform, budget, and item mapping.
 * @param {NodeJS.Platform} [options.platform] - Target platform.
 * @param {number} [options.budget] - Override used by deterministic tests.
 * @param {(item: T) => string[]} [options.itemArguments] - Item-to-argv mapping.
 * @returns {Array<{args: string[], items: T[], estimatedUnits: number}>} Batches.
 */
export function batchProcessArguments(
  command,
  fixedArgs,
  items,
  {
    platform = process.platform,
    budget = processArgumentBudget(platform),
    itemArguments = (item) => [String(item)],
  } = {},
) {
  const fixedUnits = estimatedProcessArgumentUnits(
    command,
    fixedArgs,
    platform,
  );
  if (!Number.isFinite(budget) || budget <= 0 || fixedUnits > budget) {
    const error = new RangeError(
      `Fixed process arguments require ${fixedUnits} units but the budget is ${budget}`,
    );
    error.code = "ERR_ARGUMENT_BUDGET";
    throw error;
  }

  const batches = [];
  let batchArgs = [...fixedArgs];
  let batchItems = [];
  let batchUnits = fixedUnits;

  for (const item of items) {
    const variableArgs = itemArguments(item).map(String);
    const itemUnits =
      estimatedProcessArgumentUnits(command, variableArgs, platform) -
      estimatedProcessArgumentUnits(command, [], platform);
    if (fixedUnits + itemUnits > budget) {
      const error = new RangeError(
        `One process argument item requires ${fixedUnits + itemUnits} units but the budget is ${budget}`,
      );
      error.code = "ERR_ARGUMENT_BUDGET";
      throw error;
    }
    if (batchItems.length > 0 && batchUnits + itemUnits > budget) {
      batches.push({
        args: batchArgs,
        items: batchItems,
        estimatedUnits: batchUnits,
      });
      batchArgs = [...fixedArgs];
      batchItems = [];
      batchUnits = fixedUnits;
    }
    batchArgs.push(...variableArgs);
    batchItems.push(item);
    batchUnits += itemUnits;
  }

  if (batchItems.length > 0) {
    batches.push({
      args: batchArgs,
      items: batchItems,
      estimatedUnits: batchUnits,
    });
  }
  return batches;
}

/**
 * @typedef {"success" | "nonzero" | "signal" | "timeout" | "spawn-error" | "missing-tool"} ProcessOutcome
 */

/**
 * Add one stable outcome to a child-process result. Consumers should branch on
 * `outcome` instead of inferring timeouts from a signal or spawn failures from
 * a null status.
 * @param {object} result - Raw process fields.
 * @param {boolean} [result.timedOut] - Whether our deadline fired.
 * @param {Error} [result.error] - Spawn error.
 * @param {number|null} [result.status] - Exit status.
 * @param {string|null} [result.signal] - Terminating signal.
 * @param {string} [result.stdout] - Captured stdout.
 * @param {string} [result.stderr] - Captured stderr.
 * @returns {object & {outcome: ProcessOutcome, timedOut: boolean}} Structured result.
 */
function withOutcome(result) {
  const timedOut =
    result.timedOut === true || result.error?.code === "ETIMEDOUT";
  let outcome;
  if (result.missingTool) {
    outcome = "missing-tool";
  } else if (timedOut) {
    outcome = "timeout";
  } else if (result.error) {
    outcome = "spawn-error";
  } else if (result.signal) {
    outcome = "signal";
  } else if (result.status === 0) {
    outcome = "success";
  } else if (typeof result.status === "number") {
    outcome = "nonzero";
  } else {
    outcome = "spawn-error";
  }
  return { ...result, outcome, timedOut };
}

/**
 * Run a command synchronously, capturing utf8 output. Uses cross-spawn so bare
 * command names (git, node) resolve on Windows without a shell, which also
 * avoids the Node DEP0190 warning and shell arg-quoting pitfalls.
 *
 * Long-running tool and configurable-command paths use {@link spawnAsync}, whose
 * timeout can clean up descendants. `run` is retained for short Git probes.
 * @param {string} command - Executable.
 * @param {string[]} args - Arguments.
 * @param {object} [options] - Extra spawnSync options.
 * @returns {import("node:child_process").SpawnSyncReturns<string> & {outcome: ProcessOutcome, timedOut: boolean}} Result.
 */
export function run(command, args, options = {}) {
  return withOutcome(
    spawn.sync(command, args, {
      encoding: "utf8",
      ...options,
    }),
  );
}

// Repository-local variables reported by `git rev-parse --local-env-vars`.
// Git exports these to hooks so Git subprocesses keep targeting the caller's
// repository even after changing cwd. That is useful for hook plumbing but
// unsafe for project test suites that create disposable repositories.
const GIT_LOCAL_ENVIRONMENT_VARIABLES = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];

/**
 * Copy an environment without Git's repository-local routing variables.
 * Commands launched from the repository root can rediscover the same checkout
 * by cwd, while nested Git fixtures remain isolated from the hook's caller.
 * @param {NodeJS.ProcessEnv} [environment] - Source environment.
 * @returns {NodeJS.ProcessEnv} Sanitized copy.
 */
export function withoutGitLocalEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const variable of GIT_LOCAL_ENVIRONMENT_VARIABLES) {
    delete sanitized[variable];
  }
  // GIT_CONFIG_COUNT is accompanied by a numbered key/value pair for each
  // entry. Git does not list those generated names individually.
  for (const variable of Object.keys(sanitized)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(variable)) {
      delete sanitized[variable];
    }
  }
  return sanitized;
}

function stripPathRecordTerminator(output) {
  const value = String(output || "");
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}

/**
 * Resolve the non-bare worktree that owns a directory. Git-local routing
 * variables are removed so cwd, including a nested repository or worktree,
 * remains authoritative.
 * @param {string} [cwd] - Directory whose owning worktree should be resolved.
 * @param {NodeJS.ProcessEnv} [environment] - Environment for the Git probe.
 * @returns {string|null} Absolute worktree root, or null outside a worktree.
 */
export function resolveWorktreeRoot(
  cwd = process.cwd(),
  environment = process.env,
) {
  const result = run(
    "git",
    ["-c", "core.quotePath=false", "rev-parse", "--show-toplevel"],
    { cwd, env: withoutGitLocalEnvironment(environment) },
  );
  if (result.error || result.status !== 0) return null;
  const root = stripPathRecordTerminator(result.stdout);
  return root && !root.includes("\0") ? path.resolve(cwd, root) : null;
}

/**
 * Check whether a directory is the owning worktree root by filesystem
 * identity. Windows launchers can spell the same directory with short and
 * long paths, while POSIX callers can reach it through a symlink.
 * @param {string} [cwd] - Directory to compare with the worktree root.
 * @param {string|null} [worktreeRoot] - Previously resolved worktree root.
 * @returns {boolean} Whether both paths identify the same directory.
 */
export function isWorktreeRoot(
  cwd = process.cwd(),
  worktreeRoot = resolveWorktreeRoot(cwd),
) {
  if (!worktreeRoot) return false;
  const canonical = (directory) => {
    const resolved = path.resolve(directory);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  return path.relative(canonical(worktreeRoot), canonical(cwd)) === "";
}

/**
 * Make repository-relative config, paths, tools, and child cwd deterministic
 * for a runtime command launched anywhere inside its owning worktree.
 * @returns {string|null} The entered root, or null when cwd is not a worktree.
 */
export function enterWorktreeRoot() {
  const root = resolveWorktreeRoot();
  if (root) process.chdir(root);
  return root;
}

/**
 * Find a package manifest in the project's reachable node_modules tree.
 * Resolution deliberately starts at the project cwd, not this package's own
 * install directory, so a bundled/development copy cannot mask a missing peer.
 * @param {string} name - Package name.
 * @param {string} cwd - Project root.
 * @returns {string|null} Manifest path.
 */
function findPackageManifest(name, cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(manifest)) {
      return manifest;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

// Resolve a tool's CLI entry from the project's nearest node_modules (via its
// package.json `bin` field) so it can be run with the current Node directly.
// There is intentionally no npx fallback: a missing peer must never turn a Git
// hook into an implicit registry query or install.
function resolveTool(name, cwd) {
  try {
    const pkgPath = findPackageManifest(name, cwd);
    if (!pkgPath) {
      return null;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const rel =
      typeof pkg.bin === "string" ? pkg.bin : pkg.bin && pkg.bin[name];
    if (!rel) {
      return null;
    }
    const bin = path.resolve(path.dirname(pkgPath), rel);
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * Build a local-only spawn invocation for a peer tool.
 * @param {string} name - Package/bin name (e.g. "eslint").
 * @param {string[]} args - Tool arguments.
 * @param {string} [cwd] - Project root used for node_modules resolution.
 * @returns {{command: string, args: string[], missingTool?: undefined} | {command: null, args: [], missingTool: string}} Invocation parts or a structured missing-tool result.
 */
export function toolInvocation(name, args, cwd = process.cwd()) {
  const bin = resolveTool(name, cwd);
  if (bin) {
    return { command: process.execPath, args: [bin, ...args] };
  }
  return { command: null, args: [], missingTool: name };
}

/**
 * Whether a package is installed in a project, i.e. present in a node_modules
 * reachable from that project's root. commitment-issues orchestrates peer tools
 * (eslint, prettier) but does not bundle or download them.
 * @param {string} name - Package name (e.g. "eslint").
 * @param {string} [cwd] - Project root to resolve from (defaults to cwd).
 * @returns {boolean} True when the package is installed in the project.
 */
export function isPackageInstalled(name, cwd = process.cwd()) {
  return findPackageManifest(name, cwd) !== null;
}

/**
 * Whether a project-local package exposes an existing executable bin.
 * @param {string} name - Package/bin name.
 * @param {string} [cwd] - Project root to resolve from.
 * @returns {boolean} True when the tool can be invoked locally.
 */
export function isToolInstalled(name, cwd = process.cwd()) {
  return resolveTool(name, cwd) !== null;
}

/**
 * Whether a configured command invokes Node's built-in test runner.
 * @param {string[]} command - Executable plus configured arguments.
 * @returns {boolean} True for node/node.exe commands containing --test.
 */
export function isNodeTestCommand(command) {
  return (
    Array.isArray(command) &&
    /(^|[/\\])node(\.exe)?$/i.test(command[0] || "") &&
    command.includes("--test")
  );
}

/**
 * Split Node test-runner arguments into the fixed options repeated per batch
 * and the configured/discovered positional arguments that may be partitioned.
 * Discovered paths beginning with `-` become absolute because Node can still
 * interpret a leading-hyphen relative pathname after `--` as an option.
 * @param {string[]} command - Node executable plus configured arguments.
 * @param {string[]} files - Discovered test paths.
 * @param {string[]} [injectedOptions] - Additional Node options.
 * @returns {{fixedArgs: string[], fileArgs: string[]}} Batchable arguments.
 */
export function nodeTestArgumentParts(command, files, injectedOptions = []) {
  const configured = command.slice(1);
  const separator = configured.indexOf("--");
  const options =
    separator === -1 ? configured : configured.slice(0, separator);
  const positionals = separator === -1 ? [] : configured.slice(separator + 1);
  // Node's test runner can still mis-handle a leading-hyphen relative pathname
  // after `--`; an absolute path is unambiguously positional on every platform.
  const safeFiles = files.map((file) =>
    file.startsWith("-") ? path.resolve(file) : file,
  );
  return {
    fixedArgs: [...options, ...injectedOptions, "--"],
    fileArgs: [...positionals, ...safeFiles],
  };
}

/**
 * Build Node test-runner arguments with discovered paths behind `--`. An
 * existing separator is normalized so injected options remain before it.
 * @param {string[]} command - Node executable plus configured arguments.
 * @param {string[]} files - Discovered test paths.
 * @param {string[]} [injectedOptions] - Additional Node options.
 * @returns {string[]} Arguments excluding the Node executable.
 */
export function nodeTestArguments(command, files, injectedOptions = []) {
  const { fixedArgs, fileArgs } = nodeTestArgumentParts(
    command,
    files,
    injectedOptions,
  );
  return [...fixedArgs, ...fileArgs];
}

/**
 * Force-terminate a spawned process and its still-attached descendants.
 * POSIX children are launched as process-group leaders, so a negative pid kills
 * the group. Windows uses the built-in taskkill tree operation. Both paths fall
 * back to killing the direct child if the tree operation is unavailable.
 * @param {import("node:child_process").ChildProcess} child - Spawned child.
 * @param {NodeJS.Platform} [platform] - Platform strategy to use.
 * @param {Function} [taskkill] - Synchronous taskkill runner.
 * @param {Function} [killGroup] - POSIX process-group signal function.
 * @returns {"process-group" | "taskkill-tree" | "direct-child" | "already-exited"} Cleanup method.
 */
export function terminateProcessTree(
  child,
  platform = process.platform,
  taskkill = spawn.sync,
  killGroup = process.kill,
) {
  if (!child.pid) {
    return "already-exited";
  }

  if (platform === "win32") {
    const killed = taskkill(
      "taskkill",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    if (!killed.error && killed.status === 0) {
      return "taskkill-tree";
    }
  } else {
    try {
      killGroup(-child.pid, "SIGKILL");
      return "process-group";
    } catch (error) {
      if (error?.code === "ESRCH") {
        return "already-exited";
      }
    }
  }

  try {
    child.kill("SIGKILL");
    return "direct-child";
  } catch {
    return "already-exited";
  }
}

/**
 * Whether a spawned child should lead a dedicated POSIX process group.
 * Windows uses taskkill for descendant cleanup instead.
 * @param {NodeJS.Platform} platform - Runtime platform.
 * @returns {boolean} True when the child should be detached.
 */
export function detachedForPlatform(platform) {
  return platform !== "win32";
}

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const PROCESS_CLEANUP_GRACE_MS = 1000;

/** Create invocation-wide process-tree signal ownership. */
export function createProcessInterruptionManager({
  targetProcess = process,
  platform = process.platform,
  terminate = terminateProcessTree,
  cleanupGraceMs = PROCESS_CLEANUP_GRACE_MS,
} = {}) {
  const signals = Object.keys(SIGNAL_EXIT_CODES);
  const trees = new Set();
  let parentSignal;
  let finished = false;
  const handlers = Object.fromEntries(
    signals.map((signal) => [signal, () => interrupt(signal)]),
  );

  function listen(method) {
    for (const signal of signals) {
      targetProcess[method](signal, handlers[signal]);
    }
  }

  function finishInterruption() {
    if (finished || !parentSignal || trees.size > 0) return;
    finished = true;
    listen("off");
    const exitCode = SIGNAL_EXIT_CODES[parentSignal];
    if (platform === "win32") {
      targetProcess.exit(exitCode);
      return;
    }
    try {
      targetProcess.kill(targetProcess.pid, parentSignal);
    } catch {
      targetProcess.exit(exitCode);
    }
  }

  function release(entry) {
    if (!trees.delete(entry)) return;
    clearTimeout(entry.timer);
    entry.resolveDone();
    if (!parentSignal && trees.size === 0) listen("off");
    finishInterruption();
  }

  function stop(entry) {
    if (!entry.cleanup) {
      entry.cleanup = terminate(entry.child);
      entry.timer = setTimeout(() => {
        for (const stream of [
          entry.child.stdin,
          entry.child.stdout,
          entry.child.stderr,
        ]) {
          stream?.destroy?.();
        }
        entry.child.unref?.();
        release(entry);
      }, cleanupGraceMs);
    }
    return entry.cleanup;
  }

  function interrupt(signal) {
    if (parentSignal) return;
    parentSignal = signal;
    for (const entry of trees) {
      stop(entry);
    }
    finishInterruption();
  }

  return {
    track(child) {
      let resolveDone;
      const done = new Promise((resolve) => {
        resolveDone = resolve;
      });
      const entry = { child, resolveDone };
      trees.add(entry);
      if (trees.size === 1 && !parentSignal) listen("on");
      if (parentSignal) stop(entry);
      return {
        terminate: () => stop(entry),
        release: () => release(entry),
        done,
      };
    },
    isInterrupted: () => Boolean(parentSignal),
  };
}

const interruptionManager = createProcessInterruptionManager();

/**
 * Asynchronous spawn with a structured outcome. Pass `echo: true` to tee the
 * child's output live while still capturing it. `input` sends exact stdin
 * bytes and closes the stream. `timeoutMs` overrides the configured tool
 * deadline for a single call. Neither helper option is forwarded to spawn.
 *
 * On POSIX, the child leads a new process group so timeout cleanup includes its
 * descendants. On Windows, timeout cleanup uses `taskkill /t /f`.
 * @param {string} command - Executable.
 * @param {string[]} args - Arguments.
 * @param {object} [options] - spawn options plus optional `echo`/`input`/`timeoutMs`.
 * @returns {Promise<{outcome: ProcessOutcome, timedOut: boolean, error?: Error, status: number|null, signal: string|null, stdout: string, stderr: string, cleanup?: string}>} Result.
 */
export function spawnAsync(command, args, options = {}) {
  const {
    echo = false,
    input,
    timeoutMs = toolTimeoutMs(),
    ...spawnOptions
  } = options;
  return new Promise((resolve) => {
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      const error = new RangeError(
        `timeoutMs must be a positive finite number no greater than ${MAX_TIMEOUT_MS}`,
      );
      error.code = "ERR_OUT_OF_RANGE";
      resolve(
        withOutcome({
          error,
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      );
      return;
    }

    let child;
    try {
      child = spawn(command, args, {
        ...spawnOptions,
        // A dedicated process group is required for safe descendant cleanup on
        // macOS/Linux. Windows process trees are handled by taskkill instead.
        detached: detachedForPlatform(process.platform),
        windowsHide: true,
      });
    } catch (error) {
      resolve(
        withOutcome({
          error,
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      );
      return;
    }

    const trackedTree = interruptionManager.track(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawnError;
    let timeoutCleanup = null;
    const finish = (payload) => {
      if (settled || interruptionManager.isInterrupted()) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(withOutcome(payload));
    };
    const finishTimeout = () =>
      finish({
        error: undefined,
        status: null,
        signal: null,
        stdout,
        stderr,
        timedOut: true,
        cleanup: timeoutCleanup,
      });
    const timer = setTimeout(() => {
      timeoutCleanup = trackedTree.terminate();
      trackedTree.done.then(finishTimeout);
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (echo) {
          process.stdout.write(chunk);
        }
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (echo) {
          process.stderr.write(chunk);
        }
      });
    }
    if (input !== undefined && child.stdin) {
      // A child may exit before consuming all input. Its process outcome is
      // authoritative; suppress the resulting EPIPE on the parent stream.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }

    child.on("error", (error) => {
      spawnError = error;
      if (!child.pid) {
        trackedTree.release();
        finish({ error, status: null, signal: null, stdout, stderr });
      }
    });
    child.on("close", (status, signal) => {
      trackedTree.release();
      if (timeoutCleanup !== null) {
        finishTimeout();
        return;
      }
      finish({
        error: spawnError,
        status: spawnError ? null : status,
        signal: spawnError ? null : signal,
        stdout,
        stderr,
      });
    });
  });
}

const PROCESS_INTERRUPTION_OUTCOMES = new Set([
  "timeout",
  "spawn-error",
  "signal",
  "missing-tool",
]);

function aggregateBatchResults(batchResults, plannedBatchCount) {
  const interruption = batchResults.find((result) =>
    PROCESS_INTERRUPTION_OUTCOMES.has(result.outcome),
  );
  const nonzero = batchResults.find((result) => result.outcome === "nonzero");
  const representative =
    interruption ||
    nonzero ||
    batchResults.at(-1) ||
    withOutcome({
      error: undefined,
      status: 0,
      signal: null,
      stdout: "",
      stderr: "",
    });
  return {
    ...representative,
    stdout: batchResults.map((result) => result.stdout || "").join(""),
    stderr: batchResults.map((result) => result.stderr || "").join(""),
    batchResults,
    batchCount: batchResults.length,
    plannedBatchCount,
  };
}

/**
 * Run pre-planned argument batches sequentially under one overall deadline.
 * Non-zero batches do not hide later findings; launch interruptions stop the
 * sequence. Optional callbacks support per-batch reporter setup/collection and
 * are included in the same deadline.
 * @param {string} command - Executable path/name.
 * @param {Array<{args: string[]}>} batches - Planned argument batches.
 * @param {object} [options] - spawn options plus batch callbacks.
 * @param {(batch: {args: string[]}, index: number) => void|Promise<void>} [options.beforeBatch] - Pre-spawn callback.
 * @param {(result: object, batch: {args: string[]}, index: number) => void|Promise<void>} [options.afterBatch] - Post-spawn callback.
 * @returns {Promise<object & {outcome: ProcessOutcome, batchResults: object[], batchCount: number, plannedBatchCount: number}>} Aggregate result.
 */
export async function spawnArgumentBatches(command, batches, options = {}) {
  const {
    beforeBatch,
    afterBatch,
    timeoutMs = toolTimeoutMs(),
    ...spawnOptions
  } = options;
  const startedAt = Date.now();
  const batchResults = [];

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    if (beforeBatch) {
      await beforeBatch(batch, index);
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    let result;
    if (remainingMs <= 0) {
      result = withOutcome({
        error: undefined,
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: true,
      });
    } else {
      result = await spawnAsync(command, batch.args, {
        ...spawnOptions,
        timeoutMs: remainingMs,
      });
    }
    batchResults.push(result);
    if (afterBatch) {
      await afterBatch(result, batch, index);
    }
    if (PROCESS_INTERRUPTION_OUTCOMES.has(result.outcome)) {
      break;
    }
  }

  return aggregateBatchResults(batchResults, batches.length);
}

/**
 * Plan and run a no-shell command's variable arguments in bounded batches.
 * Planning failures become structured spawn errors so hooks can retain their
 * configured blocking/advisory posture instead of crashing.
 * @template T
 * @param {string} command - Executable path/name.
 * @param {string[]} fixedArgs - Arguments repeated for every batch.
 * @param {T[]} items - Variable items to partition.
 * @param {object} [options] - Batch policy, callbacks, and spawn options.
 * @returns {Promise<object & {outcome: ProcessOutcome}>} Aggregate result.
 */
export function runBatchedCommand(command, fixedArgs, items, options = {}) {
  const {
    platform = process.platform,
    budget = processArgumentBudget(platform),
    itemArguments,
    ...spawnOptions
  } = options;
  let batches;
  try {
    batches = batchProcessArguments(command, fixedArgs, items, {
      platform,
      budget,
      ...(itemArguments ? { itemArguments } : {}),
    });
  } catch (error) {
    return Promise.resolve(
      aggregateBatchResults(
        [
          withOutcome({
            error,
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
          }),
        ],
        0,
      ),
    );
  }
  return spawnArgumentBatches(command, batches, spawnOptions);
}

/**
 * Run a project-local peer tool with the standard timeout and structured result.
 * Missing tools return immediately; they are never delegated to npx.
 * @param {string} name - Package/bin name.
 * @param {string[]} args - Tool arguments.
 * @param {object} [options] - Extra spawn options.
 * @returns {Promise<object & {outcome: ProcessOutcome}>} Structured result.
 */
export function runTool(name, args, options = {}) {
  const invocation = toolInvocation(name, args, options.cwd ?? process.cwd());
  if (invocation.missingTool) {
    return Promise.resolve(
      withOutcome({
        missingTool: name,
        error: undefined,
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
      }),
    );
  }
  return spawnAsync(invocation.command, invocation.args, options);
}

/**
 * Run a project-local peer tool over bounded batches of variable arguments.
 * The resolved Node executable and tool-bin path both count against the budget.
 * @template T
 * @param {string} name - Package/bin name.
 * @param {string[]} fixedArgs - Tool arguments repeated for every batch.
 * @param {T[]} items - Variable items to partition.
 * @param {object} [options] - Batch policy and spawn options.
 * @returns {Promise<object & {outcome: ProcessOutcome}>} Aggregate result.
 */
export function runToolBatches(name, fixedArgs, items, options = {}) {
  const invocation = toolInvocation(
    name,
    fixedArgs,
    options.cwd ?? process.cwd(),
  );
  if (invocation.missingTool) {
    return Promise.resolve(
      aggregateBatchResults(
        [
          withOutcome({
            missingTool: name,
            error: undefined,
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
          }),
        ],
        0,
      ),
    );
  }
  return runBatchedCommand(invocation.command, invocation.args, items, options);
}
