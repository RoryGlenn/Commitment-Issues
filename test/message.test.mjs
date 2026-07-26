// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  advisoryTestFailureWarning,
  appendPushWarnings,
  buildAdvisoryMessage,
  buildCommitFixHistoryRefusalMessage,
  buildCommitFixOperationRefusalMessage,
  buildCommitMessageCheckMessage,
  buildConcurrentFixRefusalMessage,
  buildPushAllowedMessage,
  plural,
  prepushTestInterruption,
  stagedTestInterruption,
  unavailableToolIssue,
} from "../scripts/lib/message.mjs";
import { stripAnsi } from "./helpers/output.mjs";

// picocolors emits plain text when stdout is not a TTY (as under `node --test`),
// so these assertions can match the message content directly.

test("success when there are no issues", () => {
  const { severity, lines } = buildAdvisoryMessage([]);
  assert.equal(severity, "success");
  assert.ok(lines.join("\n").includes("All pre-commit checks passed"));
});

test("concurrent fixer refusals distinguish staging from amending", () => {
  const staged = buildConcurrentFixRefusalMessage({
    operation: "stage",
    rerunCommand: "npm run fix:staged",
  });
  const amended = buildConcurrentFixRefusalMessage({
    operation: "amend",
    rerunCommand: "npm run commit:fix",
  });

  assert.equal(staged.severity, "error");
  assert.match(staged.lines.join("\n"), /Concurrent work was not staged/);
  assert.match(staged.lines.join("\n"), /npm run fix:staged/);
  assert.match(amended.lines.join("\n"), /latest commit was not amended/i);
  assert.match(amended.lines.join("\n"), /npm run commit:fix/);
});

test("commit-fix history refusals explain each fail-closed state", () => {
  const detached = buildCommitFixHistoryRefusalMessage({
    reason: "detached",
    rerunCommand: "pnpm run commit:fix",
  });
  const signed = buildCommitFixHistoryRefusalMessage({ reason: "signed" });
  const retained = buildCommitFixHistoryRefusalMessage({
    reason: "retained",
    references: [
      "refs/remotes/origin/main",
      "refs/tags/v1.0.0",
      "refs/tags/v1.0.1",
      "refs/tags/v1.0.2",
    ],
  });
  const retainedWithoutDetails = buildCommitFixHistoryRefusalMessage({
    reason: "retained",
  });
  const unavailable = buildCommitFixHistoryRefusalMessage({
    reason: "inspection",
  });

  assert.equal(detached.severity, "error");
  assert.match(detached.lines.join("\n"), /detached commit/);
  assert.match(detached.lines.join("\n"), /pnpm run commit:fix/);
  assert.match(signed.lines.join("\n"), /signed commit/);
  assert.match(signed.lines.join("\n"), /No index or history was changed/);
  assert.match(retained.lines.join("\n"), /refs\/remotes\/origin\/main/);
  assert.match(retained.lines.join("\n"), /\(\+1 more\)/);
  assert.match(
    retainedWithoutDetails.lines.join("\n"),
    /a tag or remote-tracking ref/,
  );
  assert.match(unavailable.lines.join("\n"), /safe to amend/);
});

test("commit-fix operation refusals distinguish active and unreadable state", () => {
  const active = buildCommitFixOperationRefusalMessage({
    operation: "revert",
    rerunCommand: "pnpm run commit:fix",
  });
  const unreadable = buildCommitFixOperationRefusalMessage({
    rerunCommand: "npm run commit:fix",
  });

  assert.equal(active.severity, "error");
  assert.match(active.lines.join("\n"), /active Git operation/);
  assert.match(active.lines.join("\n"), /active revert state/);
  assert.match(active.lines.join("\n"), /pnpm run commit:fix/);
  assert.match(
    active.lines.join("\n"),
    /operation state\s+were left unchanged/,
  );
  assert.match(unreadable.lines.join("\n"), /inspect active Git operations/);
  assert.match(
    unreadable.lines.join("\n"),
    /merge,\s+cherry-pick, revert, rebase, git am, or sequencer state/,
  );
  assert.match(
    unreadable.lines.join("\n"),
    /repository state was left unchanged/,
  );
});

