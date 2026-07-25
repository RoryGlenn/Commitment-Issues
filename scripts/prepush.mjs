// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { printHookBoxModel } from "./lib/ui.mjs";
import {
  advisoryTestFailureWarning,
  appendPushWarnings,
  buildPushAllowedMessage,
  plural,
  prepushTestInterruption,
} from "./lib/message.mjs";
import {
  isNodeTestCommand,
  nodeTestArgumentParts,
  nodeTestArguments,
  run,
  runBatchedCommand,
  enterWorktreeRoot,
  toolTimeoutMs,
  withoutGitLocalEnvironment,
} from "./lib/process.mjs";
import {
  loadPrecommitConfig,
  precommitConfigDiagnostics,
  precommitConfigWarningMessages,
  resolveHookOutput,
} from "./lib/config.mjs";
import { parseNodeTestSummary } from "./lib/checks.mjs";
import { collectTestsForFiles, parseNameStatusPaths } from "./lib/files.mjs";
import {
  branchFromRef,
  isProtectedBranch,
  resolveGuardConfig,
} from "./lib/commit-guards.mjs";
import {
  allowedStatus,
  createJsonOutput,
  emitJsonArgumentError,
  issueToJsonFinding,
  normalizeProcessOutcome,
  parseJsonOutputArgs,
} from "./lib/json-output.mjs";
import { firstPushBase } from "./lib/push-base.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";

enterWorktreeRoot();
const TOOL_TIMEOUT_MS = toolTimeoutMs();
// Force literal, unquoted paths (as the pre-commit/fix flows already do) so
// pushed files with spaces or non-ASCII names still match their associated
// tests instead of arriving octal-escaped from git.
const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];

// Git invokes pre-push hooks with the remote name and URL as two positional
// arguments. Accept those on either side of --json, but reject options and any
// additional positionals so a typo cannot silently change the run.
const outputArgs = parseJsonOutputArgs(process.argv.slice(2), 2);
if (outputArgs.error) {
  if (outputArgs.enabled) {
    emitJsonArgumentError("prepush", outputArgs.error);
  } else {
    console.error(
      escapeTerminalText(`commitment-issues prepush: ${outputArgs.error}`),
    );
  }
  process.exit(1);
}
const jsonMode = outputArgs.enabled;
const remoteName =
  outputArgs.positionals[0] || process.env.PRE_COMMIT_REMOTE_NAME || undefined;

const config = loadPrecommitConfig();
const hookOutput = resolveHookOutput(config);
const guardConfig = resolveGuardConfig(config);

// Two opt-in modes for running the suite before a push:
//   blockPushOnTestFailure: run tests and block the push if any fail.
//   advisePushTests:        run tests and report results, but never block.
// `blockPushOnTestFailure` wins if both are set. With neither, stay out of the
// way entirely — preserving the tool's non-blocking-by-default philosophy.
const blocking = config.blockPushOnTestFailure === true;
const advisory = !blocking && config.advisePushTests === true;
const protectedBranchPosture = guardConfig.protectedBranches.length > 0;
const jsonOutput = createJsonOutput({
  command: "prepush",
  mode:
    blocking || (guardConfig.blockProtectedBranches && protectedBranchPosture)
      ? "blocking"
      : advisory || protectedBranchPosture
        ? "advisory"
        : "disabled",
});
const pushFindings = [];

function emitJsonResult({
  status,
  exitCode = 0,
  summary,
  findings = pushFindings,
  suggestions = [],
}) {
  jsonOutput.emit({ status, exitCode, summary, findings, suggestions });
  process.exit(exitCode);
}

const configWarnings = precommitConfigWarningMessages(config);
if (jsonMode) {
  for (const { code, message } of precommitConfigDiagnostics(config)) {
    jsonOutput.addDiagnostic({
      severity: "warning",
      code,
      message,
    });
  }
} else {
  for (const message of configWarnings) {
    console.warn(pc.yellow(escapeTerminalText(`⚠ ${message}`)));
  }
}

