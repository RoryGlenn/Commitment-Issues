// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import pc from "picocolors";
import { printHookBoxModel } from "./lib/ui.mjs";
import {
  isNodeTestCommand,
  nodeTestArgumentParts,
  runBatchedCommand,
  runToolBatches,
  enterWorktreeRoot,
  run,
  toolTimeoutMs,
  withoutGitLocalEnvironment,
} from "./lib/process.mjs";
import {
  loadPrecommitConfig,
  precommitConfigDiagnostics,
  precommitConfigWarningMessages,
  resolveHookOutput,
} from "./lib/config.mjs";
import {
  eslintManualIssues,
  formatEslintManualIssue,
  parsePrettierList,
  summarizeEslintJson,
} from "./lib/checks.mjs";
import {
  behindUpstreamIssue,
  generatedFilesIssue,
  isProtectedBranch,
  largeCommitIssues,
  largeFileIssue,
  largeFileInspectionIssue,
  parseBatchCheckSizes,
  parseNumstat,
  protectedBranchIssue,
  resolveGuardConfig,
} from "./lib/commit-guards.mjs";
import {
  envFileFindings,
  filterExemptFindings,
  findingLines,
  inspectStagedDiffResult,
  resolveSecretScanConfig,
  secretFindingsForAddedLines,
  secretsIssue,
} from "./lib/secret-scan.mjs";
import {
  DEBUG_ARTIFACT_CHECK_ID,
  DEBUG_ARTIFACT_FINDING_ID,
  DEBUG_ARTIFACT_UNAVAILABLE_ID,
  debugArtifactFindingsForGitAddedLines,
  debugArtifactScanUnavailableIssue,
  debugArtifactsIssue,
  resolveDebugArtifactConfig,
} from "./lib/debug-artifacts.mjs";
import {
  buildAdvisoryMessage,
  plural,
  stagedTestInterruption,
  unavailableToolIssue,
} from "./lib/message.mjs";
import { devInstallCommand, runScript } from "./lib/package-manager.mjs";
import { showWelcomeOnFirstCommit } from "./lib/welcome.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";
import {
  allowedStatus,
  createJsonOutput,
  emitJsonArgumentError,
  issueToJsonFinding,
  normalizeProcessOutcome,
  parseJsonOutputArgs,
} from "./lib/json-output.mjs";
import {
  codeFilePattern,
  formatFilePattern,
  findTestFile,
  isTestFile,
  isTestExemptFile,
  isThirdPartyPath,
  collectTestsForFiles,
  parseNulPaths,
  testFileCandidates,
} from "./lib/files.mjs";
import {
  captureStagedTree,
  materializeStagedTree,
  stagedTreePatch,
} from "./lib/staged-tree.mjs";

enterWorktreeRoot();
const PROJECT_ROOT = process.cwd();
const TOOL_TIMEOUT_MS = toolTimeoutMs();
const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
// The whole-index probe keeps argv fixed-size for Windows while allowing far
// more output than Node's roughly 1 MiB spawnSync default. The explicit ceiling
// prevents an unexpectedly huge index from consuming unbounded hook memory.
const GIT_GUARD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const outputArgs = parseJsonOutputArgs(process.argv.slice(2));
if (outputArgs.error) {
  if (outputArgs.enabled) {
    emitJsonArgumentError("precommit", outputArgs.error);
  } else {
    console.error(
      escapeTerminalText(`commitment-issues precommit: ${outputArgs.error}`),
    );
  }
  process.exit(1);
}
const jsonMode = outputArgs.enabled;

function runEslint(files, stagedTreeRoot) {
  return runToolBatches(
    "eslint",
    ["--cache", "--cache-strategy", "content", "--format", "json", "--"],
    files,
    {
      cwd: stagedTreeRoot,
      stdio: ["pipe", "pipe", "pipe"],
      toolCwd: PROJECT_ROOT,
    },
  );
}

function runPrettier(files, stagedTreeRoot) {
  return runToolBatches(
    "prettier",
    [
      "--cache",
      "--cache-location",
      ".prettiercache",
      "--cache-strategy",
      "content",
      "--list-different",
      "--ignore-unknown",
      "--",
    ],
    files,
    {
      cwd: stagedTreeRoot,
      stdio: ["pipe", "pipe", "pipe"],
      toolCwd: PROJECT_ROOT,
    },
  );
}

