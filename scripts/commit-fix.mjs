// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import pc from "picocolors";
import { errorBox, infoBox, successBox, warningBox } from "./lib/ui.mjs";
import { run, spawnAsync } from "./lib/process.mjs";
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
  isFixStateChangedError,
  runFixTools,
  stageFixOutputs,
} from "./lib/fix-safety.mjs";
import { loadPrecommitConfig } from "./lib/config.mjs";
import { buildConcurrentFixRefusalMessage } from "./lib/message.mjs";

const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
const tone = loadPrecommitConfig().tone;

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
const remoteContainsResult = run("git", [
  "branch",
  "-r",
  "--contains",
  initialHead,
]);

// Fail closed: if Git cannot answer, the commit cannot be proven unpushed, and
// amending pushed history is the one thing this command must never do.
if (remoteContainsResult.error || remoteContainsResult.status !== 0) {
  errorBox([
    pc.bold("Unable to verify the latest commit is unpushed."),
    "",
    pc.dim("Amending rewrites history, so nothing was changed. Check that"),
    pc.dim("Git can list remote branches (git branch -r) and try again."),
  ]);
  process.exit(1);
}

const headIsPushed = remoteContainsResult.stdout.trim().length > 0;

if (headIsPushed) {
  errorBox([
    pc.bold("The latest commit has already been pushed."),
    "",
    pc.dim(
      "Amending it would rewrite published history. Make a new commit with fixes instead.",
    ),
  ]);
  process.exit(1);
}

function fixerStateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertHeadUnpublished(head) {
  const result = run("git", ["branch", "-r", "--contains", head]);
  if (result.error || result.status !== 0) {
    throw fixerStateError(
      "ERR_FIX_STATE_INSPECTION",
      "Unable to revalidate publication state.",
    );
  }
  if (result.stdout.trim().length > 0) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      "The original commit was published while fixes were running.",
    );
  }
}

function assertOnlyExpectedUnstagedChanges(expectedFiles) {
  const result = run("git", [...GIT_PATH_ARGS, "diff", "--name-only", "-z"]);
  const files = parseNulPaths(result.stdout);
  if (result.error || result.status !== 0 || files === null) {
    throw fixerStateError(
      "ERR_FIX_STATE_INSPECTION",
      "Unable to revalidate the working tree.",
    );
  }
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
  const snapshot = captureFixSnapshot(fixableFiles);
  if (snapshot.head !== initialHead) {
    throw fixerStateError(
      "ERR_FIX_STATE_CHANGED",
      "HEAD changed before fixer inputs were captured.",
    );
  }
  fixResult = await runFixTools(snapshot.targets, {
    eslintFiles: committedJsFiles,
    prettierFiles: fixableFiles,
  });
  for (const diagnostic of fixResult.diagnostics) {
    process.stderr.write(diagnostic.replace(/\n?$/u, "\n"));
  }

  // Bind the mutation to the same clean repository inspected before the tools
  // ran, including non-target tracked files and publication state.
  assertFixSnapshotUnchanged(snapshot);
  assertOnlyExpectedUnstagedChanges([]);
  assertHeadUnpublished(initialHead);

  const appliedSnapshot = applyFixOutputs(snapshot, fixResult.outputs);
  const expectedChanges = appliedSnapshot.targets
    .filter((target) => !target.expectedContent.equals(target.initialContent))
    .map((target) => target.file);
  assertOnlyExpectedUnstagedChanges(expectedChanges);
  const staged = stageFixOutputs(appliedSnapshot);
  stagedSnapshot = staged.snapshot;
  changedFiles = staged.changedFiles;
} catch (error) {
  refuseUnsafeFix(error, "amend");
}

const hasRemainingIssues = fixResult.toolFailed;

if (fixResult.missingTools.length > 0) {
  console.error(
    escapeTerminalText(
      `commitment-issues: missing local tool(s): ${fixResult.missingTools.join(", ")} — ` +
        `install with \`${devInstallCommand(fixResult.missingTools)}\`.`,
    ),
  );
}

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
  assertHeadUnpublished(initialHead);
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
