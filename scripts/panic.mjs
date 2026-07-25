#!/usr/bin/env node
// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import {
  enterWorktreeRoot,
  run,
  withoutGitLocalEnvironment,
} from "./lib/process.mjs";
import { printBoxModel } from "./lib/ui.mjs";
import {
  buildPanicGuide,
  inspectPanicRepository,
  panicGuideMessage,
} from "./lib/panic.mjs";

const args = process.argv.slice(2);
if (args.length > 0) {
  printBoxModel({
    severity: "error",
    lines: [
      `Panic does not accept arguments: ${args[0]}`,
      "",
      "No Git commands were run, and nothing was changed.",
    ],
  });
  process.exit(1);
}

enterWorktreeRoot();
const gitEnvironment = {
  ...withoutGitLocalEnvironment(),
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};
const runGit = (gitArgs) =>
  run(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.quotePath=false",
      ...gitArgs,
    ],
    { cwd: process.cwd(), env: gitEnvironment },
  );

const facts = inspectPanicRepository(runGit);
const guide = buildPanicGuide(facts);
printBoxModel(panicGuideMessage(guide));
process.exit(guide.exitCode);