function printHookMessage(severity, lines) {
  printHookBoxModel({ severity, lines }, hookOutput);
}

// A real `git push` pipes the ref list into the hook, so the hook's stdin is
// never a TTY then. A developer running the script by hand in a terminal does
// have a TTY on stdin. `isTTY` is the only stdin signal that is reliable across
// Windows (PowerShell/cmd), macOS, and Linux — fstat-based pipe detection is
// not (git's pipe on Windows doesn't report as a FIFO). So we only treat a run
// as interactive when stdin is *certainly* a TTY; on any ambiguity we assume
// git and stay silent, guaranteeing a real push never prints the advisory box.
// COMMITMENT_ISSUES_ASSUME_TTY is a test/debug seam to force the interactive
// path (a real TTY can't be attached through spawnSync in tests).
const interactive =
  process.stdin.isTTY === true ||
  process.env.COMMITMENT_ISSUES_ASSUME_TTY === "1";

// Git represents an absent object with an all-zero object ID whose length
// follows the repository hash format (40 for SHA-1, 64 for SHA-256).
function isZeroObjectId(value) {
  return typeof value === "string" && /^0{40,}$/.test(value);
}

// The two modes are mutually exclusive; if a repo sets both, surface the
// conflict (one concise line on stderr) so it's clearly a config mistake rather
// than silently ignored — without shoving a full box in front of every push.
if (blocking && config.advisePushTests === true) {
  const message =
    "Both blockPushOnTestFailure and advisePushTests are set; using " +
    "blockPushOnTestFailure (block on failure). Remove advisePushTests " +
    "from .commitmentrc.json or package.json to silence this.";
  if (jsonMode) {
    jsonOutput.addDiagnostic({
      severity: "warning",
      code: "config.push-mode-conflict",
      message,
    });
  } else {
    console.warn(pc.yellow(escapeTerminalText(`⚠ ${message}`)));
  }
}

// Read the pushed refs once, before any mode decision: the protected-branch
// guard applies even when both test modes are off. Interactive manual runs
// resolve to no refs instantly, so this never blocks a terminal session.
const pushRefs = await readPushRefs();

const protectedTargets = [
  ...new Set(
    pushRefs
      .map((ref) => branchFromRef(ref.remoteRef))
      .filter((name) => isProtectedBranch(name, guardConfig.protectedBranches)),
  ),
];
const protectedPushWarnings = [];

if (protectedTargets.length > 0) {
  const named = protectedTargets.map((name) => `"${name}"`).join(", ");
  const branchLabel = plural(protectedTargets.length, "branch", "branches");
  if (guardConfig.blockProtectedBranches) {
    const issue = {
      autoFixable: false,
      type: "branch",
      message: `Push blocked on protected ${plural(protectedTargets.length, "branch", "branches")}: ${named}`,
      detail: "Push a feature branch and open a pull request instead.",
    };
    jsonOutput.addCheck({
      id: "protected-branch",
      status: "failed",
      summary: `Protected push ${plural(protectedTargets.length, "target is", "targets are")} blocked`,
      details: { branches: protectedTargets },
    });
    if (jsonMode) {
      emitJsonResult({
        status: "blocked",
        exitCode: 1,
        summary: "Push blocked by protected-branch policy",
        findings: [issueToJsonFinding(issue, "error")],
      });
    }
    printHookMessage("error", [
      pc.bold("Push blocked: protected branch."),
      "",
      pc.dim(
        `Pushing to ${escapeTerminalText(named)} is blocked by blockProtectedBranches.`,
      ),
      "",
      pc.dim("Push a feature branch and open a pull request instead."),
      pc.dim("To bypass once: git push --no-verify"),
    ]);
    process.exit(1);
  }
  const issue = {
    autoFixable: false,
    type: "branch",
    message: `Pushing directly to protected ${branchLabel}: ${named}`,
    detail: "Push will continue.",
  };
  pushFindings.push(issueToJsonFinding(issue));
  jsonOutput.addCheck({
    id: "protected-branch",
    status: "advisory",
    summary: `Push updates ${protectedTargets.length} protected ${branchLabel}`,
    details: { branches: protectedTargets },
  });
  protectedPushWarnings.push(
    `Direct push to protected ${branchLabel} ${named}`,
  );
} else {
  jsonOutput.addCheck({
    id: "protected-branch",
    status: "passed",
    summary: "No protected push targets",
    details: { branches: [] },
  });
}

