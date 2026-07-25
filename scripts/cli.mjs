#!/usr/bin/env node
// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { enforceSupportedNodeVersion } from "./lib/runtime.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";
import { hooksDisabled } from "./lib/hooks.mjs";

// Single entry point for the `commitment-issues` bin. It dispatches a
// subcommand to the matching script that lives alongside it inside the
// installed package, so consumers run `commitment-issues <command>` from their
// hooks and npm scripts — no vendoring, no node_modules paths.

const COMMANDS = {
  init: {
    file: "init.mjs",
    visibility: "primary",
    group: "Setup",
    order: 0,
    summary: "Install Git hooks in this repository",
    usage: "init [--dry-run | -n] [--integration[=husky|lefthook|pre-commit]]",
    options: [
      {
        label: "-n, --dry-run",
        flags: ["-n", "--dry-run"],
        summary: "Preview changes without modifying files or hooks",
      },
      {
        label: "--integration[=<manager>]",
        flags: ["--integration"],
        summary: "Print safe coexistence snippets for an existing manager",
      },
    ],
  },
  uninstall: {
    file: "uninstall.mjs",
    visibility: "primary",
    group: "Setup",
    order: 2,
    summary: "Remove Commitment Issues from this repository",
    usage: "uninstall [--dry-run | -n]",
    options: [
      {
        label: "-n, --dry-run",
        flags: ["-n", "--dry-run"],
        summary: "Preview changes without modifying files or hooks",
      },
    ],
  },
  doctor: {
    file: "doctor.mjs",
    visibility: "primary",
    group: "Setup",
    order: 1,
    summary: "Check and repair the installation",
    usage: "doctor [--quiet] [--integration[=husky|lefthook|pre-commit]]",
    options: [
      {
        label: "--quiet",
        flags: ["--quiet"],
        summary: "Stay silent when the installation is healthy",
      },
      {
        label: "--integration[=<manager>]",
        flags: ["--integration"],
        summary: "Verify user-owned hook-manager wiring without changing it",
      },
    ],
  },
  "commit-msg": {
    file: "commit-msg.mjs",
    visibility: "compatibility",
    group: "Integration",
    order: 0,
    summary: "Check a commit message when invoked automatically by Git",
    usage: "commit-msg <message-file> | --git-path",
    options: [
      {
        label: "--git-path",
        flags: ["--git-path"],
        summary:
          "Resolve Git's active commit-message path for manager integration",
      },
    ],
  },
  hook: { file: null, visibility: "hidden", options: [] },
  precommit: {
    file: "precommit.mjs",
    visibility: "primary",
    group: "Checks",
    order: 0,
    summary: "Check staged changes now",
    usage: "precommit [--json]",
    options: [
      {
        label: "--json",
        flags: ["--json"],
        summary: "Write a machine-readable result to stdout",
      },
    ],
  },
  prepush: {
    file: "prepush.mjs",
    visibility: "primary",
    group: "Checks",
    order: 1,
    summary: "Check changes that would be pushed",
    usage: "prepush [remote-name] [remote-url] [--json]",
    options: [
      {
        label: "--json",
        flags: ["--json"],
        summary: "Write a machine-readable result to stdout",
      },
    ],
  },
  panic: {
    file: "panic.mjs",
    visibility: "primary",
    group: "Checks",
    order: 2,
    summary: "Show a safe starting point after a Git mistake",
    usage: "panic",
    options: [],
  },
  "commit-fix": {
    file: "commit-fix.mjs",
    visibility: "primary",
    group: "Fixes",
    order: 1,
    summary: "Safely amend an attached commit using local ref checks",
    usage: "commit-fix",
    options: [],
  },
  "fix-staged": {
    file: "fix-staged.mjs",
    visibility: "primary",
    group: "Fixes",
    order: 0,
    summary: "Fix files currently staged for commit",
    usage: "fix-staged",
    options: [],
  },
  "fix-staged-js": {
    file: "fix-staged-js.mjs",
    visibility: "compatibility",
    group: null,
    order: 0,
    summary: "Fix explicit files supplied by package wiring",
    usage: "fix-staged-js [files...]",
    options: [],
  },
  // Easter eggs stay dispatchable without becoming part of help, docs, or the
  // typo-suggestion compatibility surface.
  vows: {
    file: "vows.mjs",
    visibility: "hidden",
    group: null,
    order: 0,
    summary: "Show the Commitment Issues vows",
    usage: "vows",
    options: [],
  },
};

const HELP_GROUPS = ["Setup", "Checks", "Fixes", "Integration"];
const DOCUMENTATION_URL = "https://github.com/RoryGlenn/commitment-issues";
const HOOK_FILES = new Map([
  ["precommit", "precommit.mjs"],
  ["prepush", "prepush.mjs"],
  ["commit-msg", "commit-msg.mjs"],
]);

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(path.dirname(scriptsDir), "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
enforceSupportedNodeVersion(process.versions.node, packageJson.engines.node);
const [subcommand, ...rest] = process.argv.slice(2);

function formatRows(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, summary]) => `  ${label.padEnd(width + 2)}${summary}`)
    .join("\n");
}

