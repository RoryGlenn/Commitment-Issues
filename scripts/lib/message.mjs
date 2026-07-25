// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import pc from "picocolors";
import { shortFileList } from "./files.mjs";
import { escapeTerminalText } from "./terminal.mjs";

function normalizeTone(tone) {
  return tone === "fun" ? "fun" : "standard";
}

function normalizeInput(issuesOrOptions, context) {
  if (Array.isArray(issuesOrOptions)) {
    return {
      issues: issuesOrOptions,
      context: {
        ...context,
        tone: normalizeTone(context?.tone),
      },
    };
  }

  const options =
    issuesOrOptions && typeof issuesOrOptions === "object"
      ? issuesOrOptions
      : {};
  const issues = Array.isArray(options.issues) ? options.issues : [];
  const normalizedContext = {
    canInspectUnstagedFiles:
      typeof options.canInspectUnstagedFiles === "boolean"
        ? options.canInspectUnstagedFiles
        : true,
    unstagedTrackedFiles: Array.isArray(options.unstagedTrackedFiles)
      ? options.unstagedTrackedFiles
      : Array.isArray(options.dirtyTrackedFiles)
        ? options.dirtyTrackedFiles
        : [],
    tone: normalizeTone(options.tone ?? context?.tone),
    commitCommand: options.commitCommand,
  };

  return { issues, context: normalizedContext };
}

export function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue;
}

/**
 * Build a refusal message when repository state changes during an explicit
 * fixer command.
 * @param {{operation: "stage"|"amend", tone?: string, rerunCommand: string}} options - Mutation and presentation context.
 * @returns {{severity: "error", lines: string[]}} Box model.
 */
export function buildConcurrentFixRefusalMessage({
  operation,
  tone = "standard",
  rerunCommand,
}) {
  const fun = normalizeTone(tone) === "fun";
  const mutation =
    operation === "amend"
      ? fun
        ? "The latest commit was left out of the drama."
        : "The latest commit was not amended."
      : fun
        ? "No surprise changes were invited into the commit."
        : "Concurrent work was not staged.";
  return {
    severity: "error",
    lines: [
      pc.bold(
        fun
          ? "The repository changed the relationship status mid-fix."
          : "Repository state changed while automatic fixes were running.",
      ),
      "",
      pc.dim(mutation),
      pc.dim(
        fun
          ? "Your other work is still yours. Check the situation, then try again:"
          : "Concurrent work was preserved. Review git status, then try again:",
      ),
      "",
      `  ${pc.bold(escapeTerminalText(rerunCommand))}`,
    ],
  };
}

/**
 * Build a refusal for commit history that cannot be amended safely.
 * @param {{reason: "detached"|"inspection"|"retained"|"signed", tone?: string, references?: string[], rerunCommand?: string}} options - History state and presentation context.
 * @returns {{severity: "error", lines: string[]}} Box model.
 */
