// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_TIMEOUT_MS } from "../scripts/lib/config.mjs";
import {
  batchProcessArguments,
  createProcessInterruptionManager,
  DEFAULT_TOOL_TIMEOUT_MS,
  detachedForPlatform,
  estimatedProcessArgumentUnits,
  isNodeTestCommand,
  isWorktreeRoot,
  nodeTestArgumentParts,
  nodeTestArguments,
  POSIX_ARGUMENT_BUDGET_BYTES,
  processArgumentBudget,
  resolveWorktreeRoot,
  run,
  runBatchedCommand,
  toolInvocation,
  runTool,
  runToolBatches,
  spawnArgumentBatches,
  spawnAsync,
  isPackageInstalled,
  isToolInstalled,
  terminateProcessTree,
  toolTimeoutMs,
  WINDOWS_ARGUMENT_BUDGET_UNITS,
  withoutGitLocalEnvironment,
} from "../scripts/lib/process.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
} from "./helpers/temp-repo.mjs";

test("worktree root resolution follows cwd instead of inherited Git routing", (t) => {
  const tempDir = createTempRepo();
  const routedDir = createTempRepo();
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "bare-root-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "outside-root-"));
  t.after(() => {
    cleanupTempRepo(tempDir);
    cleanupTempRepo(routedDir);
    fs.rmSync(bareDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
  const nested = path.join(tempDir, "nested path", "deeper");
  fs.mkdirSync(nested, { recursive: true });
  const routedEnvironment = {
    ...process.env,
    GIT_DIR: path.join(routedDir, ".git"),
    GIT_WORK_TREE: routedDir,
    GIT_INDEX_FILE: path.join(routedDir, ".git", "index"),
  };

  assert.equal(
    fs.realpathSync.native(resolveWorktreeRoot(nested, routedEnvironment)),
    fs.realpathSync.native(tempDir),
  );

  const inner = path.join(nested, "inner repository");
  fs.mkdirSync(inner);
  assert.equal(run("git", ["init"], { cwd: inner }).status, 0);
  assert.equal(
    fs.realpathSync.native(resolveWorktreeRoot(inner)),
    fs.realpathSync.native(inner),
  );

  assert.equal(run("git", ["init", "--bare"], { cwd: bareDir }).status, 0);
  assert.equal(resolveWorktreeRoot(bareDir), null);
  assert.equal(resolveWorktreeRoot(outsideDir), null);
});

test("worktree root resolution accepts Git path record endings defensively", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  for (const output of [".\r\n", "."]) {
    const environment = fakeGitEnv(
      tempDir,
      "rev-parse --show-toplevel",
      0,
      output,
    );
    assert.equal(resolveWorktreeRoot(tempDir, environment), tempDir);
  }
  for (const output of ["", "\0"]) {
    const environment = fakeGitEnv(
      tempDir,
      "rev-parse --show-toplevel",
      0,
      output,
    );
    assert.equal(resolveWorktreeRoot(tempDir, environment), null);
  }
});

test("worktree root identity accepts alternate filesystem spellings", (t) => {
  const tempDir = createTempRepo();
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), "root-alias-"));
  const alias = path.join(aliasRoot, "repository alias");
  fs.symlinkSync(
    tempDir,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const nested = path.join(tempDir, "nested");
  fs.mkdirSync(nested);
  t.after(() => {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
    cleanupTempRepo(tempDir);
  });

  assert.equal(isWorktreeRoot(alias, tempDir), true);
  assert.equal(isWorktreeRoot(nested, tempDir), false);
  assert.equal(isWorktreeRoot(tempDir, null), false);

  const disappeared = path.join(tempDir, "disappeared");
  assert.equal(isWorktreeRoot(disappeared, disappeared), true);
  assert.equal(isWorktreeRoot(disappeared, tempDir), false);
});