function printCombinedPushModel(model, exitCode) {
  printHookBoxModel(
    appendPushWarnings(model, protectedPushWarnings),
    hookOutput,
  );
  process.exit(exitCode);
}

function printAllowedWarnings({
  warnings = [],
  notes = [],
  details = [],
} = {}) {
  printHookBoxModel(
    buildPushAllowedMessage({
      warnings: [...warnings, ...protectedPushWarnings],
      notes,
      details,
    }),
    hookOutput,
  );
  process.exit(0);
}

if (!blocking && !advisory) {
  // Silent during a real `git push` (the documented non-blocking default), but
  // when a human runs this by hand it would otherwise exit with no output and
  // look broken — so explain why nothing ran and how to turn a mode on.
  jsonOutput.addCheck({
    id: "push-tests",
    status: "skipped",
    summary: "Pre-push test checks are disabled",
    details: { command: [], files: [] },
  });
  if (jsonMode) {
    emitJsonResult({
      status: allowedStatus(pushFindings, "skipped"),
      summary: "Pre-push test checks are disabled",
    });
  }
  if (protectedPushWarnings.length > 0) {
    printAllowedWarnings();
  }
  if (interactive) {
    printHookMessage("info", [
      pc.bold("Pre-push test checks are disabled."),
      "",
      pc.dim("Nothing ran because no pre-push test mode is enabled in"),
      pc.dim(".commitmentrc.json or package.json precommitChecks. Enable one:"),
      "",
      `  ${pc.bold('"blockPushOnTestFailure": true')} ${pc.dim("— run tests and block on failure")}`,
      `  ${pc.bold('"advisePushTests": true')} ${pc.dim("— run tests but only warn")}`,
    ]);
  }
  process.exit(0);
}

const testCommand =
  Array.isArray(config.testCommand) && config.testCommand.length > 0
    ? config.testCommand
    : ["node", "--test"];