export function buildCommitFixHistoryRefusalMessage({
  reason,
  tone = "standard",
  references = [],
  rerunCommand = "npm run commit:fix",
}) {
  const fun = normalizeTone(tone) === "fun";

  if (reason === "detached") {
    return {
      severity: "error",
      lines: [
        pc.bold(
          fun
            ? "This commit has no branch to come home to."
            : "Cannot amend a detached commit.",
        ),
        "",
        pc.dim(
          fun
            ? "A replacement could end up living only in Git's reflog."
            : "The latest commit is not attached to a local branch. Amending it",
        ),
        ...(fun
          ? []
          : [
              pc.dim(
                "could leave the replacement reachable only through Git's reflog.",
              ),
            ]),
        pc.dim(
          fun
            ? "Give it a branch first, then try the relationship talk again:"
            : "Switch to or create the branch that should own it, then try again:",
        ),
        "",
        `  ${pc.bold(escapeTerminalText(rerunCommand))}`,
      ],
    };
  }

  if (reason === "signed") {
    return {
      severity: "error",
      lines: [
        pc.bold(
          fun
            ? "This signed commit deserves a proper second ceremony."
            : "Cannot automatically amend a signed commit.",
        ),
        "",
        pc.dim(
          fun
            ? "A casual amend would replace it without an explicitly approved signature."
            : "Automatic amend would replace it without an explicitly approved",
        ),
        ...(fun ? [] : [pc.dim("signature.")]),
        pc.dim(
          fun
            ? "Apply the fixes manually, then sign the new commitment yourself."
            : "Apply fixes manually, then use your normal signed-amend workflow.",
        ),
        pc.dim("No index or history was changed."),
      ],
    };
  }

  if (reason === "retained") {
    const referenceSummary =
      references.length > 0
        ? escapeTerminalText(shortFileList(references, 3))
        : "a tag or remote-tracking ref";
    return {
      severity: "error",
      lines: [
        pc.bold(
          fun
            ? "The latest commit is already seeing another Git ref."
            : "The latest commit is retained by a protected Git reference.",
        ),
        "",
        pc.dim(
          fun
            ? "That reference keeps the original history, even if HEAD moves on."
            : "A local tag or locally known remote ref already contains it:",
        ),
        "",
        `  ${referenceSummary}`,
        "",
        pc.dim(
          fun
            ? "Keep the history uncomplicated: make a new commit with the fixes."
            : "Make a new commit with the fixes instead of rewriting this one.",
        ),
      ],
    };
  }

  return {
    severity: "error",
    lines: [
      pc.bold(
        fun
          ? "Git would not define this commit's relationship status."
          : "Unable to prove the latest commit is safe to amend.",
      ),
      "",
      pc.dim(
        fun
          ? "Nothing moved on while the history check was unavailable."
          : "Amending rewrites history, so nothing was changed.",
      ),
      pc.dim(
        fun
          ? "Check HEAD, commit metadata, tags, and remote refs, then try again."
          : "Check that Git can inspect HEAD, commit metadata, tags, and",
      ),
      ...(fun ? [] : [pc.dim("remote-tracking refs, then try again.")]),
    ],
  };
}

function funIssueMessage(issue, message) {
  const prettierMatch = issue.message.match(
    /^(\d+) file(s)? need Prettier formatting$/,
  );
  if (prettierMatch) {
    const count = Number(prettierMatch[1]);
    return `${count} ${plural(count, "file")} told Prettier ${count === 1 ? '"this is just how I am"' : '"this is just how we are"'}`;
  }

  const missingTestsMatch = issue.message.match(
    /^(\d+) staged source file(s)? missing unit tests$/,
  );
  if (missingTestsMatch) {
    const count = Number(missingTestsMatch[1]);
    return `${count} staged source ${plural(count, "file")} won't commit to ${count === 1 ? "a unit test" : "unit tests"}`;
  }

  const manualLintMatch = issue.message.match(
    /^(\d+) ESLint issue(s)? needing manual fixes$/,
  );
  if (manualLintMatch) {
    const count = Number(manualLintMatch[1]);
    return `${count} ESLint ${plural(count, "issue")} that flowers won't fix`;
  }

  const autoFixableLintMatch = issue.message.match(
    /^(\d+) auto-fixable ESLint issue(s)? found$/,
  );
  if (autoFixableLintMatch) {
    const count = Number(autoFixableLintMatch[1]);
    return `${count} ESLint ${plural(count, "issue")} ready to take you back, no questions asked`;
  }

  const failingTestsMatch = issue.message.match(
    /^(\d+) staged test file(s)? failing$/,
  );
  if (failingTestsMatch) {
    const count = Number(failingTestsMatch[1]);
    return `${count} staged test ${plural(count, "file")} just said "we need to talk"`;
  }

  const protectedBranchMatch = issue.message.match(
    /^Committing directly to protected branch "(.+)"$/,
  );
  if (protectedBranchMatch) {
    return `"${protectedBranchMatch[1]}" deserves a feature branch, not surprise commits`;
  }

  const largeFilesCommitMatch = issue.message.match(
    /^Large commit: (\d+) staged file(s)? \(limit \d+\)$/,
  );
  if (largeFilesCommitMatch) {
    const count = Number(largeFilesCommitMatch[1]);
    return `${count} staged ${plural(count, "file")} — less a commit, more a lifestyle choice`;
  }

  const largeLinesCommitMatch = issue.message.match(
    /^Large commit: (\d+) changed line(s)? \(limit \d+\)$/,
  );
  if (largeLinesCommitMatch) {
    const count = Number(largeLinesCommitMatch[1]);
    return `${count} changed ${plural(count, "line")} — that's not a commit, that's a memoir`;
  }

  const largeFileMatch = issue.message.match(
    /^(\d+) staged file(s)? over (\d+) MB$/,
  );
  if (largeFileMatch) {
    const count = Number(largeFileMatch[1]);
    return `${count} staged ${plural(count, "file")} that should really be seeing Git LFS`;
  }

  const generatedMatch = issue.message.match(
    /^(\d+) generated file(s)? staged$/,
  );
  if (generatedMatch) {
    const count = Number(generatedMatch[1]);
    return `${count} generated ${plural(count, "file")} trying to sneak into the commit`;
  }

  const behindMatch = issue.message.match(
    /^Branch is (\d+) commit(s)? behind (.+)$/,
  );
  if (behindMatch) {
    const count = Number(behindMatch[1]);
    return `${count} ${plural(count, "commit")} behind ${behindMatch[3]} — stacking more chaos on top`;
  }

  const secretsMatch = issue.message.match(
    /^(\d+) possible secret(s)? staged$/,
  );
  if (secretsMatch) {
    const count = Number(secretsMatch[1]);
    return `${count} possible ${plural(count, "secret")} this commit can't keep`;
  }

  const debugArtifactMatch = issue.message.match(
    /^(\d+) temporary debug artifact(s)? staged$/,
  );
  if (debugArtifactMatch) {
    const count = Number(debugArtifactMatch[1]);
    return `${count} temporary debug ${plural(count, "artifact")} hoping nobody notices`;
  }

  return message;
}

