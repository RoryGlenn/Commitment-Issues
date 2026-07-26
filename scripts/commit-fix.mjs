// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import pc from "picocolors";
import { errorBox, infoBox, successBox, warningBox } from "./lib/ui.mjs";
import { enterWorktreeRoot, run, spawnAsync } from "./lib/process.mjs";
import { devInstallCommand, runScript } from "./lib/package-manager.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";
import {
  codeFilePattern,
  formatFilePattern,
  parseNulPaths,
  shortFileList,
} from "./lib/files.mjs";
import {
  applyFixOutputs,
  assertFixSnapshotUnchanged,
  captureFixSnapshot,
  inspectGitOperationState,
  inspectInterruptedFixState,
  isFixStateChangedError,
  runFixTools,
  stageFixOutputs,
} from "./lib/fix-safety.mjs";
import { loadPrecommitConfig } from "./lib/config.mjs";
import {
  buildCommitFixHistoryRefusalMessage,
  buildCommitFixOperationRefusalMessage,
  buildConcurrentFixRefusalMessage,
  buildInterruptedFixRefusalMessage,
} from "./lib/message.mjs";

enterWorktreeRoot();
const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
const tone = loadPrecommitConfig().tone;

function fixerStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function refuseInitialOperationState(operation) {
  const message = buildCommitFixOperationRefusalMessage({
    operation,
    tone,
    rerunCommand: runScript("commit:fix"),
  });
  errorBox(message.lines);
  process.exit(1);
}

function assertNoActiveGitOperation() {
  const state = inspectGitOperationState();
  if (state.operation) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      `Git ${state.operation} state became active.`,
    );
  }
}

let initialOperationState;
try {
  initialOperationState = inspectGitOperationState();
} catch {
  refuseInitialOperationState(null);
}
if (initialOperationState.operation) {
  refuseInitialOperationState(initialOperationState.operation);
}

function inspectCommitAmendSafety(head) {
  const branchResult = run("git", ["symbolic-ref", "--quiet", "HEAD"]);
  if (branchResult.status !== 0 && branchResult.status !== 1) {
    return { safe: false, reason: "inspection" };
  }
  const branchRef = branchResult.stdout.trim();
  if (branchResult.status === 1 || !branchRef.startsWith("refs/heads/")) {
    return { safe: false, reason: "detached" };
  }

  const referencesResult = run("git", [
    "for-each-ref",
    "--format=%(refname)",
    "--contains",
    head,
    "refs/remotes",
    "refs/tags",
  ]);
  if (referencesResult.status !== 0) {
    return { safe: false, reason: "inspection" };
  }
  const references = referencesResult.stdout
    .split(/\r?\n/u)
    .filter((reference) => reference.length > 0);
  if (references.length > 0) {
    return { safe: false, reason: "retained", references };
  }

  const commitResult = run("git", [
    "--no-replace-objects",
    "cat-file",
    "commit",
    head,
  ]);
  const headerEnd = commitResult.stdout.indexOf("\n\n");
  if (commitResult.status !== 0 || headerEnd === -1) {
    return { safe: false, reason: "inspection" };
  }
  const headers = commitResult.stdout.slice(0, headerEnd);
  if (/(?:^|\n)gpgsig(?:-sha256)? /u.test(headers)) {
    return { safe: false, reason: "signed" };
  }

  return { safe: true, branchRef };
}

function refuseInitialHistoryState(state) {
  const message = buildCommitFixHistoryRefusalMessage({
    reason: state.reason,
    tone,
    references: state.references,
    rerunCommand: runScript("commit:fix"),
  });
  errorBox(message.lines);
  process.exit(1);
}

function assertCommitStillAmendable(head, branchRef) {
  const state = inspectCommitAmendSafety(head);
  if (!state.safe && state.reason === "inspection") {
    throw fixerStateError(
      "ERR_FIX_STATE_INSPECTION",
      "Unable to revalidate commit history safety.",
    );
  }
  if (!state.safe || state.branchRef !== branchRef) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      "The original commit is no longer safe to amend.",
    );
  }
}

const headResult = run("git", ["rev-parse", "--verify", "HEAD"]);

if (headResult.error || headResult.status !== 0) {
  errorBox([
    pc.bold("Unable to inspect the latest commit."),
    "",
    pc.dim(
      "Check that Git is available and the current directory has at least one commit.",
    ),
  ]);
  process.exit(1);
}

const initialHead = headResult.stdout.trim();
const initialAmendSafety = inspectCommitAmendSafety(initialHead);
if (!initialAmendSafety.safe) {
  refuseInitialHistoryState(initialAmendSafety);
}
const initialBranchRef = initialAmendSafety.branchRef;