// Git feeds the pre-push hook "<local ref> <local sha> <remote ref> <remote
// sha>" lines on stdin. Read them to learn exactly what is being pushed.
function readStdin() {
  // Interactive terminal: no refs are coming, and reading a TTY would block, so
  // skip it entirely.
  if (interactive) {
    return Promise.resolve("");
  }
  // Otherwise read the piped refs, but guard with a timeout: a shell that hands
  // us a non-TTY stdin with no data (e.g. Git Bash run by hand) must not hang
  // the script forever waiting for input that never arrives. A real push closes
  // the pipe promptly, so `end` fires well before the timeout.
  return new Promise((resolve) => {
    let raw = "";
    let timer;
    const done = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      resolve(raw);
    };
    // Treat the timeout as an *idle* deadline, re-armed on each chunk, so we
    // always wait for the full ref list and only bail when stdin goes quiet
    // (the never-arrives case) rather than truncating a slow push mid-stream.
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(done, 1000);
      timer.unref?.();
    };
    const onData = (chunk) => {
      raw += chunk;
      armTimer();
    };
    armTimer();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

async function readPushRefs() {
  const raw = await readStdin();
  const stdinRefs = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    }))
    .filter((ref) => ref.localSha && !isZeroObjectId(ref.localSha));
  if (stdinRefs.length > 0) {
    return stdinRefs;
  }

  // The Python pre-commit framework consumes Git's stdin itself and exposes
  // the same push range through documented PRE_COMMIT_* variables. Accept the
  // environment only when every range field is present; a partial environment
  // is ambiguous and must fall back to the normal manual-run behavior.
  const preCommitRef = {
    localRef: process.env.PRE_COMMIT_LOCAL_BRANCH,
    localSha: process.env.PRE_COMMIT_TO_REF,
    remoteRef: process.env.PRE_COMMIT_REMOTE_BRANCH,
    remoteSha: process.env.PRE_COMMIT_FROM_REF,
  };
  if (
    Object.values(preCommitRef).every(
      (value) => typeof value === "string" && value.length > 0,
    ) &&
    !isZeroObjectId(preCommitRef.localSha)
  ) {
    return [preCommitRef];
  }

  // For a first push that includes the repository's root commit, pre-commit
  // intentionally selects all files and omits FROM_REF/TO_REF. It still
  // publishes both branch names and the remote, which are enough to recover
  // the same conservative first-push range without access to Git's consumed
  // stdin. Keep a partially populated range fail-closed instead of mistaking
  // it for this documented all-files case.
  const allFilesFirstPush =
    !preCommitRef.localSha &&
    !preCommitRef.remoteSha &&
    [preCommitRef.localRef, preCommitRef.remoteRef, remoteName].every(
      (value) => typeof value === "string" && value.length > 0,
    );
  return allFilesFirstPush
    ? [
        {
          localRef: preCommitRef.localRef,
          localSha: preCommitRef.localRef,
          remoteRef: preCommitRef.remoteRef,
          remoteSha: "",
        },
      ]
    : [];
}

function diffFiles(base, head) {
  // Keep deletions so a removed source file can still map to its surviving
  // related test. Name/status output also preserves both sides of a rename;
  // `-z` makes every path unambiguous, including whitespace and newlines.
  const result = run("git", [
    ...GIT_PATH_ARGS,
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    base,
    head,
  ]);
  // Surface the failure rather than swallowing it as "no files": blocking mode
  // must be able to fail closed instead of silently allowing a push it could
  // not actually inspect.
  if (result.error || (result.status || 0) !== 0) {
    return {
      ok: false,
      files: [],
      detail:
        (result.stderr || "").trim() || `git diff ${base}..${head} failed`,
    };
  }
  const files = parseNameStatusPaths(result.stdout);
  return files === null
    ? {
        ok: false,
        files: [],
        detail: "git diff returned malformed name-status output",
      }
    : { ok: true, files };
}

function getPushedFiles() {
  const refs = pushRefs;
  const files = new Set();
  const diffErrors = [];

  const collect = (result) => {
    if (result.ok) {
      for (const file of result.files) {
        files.add(file);
      }
    } else {
      diffErrors.push(result.detail);
    }
  };

  if (refs.length > 0) {
    for (const { localRef, localSha, remoteSha } of refs) {
      const base =
        remoteSha && !isZeroObjectId(remoteSha)
          ? remoteSha
          : firstPushBase({
              localRef,
              localSha,
              remoteName,
              run,
            });
      collect(diffFiles(base, localSha));
    }
    return { files: [...files], diffErrors };
  }

  // Fallback for manual runs (no stdin): compare against the upstream branch.
  // A missing upstream is not an error — there is simply nothing to diff — so
  // only a genuine `git diff` failure counts as a diff error.
  if (run("git", ["rev-parse", "@{u}"]).status === 0) {
    collect(diffFiles("@{u}", "HEAD"));
  }
  return { files: [...files], diffErrors };
}

const { files: pushedFiles, diffErrors } = getPushedFiles();