// Fun-tone rewrites for the exact (count-free) tool-failure messages, so a
// fun-toned box never falls back to standard wording mid-relationship-note.
// Standard wording stays the source of truth; keys must match it exactly.
const FUN_EXACT_MESSAGES = {
  "ESLint timed out": "ESLint needed space and never texted back",
  "Prettier timed out": "Prettier needed space and never texted back",
  "Staged tests timed out":
    "The staged tests needed space and never texted back",
  "Unable to run ESLint": "ESLint won't even pick up the phone",
  "Unable to run Prettier": "Prettier won't even pick up the phone",
  "Unable to run staged tests": "The staged tests won't even pick up the phone",
  "Staged file-size check unavailable":
    "The staged files would not say how much baggage they are carrying",
  "Debug artifact scan unavailable":
    "The debug-artifact check could not get a straight answer from Git",
};

function issueMessage(issue, tone = "standard") {
  if (issue.message === "ESLint failed before reporting any file issues") {
    return tone === "fun"
      ? "ESLint stormed off without saying what's wrong"
      : "ESLint failed to complete";
  }

  if (issue.message === "Prettier failed to complete") {
    return tone === "fun" ? "Prettier left you on read" : issue.message;
  }

  if (tone === "fun" && FUN_EXACT_MESSAGES[issue.message]) {
    return FUN_EXACT_MESSAGES[issue.message];
  }

  const match = issue.message.match(
    /^(\d+) file(s)? need Prettier formatting$/,
  );
  const message = match
    ? `${Number(match[1])} ${plural(Number(match[1]), "file")} with formatting issues`
    : issue.message;

  return tone === "fun" ? funIssueMessage(issue, message) : message;
}

/**
 * Builds the consolidated advisory message for the pre-commit box. Pure (no
 * I/O), so it can be unit-tested directly.
 * @param {Array<{type: string, message: string, autoFixable: boolean, detail?: string|string[]}>|object} issuesOrOptions - Detected issues, or an options object containing issues.
 * @param {{canInspectUnstagedFiles?: boolean, unstagedTrackedFiles?: string[], tone?: string}} [context] - Worktree context for the commit:fix recommendation.
 * @returns {{severity: string, lines: string[]}} Box severity and lines.
 */