test("worktree root resolution supports linked worktrees and submodules", (t) => {
  const primary = createTempRepo();
  const host = createTempRepo();
  const source = createTempRepo();
  const linked = `${primary} linked worktree`;
  t.after(() => {
    run("git", ["worktree", "remove", "--force", linked], { cwd: primary });
    fs.rmSync(linked, { recursive: true, force: true });
    cleanupTempRepo(primary);
    cleanupTempRepo(host);
    cleanupTempRepo(source);
  });

  const addedWorktree = run(
    "git",
    ["worktree", "add", "-b", "root-resolution-linked", linked],
    { cwd: primary },
  );
  assert.equal(
    addedWorktree.status,
    0,
    `${addedWorktree.stdout}${addedWorktree.stderr}`,
  );
  assert.equal(
    fs.realpathSync.native(resolveWorktreeRoot(linked)),
    fs.realpathSync.native(linked),
  );

  const submodulePath = path.join("vendor", "child module");
  const addedSubmodule = run(
    "git",
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      source,
      submodulePath,
    ],
    { cwd: host },
  );
  assert.equal(
    addedSubmodule.status,
    0,
    `${addedSubmodule.stdout}${addedSubmodule.stderr}`,
  );
  const submodule = path.join(host, submodulePath);
  assert.equal(
    fs.realpathSync.native(resolveWorktreeRoot(submodule)),
    fs.realpathSync.native(submodule),
  );
});

test("tool timeouts are loaded lazily from the selected root", (t) => {
  const configured = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-root-"));
  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "timeout-fallback-"));
  t.after(() => {
    fs.rmSync(configured, { recursive: true, force: true });
    fs.rmSync(fallback, { recursive: true, force: true });
  });
  fs.writeFileSync(
    path.join(configured, "package.json"),
    '{"precommitChecks":{"timeoutMs":4321}}\n',
  );

  assert.equal(toolTimeoutMs(configured), 4321);
  assert.equal(toolTimeoutMs(fallback), DEFAULT_TOOL_TIMEOUT_MS);
});

test("Node test arguments separate configured options from hostile paths", () => {
  assert.equal(isNodeTestCommand([process.execPath, "--test"]), true);
  assert.equal(isNodeTestCommand(["node.exe", "--test"]), true);
  assert.equal(isNodeTestCommand(["node"]), false);
  assert.equal(isNodeTestCommand(["custom-runner", "--test"]), false);
  assert.equal(isNodeTestCommand([]), false);
  assert.equal(isNodeTestCommand(null), false);

  assert.deepEqual(nodeTestArguments(["node", "--test"], ["plain.test.mjs"]), [
    "--test",
    "--",
    "plain.test.mjs",
  ]);

  assert.deepEqual(
    nodeTestArguments(
      ["node", "--test", "--", "configured.test.mjs"],
      ["normal.test.mjs", "-option.test.mjs"],
      ["--test-reporter=tap"],
    ),
    [
      "--test",
      "--test-reporter=tap",
      "--",
      "configured.test.mjs",
      "normal.test.mjs",
      path.resolve("-option.test.mjs"),
    ],
  );

  assert.deepEqual(
    nodeTestArgumentParts(
      ["node", "--test", "--", "configured.test.mjs"],
      ["normal.test.mjs", "-option.test.mjs"],
      ["--test-reporter=tap"],
    ),
    {
      fixedArgs: ["--test", "--test-reporter=tap", "--"],
      fileArgs: [
        "configured.test.mjs",
        "normal.test.mjs",
        path.resolve("-option.test.mjs"),
      ],
    },
  );
});

test("argument budgets use bytes on POSIX and conservative units on Windows", () => {
  assert.equal(processArgumentBudget("linux"), POSIX_ARGUMENT_BUDGET_BYTES);
  assert.equal(processArgumentBudget("darwin"), POSIX_ARGUMENT_BUDGET_BYTES);
  assert.equal(processArgumentBudget("win32"), WINDOWS_ARGUMENT_BUDGET_UNITS);
  assert.equal(
    estimatedProcessArgumentUnits("node", ["雪.js"], "linux"),
    Buffer.byteLength("node") + 1 + Buffer.byteLength("雪.js") + 1,
  );
  assert.equal(
    estimatedProcessArgumentUnits("node", ["雪.js"], "win32"),
    "node".length * 2 + 2 + "雪.js".length * 2 + 3,
  );
});