// A failed diff means we don't know what is being pushed, so we can't know
// which tests to run. Advisory mode stays out of the way (warn, then allow);
// blocking mode fails closed rather than waving through an un-inspectable push.
if (diffErrors.length > 0) {
  const detailLines = [...new Set(diffErrors)].map((detail) =>
    pc.dim(escapeTerminalText(detail)),
  );
  const issue = {
    autoFixable: false,
    type: "git",
    message: blocking
      ? "Could not inspect pushed files"
      : "Could not inspect pushed files (advisory)",
    detail: [...new Set(diffErrors)],
  };
  jsonOutput.addCheck({
    id: "pushed-files",
    status: blocking ? "failed" : "advisory",
    summary: "Git could not inspect pushed files",
    details: { errors: [...new Set(diffErrors)] },
  });
  if (blocking) {
    if (jsonMode) {
      emitJsonResult({
        status: "blocked",
        exitCode: 1,
        summary: "Push blocked because pushed files could not be inspected",
        findings: [...pushFindings, issueToJsonFinding(issue, "error")],
      });
    }
    printCombinedPushModel(
      {
        severity: "error",
        lines: [
          pc.bold("Push blocked: could not inspect pushed files"),
          "",
          pc.dim(
            "Git could not list the files being pushed, so the pre-push test",
          ),
          pc.dim("gate cannot run."),
          "",
          ...detailLines,
          "",
          pc.dim("Fix the Git error above, then push again."),
          pc.dim("To bypass this gate once: git push --no-verify"),
        ],
      },
      1,
    );
  }
  pushFindings.push(issueToJsonFinding(issue));
  if (jsonMode) {
    emitJsonResult({
      status: "advisory",
      summary: "Push allowed, but pushed files could not be inspected",
    });
  }
  if (protectedPushWarnings.length > 0) {
    printAllowedWarnings({
      warnings: ["Could not inspect pushed files (advisory)"],
      details: [...new Set(diffErrors)],
      notes: ["No pre-push tests ran."],
    });
  }
  printHookMessage("warning", [
    pc.bold("Could not inspect pushed files (advisory)"),
    "",
    pc.dim("Git could not list the files being pushed, so no pre-push tests"),
    pc.dim("ran."),
    "",
    ...detailLines,
    "",
    pc.dim("Push allowed."),
  ]);
  process.exit(0);
}

jsonOutput.addCheck({
  id: "pushed-files",
  status: "passed",
  summary: `${pushedFiles.length} pushed file${pushedFiles.length === 1 ? "" : "s"} inspected`,
  details: { files: pushedFiles },
});

// Deleted/renamed test paths can appear in the diff so deleted source paths
// remain useful for related-test discovery. Never pass a test that no longer
// exists in the working tree to the runner.
const testFiles = collectTestsForFiles(pushedFiles).filter((file) =>
  fs.existsSync(file),
);

if (testFiles.length === 0) {
  jsonOutput.addCheck({
    id: "push-tests",
    status: "skipped",
    summary: "No related tests found",
    details: { command: [], files: [] },
  });
  if (jsonMode) {
    emitJsonResult({
      status: allowedStatus(pushFindings, "skipped"),
      summary: "No tests to run before push",
    });
  }
  if (protectedPushWarnings.length > 0) {
    printAllowedWarnings({ notes: ["No tests to run before push."] });
  }
  printHookMessage("info", [
    pc.bold("No tests to run before push"),
    "",
    pc.dim("None of the pushed files have associated tests. Push allowed."),
  ]);
  process.exit(0);
}

const isNodeTest = isNodeTestCommand(testCommand);
const fullCommand = isNodeTest
  ? [testCommand[0], ...nodeTestArguments(testCommand, testFiles)]
  : [...testCommand, ...testFiles];

if (!jsonMode) {
  console.log("");
  console.log(
    pc.dim(
      escapeTerminalText(
        `Running tests for pushed files: ${fullCommand.join(" ")}`,
      ),
    ),
  );
  console.log("");
}

// Avoid leaking this process's test-runner context or Git's hook-local
// repository routing into the spawned suite. Tests can rediscover the current
// checkout by cwd without redirecting nested Git fixtures into the caller.
const env = withoutGitLocalEnvironment();
delete env.NODE_TEST_CONTEXT;