function currentUnstagedTrackedFiles() {
  const result = run("git", [...GIT_PATH_ARGS, "diff", "--name-only", "-z"]);
  const files = parseNulPaths(result.stdout);
  if (result.error || result.status !== 0 || files === null) {
    throw fixerStateError(
      "ERR_FIX_STATE_INSPECTION",
      "Unable to revalidate the working tree.",
    );
  }
  return files;
}

function assertOnlyExpectedUnstagedChanges(expectedFiles) {
  const files = currentUnstagedTrackedFiles();
  const expected = new Set(expectedFiles);
  if (
    files.length !== expected.size ||
    files.some((file) => !expected.has(file))
  ) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      "Tracked worktree changes appeared while fixes were running.",
    );
  }
}

function assertNoUnexpectedUnstagedChanges(allowedFiles) {
  const files = currentUnstagedTrackedFiles();
  const allowed = new Set(allowedFiles);
  if (files.some((file) => !allowed.has(file))) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      "Unexpected tracked worktree changes appeared while fixes were running.",
    );
  }
}

function refuseUnsafeFix(error, operation) {
  if (isFixStateChangedError(error)) {
    const message = buildConcurrentFixRefusalMessage({
      operation,
      tone,
      rerunCommand: runScript("commit:fix"),
    });
    errorBox(message.lines);
  } else {
    errorBox([
      pc.bold("Unable to apply automatic fixes safely."),
      "",
      pc.dim("The repository could not be revalidated, so the commit"),
      pc.dim("was not amended. Review git status, then try again."),
      pc.dim(escapeTerminalText(error.message)),
    ]);
  }
  process.exit(1);
}

const stagedDirtyResult = run("git", [
  ...GIT_PATH_ARGS,
  "diff",
  "--cached",
  "--name-only",
  "-z",
]);
const unstagedDirtyResult = run("git", [
  ...GIT_PATH_ARGS,
  "diff",
  "--name-only",
  "-z",
]);

const stagedDirtyFiles = parseNulPaths(stagedDirtyResult.stdout);
const unstagedDirtyFiles = parseNulPaths(unstagedDirtyResult.stdout);

if (
  stagedDirtyResult.error ||
  stagedDirtyResult.status !== 0 ||
  unstagedDirtyResult.error ||
  unstagedDirtyResult.status !== 0 ||
  stagedDirtyFiles === null ||
  unstagedDirtyFiles === null
) {
  errorBox([
    pc.bold("Unable to inspect the current working tree."),
    "",
    pc.dim(
      "Check that Git is available and the working tree can be inspected.",
    ),
  ]);
  process.exit(1);
}

const dirtyTrackedFiles = Array.from(
  new Set([...stagedDirtyFiles, ...unstagedDirtyFiles]),
);

if (dirtyTrackedFiles.length > 0) {
  errorBox([
    pc.bold("Cannot safely amend the latest commit."),
    "",
    pc.dim("Commit, stash, or discard tracked changes first:"),
    "",
    `  ${escapeTerminalText(shortFileList(dirtyTrackedFiles))}`,
  ]);
  process.exit(1);
}

const committedFilesResult = run("git", [
  ...GIT_PATH_ARGS,
  "diff-tree",
  "--root",
  "--no-commit-id",
  "--name-only",
  "-z",
  "-r",
  "--diff-filter=ACMRT",
  "HEAD",
]);

const committedFiles = parseNulPaths(committedFilesResult.stdout);

if (
  committedFilesResult.error ||
  committedFilesResult.status !== 0 ||
  committedFiles === null
) {
  errorBox([
    pc.bold("Unable to inspect files from the latest commit."),
    "",
    pc.dim("Check that the latest commit can be read from Git history."),
  ]);
  process.exit(1);
}

const committedJsFiles = committedFiles.filter((file) =>
  codeFilePattern.test(file),
);
const committedFormatFiles = committedFiles.filter((file) =>
  formatFilePattern.test(file),
);
const fixableFiles = Array.from(
  new Set([...committedJsFiles, ...committedFormatFiles]),
);

if (fixableFiles.length === 0) {
  infoBox([
    pc.bold("No fixable files in the latest commit."),
    "",
    pc.dim("The latest commit does not contain staged-fixer targets."),
  ]);
  process.exit(0);
}