test("argument batching covers just-under, exact, and multi-batch boundaries", () => {
  for (const platform of ["linux", "win32"]) {
    const command = "node";
    const fixedArgs = ["--test", "--"];
    const first = "one test.js";
    const exact = estimatedProcessArgumentUnits(
      command,
      [...fixedArgs, first],
      platform,
    );

    const justUnder = batchProcessArguments(command, fixedArgs, [first], {
      platform,
      budget: exact + 1,
    });
    assert.equal(justUnder.length, 1);
    assert.equal(justUnder[0].estimatedUnits, exact);

    const exactBoundary = batchProcessArguments(command, fixedArgs, [first], {
      platform,
      budget: exact,
    });
    assert.deepEqual(exactBoundary[0].items, [first]);
    assert.equal(exactBoundary[0].estimatedUnits, exact);

    const multi = batchProcessArguments(
      command,
      fixedArgs,
      [first, first, first],
      { platform, budget: exact },
    );
    assert.equal(multi.length, 3);
    assert.deepEqual(
      multi.map((batch) => batch.items),
      [[first], [first], [first]],
    );
    assert.ok(multi.every((batch) => batch.estimatedUnits <= exact));
  }
});

test("argument batching maps items and rejects impossible budgets", () => {
  const command = "node";
  const fixedArgs = ["script.mjs"];
  const mappedBudget = estimatedProcessArgumentUnits(
    command,
    [...fixedArgs, "--file", "a"],
    "linux",
  );
  assert.deepEqual(
    batchProcessArguments(command, fixedArgs, ["a", "b"], {
      platform: "linux",
      budget: mappedBudget,
      itemArguments: (item) => ["--file", item],
    }).map((batch) => batch.args),
    [
      ["script.mjs", "--file", "a"],
      ["script.mjs", "--file", "b"],
    ],
  );

  assert.throws(
    () =>
      batchProcessArguments(command, fixedArgs, ["a"], {
        budget: 0,
      }),
    (error) => error.code === "ERR_ARGUMENT_BUDGET",
  );
  assert.throws(
    () =>
      batchProcessArguments(command, fixedArgs, ["too-long"], {
        platform: "linux",
        budget: estimatedProcessArgumentUnits(command, fixedArgs, "linux"),
      }),
    (error) => error.code === "ERR_ARGUMENT_BUDGET",
  );
  assert.deepEqual(batchProcessArguments(command, fixedArgs, []), []);
});

test("child environments drop Git hook routing without mutating the source", () => {
  const source = {
    HOME: "/home/example",
    PATH: "/bin",
    GIT_DIR: "/caller/.git",
    GIT_WORK_TREE: "/caller",
    GIT_INDEX_FILE: "/caller/.git/index",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  };

  assert.deepEqual(withoutGitLocalEnvironment(source), {
    HOME: "/home/example",
    PATH: "/bin",
  });
  assert.equal(source.GIT_DIR, "/caller/.git");
});

test("toolInvocation resolves a local bin and runs it via the current Node", () => {
  const eslint = toolInvocation("eslint", ["--version"]);
  assert.equal(eslint.command, process.execPath);
  assert.match(eslint.args[0], /eslint/);

  const prettier = toolInvocation("prettier", ["--version"]);
  assert.equal(prettier.command, process.execPath);
  assert.match(prettier.args[0], /prettier/);
});

test("toolInvocation returns a missing-tool invocation without npx", () => {
  const inv = toolInvocation("definitely-not-installed-xyz", ["--help"]);
  assert.equal(inv.command, null);
  assert.deepEqual(inv.args, []);
  assert.equal(inv.missingTool, "definitely-not-installed-xyz");
});

test("toolInvocation reports a resolvable package with no bin as missing", () => {
  // picocolors is installed (its package.json resolves) but exposes no `bin`,
  // so it cannot be executed as a tool.
  const inv = toolInvocation("picocolors", ["--help"]);
  assert.equal(inv.command, null);
  assert.deepEqual(inv.args, []);
  assert.equal(inv.missingTool, "picocolors");
});