function printGlobalHelp(stream) {
  const sections = HELP_GROUPS.map((group) => {
    const rows = Object.entries(COMMANDS)
      .filter(
        ([, command]) =>
          command.visibility !== "hidden" && command.group === group,
      )
      .sort(([, left], [, right]) => left.order - right.order)
      .map(([name, command]) => [name, command.summary]);
    return `${group}:\n${formatRows(rows)}`;
  }).join("\n\n");

  stream(`Commitment Issues v${packageJson.version}
Catch mistakes locally—before CI makes them expensive.

Usage:
  commitment-issues <command> [options]
  commitment-issues help <command>

${sections}

Options:
${formatRows([
  ["-h, --help", "Show help"],
  ["-v, --version", "Show the installed version"],
])}

Examples:
  commitment-issues init --dry-run
  commitment-issues init
  commitment-issues doctor
  commitment-issues panic

Documentation:
  ${DOCUMENTATION_URL}`);
}

function printCommandHelp(command, stream) {
  const options = [
    ...command.options.map(({ label, summary }) => [label, summary]),
    ["--help", "Show help for this command"],
  ];
  stream(`Commitment Issues v${packageJson.version}

${command.summary}.

Usage:
  commitment-issues ${command.usage}

Options:
${formatRows(options)}

Documentation:
  ${DOCUMENTATION_URL}`);
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous = current;
  }

  return previous[right.length];
}

function closestCommand(input) {
  // Bound work for an accidentally pasted argument while keeping every real
  // command typo comfortably inside the comparison window.
  if (input.length > 64) return null;

  let closest = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const [command, metadata] of Object.entries(COMMANDS)) {
    if (metadata.visibility === "hidden") continue;
    const candidateDistance = editDistance(input, command);
    if (candidateDistance < distance) {
      closest = command;
      distance = candidateDistance;
    }
  }

  const threshold = Math.min(3, Math.max(1, Math.floor(closest.length / 3)));
  return distance <= threshold ? closest : null;
}

if (subcommand === "-v" || subcommand === "--version") {
  console.log(packageJson.version);
  process.exit(0);
}

if (!subcommand || subcommand === "-h" || subcommand === "--help") {
  printGlobalHelp(subcommand ? console.log : console.error);
  process.exit(subcommand ? 0 : 1);
}

if (subcommand === "help") {
  if (rest.length === 0) {
    printGlobalHelp(console.log);
    process.exit(0);
  }
  if (rest.length > 1) {
    console.error(
      `commitment-issues help: expected one command; received ${rest.length}`,
    );
    process.exit(1);
  }
}

const commandName = subcommand === "help" ? rest[0] : subcommand;
const command = Object.hasOwn(COMMANDS, commandName)
  ? COMMANDS[commandName]
  : undefined;
if (!command || (subcommand === "help" && command.visibility === "hidden")) {
  const suggestion = closestCommand(commandName);
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : "";
  console.error(
    escapeTerminalText(
      `commitment-issues: unknown command '${commandName}'.${hint} Run 'commitment-issues --help'.`,
    ),
  );
  process.exit(1);
}

if (
  command.visibility !== "hidden" &&
  (subcommand === "help" || rest.includes("--help"))
) {
  printCommandHelp(command, console.log);
  process.exit(0);
}

const commandArgs = rest;

function validateCommitMsgArgs(args) {
  if (args.length > 1) {
    console.error(
      `commitment-issues commit-msg: expected one message-file argument or --git-path; received ${args.length}`,
    );
    process.exit(1);
  }
  if (args[0]?.startsWith("--") && args[0] !== "--git-path") {
    console.error(
      escapeTerminalText(
        `commitment-issues commit-msg: unknown option '${args[0]}'`,
      ),
    );
    process.exit(1);
  }
}

if (commandName === "hook") {
  const [hookName, ...hookArgs] = commandArgs;
  const hookFile = HOOK_FILES.get(hookName);
  if (!hookFile) {
    console.error(
      escapeTerminalText(
        `commitment-issues hook: expected precommit, prepush, or commit-msg; received '${hookName ?? ""}'`,
      ),
    );
    process.exit(1);
  }
  if (hooksDisabled()) process.exit(0);
  if (hookName === "commit-msg") validateCommitMsgArgs(hookArgs);
  const hookTarget = path.join(scriptsDir, hookFile);
  process.argv = [process.argv[0], hookTarget, ...hookArgs];
  await import(pathToFileURL(hookTarget).href);
  process.exit(0);
}

if (
  commandArgs.some((arg) => arg === "--json" || /^--json=/.test(arg)) &&
  !command.options.some(({ flags }) => flags.includes("--json"))
) {
  console.error(
    `commitment-issues: --json is only supported by 'precommit' and 'prepush'.`,
  );
  process.exit(1);
}

const noArgumentCommands = new Set([
  "commit-fix",
  "fix-staged",
  "panic",
  "vows",
]);
if (noArgumentCommands.has(commandName) && commandArgs.length > 0) {
  console.error(
    escapeTerminalText(
      `commitment-issues ${commandName}: expected no arguments; received '${commandArgs[0]}'`,
    ),
  );
  process.exit(1);
}
if (commandName === "commit-msg") validateCommitMsgArgs(commandArgs);

// Run the target script in this same process: rewrite argv so it sees only its
// own arguments, then import it. The scripts call process.exit themselves, which
// propagates the correct exit code (and stdin stays connected for pre-push).
const target = path.join(scriptsDir, command.file);
process.argv = [process.argv[0], target, ...commandArgs];
// Package integrity guarantees the mapped entry script exists. Let a corrupt
// installation reject naturally so Node preserves the original module error.
await import(pathToFileURL(target).href);