let fixResult;
let stagedSnapshot;
let changedFiles;
try {
  assertNoActiveGitOperation();
  const snapshot = captureFixSnapshot(fixableFiles);
  if (snapshot.head !== initialHead) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      "HEAD changed before fixer inputs were captured.",
    );
  }
  assertNoActiveGitOperation();
  fixResult = await runFixTools(snapshot.targets, {
    eslintFiles: committedJsFiles,
    prettierFiles: fixableFiles,
  });
  for (const diagnostic of fixResult.diagnostics) {
    process.stderr.write(diagnostic.replace(/\n?$/u, "\n"));
  }
  if (fixResult.interruption) {
    const { affectedFiles } = inspectInterruptedFixState(snapshot);
    assertNoUnexpectedUnstagedChanges(affectedFiles);
    assertCommitStillAmendable(initialHead, initialBranchRef);
    assertNoActiveGitOperation();
    const message = buildInterruptedFixRefusalMessage({
      operation: "amend",
      interruption: fixResult.interruption,
      affectedFiles,
      missingTools: fixResult.missingTools,
      installCommand:
        fixResult.missingTools.length > 0
          ? devInstallCommand(fixResult.missingTools)
          : undefined,
      tone,
      rerunCommand: runScript("commit:fix"),
    });
    errorBox(message.lines);
    process.exit(1);
  }

  // Bind the mutation to the same clean repository inspected before the tools
  // ran, including non-target tracked files and history-safety state.
  assertFixSnapshotUnchanged(snapshot);
  assertOnlyExpectedUnstagedChanges([]);
  assertCommitStillAmendable(initialHead, initialBranchRef);
  assertNoActiveGitOperation();

  const appliedSnapshot = applyFixOutputs(snapshot, fixResult.outputs);
  const expectedChanges = appliedSnapshot.targets
    .filter((target) => !target.expectedContent.equals(target.initialContent))
    .map((target) => target.file);
  assertOnlyExpectedUnstagedChanges(expectedChanges);
  assertNoActiveGitOperation();
  const staged = stageFixOutputs(appliedSnapshot);
  stagedSnapshot = staged.snapshot;
  changedFiles = staged.changedFiles;
} catch (error) {
  refuseUnsafeFix(error, "amend");
}

const hasRemainingIssues = fixResult.toolFailed;

console.log("");

if (changedFiles.length === 0) {
  if (hasRemainingIssues) {
    warningBox([
      pc.bold("Manual attention still needed."),
      "",
      pc.dim("No automatic changes were added to the latest commit."),
      pc.dim(
        "Review the ESLint or Prettier output above and amend manually after fixing.",
      ),
    ]);
    process.exit(1);
  }

  successBox([
    pc.bold("Latest commit already clean."),
    "",
    pc.dim(
      `Checked ${fixableFiles.length} file${fixableFiles.length === 1 ? "" : "s"} from the latest commit.`,
    ),
    pc.dim(escapeTerminalText(shortFileList(fixableFiles))),
  ]);
  process.exit(0);
}

// The staged fixes differ from the latest commit, but if they merely reverted
// that commit's only changes, the index now matches the parent tree — amending
// would create an empty commit, which git refuses. Detect that and guide the
// user to drop the now-redundant commit instead of failing confusingly.
const parentRef = run("git", ["rev-parse", "--verify", "--quiet", "HEAD^"]);
if (!parentRef.error && parentRef.status === 0) {
  const diffVsParent = run("git", [
    ...GIT_PATH_ARGS,
    "diff",
    "--cached",
    "--quiet",
    "HEAD^",
  ]);
  if (!diffVsParent.error && diffVsParent.status === 0) {
    warningBox([
      pc.bold("Nothing to amend — the fixes emptied the latest commit."),
      "",
      pc.dim("The automatic fixes reverted the only changes in the latest"),
      pc.dim("commit, so amending it would create an empty commit."),
      "",
      pc.dim("Drop the now-redundant commit with:  git reset --soft HEAD^"),
    ]);
    process.exit(0);
  }
}

try {
  assertFixSnapshotUnchanged(stagedSnapshot);
  assertOnlyExpectedUnstagedChanges([]);
  assertCommitStillAmendable(initialHead, initialBranchRef);
  assertNoActiveGitOperation();
} catch (error) {
  refuseUnsafeFix(error, "amend");
}

const amendResult = await spawnAsync(
  "git",
  // Skip the pre-commit hook: commit:fix already lint/format-checked these
  // files, so re-running the advisory hook here would only print a duplicate box.
  ["commit", "--amend", "--no-edit", "--no-verify"],
  {
    stdio: "inherit",
  },
);

if (amendResult.outcome !== "success") {
  errorBox([
    pc.bold(
      "Automatic fixes were staged, but the latest commit could not be amended.",
    ),
    "",
    pc.dim(
      "Run git commit --amend --no-edit manually after reviewing the staged changes.",
    ),
  ]);
  process.exit(1);
}

console.log("");

if (hasRemainingIssues) {
  warningBox([
    pc.bold("Latest commit amended with available fixes."),
    "",
    pc.dim("Some issues still need manual attention."),
    pc.dim(`Updated files: ${escapeTerminalText(shortFileList(changedFiles))}`),
  ]);
  process.exit(1);
}

successBox([
  pc.bold("Latest commit amended with automatic fixes."),
  "",
  pc.dim(
    `Updated ${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"} from the latest commit.`,
  ),
  pc.dim(escapeTerminalText(shortFileList(changedFiles))),
]);

process.exit(0);
