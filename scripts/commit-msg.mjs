#!/usr/bin/env node
// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { printHookBoxModel } from "./lib/ui.mjs";
import {
  loadPrecommitConfig,
  precommitConfigWarningMessages,
  resolveCommitMessageConfig,
  resolveHookOutput,
} from "./lib/config.mjs";
import { buildCommitMessageCheckMessage } from "./lib/message.mjs";
import { devInstallCommand } from "./lib/package-manager.mjs";
import {
  interruptedToolOutcome,
  localToolInvocation,
} from "./lib/local-tool.mjs";
import { enterWorktreeRoot, run, spawnAsync } from "./lib/process.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";

const invocationCwd = process.cwd();
enterWorktreeRoot();
const config = loadPrecommitConfig();
const hookOutput = resolveHookOutput(config);
for (const message of precommitConfigWarningMessages(config)) {
  console.warn(pc.yellow(escapeTerminalText(`⚠ ${message}`)));
}

const commitMessage = resolveCommitMessageConfig(config);
if (!commitMessage.enabled) {
  process.exit(0);
}

function finish(outcome, detail = []) {
  const model = buildCommitMessageCheckMessage({
    outcome,
    detail,
    blocking: commitMessage.blockOnFailure,
    tone: config.tone,
    installCommand: devInstallCommand(["@commitlint/cli"]),
  });
  printHookBoxModel(model, hookOutput);
  process.exit(commitMessage.blockOnFailure ? 1 : 0);
}

const messageArgument = process.argv[2];
let messageFile = messageArgument;
if (messageArgument === "--git-path") {
  const stripPathRecordTerminator = (output) =>
    output.endsWith("\r\n")
      ? output.slice(0, -2)
      : output.endsWith("\n")
        ? output.slice(0, -1)
        : output;
  const resolveGitPath = (name) => {
    const result = run("git", ["rev-parse", "--git-path", name]);
    const resolved =
      result.status === 0
        ? stripPathRecordTerminator(String(result.stdout || ""))
        : "";
    return { resolved, succeeded: result.status === 0 && Boolean(resolved) };
  };
  const hasMergeHeadEnvironment = Object.keys(process.env).some((name) =>
    /^GITHEAD_(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(name),
  );
  let directMerge = false;
  if (hasMergeHeadEnvironment) {
    const mergeHead = resolveGitPath("MERGE_HEAD");
    if (!mergeHead.succeeded) {
      finish("unreadable", [
        "Git could not verify its MERGE_HEAD path for this merge.",
      ]);
    }
    try {
      // A direct `git merge` exports GITHEAD_<object-id> and invokes the hook
      // with MERGE_MSG. A later `git commit` can still have MERGE_HEAD on disk,
      // but it does not export GITHEAD_* and invokes the hook with
      // COMMIT_EDITMSG. Require both signals so stale files or environment
      // variables cannot select the wrong message.
      if (!fs.lstatSync(path.resolve(mergeHead.resolved)).isFile()) {
        finish("unreadable", ["Git's MERGE_HEAD path is not a regular file."]);
      }
      directMerge = true;
    } catch (error) {
      if (error?.code === "ENOENT") {
        directMerge = false;
      } else {
        finish("unreadable", [
          "Git's MERGE_HEAD path could not be inspected safely.",
        ]);
      }
    }
  }
  const messagePathName = directMerge ? "MERGE_MSG" : "COMMIT_EDITMSG";
  // Git prints one pathname record followed by LF (or CRLF on some hosts).
  // Remove only that record terminator: trim() would corrupt a valid path that
  // itself begins or ends with whitespace or a newline.
  const resolvedMessagePath = resolveGitPath(messagePathName);
  messageFile = resolvedMessagePath.resolved;
  if (!resolvedMessagePath.succeeded) {
    finish("unreadable", [
      `Git could not resolve its ${messagePathName} path for this worktree.`,
    ]);
  }
}
let absoluteMessageFile;
try {
  absoluteMessageFile = path.resolve(
    messageArgument === "--git-path" ? process.cwd() : invocationCwd,
    messageFile,
  );
  if (!fs.statSync(absoluteMessageFile).isFile()) {
    finish("unreadable", [`Not a file: ${messageFile}`]);
  }
} catch {
  finish("unreadable", [
    messageFile
      ? `Could not open: ${messageFile}`
      : "No message file was provided.",
  ]);
}

const invocation = localToolInvocation("commitlint", [
  "--color=false",
  "--strict",
  "--edit",
  absoluteMessageFile,
]);
if (!invocation) {
  finish("missing-tool");
}

const result = await spawnAsync(invocation.command, invocation.args, {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"],
});

const detail = [result.stdout, result.stderr]
  .map((value) => String(value || "").trim())
  .filter(Boolean);
const detailText = detail.join("\n");

const interruptedOutcome = interruptedToolOutcome(result);
if (interruptedOutcome === "timeout") {
  finish(interruptedOutcome, detail);
}
if (interruptedOutcome === "unavailable") {
  finish("unavailable", [result.error?.message].filter(Boolean).concat(detail));
}
// Commitlint normally uses result code 9 when no rules configuration can be
// found. In --strict mode, current releases remap that same empty-rules error
// to result code 3, so retain the dedicated setup diagnosis by recognizing the
// standard formatter's empty-rules message as well as the documented exit code.
const strictMissingConfig =
  result.status === 3 &&
  /Please add rules to your [`'"]?commitlint\.config\.js/i.test(detailText) &&
  /\[empty-rules\]/.test(detailText);
if (result.status === 9 || strictMissingConfig) {
  finish("missing-config", detail);
}
if (result.status === 0) {
  process.exit(0);
}

finish(
  "reported",
  detail.length > 0
    ? detail
    : [`Commitlint exited with status ${result.status}.`],
);