test("advisory input normalization accepts omitted and legacy context shapes", () => {
  assert.equal(buildAdvisoryMessage({}).severity, "success");
  assert.equal(buildAdvisoryMessage(null).severity, "success");

  const legacy = buildAdvisoryMessage({
    issues: "not-an-array",
    dirtyTrackedFiles: ["README.md"],
  });
  assert.equal(legacy.severity, "success");

  const current = buildAdvisoryMessage({
    issues: [],
    unstagedTrackedFiles: ["CHANGELOG.md"],
  });
  assert.equal(current.severity, "success");
});

test("warns and recommends commit:fix when amend is safe", () => {
  const { severity, lines } = buildAdvisoryMessage(
    [{ type: "format", autoFixable: true, message: "1 file with issues" }],
    { canInspectUnstagedFiles: true, unstagedTrackedFiles: [] },
  );
  const text = lines.join("\n");
  assert.equal(severity, "warning");
  assert.ok(text.includes("npm run commit:fix"));
  assert.ok(!text.includes("still need your attention"));
});

test("mixed warnings recommend commit:fix and flag manual work", () => {
  const { lines } = buildAdvisoryMessage(
    [
      { type: "format", autoFixable: true, message: "fmt" },
      { type: "tests", autoFixable: false, message: "missing tests" },
    ],
    { canInspectUnstagedFiles: true, unstagedTrackedFiles: [] },
  );
  const text = lines.join("\n");
  assert.ok(text.includes("npm run commit:fix"));
  assert.ok(text.includes("Manual items above still need your attention."));
});

test("suppresses commit:fix when tracked worktree changes block amend", () => {
  const { lines } = buildAdvisoryMessage(
    [{ type: "format", autoFixable: true, message: "fmt" }],
    { canInspectUnstagedFiles: true, unstagedTrackedFiles: ["README.md"] },
  );
  const text = lines.join("\n");
  assert.ok(!text.includes("npm run commit:fix"));
  assert.ok(text.includes("Other tracked changes will still be present"));
});

test("flags manual work when a fixable+manual mix has amend blocked", () => {
  const { lines } = buildAdvisoryMessage(
    [
      { type: "format", autoFixable: true, message: "fmt" },
      { type: "tests", autoFixable: false, message: "missing tests" },
    ],
    { canInspectUnstagedFiles: true, unstagedTrackedFiles: ["README.md"] },
  );
  const text = lines.join("\n");
  // Amend is unsafe (other tracked changes), but the manual items are still
  // called out alongside the blocked-amend note.
  assert.ok(!text.includes("npm run commit:fix"));
  assert.ok(text.includes("Manual items above still need your attention."));
  assert.ok(text.includes("Other tracked changes will still be present"));
});

test("no fix command when nothing is auto-fixable", () => {
  const { lines } = buildAdvisoryMessage(
    [{ type: "tests", autoFixable: false, message: "missing tests" }],
    { canInspectUnstagedFiles: true, unstagedTrackedFiles: [] },
  );
  const text = lines.join("\n");
  assert.ok(text.includes("No automatic fix command"));
  assert.ok(!text.includes("npm run commit:fix"));
});

