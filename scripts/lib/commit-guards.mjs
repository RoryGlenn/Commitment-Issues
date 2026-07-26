// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

// Pure helpers behind the advisory commit/push guards: protected-branch
// awareness, commit-shape warnings (file/line counts, oversized blobs,
// generated artifacts), and the behind-upstream nudge. No I/O here — entry
// scripts gather the git facts and hand them in, so everything is directly
// unit-testable.

import { globToRegExp, normalizeRepoPath, shortFileList } from "./files.mjs";

export const DEFAULT_PROTECTED_BRANCHES = ["main", "master"];

// Mirrors the "usually not committed" list in docs: build output, coverage,
// dependencies, and OS/tooling droppings. Overridable via
// precommitChecks.generatedPaths (replaces, not extends).
export const DEFAULT_GENERATED_GLOBS = [
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/node_modules/**",
  "**/.DS_Store",
  "**/__pycache__/**",
];

export const DEFAULT_MAX_COMMIT_FILES = 30;
export const DEFAULT_MAX_COMMIT_LINES = 2000;
export const DEFAULT_MAX_FILE_SIZE_MB = 5;

const MB = 1024 * 1024;

function resolveLimit(value, fallback) {
  // 0 is the documented "disable this guard" value; undefined means default.
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve the guard-related config keys to effective values.
 * @param {object} config - Sanitized precommitChecks config.
 * @returns {{protectedBranches: string[], blockProtectedBranches: boolean,
 *   maxCommitFiles: number, maxCommitLines: number, maxFileSizeMb: number,
 *   generatedPaths: string[], adviseBehindUpstream: boolean}} Effective values.
 */
export function resolveGuardConfig(config = {}) {
  return {
    protectedBranches: Array.isArray(config.protectedBranches)
      ? config.protectedBranches
      : DEFAULT_PROTECTED_BRANCHES,
    blockProtectedBranches: config.blockProtectedBranches === true,
    maxCommitFiles: resolveLimit(
      config.maxCommitFiles,
      DEFAULT_MAX_COMMIT_FILES,
    ),
    maxCommitLines: resolveLimit(
      config.maxCommitLines,
      DEFAULT_MAX_COMMIT_LINES,
    ),
    maxFileSizeMb: resolveLimit(config.maxFileSizeMb, DEFAULT_MAX_FILE_SIZE_MB),
    generatedPaths: Array.isArray(config.generatedPaths)
      ? config.generatedPaths
      : DEFAULT_GENERATED_GLOBS,
    adviseBehindUpstream: config.adviseBehindUpstream !== false,
  };
}

/**
 * @param {string|null|undefined} branch - Current branch name ("HEAD" when detached).
 * @param {string[]} patterns - Branch names or globs (e.g. "release/*").
 * @returns {boolean} True when the branch matches a protected pattern.
 */
export function isProtectedBranch(branch, patterns) {
  if (!branch || branch === "HEAD") {
    return false;
  }
  return patterns.some((pattern) => globToRegExp(pattern).test(branch));
}

/**
 * Extract a branch name from a push ref ("refs/heads/main" -> "main").
 * @param {string} ref - Fully qualified git ref.
 * @returns {string|null} Branch name, or null for non-branch refs (tags etc.).
 */
export function branchFromRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) {
    return null;
  }
  return ref.slice("refs/heads/".length);
}

/**
 * Totals a NUL-delimited `git diff-tree --numstat -z` listing. Binary
 * entries report "-" counts and contribute 0 changed lines but still count as
 * a file. Rename/copy records contain an empty header path followed by old and
 * new pathname fields; those count as one file without parsing pathname bytes.
 *
 * @param {string} stdout - NUL-delimited numstat output.
 * @returns {{fileCount: number, changedLines: number}|null} Commit shape totals,
 *   or null when the structured output is malformed.
 */
export function parseNumstat(stdout) {
  if (stdout === "") {
    return { fileCount: 0, changedLines: 0 };
  }
  if (typeof stdout !== "string" || !stdout.endsWith("\0")) {
    return null;
  }

  const fields = stdout.slice(0, -1).split("\0");
  let fileCount = 0;
  let changedLines = 0;
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    const match = header.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) {
      return null;
    }
    if (match[3] === "") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) {
        return null;
      }
    }
    fileCount += 1;
    if (match[1] !== "-") {
      changedLines += Number(match[1]);
    }
    if (match[2] !== "-") {
      changedLines += Number(match[2]);
    }
  }
  return { fileCount, changedLines };
}

/**
 * Zip `git cat-file --batch-check` output back onto the file list that
 * produced it (the output lines are 1:1 with the stdin object specs).
 * @param {string} stdout - batch-check output.
 * @param {string[]} files - Staged files, in the order they were piped in.
 * @returns {Array<{file: string, bytes: number}>} Sizes for resolvable blobs.
 */
export function parseBatchCheckSizes(stdout, files) {
  const lines = (stdout || "").split("\n").filter(Boolean);
  const sizes = [];
  lines.forEach((line, index) => {
    const file = files[index];
    if (file === undefined) {
      return;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3 && parts[1] === "blob" && /^\d+$/.test(parts[2])) {
      sizes.push({ file, bytes: Number(parts[2]) });
    }
  });
  return sizes;
}

/**
 * @param {string[]} files - Staged repo-relative paths (unfiltered).
 * @param {string[]} globs - Generated-path globs.
 * @returns {string[]} Files matching a generated-path glob.
 */