export function buildAdvisoryMessage(issuesOrOptions, context = {}) {
  const normalized = normalizeInput(issuesOrOptions, context);
  const issues = normalized.issues;
  const {
    canInspectUnstagedFiles = true,
    unstagedTrackedFiles = [],
    tone = "standard",
    commitCommand = "npm run commit:fix",
  } = normalized.context;

  if (issues.length === 0) {
    return {
      severity: "success",
      lines: [
        pc.bold("All pre-commit checks passed"),
        "",
        pc.dim("No suggestions found. Ready to commit!"),
      ],
    };
  }

  const lines = [
    pc.bold("Pre-commit suggestions found"),
    "",
    pc.dim(
      tone === "fun"
        ? "Commit will continue. Relationship notes:"
        : "Commit will continue. Suggestions:",
    ),
    "",
  ];

  issues.forEach((issue) => {
    lines.push(
      `${pc.yellow("→")} ${escapeTerminalText(issueMessage(issue, tone))}`,
    );
    if (issue.detail) {
      const detailLines = Array.isArray(issue.detail)
        ? issue.detail.map(String)
        : String(issue.detail).split("\n");
      detailLines.forEach((line) => {
        lines.push(`  ${pc.dim(escapeTerminalText(line))}`);
      });
    }
  });

  const hasFixableIssue = issues.some((issue) => issue.autoFixable);
  const hasNonFixableIssue = issues.some((issue) => !issue.autoFixable);
  const canAmendLatestCommit =
    hasFixableIssue &&
    canInspectUnstagedFiles &&
    unstagedTrackedFiles.length === 0;

  lines.push("");
  if (canAmendLatestCommit) {
    lines.push(
      pc.dim(
        hasNonFixableIssue
          ? tone === "fun"
            ? "patch things up where you can and amend it:"
            : "you can still apply automatic fixes and amend it:"
          : tone === "fun"
            ? "send the apology text and amend it:"
            : "apply automatic fixes and amend it:",
      ),
    );
    lines.push(`  ${pc.bold(escapeTerminalText(commitCommand))}`);

    if (hasNonFixableIssue) {
      lines.push("");
      lines.push(
        pc.dim(
          tone === "fun"
            ? "commit:fix only smooths over the small stuff."
            : "commit:fix only auto-fixes formatting and fixable lint.",
        ),
      );
      lines.push(
        pc.dim(
          tone === "fun"
            ? "The rest can't be fixed over text."
            : "Manual items above still need your attention.",
        ),
      );
    }
  } else if (hasFixableIssue) {
    if (hasNonFixableIssue) {
      lines.push(
        pc.dim(
          tone === "fun"
            ? "The rest can't be fixed over text."
            : "Manual items above still need your attention.",
        ),
      );
      lines.push("");
    }

    if (!canInspectUnstagedFiles) {
      lines.push(
        pc.dim(
          "The working tree could not be inspected for a safe post-commit amend.",
        ),
      );
    } else if (unstagedTrackedFiles.length > 0) {
      lines.push(
        pc.dim(
          "Other tracked changes will still be present after commit, so no automatic amend command is shown.",
        ),
      );
      lines.push(
        `  ${pc.dim(escapeTerminalText(shortFileList(unstagedTrackedFiles)))}`,
      );
    }
  } else {
    lines.push(
      pc.dim(
        tone === "fun"
          ? "No automatic fix command. It's not the code, it's you."
          : "No automatic fix command for these issues.",
      ),
    );
  }

  return { severity: "warning", lines };
}

/**
 * Build the failure/unavailable message for the optional commit-msg check.
 * Successful checks stay silent, matching commitlint's normal hook behavior.
 * @param {{outcome?: "reported"|"missing-tool"|"missing-config"|"unreadable"|"timeout"|"unavailable", blocking?: boolean, tone?: string, detail?: string|string[], installCommand?: string}} options - Result and presentation context.
 * @returns {{severity: "warning"|"error", lines: string[]}} Box model.
 */