function runStagedTestCommand(testCommand, tests, stagedTreeRoot) {
  // Avoid leaking this process's test-runner context or Git's hook-local
  // repository routing into the spawned tests. The suite can rediscover this
  // checkout by cwd, while any nested Git fixtures remain isolated.
  const env = withoutGitLocalEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const nodeParts = isNodeTestCommand(testCommand)
    ? nodeTestArgumentParts(testCommand, tests, [], stagedTreeRoot)
    : null;
  return runBatchedCommand(
    testCommand[0],
    nodeParts?.fixedArgs ?? testCommand.slice(1),
    nodeParts?.fileArgs ?? tests,
    {
      cwd: stagedTreeRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

const config = loadPrecommitConfig();
const hookOutput = resolveHookOutput(config);
const guardConfig = resolveGuardConfig(config);
const secretScanConfig = resolveSecretScanConfig(config);
const debugArtifactConfig = resolveDebugArtifactConfig(config);
const jsonOutput = createJsonOutput({
  command: "precommit",
  mode:
    (guardConfig.blockProtectedBranches &&
      guardConfig.protectedBranches.length > 0) ||
    (secretScanConfig.scanSecrets && secretScanConfig.blockOnSecrets)
      ? "blocking"
      : "advisory",
});

function emitJsonResult({
  status,
  exitCode = 0,
  summary,
  findings = [],
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
  // The one-time welcome is itself the final presentation for a clean or
  // informational first run. Findings always take priority, and leaving the
  // marker untouched lets onboarding happen on the next clean invocation.
  // This preserves the one-box-per-command invariant in both hook-output
  // modes without hiding a warning or error behind onboarding content.
  if (
    (severity === "info" || severity === "success") &&
    showWelcomeOnFirstCommit({ config, jsonMode })
  ) {
    return;
  }
  printHookBoxModel({ severity, lines }, hookOutput);
}

function branchName(args) {
  const result = run("git", args);
  return result.status === 0 ? result.stdout.trim() : "";
}

function currentBranch() {
  // HEAD has no commit in a freshly initialized repository, so rev-parse
  // fails even though the symbolic branch name already exists. Resolve that
  // name directly before treating the branch as unidentifiable.
  return (
    branchName(["rev-parse", "--abbrev-ref", "HEAD"]) ||
    branchName(["symbolic-ref", "--quiet", "--short", "HEAD"]) ||
    null
  );
}

const branch = currentBranch();

// Blocking guards must run before staged-file early exits. Deletion-only,
// allow-empty, and first commits are still commits to the protected branch.
if (
  guardConfig.blockProtectedBranches &&
  isProtectedBranch(branch, guardConfig.protectedBranches)
) {
  const issue = {
    autoFixable: false,
    type: "branch",
    message: `Commit blocked on protected branch "${branch}"`,
    detail: "Create a branch: git switch -c <name>",
  };
  jsonOutput.addCheck({
    id: "protected-branch",
    status: "failed",
    summary: `Protected branch "${branch}" is blocked`,
    details: { branch },
  });
  if (jsonMode) {
    emitJsonResult({
      status: "blocked",
      exitCode: 1,
      summary: "Commit blocked by protected-branch policy",
      findings: [issueToJsonFinding(issue, "error")],
    });
  }
  printHookMessage("error", [
    pc.bold("Commit blocked: protected branch."),
    "",
    pc.dim(
      `Committing to "${escapeTerminalText(branch)}" is blocked by blockProtectedBranches.`,
    ),
    "",
    pc.dim("Create a branch: git switch -c <name>"),
    pc.dim("To bypass once: git commit --no-verify"),
  ]);
  process.exit(1);
}

let stagedTree;
try {
  stagedTree = captureStagedTree({ cwd: PROJECT_ROOT });
} catch (error) {
  // Advisory philosophy: the hook cannot check anything, but it must not
  // block the commit either — warn (matching the pre-push advisory
  // uninspectable state) and continue.
  const issue = {
    autoFixable: false,
    type: "git",
    message: "Unable to inspect staged files",
    detail: "Verify Git is available in PATH.",
  };
  jsonOutput.addCheck({
    id: "staged-files",
    status: "failed",
    summary: "Git could not inspect staged files",
    details: {
      status: null,
      error: error.message,
    },
  });
  if (jsonMode) {
    emitJsonResult({
      status: "advisory",
      summary: "Commit allowed, but staged files could not be inspected",
      findings: [issueToJsonFinding(issue)],
    });
  }
  printHookMessage("warning", [
    pc.bold("Unable to inspect staged files."),
    "",
    pc.dim("Commit will continue. Verify Git is available in PATH."),
  ]);

  process.exit(0);
}

process.once("exit", () => stagedTree.cleanup());

const rawStagedFiles = stagedTree.files;
const hasStagedChanges = stagedTree.allChangedFiles.length > 0;

if (!hasStagedChanges) {
  const summary = "No staged files to check";
  jsonOutput.addCheck({
    id: "staged-files",
    status: "skipped",
    summary,
    details: { deletionOnly: false, files: [] },
  });
  if (jsonMode) {
    emitJsonResult({ status: "skipped", summary });
  }
  printHookMessage("info", [
    pc.bold("No staged files to check."),
    "",
    pc.dim("Stage changes with git add before committing."),
  ]);

  process.exit(0);
}

jsonOutput.addCheck({
  id: "staged-files",
  status: rawStagedFiles.length > 0 ? "passed" : "skipped",
  summary:
    rawStagedFiles.length > 0
      ? `${rawStagedFiles.length} staged file${rawStagedFiles.length === 1 ? "" : "s"} inspected`
      : "Deletion-only commit; resulting tree inspected",
  details: {
    deletionOnly: rawStagedFiles.length === 0,
    files: rawStagedFiles,
  },
});

const stagedFiles = rawStagedFiles.filter((file) => !isThirdPartyPath(file));

// Secrets and debug-artifact advisories share one validated staged patch. The
// parser preserves unusual Git paths, ignores binary/deletion-only sections,
// and exposes only added lines to deterministic local rules.
let stagedDiff = null;
if (secretScanConfig.scanSecrets || debugArtifactConfig.scanDebugArtifacts) {
  try {
    stagedDiff = {
      error: undefined,
      status: 0,
      stdout: stagedTreePatch(stagedTree),
    };
  } catch {
    stagedDiff = {
      error: undefined,
      status: 1,
      stdout: "",
    };
  }
}
const stagedDiffInspection = stagedDiff
  ? inspectStagedDiffResult(stagedDiff)
  : { addedLines: [], inspected: false, outcome: "disabled" };

// Staged-secrets scan: high-precision patterns against *added* lines only,
// plus staged .env files. Advisory mode warns and continues when the patch is
// unavailable; explicit blocking mode fails closed.
function collectSecretFindings() {
  if (!secretScanConfig.scanSecrets) {
    return {
      findings: [],
      diffInspected: false,
      inspectionOutcome: "disabled",
      diffStatus: null,
    };
  }
  const findings = [...envFileFindings(rawStagedFiles)];
  findings.push(
    ...secretFindingsForAddedLines(stagedDiffInspection.addedLines),
  );
  return {
    findings: filterExemptFindings(findings, secretScanConfig.secretExempt),
    diffInspected: stagedDiffInspection.inspected,
    inspectionOutcome: stagedDiffInspection.outcome,
    diffStatus: stagedDiff.status,
  };
}

const {
  findings: secretFindings,
  diffInspected: secretDiffInspected,
  inspectionOutcome: secretInspectionOutcome,
  diffStatus: secretDiffStatus,
} = collectSecretFindings();

function secretScanUnavailableIssue() {
  const malformed = secretInspectionOutcome === "malformed";
  return {
    autoFixable: false,
    type: "secrets",
    message: "Staged secret scan unavailable",
    detail: malformed
      ? "Git returned a malformed staged patch; possible secrets could not be ruled out."
      : "Git could not inspect the staged diff; possible secrets could not be ruled out.",
  };
}

const secretScanUnavailable =
  secretScanConfig.scanSecrets && !secretDiffInspected;

jsonOutput.addCheck({
  id: "secrets",
  status: !secretScanConfig.scanSecrets
    ? "skipped"
    : secretScanUnavailable
      ? secretScanConfig.blockOnSecrets
        ? "failed"
        : secretFindings.length > 0
          ? "advisory"
          : "skipped"
      : secretFindings.length > 0
        ? secretScanConfig.blockOnSecrets
          ? "failed"
          : "advisory"
        : "passed",
  summary: !secretScanConfig.scanSecrets
    ? "Secret scanning is disabled"
    : secretScanUnavailable
      ? secretScanConfig.blockOnSecrets
        ? "Blocking secret scan could not inspect staged diff"
        : "Secret diff could not be inspected"
      : secretFindings.length > 0
        ? `${secretFindings.length} possible ${plural(secretFindings.length, "secret")} found`
        : "No possible secrets found",
  details: {
    findingCount: secretFindings.length,
    diffInspected: secretDiffInspected,
    inspectionOutcome: secretInspectionOutcome,
    status: secretDiffStatus,
  },
});

const debugArtifactFindings = debugArtifactConfig.scanDebugArtifacts
  ? debugArtifactFindingsForGitAddedLines(
      stagedDiffInspection.addedLines,
      debugArtifactConfig.debugArtifactExempt,
    )
  : [];
const debugArtifactScanUnavailable =
  debugArtifactConfig.scanDebugArtifacts && !stagedDiffInspection.inspected;
const debugArtifactIssues = [];
if (debugArtifactScanUnavailable) {
  debugArtifactIssues.push(
    debugArtifactScanUnavailableIssue(stagedDiffInspection.outcome),
  );
}
const debugArtifactIssue = debugArtifactsIssue(debugArtifactFindings);
if (debugArtifactIssue) {
  debugArtifactIssues.push(debugArtifactIssue);
}

jsonOutput.addCheck({
  id: DEBUG_ARTIFACT_CHECK_ID,
  status: !debugArtifactConfig.scanDebugArtifacts
    ? "skipped"
    : debugArtifactScanUnavailable || debugArtifactFindings.length > 0
      ? "advisory"
      : "passed",
  summary: !debugArtifactConfig.scanDebugArtifacts
    ? "Debug artifact scanning is disabled"
    : debugArtifactScanUnavailable
      ? "Debug artifact diff could not be inspected"
      : debugArtifactFindings.length > 0
        ? `${debugArtifactFindings.length} temporary debug artifact${debugArtifactFindings.length === 1 ? "" : "s"} found`
        : "No temporary debug artifacts found",
  details: {
    findingId: debugArtifactScanUnavailable
      ? DEBUG_ARTIFACT_UNAVAILABLE_ID
      : debugArtifactFindings.length > 0
        ? DEBUG_ARTIFACT_FINDING_ID
        : null,
    findingCount: debugArtifactFindings.length,
    findings: debugArtifactFindings,
    diffInspected: debugArtifactConfig.scanDebugArtifacts
      ? stagedDiffInspection.inspected
      : false,
    inspectionOutcome: debugArtifactConfig.scanDebugArtifacts
      ? stagedDiffInspection.outcome
      : "disabled",
    status: debugArtifactConfig.scanDebugArtifacts ? stagedDiff.status : null,
  },
});

if (secretScanConfig.blockOnSecrets && secretScanUnavailable) {
  const issue = secretScanUnavailableIssue();
  if (jsonMode) {
    emitJsonResult({
      status: "blocked",
      exitCode: 1,
      summary: "Commit blocked because the secret scan was unavailable",
      findings: [issueToJsonFinding(issue, "error")],
    });
  }
  const reason =
    secretInspectionOutcome === "malformed"
      ? "Git returned a malformed staged patch, so possible secrets could not be ruled out."
      : "Git could not inspect the staged diff, so possible secrets could not be ruled out.";
  printHookMessage("error", [
    pc.bold("Commit blocked: staged secret scan unavailable."),
    "",
    pc.dim(reason),
    pc.dim("Retry after restoring Git access or a valid index."),
    pc.dim("To bypass once: git commit --no-verify"),
  ]);
  process.exit(1);
}

if (secretScanConfig.blockOnSecrets && secretFindings.length > 0) {
  const issue = secretsIssue(secretFindings);
  if (jsonMode) {
    emitJsonResult({
      status: "blocked",
      exitCode: 1,
      summary: "Commit blocked because possible secrets are staged",
      findings: [issueToJsonFinding(issue, "error")],
    });
  }
  printHookMessage("error", [
    pc.bold("Commit blocked: possible secret staged."),
    "",
    ...findingLines(secretFindings).map((line) =>
      pc.dim(escapeTerminalText(line)),
    ),
    "",
    pc.dim("Remove the secret and rotate anything already exposed."),
    pc.dim("To bypass once: git commit --no-verify"),
  ]);
  process.exit(1);
}

// Advisory guards: instant git-only facts about the commit itself (branch,
// shape, oversized or generated files, behind-upstream). Guards never block a
// commit; an unavailable file-size probe becomes a visible advisory instead of
// silently claiming that no oversized staged blob exists.
function collectGuardIssues() {
  const guardIssues = [];

  if (secretScanUnavailable) {
    guardIssues.push(secretScanUnavailableIssue());
  }

  const secretIssue = secretsIssue(secretFindings);
  if (secretIssue) {
    guardIssues.push(secretIssue);
  }

  guardIssues.push(...debugArtifactIssues);

  const branchIssue = protectedBranchIssue(branch, guardConfig);
  if (branchIssue) {
    guardIssues.push(branchIssue);
  }

  if (guardConfig.adviseBehindUpstream) {
    const upstream = run("git", ["rev-parse", "--abbrev-ref", "@{u}"]);
    if (!upstream.error && upstream.status === 0) {
      const behind = run("git", ["rev-list", "--count", "HEAD..@{u}"]);
      if (!behind.error && behind.status === 0) {
        guardIssues.push(
          ...[
            behindUpstreamIssue(
              {
                behindCount: Number(behind.stdout.trim()),
                upstream: upstream.stdout.trim(),
              },
              guardConfig,
            ),
          ].filter(Boolean),
        );
      }
    }
  }

  const shape = parseNumstat(stagedTree.numstat);
  if (shape !== null) {
    guardIssues.push(...largeCommitIssues(shape, guardConfig));
  }

  if (guardConfig.maxFileSizeMb > 0) {
    const objectByFile = new Map(
      stagedTree.entries
        .filter((entry) => entry.type === "blob")
        .map((entry) => [entry.file, entry.object]),
    );
    const stagedBlobs = rawStagedFiles
      .filter((file) => objectByFile.has(file))
      .map((file) => ({ file, object: objectByFile.get(file) }));
    const batch = run("git", ["cat-file", "--batch-check"], {
      input: stagedBlobs.map(({ object }) => object).join("\n"),
      maxBuffer: GIT_GUARD_MAX_BUFFER_BYTES,
    });
    if (!batch.error && batch.status === 0) {
      const sizeIssue = largeFileIssue(
        parseBatchCheckSizes(
          batch.stdout,
          stagedBlobs.map(({ file }) => file),
        ),
        guardConfig,
      );
      if (sizeIssue) {
        guardIssues.push(sizeIssue);
      }
    } else {
      guardIssues.push(largeFileInspectionIssue(batch.error));
    }
  }

  const generatedIssue = generatedFilesIssue(rawStagedFiles, guardConfig);
  if (generatedIssue) {
    guardIssues.push(generatedIssue);
  }

  return guardIssues;
}

const issues = collectGuardIssues();
const guardIssues = issues.filter(
  (issue) => issue.type !== "secrets" && issue.type !== DEBUG_ARTIFACT_CHECK_ID,
);
jsonOutput.addCheck({
  id: "commit-guards",
  status: guardIssues.length > 0 ? "advisory" : "passed",
  summary:
    guardIssues.length > 0
      ? `${guardIssues.length} commit guard finding${guardIssues.length === 1 ? "" : "s"}`
      : "Commit guards passed",
  details: { findingCount: guardIssues.length },
});

// Early-exit states below still surface any guard findings: a commit made of
// only node_modules files or only unlintable files can still be on the wrong
// branch or staging build artifacts.
function exitWithGuardSummary(infoLines, summary) {
  if (jsonMode) {
    emitJsonResult({
      status: allowedStatus(issues, "skipped"),
      summary,
      findings: issues.map((issue) => issueToJsonFinding(issue)),
    });
  }
  if (issues.length > 0) {
    printHookMessage(
      "warning",
      buildAdvisoryMessage({
        issues,
        tone: config.tone,
        commitCommand: runScript("commit:fix"),
      }),
    );
  } else {
    printHookMessage("info", infoLines);
  }
  process.exit(0);
}

const stagedJsFiles = stagedFiles.filter((file) => codeFilePattern.test(file));
const stagedFormatFiles = stagedFiles.filter((file) =>
  formatFilePattern.test(file),
);
const deletedTestFiles = stagedTree.deletedFiles.filter(
  (file) => !isThirdPartyPath(file) && isTestFile(file),
);
const needsMaterializedTree =
  stagedJsFiles.length > 0 ||
  stagedFormatFiles.length > 0 ||
  (config.requireTests !== false && deletedTestFiles.length > 0);
let stagedTreeRoot = null;

if (needsMaterializedTree) {
  try {
    stagedTreeRoot = materializeStagedTree(stagedTree);
    jsonOutput.addCheck({
      id: "staged-tree",
      status: "passed",
      summary: "Exact staged tree materialized",
      details: {},
    });
  } catch (error) {
    const materializationError = error.message;
    const issue = {
      autoFixable: false,
      type: "git",
      message: "Unable to inspect the exact staged tree",
      detail: materializationError,
    };
    issues.push(issue);
    jsonOutput.addCheck({
      id: "staged-tree",
      status: "failed",
      summary: "Exact staged tree could not be materialized",
      details: {
        error: materializationError,
      },
    });
    exitWithGuardSummary(
      [
        pc.bold("Unable to inspect the exact staged tree."),
        "",
        pc.dim("Commit will continue without lint, format, or test claims."),
      ],
      "Commit allowed, but the exact staged tree could not be checked",
    );
  }
} else {
  jsonOutput.addCheck({
    id: "staged-tree",
    status: "skipped",
    summary: "No exact-tree checks are needed",
    details: {},
  });
}

const deletedTestSet = new Set(deletedTestFiles);
const orphanedSources =
  config.requireTests !== false && deletedTestFiles.length > 0
    ? stagedTree.entries
        .map((entry) => entry.file)
        .filter(
          (file) =>
            !isThirdPartyPath(file) &&
            codeFilePattern.test(file) &&
            !isTestExemptFile(file) &&
            !findTestFile(file, stagedTreeRoot) &&
            testFileCandidates(file, stagedTreeRoot).some((candidate) =>
              deletedTestSet.has(candidate),
            ),
        )
    : [];
const testRelevantSources = [
  ...new Set([...stagedJsFiles, ...orphanedSources]),
];

// Test discovery reads only the materialized future tree. Unstaged and
// untracked paths therefore cannot satisfy a source file or enter a test run.
if (config.requireTests !== false && testRelevantSources.length > 0) {
  const missingTests = testRelevantSources.filter(
    (file) => !isTestExemptFile(file) && !findTestFile(file, stagedTreeRoot),
  );

  if (missingTests.length > 0) {
    issues.push({
      autoFixable: false,
      type: "tests",
      message: `${missingTests.length} staged source file${missingTests.length === 1 ? "" : "s"} missing unit tests`,
      detail: missingTests,
    });
  }
}

const missingTestIssues = issues.filter(
  (issue) =>
    issue.type === "tests" && issue.message.includes("missing unit tests"),
);
jsonOutput.addCheck({
  id: "missing-tests",
  status:
    config.requireTests === false || testRelevantSources.length === 0
      ? "skipped"
      : missingTestIssues.length > 0
        ? "advisory"
        : "passed",
  summary:
    config.requireTests === false
      ? "Missing-test detection is disabled"
      : testRelevantSources.length === 0
        ? "No staged source files need test discovery"
        : missingTestIssues.length > 0
          ? missingTestIssues[0].message
          : "Staged source files have tests or exemptions",
  details: { sourceFiles: testRelevantSources },
});

if (rawStagedFiles.length === 0) {
  exitWithGuardSummary(
    [
      pc.bold("Deletion-only commit — resulting tree checked."),
      "",
      pc.dim("Removed files leave source and test relationships intact."),
    ],
    "Deletion-only commit; resulting tree checked",
  );
}

if (stagedFiles.length === 0) {
  exitWithGuardSummary(
    [
      pc.bold("No project files to check."),
      "",
      pc.dim("Only package dependency files are staged."),
    ],
    "No project files to check",
  );
}

if (stagedJsFiles.length === 0 && stagedFormatFiles.length === 0) {
  exitWithGuardSummary(
    [
      pc.bold("No lintable or formattable files staged."),
      "",
      pc.dim(
        `${stagedFiles.length} staged file${stagedFiles.length === 1 ? "" : "s"} will be committed without checks.`,
      ),
    ],
    "No lintable or formattable files staged",
  );
}

const stagedTests = config.runStagedTests
  ? collectTestsForFiles(stagedFiles, stagedTreeRoot)
  : [];
const testCommand =
  Array.isArray(config.testCommand) && config.testCommand.length > 0
    ? config.testCommand
    : ["node", "--test"];

// Run the independent tool checks concurrently.
const [eslintResult, prettierResult, testRun] = await Promise.all([
  stagedJsFiles.length > 0 ? runEslint(stagedJsFiles, stagedTreeRoot) : null,
  // The no-lint/no-format state exits above, and every JS/TS extension is also
  // formattable, so this collection is guaranteed non-empty here.
  runPrettier(stagedFormatFiles, stagedTreeRoot),
  stagedTests.length > 0
    ? runStagedTestCommand(testCommand, stagedTests, stagedTreeRoot)
    : null,
]);

const eslintOutcome = eslintResult
  ? normalizeProcessOutcome(eslintResult)
  : null;
const prettierOutcome = normalizeProcessOutcome(prettierResult);
const stagedTestOutcome = testRun ? normalizeProcessOutcome(testRun) : null;
const processDidNotComplete = (outcome) =>
  ["timeout", "spawn-error", "signal", "missing-tool"].includes(outcome);
const completedBatchResults = (result) =>
  result.batchResults.filter(
    (batch) => !processDidNotComplete(normalizeProcessOutcome(batch)),
  );

if (eslintResult) {
  if (processDidNotComplete(eslintOutcome)) {
    issues.push(
      unavailableToolIssue({
        result: eslintResult,
        outcome: eslintOutcome,
        displayName: "ESLint",
        type: "lint",
        installCommand: devInstallCommand(["eslint"]),
        timeoutSeconds: TOOL_TIMEOUT_MS / 1000,
      }),
    );
  }

  let eslintIssueCount = 0;
  let eslintFixableCount = 0;
  let eslintFailedWithoutIssues = false;
  const eslintManualDetail = [];
  for (const batch of completedBatchResults(eslintResult)) {
    const batchSummary = summarizeEslintJson(batch.stdout);
    eslintIssueCount += batchSummary.issueCount;
    eslintFixableCount += batchSummary.fixableCount;
    eslintManualDetail.push(
      ...eslintManualIssues(batch.stdout).map((issue) =>
        formatEslintManualIssue(issue, stagedTreeRoot),
      ),
    );
    eslintFailedWithoutIssues ||=
      batchSummary.issueCount === 0 && batch.status > 1;
  }
  const eslintManualCount = eslintIssueCount - eslintFixableCount;

  if (eslintFixableCount > 0) {
    issues.push({
      autoFixable: true,
      type: "lint",
      message: `${eslintFixableCount} auto-fixable ESLint issue${eslintFixableCount === 1 ? "" : "s"} found`,
    });
  }

  if (eslintManualCount > 0) {
    issues.push({
      autoFixable: false,
      type: "lint",
      message: `${eslintManualCount} ESLint issue${eslintManualCount === 1 ? "" : "s"} needing manual fixes`,
      detail: eslintManualDetail,
    });
  }

  if (eslintFailedWithoutIssues) {
    issues.push({
      autoFixable: false,
      type: "lint",
      message: "ESLint failed before reporting any file issues",
      detail: "Check ESLint install and project config",
    });
  }
}

const lintIssues = issues.filter((issue) => issue.type === "lint");
jsonOutput.addCheck({
  id: "eslint",
  status:
    stagedJsFiles.length === 0
      ? "skipped"
      : lintIssues.length > 0
        ? "advisory"
        : "passed",
  summary:
    stagedJsFiles.length === 0
      ? "No staged JavaScript or TypeScript files"
      : lintIssues.length > 0
        ? `${lintIssues.length} ESLint finding${lintIssues.length === 1 ? "" : "s"}`
        : "ESLint passed",
  details: {
    files: stagedJsFiles,
    status: eslintResult?.status ?? null,
    signal: eslintResult?.signal ?? null,
    outcome: eslintOutcome,
    batchCount: eslintResult?.batchCount ?? 0,
    plannedBatchCount: eslintResult?.plannedBatchCount ?? 0,
    batchOutcomes: (eslintResult?.batchResults ?? []).map(
      ({ outcome, status, signal }) => ({ outcome, status, signal }),
    ),
  },
});

if (processDidNotComplete(prettierOutcome)) {
  issues.push(
    unavailableToolIssue({
      result: prettierResult,
      outcome: prettierOutcome,
      displayName: "Prettier",
      type: "format",
      installCommand: devInstallCommand(["prettier"]),
      timeoutSeconds: TOOL_TIMEOUT_MS / 1000,
    }),
  );
}

let prettierFailed = false;
const prettierFiles = [];
for (const batch of completedBatchResults(prettierResult)) {
  const parsed = parsePrettierList(batch.status, batch.stdout);
  prettierFailed ||= parsed.failed;
  prettierFiles.push(...parsed.files);
}
if (prettierFailed) {
  // A crash (parse error, broken install) is not a formatting issue:
  // commit:fix cannot resolve it, so never present it as auto-fixable.
  issues.push({
    autoFixable: false,
    type: "format",
    message: "Prettier failed to complete",
    detail: "Check Prettier install and project config",
  });
} else if (prettierFiles.length > 0) {
  issues.push({
    autoFixable: true,
    type: "format",
    message: `${prettierFiles.length} file${prettierFiles.length === 1 ? "" : "s"} need Prettier formatting`,
    detail: prettierFiles,
  });
}

const formatIssues = issues.filter((issue) => issue.type === "format");
jsonOutput.addCheck({
  id: "prettier",
  status: formatIssues.length > 0 ? "advisory" : "passed",
  summary: formatIssues.length > 0 ? "1 Prettier finding" : "Prettier passed",
  details: {
    files: stagedFormatFiles,
    status: prettierResult.status,
    signal: prettierResult.signal,
    outcome: prettierOutcome,
    batchCount: prettierResult.batchCount,
    plannedBatchCount: prettierResult.plannedBatchCount,
    batchOutcomes: prettierResult.batchResults.map(
      ({ outcome, status, signal }) => ({ outcome, status, signal }),
    ),
  },
});

if (testRun) {
  if (processDidNotComplete(stagedTestOutcome)) {
    const interruption = stagedTestInterruption(
      testRun,
      stagedTestOutcome,
      TOOL_TIMEOUT_MS / 1000,
    );
    issues.push({
      autoFixable: false,
      type: "tests",
      ...interruption,
    });
  } else if (stagedTestOutcome === "nonzero") {
    issues.push({
      autoFixable: false,
      type: "tests",
      message: `${stagedTests.length} staged test file${stagedTests.length === 1 ? "" : "s"} failing`,
      detail: stagedTests,
    });
  }
}

const stagedTestIssues = issues.filter(
  (issue) =>
    issue.type === "tests" && !issue.message.includes("missing unit tests"),
);
jsonOutput.addCheck({
  id: "staged-tests",
  status:
    stagedTests.length === 0
      ? "skipped"
      : stagedTestIssues.length > 0
        ? "advisory"
        : "passed",
  summary:
    stagedTests.length === 0
      ? "Staged tests are disabled or no related tests were found"
      : stagedTestIssues.length > 0
        ? "1 staged-test finding"
        : "Staged tests passed",
  details: {
    command: stagedTests.length > 0 ? [...testCommand, ...stagedTests] : [],
    files: stagedTests,
    status: testRun?.status ?? null,
    signal: testRun?.signal ?? null,
    outcome: stagedTestOutcome,
    batchCount: testRun?.batchCount ?? 0,
    plannedBatchCount: testRun?.plannedBatchCount ?? 0,
    batchOutcomes: (testRun?.batchResults ?? []).map(
      ({ outcome, status, signal }) => ({ outcome, status, signal }),
    ),
  },
});

const dirtyTrackedResult = run("git", [
  ...GIT_PATH_ARGS,
  "diff",
  "--name-only",
  "-z",
]);
// When the probe fails we cannot verify the worktree is clean. Tell the
// message builder explicitly instead of letting an empty file list read as
// "clean", which would recommend an unverified post-commit amend.
const canInspectUnstagedFiles =
  !dirtyTrackedResult.error &&
  dirtyTrackedResult.status === 0 &&
  parseNulPaths(dirtyTrackedResult.stdout) !== null;
const dirtyTrackedFiles = canInspectUnstagedFiles
  ? parseNulPaths(dirtyTrackedResult.stdout)
  : [];

jsonOutput.addCheck({
  id: "worktree",
  status: canInspectUnstagedFiles ? "passed" : "skipped",
  summary: canInspectUnstagedFiles
    ? "Unstaged tracked files inspected"
    : "Unable to inspect unstaged tracked files",
  details: { files: dirtyTrackedFiles },
});

if (issues.length === 0) {
  if (jsonMode) {
    emitJsonResult({
      status: "clean",
      summary: `All pre-commit checks passed for ${stagedFiles.length} staged ${plural(stagedFiles.length, "file")}`,
    });
  }
  printHookMessage("success", [
    pc.bold("All pre-commit checks passed."),
    "",
    pc.dim(
      `${stagedFiles.length} staged file${stagedFiles.length === 1 ? "" : "s"} checked.`,
    ),
  ]);
  process.exit(0);
}

const canSuggestCommitFix =
  issues.some((issue) => issue.autoFixable) &&
  canInspectUnstagedFiles &&
  dirtyTrackedFiles.length === 0;
const suggestions = canSuggestCommitFix
  ? [
      {
        command: runScript("commit:fix"),
        description: "Apply automatic fixes and safely amend the latest commit",
      },
    ]
  : [];

if (jsonMode) {
  emitJsonResult({
    status: "advisory",
    summary: `${issues.length} pre-commit ${plural(issues.length, "finding")}; commit allowed`,
    findings: issues.map((issue) => issueToJsonFinding(issue)),
    suggestions,
  });
}

printHookMessage(
  "warning",
  buildAdvisoryMessage({
    issues,
    tone: config.tone,
    commitCommand: runScript("commit:fix"),
    canInspectUnstagedFiles,
    dirtyTrackedFiles,
  }),
);

process.exit(0);
