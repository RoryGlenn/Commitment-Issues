// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import pc from "picocolors";
import { errorBox, infoBox, successBox, warningBox } from "./lib/ui.mjs";
import { enterWorktreeRoot, run } from "./lib/process.mjs";
import {
  codeFilePattern,
  formatFilePattern,
  parseNulPaths,
  shortFileList,
} from "./lib/files.mjs";
import {
  applyFixOutputs,
  captureFixSnapshot,
  inspectInterruptedFixState,
  isFixStateChangedError,
  runFixTools,
  stageFixOutputs,
} from "./lib/fix-safety.mjs";
import { loadPrecommitConfig } from "./lib/config.mjs";
import {
  buildConcurrentFixRefusalMessage,
  buildInterruptedFixRefusalMessage,
} from "./lib/message.mjs";
import { devInstallCommand, runScript } from "./lib/package-manager.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";

enterWorktreeRoot();
const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
const tone = loadPrecommitConfig().tone;

const stagedResult = run("git", [
  ...GIT_PATH_ARGS,
  "diff",
  "--cached",
  "--name-only",
  "-z",
  "--diff-filter=ACMRT",
]);

const stagedFiles = parseNulPaths(stagedResult.stdout);

if (stagedResult.error || stagedResult.status !== 0 || stagedFiles === null) {
  errorBox([
    pc.bold("Unable to inspect staged files."),
    "",
    pc.dim(
      "Check that Git is available and the current directory is a repository.",
    ),
  ]);
  process.exit(1);
}

const stagedJsFiles = stagedFiles.filter((file) => codeFilePattern.test(file));
const stagedFormatFiles = stagedFiles.filter((file) =>
  formatFilePattern.test(file),
);
const fixableFiles = Array.from(
  new Set([...stagedJsFiles, ...stagedFormatFiles]),
);

if (fixableFiles.length === 0) {
  infoBox([
    pc.bold("No staged files to fix."),
    "",
    pc.dim(
      `Stage a JS, JSON, CSS, Markdown, HTML, or YAML file and run ${runScript("fix:staged")} again.`,
    ),
  ]);
  process.exit(0);
}

const unstagedResult = run("git", [
  ...GIT_PATH_ARGS,
  "diff",
  "--name-only",
  "-z",
]);

const rawUnstagedFiles = parseNulPaths(unstagedResult.stdout);

if (
  unstagedResult.error ||
  unstagedResult.status !== 0 ||
  rawUnstagedFiles === null
) {
  errorBox([
    pc.bold("Unable to inspect unstaged files."),
    "",
    pc.dim(
      "Check that Git is available and the working tree can be inspected.",
    ),
  ]);
  process.exit(1);
}

const unstagedFiles = new Set(rawUnstagedFiles);

const partiallyStagedFiles = fixableFiles.filter((file) =>
  unstagedFiles.has(file),
);
const missingWorkingTreeFiles = fixableFiles.filter(
  (file) => !fs.existsSync(file),
);

if (partiallyStagedFiles.length > 0) {
  errorBox([
    pc.bold("Cannot safely fix partially staged files."),
    "",
    pc.dim("Resolve staged vs unstaged changes first:"),
    "",
    `  ${escapeTerminalText(shortFileList(partiallyStagedFiles))}`,
    "",
    pc.dim(`Then run ${runScript("fix:staged")} again.`),
  ]);
  process.exit(1);
}

if (missingWorkingTreeFiles.length > 0) {
  errorBox([
    pc.bold("Cannot safely fix staged files missing from the working tree."),
    "",
    pc.dim("Restore or unstage these files first:"),
    "",
    `  ${escapeTerminalText(shortFileList(missingWorkingTreeFiles))}`,
  ]);
  process.exit(1);
}

let fixResult;
let stagingResult;
try {
  const snapshot = captureFixSnapshot(fixableFiles, {
    allowUnbornHead: true,
  });
  fixResult = await runFixTools(snapshot.targets, {
    eslintFiles: stagedJsFiles,
    prettierFiles: fixableFiles,
  });
  for (const diagnostic of fixResult.diagnostics) {
    process.stderr.write(diagnostic.replace(/\n?$/u, "\n"));
  }
  if (fixResult.interruption) {
    const { affectedFiles } = inspectInterruptedFixState(snapshot);
    const message = buildInterruptedFixRefusalMessage({
      operation: "stage",
      interruption: fixResult.interruption,
      affectedFiles,
      missingTools: fixResult.missingTools,
      installCommand:
        fixResult.missingTools.length > 0
          ? devInstallCommand(fixResult.missingTools)
          : undefined,
      tone,
      rerunCommand: runScript("fix:staged"),
    });
    errorBox(message.lines);
    process.exit(1);
  }
  const appliedSnapshot = applyFixOutputs(snapshot, fixResult.outputs);
  stagingResult = stageFixOutputs(appliedSnapshot);
} catch (error) {
  if (isFixStateChangedError(error)) {
    const message = buildConcurrentFixRefusalMessage({
      operation: "stage",
      tone,
      rerunCommand: runScript("fix:staged"),
    });
    errorBox(message.lines);
    process.exit(1);
  }
  errorBox([
    pc.bold("Unable to apply automatic fixes safely."),
    "",
    pc.dim("Exact staging could not be verified."),
    pc.dim(escapeTerminalText(error.message)),
    pc.dim("Review git status and the tool output, then try again."),
  ]);
  process.exit(1);
}

console.log("");

if (!fixResult.toolFailed) {
  const indexChanged = stagingResult.changedFiles.length > 0;

  const summaryTitle = indexChanged
    ? "Staged fixes applied."
    : "Staged files already clean.";
  const summaryDetail = indexChanged
    ? `Refreshed the index for ${fixableFiles.length} staged file${fixableFiles.length === 1 ? "" : "s"}.`
    : `Checked ${fixableFiles.length} staged file${fixableFiles.length === 1 ? "" : "s"}. No automatic changes were needed.`;

  successBox([
    pc.bold(summaryTitle),
    "",
    pc.dim(summaryDetail),
    pc.dim(escapeTerminalText(shortFileList(fixableFiles))),
  ]);
  process.exit(0);
}

warningBox([
  pc.bold("Manual attention still needed."),
  "",
  pc.dim("Available attributable fixes were applied and staged."),
  pc.dim(
    "Review the ESLint or Prettier output above, then commit again when ready.",
  ),
]);

process.exit(1);