export function buildCommitMessageCheckMessage(options = {}) {
  const {
    outcome = "unavailable",
    blocking = false,
    detail = "",
    installCommand = "",
  } = options;
  const tone = normalizeTone(options.tone);
  const fun = tone === "fun";

  const copy = {
    reported: {
      title: fun
        ? "Commit message sent mixed signals"
        : blocking
          ? "Commit blocked: commit message needs attention"
          : "Commit message needs attention",
      summary: fun
        ? "Commitlint found a few relationship rules this message missed."
        : "Commitlint reported a problem with this commit message or its configuration.",
    },
    "missing-tool": {
      title: fun
        ? "Commitlint stood this commit up"
        : "Commit-message check unavailable",
      summary: fun
        ? "The project-local commitlint CLI never showed."
        : "The project-local commitlint CLI is not installed.",
    },
    "missing-config": {
      title: fun
        ? "Commitlint needs relationship rules"
        : "Commitlint configuration not found",
      summary: fun
        ? "There is no project ruleset defining what commitment looks like."
        : "Commitlint requires a project configuration with at least one rule.",
    },
    unreadable: {
      title: fun
        ? "The commit message went missing"
        : "Unable to read the commit message",
      summary: fun
        ? "Git handed over a message file that could not be opened."
        : "The commit-msg hook did not receive a readable message file.",
    },
    timeout: {
      title: fun ? "Commitlint needed space" : "Commitlint timed out",
      summary: fun
        ? "It never texted back before the hook timeout."
        : "Commitlint did not finish before the configured timeout.",
    },
    unavailable: {
      title: fun
        ? "Commitlint left this commit on read"
        : "Commit-message check unavailable",
      summary: fun
        ? "The local CLI was present but could not finish the conversation."
        : "The project-local commitlint CLI could not be executed.",
    },
  }[outcome];

  const lines = [pc.bold(copy.title), "", pc.dim(copy.summary)];

  if (outcome === "missing-tool") {
    lines.push(
      "",
      pc.dim("No npx, network, or global-tool fallback was attempted."),
    );
    if (installCommand) {
      lines.push(
        pc.dim(
          `Install it in this project: ${escapeTerminalText(installCommand)}`,
        ),
      );
    }
  }

  if (outcome === "missing-config") {
    lines.push(
      "",
      pc.dim("Add a commitlint config with your chosen rules."),
      pc.dim("No built-in Conventional Commits rules were substituted."),
    );
  }

  const detailLines = Array.isArray(detail)
    ? detail.map(String).filter(Boolean)
    : String(detail).trim().split(/\r?\n/).filter(Boolean);
  if (detailLines.length > 0) {
    lines.push(
      "",
      ...detailLines.map((line) => pc.dim(escapeTerminalText(line))),
    );
  }

  lines.push(
    "",
    pc.dim(
      blocking
        ? fun
          ? "This commit is on pause because blocking mode is official."
          : "Commit blocked because commit-message enforcement is enabled."
        : fun
          ? "Commit will continue. Consider this a relationship note."
          : "Commit will continue because commit-message linting is advisory.",
    ),
  );
  if (blocking) {
    lines.push(
      pc.dim(
        "Fix the message or setup, or bypass once: git commit --no-verify",
      ),
    );
  }

  return { severity: blocking ? "error" : "warning", lines };
}

/**
 * Build the single final box for an allowed push with one or more advisory
 * findings. Test-runner output stays outside the box; this is the compact
 * command-level summary printed after it.
 * @param {{warnings?: string[], notes?: string[], details?: string[]}} options - Advisory findings and supporting context.
 * @returns {{severity: "warning", lines: string[]}} Box model.
 */
export function buildPushAllowedMessage(options = {}) {
  const warnings = Array.isArray(options.warnings)
    ? options.warnings.filter(Boolean)
    : [];
  const notes = Array.isArray(options.notes)
    ? options.notes.filter(Boolean)
    : [];
  const details = Array.isArray(options.details)
    ? options.details.filter(Boolean)
    : [];
  const count = warnings.length;
  const lines = [
    pc.bold(`Push allowed with ${count} warning${count === 1 ? "" : "s"}.`),
  ];

  if (warnings.length > 0) {
    lines.push(
      "",
      ...warnings.map(
        (warning) => `${pc.yellow("→")} ${escapeTerminalText(warning)}`,
      ),
    );
  }
  if (details.length > 0) {
    lines.push(
      "",
      ...details.map((detail) => pc.dim(escapeTerminalText(detail))),
    );
  }
  if (notes.length > 0) {
    lines.push("", ...notes.map((note) => pc.dim(escapeTerminalText(note))));
  }

  return { severity: "warning", lines };
}

/**
 * Summarize an advisory test failure for the combined push warning model.
 * @param {{passed: number, failed: number}|null} summary - Parsed test counts.
 * @returns {string} Compact advisory finding.
 */
export function advisoryTestFailureWarning(summary) {
  if (!summary) {
    return "Tests failed (advisory)";
  }
  const failedCount = summary.failed;
  return `Tests failed (advisory): ${failedCount} related test${failedCount === 1 ? "" : "s"} failed (${summary.passed} passed, ${failedCount} failed)`;
}

/**
 * Build a pre-commit issue for a peer tool that could not complete.
 * @param {{result: object, outcome: string, displayName: string, type: string, installCommand: string, timeoutSeconds: number}} options - Process and display context.
 * @returns {{autoFixable: false, type: string, message: string, detail: string}} Advisory issue.
 */