test("tool resolution rejects malformed manifests and missing bin files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-manifest-"));
  try {
    const malformed = path.join(dir, "node_modules", "malformed");
    fs.mkdirSync(malformed, { recursive: true });
    fs.writeFileSync(path.join(malformed, "package.json"), "{ invalid\n");
    assert.equal(isToolInstalled("malformed", dir), false);

    const missingBin = path.join(dir, "node_modules", "missing-bin");
    fs.mkdirSync(missingBin, { recursive: true });
    fs.writeFileSync(
      path.join(missingBin, "package.json"),
      JSON.stringify({ bin: { "missing-bin": "cli.mjs" } }),
    );
    assert.equal(isToolInstalled("missing-bin", dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("process-tree cleanup covers POSIX and Windows recovery strategies", () => {
  assert.equal(terminateProcessTree({ pid: 0 }), "already-exited");

  const directKills = [];
  const directChild = {
    pid: 42,
    kill(signal) {
      directKills.push(signal);
    },
  };
  assert.equal(
    terminateProcessTree(
      directChild,
      "win32",
      () => ({ status: 0 }),
      () => {},
    ),
    "taskkill-tree",
  );
  assert.deepEqual(directKills, []);

  assert.equal(
    terminateProcessTree(
      directChild,
      "win32",
      () => ({ error: new Error("taskkill unavailable"), status: null }),
      () => {},
    ),
    "direct-child",
  );
  assert.equal(
    terminateProcessTree(
      directChild,
      "win32",
      () => ({ status: 1 }),
      () => {},
    ),
    "direct-child",
  );

  const groupSignals = [];
  assert.equal(
    terminateProcessTree(
      directChild,
      "linux",
      () => ({ status: 1 }),
      (...args) => groupSignals.push(args),
    ),
    "process-group",
  );
  assert.deepEqual(groupSignals, [[-42, "SIGKILL"]]);

  assert.equal(
    terminateProcessTree(
      directChild,
      "linux",
      () => ({ status: 1 }),
      () => {
        const error = new Error("already gone");
        error.code = "ESRCH";
        throw error;
      },
    ),
    "already-exited",
  );
  assert.equal(
    terminateProcessTree(
      directChild,
      "linux",
      () => ({ status: 1 }),
      () => {
        throw new Error("group unavailable");
      },
    ),
    "direct-child",
  );
  assert.equal(
    terminateProcessTree(
      {
        pid: 42,
        kill() {
          throw new Error("child already gone");
        },
      },
      "linux",
      () => ({ status: 1 }),
      () => {
        throw undefined;
      },
    ),
    "already-exited",
  );

  assert.equal(detachedForPlatform("win32"), false);
  assert.equal(detachedForPlatform("linux"), true);
});

function fakeSignalProcess({ killError = null } = {}) {
  const target = new EventEmitter();
  target.pid = 4242;
  target.kills = [];
  target.exits = [];
  target.kill = (pid, signal) => {
    target.kills.push([pid, signal]);
    if (killError) {
      throw killError;
    }
  };
  target.exit = (status) => target.exits.push(status);
  return target;
}

const interruptionSignals = ["SIGHUP", "SIGINT", "SIGTERM"];

test("process interruption owns active, timed-out, and late child trees", () => {
  const targetProcess = fakeSignalProcess();
  const terminations = [];
  const manager = createProcessInterruptionManager({
    targetProcess,
    platform: "linux",
    terminate: (child) => {
      terminations.push(child.pid);
      return `tree-${child.pid}`;
    },
  });
  const first = manager.track({ pid: 1 });
  const second = manager.track({ pid: 2 });

  assert.equal(first.terminate(), "tree-1");
  assert.equal(first.terminate(), "tree-1");
  assert.deepEqual(terminations, [1]);
  assert.equal(targetProcess.listenerCount("SIGINT"), 1);

  targetProcess.emit("SIGINT");
  targetProcess.emit("SIGTERM");
  assert.equal(manager.isInterrupted(), true);
  assert.deepEqual(terminations, [1, 2]);

  const late = manager.track({ pid: 3 });
  assert.deepEqual(terminations, [1, 2, 3]);
  first.release();
  first.release();
  second.release();
  assert.deepEqual(targetProcess.kills, []);
  late.release();

  assert.deepEqual(targetProcess.kills, [[4242, "SIGINT"]]);
  assert.deepEqual(targetProcess.exits, []);
  for (const signal of interruptionSignals) {
    assert.equal(targetProcess.listenerCount(signal), 0);
  }

  const afterExit = manager.track({ pid: 4 });
  afterExit.release();
  assert.deepEqual(terminations, [1, 2, 3, 4]);
  assert.deepEqual(targetProcess.kills, [[4242, "SIGINT"]]);
});

test("process interruption bounds cleanup when inherited pipes stay open", async () => {
  const targetProcess = fakeSignalProcess();
  const destroyed = [];
  const child = {
    pid: 1,
    stdin: { destroy: () => destroyed.push("stdin") },
    stdout: { destroy: () => destroyed.push("stdout") },
    stderr: { destroy: () => destroyed.push("stderr") },
    unref: () => destroyed.push("child"),
  };
  const manager = createProcessInterruptionManager({
    targetProcess,
    platform: "linux",
    terminate: () => "direct-child",
    cleanupGraceMs: 1,
  });
  const tracked = manager.track(child);

  targetProcess.emit("SIGTERM");
  await tracked.done;

  assert.deepEqual(destroyed, ["stdin", "stdout", "stderr", "child"]);
  assert.deepEqual(targetProcess.kills, [[4242, "SIGTERM"]]);
  for (const signal of interruptionSignals) {
    assert.equal(targetProcess.listenerCount(signal), 0);
  }
});

test("process interruption removes idle handlers after normal completion", () => {
  const targetProcess = fakeSignalProcess();
  const manager = createProcessInterruptionManager({
    targetProcess,
    terminate: () => "already-exited",
  });
  const tracked = manager.track({ pid: 1 });

  tracked.release();

  assert.equal(manager.isInterrupted(), false);
  for (const signal of interruptionSignals) {
    assert.equal(targetProcess.listenerCount(signal), 0);
  }
});

test("process interruption uses conventional Windows signal status", () => {
  for (const [signal, status] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const targetProcess = fakeSignalProcess();
    const manager = createProcessInterruptionManager({
      targetProcess,
      platform: "win32",
      terminate: () => "taskkill-tree",
    });
    const tracked = manager.track({ pid: 1 });

    targetProcess.emit(signal);
    tracked.release();

    assert.deepEqual(targetProcess.kills, []);
    assert.deepEqual(targetProcess.exits, [status]);
  }
});

test("process interruption falls back to signal status when re-signal fails", () => {
  const targetProcess = fakeSignalProcess({
    killError: new Error("cannot re-signal"),
  });
  const manager = createProcessInterruptionManager({
    targetProcess,
    platform: "darwin",
    terminate: () => "process-group",
  });
  const tracked = manager.track({ pid: 1 });

  targetProcess.emit("SIGTERM");
  tracked.release();

  assert.deepEqual(targetProcess.kills, [[4242, "SIGTERM"]]);
  assert.deepEqual(targetProcess.exits, [143]);
});

test("toolInvocation resolves only from the selected project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-project-"));
  try {
    assert.equal(
      toolInvocation("eslint", ["--version"], dir).missingTool,
      "eslint",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isPackageInstalled resolves a package present in the project", () => {
  // Resolves from process.cwd() (the repo root under `npm test`), where these
  // are installed, using the same manifest resolution the hooks rely on.
  assert.equal(isPackageInstalled("eslint"), true);
  assert.equal(isPackageInstalled("picocolors"), true);
});

test("isPackageInstalled reports a package that cannot be resolved", () => {
  assert.equal(isPackageInstalled("definitely-not-installed-xyz"), false);
});

test("isToolInstalled requires a real package bin", () => {
  assert.equal(isToolInstalled("eslint"), true);
  assert.equal(isToolInstalled("picocolors"), false);
});

test("isPackageInstalled resolves relative to the given project root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-installed-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), '{"name":"host"}\n');
    // A dependency present in this project's node_modules resolves...
    const pkgDir = path.join(dir, "node_modules", "present-dep");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      '{"name":"present-dep","version":"1.0.0"}\n',
    );
    assert.equal(isPackageInstalled("present-dep", dir), true);
    // ...while one that is not installed there does not.
    assert.equal(isPackageInstalled("absent-dep", dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run captures stdout synchronously", () => {
  const result = run("node", ["-e", "process.stdout.write('hi')"]);
  assert.equal(result.outcome, "success");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hi");
});

test("run passes a space-containing argument as a single argv", () => {
  // cross-spawn runs without shell:true, so an argument with spaces must arrive
  // intact rather than being word-split by a shell (the Windows footgun this
  // migration removes). This also keeps us clear of the Node DEP0190 warning.
  const result = run("node", [
    "-e",
    "process.stdout.write(process.argv[1])",
    "hello world",
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "hello world");
});

test("run passes shell-sensitive tokens as literal argv", () => {
  const tokens = [
    "has space",
    "quote'file",
    "semi;colon",
    "unicode-猫",
    "glob[abc].js",
    String.raw`windows\\path.js`,
  ];

  const result = run("node", [
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    ...tokens,
  ]);

  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), tokens);
});

test("runTool runs a resolved local tool", async () => {
  const result = await runTool("prettier", ["--version"]);
  assert.equal(result.outcome, "success");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\d+\.\d+/);
});