// Human mode keeps the test runner attached/teed as before. JSON mode captures
// the same subprocess output and relays it to stderr after completion; stdout
// remains exactly one parseable JSON document.
let result;
let summary = null;

function aggregateTestSummaries(batchResult, summaries) {
  if (
    summaries.some((entry) => entry === null) ||
    batchResult.batchResults.some(
      (entry) => entry.outcome !== "success" && entry.outcome !== "nonzero",
    )
  ) {
    return null;
  }
  return summaries.reduce(
    (totals, entry) => ({
      passed: totals.passed + entry.passed,
      failed: totals.failed + entry.failed,
    }),
    { passed: 0, failed: 0 },
  );
}

if (isNodeTest) {
  // Keep reporter output below a freshly created private directory. A
  // predictable shared-temp filename can collide with or follow an attacker-
  // prepared path on multi-user systems.
  const tapDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "commitment-issues-prepush-"),
  );
  const tapFile = path.join(tapDir, "results.tap");
  const parts = nodeTestArgumentParts(testCommand, testFiles, [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapFile}`,
  ]);
  const batchSummaries = [];
  try {
    result = await runBatchedCommand(
      testCommand[0],
      parts.fixedArgs,
      parts.fileArgs,
      {
        env,
        stdio: jsonMode ? ["ignore", "pipe", "pipe"] : "inherit",
        beforeBatch: () => fs.writeFileSync(tapFile, ""),
        afterBatch: () =>
          batchSummaries.push(
            parseNodeTestSummary(fs.readFileSync(tapFile, "utf8")),
          ),
      },
    );
    summary = aggregateTestSummaries(result, batchSummaries);
  } finally {
    fs.rmSync(tapDir, { recursive: true, force: true });
  }
} else {
  result = await runBatchedCommand(
    testCommand[0],
    testCommand.slice(1),
    testFiles,
    {
      env,
      echo: !jsonMode,
    },
  );
  summary = aggregateTestSummaries(
    result,
    result.batchResults.map((batch) =>
      parseNodeTestSummary(`${batch.stdout}\n${batch.stderr}`),
    ),
  );
}

if (jsonMode) {
  // Test output is intentionally not embedded in the stable payload: it can be
  // arbitrarily large and tool-specific. stderr remains available for humans
  // and CI logs without corrupting stdout JSON.
  if (result.stdout) {
    fs.writeSync(process.stderr.fd, result.stdout);
  }
  if (result.stderr) {
    fs.writeSync(process.stderr.fd, result.stderr);
  }
} else {
  console.log("");
}

const summaryLines = summary
  ? ["", pc.dim(`${summary.passed} passed, ${summary.failed} failed`)]
  : [];

const testOutcome = normalizeProcessOutcome(result);
const testDidNotComplete = [
  "timeout",
  "spawn-error",
  "signal",
  "missing-tool",
].includes(testOutcome);

if (testDidNotComplete) {
  const { reasonText, issue } = prepushTestInterruption(
    result,
    testOutcome,
    TOOL_TIMEOUT_MS / 1000,
    blocking,
  );
  const reason = pc.dim(reasonText);
  jsonOutput.addCheck({
    id: "push-tests",
    status: blocking ? "failed" : "advisory",
    summary: "Pre-push test command could not complete",
    details: {
      command: fullCommand,
      files: testFiles,
      status: result.status,
      signal: result.signal,
      error: result.error?.message || null,
      outcome: testOutcome,
      summary,
      batchCount: result.batchCount,
      plannedBatchCount: result.plannedBatchCount,
      batchOutcomes: result.batchResults.map(({ outcome, status, signal }) => ({
        outcome,
        status,
        signal,
      })),
    },
  });
  if (blocking) {
    if (jsonMode) {
      emitJsonResult({
        status: "blocked",
        exitCode: 1,
        summary: "Push blocked because tests could not run",
        findings: [...pushFindings, issueToJsonFinding(issue, "error")],
      });
    }
    printCombinedPushModel(
      {
        severity: "error",
        lines: [pc.bold("Push blocked: could not run tests"), "", reason],
      },
      1,
    );
  }
  pushFindings.push(issueToJsonFinding(issue));
  if (jsonMode) {
    emitJsonResult({
      status: "advisory",
      summary: "Push allowed, but tests could not run",
    });
  }
  if (protectedPushWarnings.length > 0) {
    printAllowedWarnings({
      warnings: ["Could not run tests (advisory)"],
      details: [reasonText],
    });
  }
  printHookMessage("warning", [
    pc.bold("Could not run tests (advisory)"),
    "",
    reason,
    pc.dim("Push allowed."),
  ]);
  process.exit(0);
}

if (testOutcome === "nonzero") {
  const issue = {
    autoFixable: false,
    type: "tests",
    message: blocking
      ? "Pre-push tests failed"
      : "Pre-push tests failed (advisory)",
    detail: summary
      ? `${summary.passed} passed, ${summary.failed} failed`
      : undefined,
  };
  jsonOutput.addCheck({
    id: "push-tests",
    status: blocking ? "failed" : "advisory",
    summary: "Pre-push tests failed",
    details: {
      command: fullCommand,
      files: testFiles,
      status: result.status,
      signal: result.signal,
      outcome: testOutcome,
      summary,
      batchCount: result.batchCount,
      plannedBatchCount: result.plannedBatchCount,
      batchOutcomes: result.batchResults.map(({ outcome, status, signal }) => ({
        outcome,
        status,
        signal,
      })),
    },
  });
  if (blocking) {
    if (jsonMode) {
      emitJsonResult({
        status: "blocked",
        exitCode: 1,
        summary: "Push blocked because tests failed",
        findings: [...pushFindings, issueToJsonFinding(issue, "error")],
      });
    }
    printCombinedPushModel(
      {
        severity: "error",
        lines: [
          pc.bold("Push blocked: tests failed"),
          ...summaryLines,
          "",
          pc.dim("Fix the failing tests above, then push again."),
          pc.dim("To bypass this gate once: git push --no-verify"),
        ],
      },
      1,
    );
  }
  pushFindings.push(issueToJsonFinding(issue));
  if (jsonMode) {
    emitJsonResult({
      status: "advisory",
      summary: "Push allowed, but pre-push tests failed",
    });
  }
  if (protectedPushWarnings.length > 0) {
    printAllowedWarnings({
      warnings: [advisoryTestFailureWarning(summary)],
      notes: ["Review the failing test output above."],
    });
  }
  printHookMessage("warning", [
    pc.bold("Tests failed (advisory)"),
    ...summaryLines,
    "",
    pc.dim("Push allowed, but the failing tests above need attention."),
  ]);
  process.exit(0);
}

jsonOutput.addCheck({
  id: "push-tests",
  status: "passed",
  summary: "All related pre-push tests passed",
  details: {
    command: fullCommand,
    files: testFiles,
    status: result.status,
    signal: result.signal,
    outcome: testOutcome,
    summary,
    batchCount: result.batchCount,
    plannedBatchCount: result.plannedBatchCount,
    batchOutcomes: result.batchResults.map(({ outcome, status, signal }) => ({
      outcome,
      status,
      signal,
    })),
  },
});

if (jsonMode) {
  emitJsonResult({
    status: allowedStatus(pushFindings, "clean"),
    summary:
      pushFindings.length > 0
        ? "All tests passed; push allowed with advisory findings"
        : "All pre-push tests passed; push allowed",
  });
}

if (protectedPushWarnings.length > 0) {
  const passedCount = summary?.passed;
  printAllowedWarnings({
    notes: [
      summary
        ? `All tests passed: ${passedCount} passed, ${summary.failed} failed.`
        : "All tests passed.",
    ],
  });
}

printHookMessage("success", [
  pc.bold("All tests passed"),
  ...summaryLines,
  "",
  pc.dim("Push allowed."),
]);

process.exit(0);