test("renders an issue's detail lines", () => {
  const { lines } = buildAdvisoryMessage([
    {
      type: "lint",
      autoFixable: false,
      message: "1 issue",
      detail: "src/a.js:1:2 (no-undef)\nsrc/b.js:3:4 (no-undef)",
    },
  ]);
  const text = lines.join("\n");
  assert.ok(text.includes("src/a.js:1:2 (no-undef)"));
  assert.ok(text.includes("src/b.js:3:4 (no-undef)"));

  const arrayModel = buildAdvisoryMessage([
    {
      type: "git",
      autoFixable: false,
      message: "Git detail",
      detail: ["one\nembedded\u001b[31mRED\u001b[39m", 2],
    },
  ]);
  assert.ok(
    arrayModel.lines.some((line) => line.includes("one\\nembeddedRED")),
  );
  assert.ok(arrayModel.lines.some((line) => line.includes("2")));
  const rendered = arrayModel.lines.join("\n");
  assert.doesNotMatch(stripAnsi(rendered), /\u001b/);
  assert.doesNotMatch(rendered, /embedded\u001b\[31mRED/);
});

test("notes when the worktree cannot be inspected for a safe amend", () => {
  const { lines } = buildAdvisoryMessage(
    [{ type: "format", autoFixable: true, message: "fmt" }],
    { canInspectUnstagedFiles: false, unstagedTrackedFiles: [] },
  );
  const text = lines.join("\n");
  assert.ok(!text.includes("npm run commit:fix"));
  assert.ok(text.includes("could not be inspected"));
});

test("maps the Prettier failure message across tones", () => {
  const issue = {
    type: "format",
    autoFixable: false,
    message: "Prettier failed to complete",
  };
  const standard = buildAdvisoryMessage([issue]).lines.join("\n");
  assert.ok(standard.includes("Prettier failed to complete"));

  const fun = buildAdvisoryMessage([issue], { tone: "fun" }).lines.join("\n");
  assert.ok(fun.includes("Prettier left you on read"));
});

test("commit-message copy is advisory by default and blocking only on opt-in", () => {
  const advisory = buildCommitMessageCheckMessage({
    outcome: "reported",
    detail: "type must be one of feat, fix",
  });
  assert.equal(advisory.severity, "warning");
  assert.match(advisory.lines.join("\n"), /Commit message needs attention/);
  assert.match(advisory.lines.join("\n"), /Commit will continue/);
  assert.match(advisory.lines.join("\n"), /type must be one of feat, fix/);

  const blocking = buildCommitMessageCheckMessage({
    outcome: "reported",
    blocking: true,
  });
  assert.equal(blocking.severity, "error");
  assert.match(blocking.lines.join("\n"), /Commit blocked/);
  assert.match(blocking.lines.join("\n"), /git commit --no-verify/);
});

test("commit-message copy explains local-only tools and bring-your-own rules", () => {
  const missingTool = buildCommitMessageCheckMessage({
    outcome: "missing-tool",
    installCommand: "pnpm add -D @commitlint/cli",
  }).lines.join("\n");
  assert.match(missingTool, /No npx, network, or global-tool fallback/);
  assert.match(missingTool, /pnpm add -D @commitlint\/cli/);

  const missingConfig = buildCommitMessageCheckMessage({
    outcome: "missing-config",
  }).lines.join("\n");
  assert.match(missingConfig, /Add a commitlint config/);
  assert.match(missingConfig, /No built-in Conventional Commits rules/);
});

test("commit-message failures have complete fun-tone variants", () => {
  for (const outcome of [
    "reported",
    "missing-tool",
    "missing-config",
    "unreadable",
    "timeout",
    "unavailable",
  ]) {
    const text = buildCommitMessageCheckMessage({
      outcome,
      tone: "fun",
    }).lines.join("\n");
    assert.match(text, /relationship|stood|space|left|missing/i);
    assert.match(text, /relationship note/);
  }

  const blocking = buildCommitMessageCheckMessage({
    outcome: "unavailable",
    tone: "fun",
    blocking: true,
  });
  assert.equal(blocking.severity, "error");
  assert.match(blocking.lines.join("\n"), /blocking mode is official/);
  assert.match(blocking.lines.join("\n"), /git commit --no-verify/);
});

test("push summary consolidates allowed advisory findings", () => {
  const model = buildPushAllowedMessage({
    warnings: [
      "Tests failed (advisory): 1 related test failed",
      'Direct push to protected branch "main"',
    ],
    notes: ["Review the failing test output above."],
  });
  const text = model.lines.join("\n");

  assert.equal(model.severity, "warning");
  assert.match(text, /Push allowed with 2 warnings/);
  assert.match(text, /Tests failed \(advisory\)/);
  assert.match(text, /protected branch "main"/);
  assert.match(text, /Review the failing test output above/);
});

test("push summary safely ignores malformed optional collections", () => {
  const model = buildPushAllowedMessage({
    warnings: "warning",
    notes: null,
    details: ["detail", ""],
  });
  const text = model.lines.join("\n");

  assert.match(text, /Push allowed with 0 warnings/);
  assert.match(text, /detail/);
});

test("advisory test failure warning covers missing and plural summaries", () => {
  assert.equal(advisoryTestFailureWarning(null), "Tests failed (advisory)");
  assert.equal(
    advisoryTestFailureWarning({ passed: 0, failed: 1 }),
    "Tests failed (advisory): 1 related test failed (0 passed, 1 failed)",
  );
  assert.equal(
    advisoryTestFailureWarning({ passed: 1, failed: 2 }),
    "Tests failed (advisory): 2 related tests failed (1 passed, 2 failed)",
  );
});

test("plural supports regular and irregular nouns", () => {
  assert.equal(plural(1, "file"), "file");
  assert.equal(plural(2, "file"), "files");
  assert.equal(plural(2, "branch", "branches"), "branches");
});

test("unavailableToolIssue covers install, timeout, signal, and spawn failures", () => {
  const base = {
    displayName: "ESLint",
    type: "lint",
    installCommand: "npm install -D eslint",
    timeoutSeconds: 30,
  };
  assert.match(
    unavailableToolIssue({
      ...base,
      result: {},
      outcome: "missing-tool",
    }).detail,
    /npm install -D eslint/,
  );

  for (const [cleanup, expected] of [
    ["direct-child", /descendant cleanup was unavailable/],
    ["process-group", /process-tree cleanup completed/],
    [undefined, /^No result within 30s$/],
  ]) {
    const issue = unavailableToolIssue({
      ...base,
      result: { cleanup },
      outcome: "timeout",
    });
    assert.equal(issue.message, "ESLint timed out");
    assert.match(issue.detail, expected);
  }

  assert.match(
    unavailableToolIssue({
      ...base,
      result: { signal: "SIGKILL" },
      outcome: "signal",
    }).detail,
    /SIGKILL/,
  );
  assert.match(
    unavailableToolIssue({
      ...base,
      result: { signal: null },
      outcome: "signal",
    }).detail,
    /unknown signal/,
  );
  assert.match(
    unavailableToolIssue({
      ...base,
      result: {},
      outcome: "spawn-error",
    }).detail,
    /Check ESLint install/,
  );
});

test("stagedTestInterruption describes every cleanup and signal state", () => {
  for (const [cleanup, expected] of [
    ["direct-child", /descendant cleanup was unavailable/],
    ["process-group", /process-tree cleanup completed/],
    [undefined, /^No result within 12s$/],
  ]) {
    const finding = stagedTestInterruption({ cleanup }, "timeout", 12);
    assert.equal(finding.message, "Staged tests timed out");
    assert.match(finding.detail, expected);
  }
  assert.match(
    stagedTestInterruption({ signal: "SIGINT" }, "signal", 12).detail,
    /SIGINT/,
  );
  assert.match(
    stagedTestInterruption({ signal: null }, "signal", 12).detail,
    /unknown signal/,
  );
  assert.match(
    stagedTestInterruption({}, "spawn-error", 12).detail,
    /Check testCommand/,
  );
});

test("prepushTestInterruption preserves policy and process detail", () => {
  for (const [cleanup, expected] of [
    ["direct-child", /descendant cleanup was unavailable/],
    ["process-group", /process-tree cleanup completed/],
    [undefined, /timed out after 9s\.$/],
  ]) {
    const model = prepushTestInterruption({ cleanup }, "timeout", 9, true);
    assert.equal(model.issue.message, "Could not run pre-push tests");
    assert.match(model.reasonText, expected);
  }

  assert.match(
    prepushTestInterruption({ signal: "SIGTERM" }, "signal", 9, false)
      .reasonText,
    /SIGTERM/,
  );
  assert.match(
    prepushTestInterruption({ signal: null }, "signal", 9, false).reasonText,
    /unknown signal/,
  );
  const unavailable = prepushTestInterruption({}, "spawn-error", 9, false);
  assert.equal(
    unavailable.issue.message,
    "Could not run pre-push tests (advisory)",
  );
  assert.match(unavailable.reasonText, /Check testCommand/);
});

test("secondary push warnings preserve a blocking outcome", () => {
  const model = appendPushWarnings(
    {
      severity: "error",
      lines: ["Push blocked: tests failed"],
    },
    ['Direct push to protected branch "main"'],
  );

  assert.equal(model.severity, "error");
  assert.match(model.lines.join("\n"), /Additional warning/);
  assert.match(model.lines.join("\n"), /protected branch "main"/);
});

test("push warning composition leaves an outcome unchanged when none exist", () => {
  const primary = {
    severity: "success",
    lines: ["All tests passed"],
  };

  assert.equal(appendPushWarnings(primary, []), primary);
  assert.equal(appendPushWarnings(primary, "warning"), primary);
});

test("secondary push warnings promote a non-error outcome to warning", () => {
  const model = appendPushWarnings(
    { severity: "success", lines: ["All tests passed"] },
    ['Direct push to protected branch "main"'],
  );

  assert.equal(model.severity, "warning");
  assert.match(model.lines.join("\n"), /protected branch "main"/);
});

test("secondary push warnings pluralize their heading", () => {
  const model = appendPushWarnings({ severity: "info", lines: ["No tests"] }, [
    "First warning",
    "Second warning",
  ]);

  assert.equal(model.severity, "warning");
  assert.match(model.lines.join("\n"), /Additional warnings:/);
});