export function unavailableToolIssue(options) {
  const { result, outcome, displayName, type, installCommand, timeoutSeconds } =
    options;
  if (outcome === "missing-tool") {
    return {
      autoFixable: false,
      type,
      message: `${displayName} is not installed locally`,
      detail: `Install it: ${installCommand}`,
    };
  }
  if (outcome === "timeout") {
    const cleanupDetail =
      result.cleanup === "direct-child"
        ? "the direct child was stopped; descendant cleanup was unavailable"
        : result.cleanup
          ? "attached process-tree cleanup completed"
          : null;
    return {
      autoFixable: false,
      type,
      message: `${displayName} timed out`,
      detail: `No result within ${timeoutSeconds}s${cleanupDetail ? `; ${cleanupDetail}` : ""}`,
    };
  }
  if (outcome === "signal") {
    return {
      autoFixable: false,
      type,
      message: `${displayName} stopped before completing`,
      detail: `Process ended from ${result.signal || "an unknown signal"}`,
    };
  }
  return {
    autoFixable: false,
    type,
    message: `Unable to run ${displayName}`,
    detail: `Check ${displayName} install and project config`,
  };
}

/**
 * Build the message/detail pair for an interrupted staged-test command.
 * @param {object} result - Structured process result.
 * @param {string} outcome - Normalized process outcome.
 * @param {number} timeoutSeconds - Configured timeout in seconds.
 * @returns {{message: string, detail: string}} Staged-test finding fields.
 */
export function stagedTestInterruption(result, outcome, timeoutSeconds) {
  if (outcome === "timeout") {
    const cleanup =
      result.cleanup === "direct-child"
        ? "; the direct child was stopped; descendant cleanup was unavailable"
        : result.cleanup
          ? "; attached process-tree cleanup completed"
          : "";
    return {
      message: "Staged tests timed out",
      detail: `No result within ${timeoutSeconds}s${cleanup}`,
    };
  }
  if (outcome === "signal") {
    return {
      message: "Staged tests stopped before completing",
      detail: `Process ended from ${result.signal || "an unknown signal"}`,
    };
  }
  return {
    message: "Unable to run staged tests",
    detail:
      "Check testCommand in .commitmentrc.json or package.json precommitChecks",
  };
}

/**
 * Build the failure reason and issue for a pre-push test command that did not
 * complete.
 * @param {object} result - Structured process result.
 * @param {string} outcome - Normalized process outcome.
 * @param {number} timeoutSeconds - Configured timeout in seconds.
 * @param {boolean} blocking - Whether failure blocks the push.
 * @returns {{reasonText: string, issue: object}} Presentation model.
 */
export function prepushTestInterruption(
  result,
  outcome,
  timeoutSeconds,
  blocking,
) {
  const timeoutCleanup =
    result.cleanup === "direct-child"
      ? "the direct child was stopped, but descendant cleanup was unavailable"
      : result.cleanup
        ? "attached process-tree cleanup completed"
        : null;
  const reasonText =
    outcome === "timeout"
      ? `The test command timed out after ${timeoutSeconds}s${timeoutCleanup ? `; ${timeoutCleanup}` : ""}.`
      : outcome === "signal"
        ? `The test command stopped after ${result.signal || "an unknown signal"}.`
        : "Check testCommand in .commitmentrc.json or package.json precommitChecks.";
  return {
    reasonText,
    issue: {
      autoFixable: false,
      type: "tests",
      message: blocking
        ? "Could not run pre-push tests"
        : "Could not run pre-push tests (advisory)",
      detail: reasonText,
    },
  };
}

/**
 * Fold secondary push warnings into an existing blocking outcome without
 * weakening its severity or printing another box.
 * @param {{severity: "info"|"success"|"warning"|"error", lines: string[]}} model - Primary push outcome.
 * @param {string[]} warnings - Secondary advisory findings.
 * @returns {{severity: "warning"|"error", lines: string[]}} Combined model.
 */
export function appendPushWarnings(model, warnings = []) {
  const filtered = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
  if (filtered.length === 0) {
    return model;
  }

  return {
    severity: model.severity === "error" ? "error" : "warning",
    lines: [
      ...model.lines,
      "",
      pc.dim(
        filtered.length === 1 ? "Additional warning:" : "Additional warnings:",
      ),
      ...filtered.map(
        (warning) => `${pc.yellow("→")} ${escapeTerminalText(warning)}`,
      ),
    ],
  };
}