test("runTool returns missing-tool without invoking a command fallback", async () => {
  const result = await runTool("definitely-not-installed-xyz", ["--help"]);
  assert.equal(result.outcome, "missing-tool");
  assert.equal(result.missingTool, "definitely-not-installed-xyz");
  assert.equal(result.status, null);
  assert.equal(result.error, undefined);
});

test("runToolBatches preserves missing-tool outcomes without a fallback", async () => {
  const result = await runToolBatches(
    "definitely-not-installed-xyz",
    ["--check"],
    ["a.js", "b.js"],
  );
  assert.equal(result.outcome, "missing-tool");
  assert.equal(result.missingTool, "definitely-not-installed-xyz");
  assert.equal(result.batchCount, 1);
  assert.equal(result.plannedBatchCount, 0);
});

test("batched commands continue after nonzero results and aggregate output", async () => {
  const script =
    "process.stdout.write(process.argv[1]); process.exit(process.argv[1] === 'fail' ? 2 : 0)";
  const fixedArgs = ["-e", script];
  const budget = Math.max(
    estimatedProcessArgumentUnits(
      process.execPath,
      [...fixedArgs, "fail"],
      process.platform,
    ),
    estimatedProcessArgumentUnits(
      process.execPath,
      [...fixedArgs, "pass"],
      process.platform,
    ),
  );
  const callbacks = [];
  const result = await runBatchedCommand(
    process.execPath,
    fixedArgs,
    ["fail", "pass"],
    {
      budget,
      itemArguments: (item) => [item],
      beforeBatch: (_batch, index) => callbacks.push(`before-${index}`),
      afterBatch: (batch, _plan, index) =>
        callbacks.push(`after-${index}-${batch.outcome}`),
    },
  );

  assert.equal(result.outcome, "nonzero");
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "failpass");
  assert.equal(result.batchCount, 2);
  assert.equal(result.plannedBatchCount, 2);
  assert.deepEqual(callbacks, [
    "before-0",
    "after-0-nonzero",
    "before-1",
    "after-1-success",
  ]);
});