export function matchGeneratedPaths(files, globs) {
  const matchers = globs.map((glob) => globToRegExp(glob));
  return files.filter((file) => {
    const normalized = normalizeRepoPath(file);
    return matchers.some((matcher) => matcher.test(normalized));
  });
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return count === 1 ? singular : pluralValue;
}

/**
 * Advisory issue for committing directly to a protected branch, or null.
 * @param {string|null} branch - Current branch.
 * @param {{protectedBranches: string[]}} guardConfig - Resolved guard config.
 * @returns {object|null} Issue for the consolidated pre-commit box.
 */
export function protectedBranchIssue(branch, guardConfig) {
  if (!isProtectedBranch(branch, guardConfig.protectedBranches)) {
    return null;
  }
  return {
    autoFixable: false,
    type: "branch",
    message: `Committing directly to protected branch "${branch}"`,
    detail: "Consider a branch: git switch -c <name>",
  };
}

/**
 * Advisory issues for unusually large commits (file count / changed lines).
 * @param {{fileCount: number, changedLines: number}} shape - Numstat totals.
 * @param {{maxCommitFiles: number, maxCommitLines: number}} guardConfig - Resolved guard config.
 * @returns {object[]} Zero, one, or two issues.
 */
export function largeCommitIssues(shape, guardConfig) {
  const issues = [];
  if (
    guardConfig.maxCommitFiles > 0 &&
    shape.fileCount > guardConfig.maxCommitFiles
  ) {
    issues.push({
      autoFixable: false,
      type: "shape",
      message: `Large commit: ${shape.fileCount} staged ${plural(shape.fileCount, "file")} (limit ${guardConfig.maxCommitFiles})`,
      detail: "Consider splitting this into smaller commits.",
    });
  }
  if (
    guardConfig.maxCommitLines > 0 &&
    shape.changedLines > guardConfig.maxCommitLines
  ) {
    issues.push({
      autoFixable: false,
      type: "shape",
      message: `Large commit: ${shape.changedLines} changed ${plural(shape.changedLines, "line")} (limit ${guardConfig.maxCommitLines})`,
      detail: "Consider splitting this into smaller commits.",
    });
  }
  return issues;
}

/**
 * Advisory issue for staged files above the size threshold, or null.
 * @param {Array<{file: string, bytes: number}>} sizes - Staged blob sizes.
 * @param {{maxFileSizeMb: number}} guardConfig - Resolved guard config.
 * @returns {object|null} Issue listing each oversized file.
 */
export function largeFileIssue(sizes, guardConfig) {
  if (guardConfig.maxFileSizeMb <= 0) {
    return null;
  }
  const threshold = guardConfig.maxFileSizeMb * MB;
  const oversized = sizes.filter((entry) => entry.bytes > threshold);
  if (oversized.length === 0) {
    return null;
  }
  const detail = oversized.map(
    (entry) =>
      `${(entry.bytes / MB).toFixed(1)} MB  ${normalizeRepoPath(entry.file)}`,
  );
  return {
    autoFixable: false,
    type: "shape",
    message: `${oversized.length} staged ${plural(oversized.length, "file")} over ${guardConfig.maxFileSizeMb} MB`,
    detail: [...detail, "Did you mean to use Git LFS?"],
  };
}

/**
 * Advisory issue for a staged file-size probe that could not complete.
 * @param {{code?: string}|null} [error] - Optional child-process error.
 * @returns {object} Issue for the consolidated pre-commit box.
 */
export function largeFileInspectionIssue(error = null) {
  const outputLimitExceeded = error?.code === "ENOBUFS";
  return {
    autoFixable: false,
    type: "shape",
    message: "Staged file-size check unavailable",
    detail: outputLimitExceeded
      ? "Git returned more blob metadata than the bounded inspection buffer allows."
      : "Git could not inspect staged blob sizes; retry after restoring Git access.",
  };
}

/**
 * Advisory issue for staged generated/build-artifact files, or null.
 * @param {string[]} stagedFiles - All staged paths (unfiltered).
 * @param {{generatedPaths: string[]}} guardConfig - Resolved guard config.
 * @returns {object|null} Issue listing the matched files.
 */
export function generatedFilesIssue(stagedFiles, guardConfig) {
  const matched = matchGeneratedPaths(stagedFiles, guardConfig.generatedPaths);
  if (matched.length === 0) {
    return null;
  }
  return {
    autoFixable: false,
    type: "shape",
    message: `${matched.length} generated ${plural(matched.length, "file")} staged`,
    detail: [
      shortFileList(matched),
      "These are usually ignored, not committed.",
    ],
  };
}

/**
 * Advisory issue for a branch behind its upstream, or null.
 * @param {{behindCount: number, upstream: string}|null} behind - Behind facts, or null when unknown.
 * @param {{adviseBehindUpstream: boolean}} guardConfig - Resolved guard config.
 * @returns {object|null} Issue with a pull/rebase nudge.
 */
export function behindUpstreamIssue(behind, guardConfig) {
  if (
    !guardConfig.adviseBehindUpstream ||
    !behind ||
    !Number.isFinite(behind.behindCount) ||
    behind.behindCount <= 0
  ) {
    return null;
  }
  return {
    autoFixable: false,
    type: "upstream",
    message: `Branch is ${behind.behindCount} ${plural(behind.behindCount, "commit")} behind ${behind.upstream}`,
    detail: "Pull or rebase before stacking more commits.",
  };
}
