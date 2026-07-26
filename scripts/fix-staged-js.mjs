// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import path from "node:path";
import { enterWorktreeRoot, isWorktreeRoot, runTool } from "./lib/process.mjs";
import { devInstallCommand } from "./lib/package-manager.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";

const invocationCwd = process.cwd();
const worktreeRoot = enterWorktreeRoot();
const invokedFromRoot =
  !worktreeRoot || isWorktreeRoot(invocationCwd, worktreeRoot);
const files = process.argv
  .slice(2)
  .filter(Boolean)
  .map((file) => (invokedFromRoot ? file : path.resolve(invocationCwd, file)));

if (files.length === 0) {
  process.exit(0);
}

let hasRemainingIssues = false;
const missingTools = [];

function recordToolResult(result) {
  if (result.outcome !== "success") {
    hasRemainingIssues = true;
  }
  if (result.outcome === "missing-tool") {
    missingTools.push(result.missingTool);
  }
}

const eslintResult = await runTool(
  "eslint",
  ["--cache", "--cache-strategy", "content", "--fix", "--", ...files],
  { stdio: "inherit" },
);

recordToolResult(eslintResult);

const prettierResult = await runTool(
  "prettier",
  [
    "--cache",
    "--cache-location",
    ".prettiercache",
    "--cache-strategy",
    "content",
    "--write",
    "--ignore-unknown",
    "--",
    ...files,
  ],
  { stdio: "inherit" },
);

recordToolResult(prettierResult);

if (missingTools.length > 0) {
  console.error(
    escapeTerminalText(
      `commitment-issues: missing local tool(s): ${missingTools.join(", ")} — ` +
        `install with \`${devInstallCommand(missingTools)}\`.`,
    ),
  );
}

if (hasRemainingIssues) {
  process.exit(1);
}

process.exit(0);