test("batched commands turn planning failures into structured outcomes", async () => {
  const result = await runBatchedCommand("node", ["--test"], ["file.js"], {
    budget: 1,
  });
  assert.equal(result.outcome, "spawn-error");
  assert.equal(result.error?.code, "ERR_ARGUMENT_BUDGET");
  assert.equal(result.batchCount, 1);
  assert.equal(result.plannedBatchCount, 0);

  const empty = await spawnArgumentBatches("node", []);
  assert.equal(empty.outcome, "success");
  assert.equal(empty.status, 0);
  assert.equal(empty.batchCount, 0);
});

test("batched commands share one timeout across callback and child work", async () => {
  const batches = [
    { args: ["-e", "process.exit(0)"] },
    { args: ["-e", "process.exit(0)"] },
  ];
  const result = await spawnArgumentBatches(process.execPath, batches, {
    timeoutMs: 500,
    beforeBatch: async (_batch, index) => {
      if (index === 1) await delay(550);
    },
  });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.batchCount, 2);
  assert.equal(result.plannedBatchCount, 2);
});

test("spawnAsync captures output and resolves a status", async () => {
  const result = await spawnAsync("node", [
    "-e",
    "process.stdout.write('out'); process.stderr.write('err')",
  ]);
  assert.equal(result.outcome, "success");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("spawnAsync sends exact stdin and closes the stream", async () => {
  const input = "first line\nsecond \u732b line\n";
  const result = await spawnAsync(
    process.execPath,
    [
      "-e",
      "process.stdin.pipe(process.stdout); process.stdin.on('end', () => process.stderr.write('closed\\n'));",
    ],
    { input },
  );

  assert.equal(result.outcome, "success");
  assert.equal(result.stdout, input);
  assert.equal(result.stderr, "closed\n");
});

test("spawnAsync suppresses parent EPIPE when a child exits before reading", async () => {
  const result = await spawnAsync(process.execPath, ["-e", "process.exit(0)"], {
    input: Buffer.alloc(8 * 1024 * 1024, "x"),
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.status, 0);
});

test("spawnAsync resolves an error for a missing binary", async () => {
  const result = await spawnAsync("definitely-not-a-real-binary-xyz", []);
  assert.equal(result.outcome, "spawn-error");
  assert.ok(result.error);
  assert.equal(result.status, null);
});

test("spawnAsync resolves an error when spawn throws synchronously", async () => {
  // An invalid `cwd` makes the spawn throw synchronously; spawnAsync must catch
  // it and resolve a result rather than letting the throw escape.
  const result = await spawnAsync("node", ["-v"], { cwd: 12345 });
  assert.equal(result.outcome, "spawn-error");
  assert.ok(result.error);
  assert.equal(result.status, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("spawnAsync enforces Node's maximum timer delay", async () => {
  const accepted = await spawnAsync(
    "node",
    ["-e", "process.stdout.write('ok')"],
    { timeoutMs: MAX_TIMEOUT_MS },
  );
  assert.equal(accepted.outcome, "success");
  assert.equal(accepted.stdout, "ok");

  const rejected = await spawnAsync("node", ["-e", "process.exit(0)"], {
    timeoutMs: MAX_TIMEOUT_MS + 1,
  });
  assert.equal(rejected.outcome, "spawn-error");
  assert.equal(rejected.error?.code, "ERR_OUT_OF_RANGE");
  assert.match(rejected.error?.message ?? "", /2147483647/);
});

test("spawnAsync reports a non-zero status", async () => {
  const result = await spawnAsync("node", ["-e", "process.exit(3)"]);
  assert.equal(result.outcome, "nonzero");
  assert.equal(result.status, 3);
});

test("spawnAsync with echo tees output while capturing it", async () => {
  // Let the test reporter flush the previous result before temporarily
  // replacing its stdout writer.
  await delay(10);
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let echoed = "";
  // Capture without forwarding so the child's output doesn't pollute the runner.
  process.stdout.write = (chunk) => {
    echoed += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    echoed += chunk;
    return true;
  };
  try {
    const result = await spawnAsync(
      "node",
      ["-e", "process.stdout.write('teed'); process.stderr.write('errteed')"],
      { echo: true },
    );
    assert.equal(result.stdout, "teed");
    assert.equal(result.stderr, "errteed");
    assert.match(echoed, /teed/);
    assert.match(echoed, /errteed/);
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
});

test(
  "spawnAsync distinguishes termination by signal",
  { skip: process.platform === "win32" },
  async () => {
    const result = await spawnAsync("node", [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);
    assert.equal(result.outcome, "signal");
    assert.equal(result.signal, "SIGTERM");
  },
);

test("spawnAsync reports timeout separately and cleans up grandchildren", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const heartbeat = path.join(dir, "grandchild-heartbeat");
  const pidFile = path.join(dir, "grandchild-pid");
  const grandchild = [
    "const fs = require('node:fs');",
    `const heartbeat = ${JSON.stringify(heartbeat)};`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "let beat = 0;",
    "fs.writeFileSync(heartbeat, String(beat));",
    "setInterval(() => fs.writeFileSync(heartbeat, String(++beat)), 50);",
  ].join("\n");
  const parent = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    "setInterval(() => {}, 1000);",
  ].join("\n");

  const result = await spawnAsync("node", ["-e", parent], { timeoutMs: 1000 });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.timedOut, true);
  assert.match(
    result.cleanup,
    /process-group|taskkill-tree|direct-child|already-exited/,
  );

  assert.equal(fs.existsSync(pidFile), true, "grandchild should start");
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
  const beatAtTimeout = fs.readFileSync(heartbeat, "utf8");
  await delay(350);
  const beatAfterTimeout = fs.readFileSync(heartbeat, "utf8");
  if (beatAfterTimeout !== beatAtTimeout) {
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // It may have exited between the heartbeat read and cleanup attempt.
    }
  }
  assert.equal(beatAfterTimeout, beatAtTimeout);
});

test(
  "spawnAsync bounds timeout cleanup when an escaped descendant keeps stdout open",
  { skip: process.platform === "win32", timeout: 4000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-pipe-"));
    const pidFile = path.join(dir, "escaped-pid");
    t.after(() => {
      if (fs.existsSync(pidFile)) {
        try {
          process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {
          // The escaped fixture may already have exited.
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const parent = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "child.unref();",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const startedAt = Date.now();
    const result = await spawnAsync(process.execPath, ["-e", parent], {
      timeoutMs: 250,
    });

    assert.equal(result.outcome, "timeout");
    assert.equal(result.cleanup, "process-group");
    assert.ok(Date.now() - startedAt < 4000);
    assert.equal(fs.existsSync(pidFile), true);
  },
);

test("test environment still resolves path module", () => {
  assert.equal(path.basename("a/b.js"), "b.js");
});
