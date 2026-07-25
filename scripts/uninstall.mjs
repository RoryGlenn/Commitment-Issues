#!/usr/bin/env node
// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { infoBox, successBox, warningBox, errorBox } from "./lib/ui.mjs";
import {
  BIN,
  HOOK_MANAGERS,
  HOOK_NAMES,
  classifyHook,
  detectHookManagers,
  effectiveHooksDir,
  gitWorkTreeState,
  gitHooksDir,
  hooksPathConfigState,
  isHuskyHooksPath,
  inspectHookManagerForCleanup,
  legacyHuskyDirectoryState,
} from "./lib/hooks.mjs";
import { removeCommand } from "./lib/package-manager.mjs";
import {
  inspectMutableProjectFile,
  preflightMutableProjectFile,
  removeMutableProjectFile,
  writeMutableProjectFile,
} from "./lib/files.mjs";
import {
  readStandalonePrecommitConfig,
  STANDALONE_CONFIG_FILE,
} from "./lib/config.mjs";
import { resolveWorktreeRoot } from "./lib/process.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";

// Remove only setup that commitment-issues can identify as its own. Exact
// generated scripts and hook bodies are safe to delete; customized scripts,
// custom hooks, dependencies, lockfiles, and shared .gitignore entries are
// deliberately preserved.

const worktreeRoot = resolveWorktreeRoot();
if (
  worktreeRoot &&
  path.relative(worktreeRoot, path.resolve(process.cwd())) !== ""
) {
  errorBox([
    pc.bold("Project root required."),
    "",
    pc.dim("Uninstall only changes files and hooks from a worktree root."),
    pc.dim(`Run this command from: ${escapeTerminalText(worktreeRoot)}`),
  ]);
  process.exit(1);
}

const args = process.argv.slice(2);
const unknownOption = args.find(
  (argument) => !["--dry-run", "-n"].includes(argument),
);
if (unknownOption) {
  errorBox([
    pc.bold(`Unknown uninstall option: ${escapeTerminalText(unknownOption)}`),
    "",
    pc.dim("Supported options: --dry-run, -n."),
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}
const dryRun = args.includes("--dry-run") || args.includes("-n");

const packageFileState = inspectMutableProjectFile("package.json");
if (packageFileState.status === "missing") {
  errorBox([
    pc.bold("No package.json found."),
    "",
    pc.dim("Run this from your project root."),
  ]);
  process.exit(1);
}

const projectFileStates = new Map([
  ["package.json", packageFileState],
  [STANDALONE_CONFIG_FILE, inspectMutableProjectFile(STANDALONE_CONFIG_FILE)],
]);
const unsafeProjectFile = [...projectFileStates.values()].find(
  (state) => state.status === "unsafe",
);
if (unsafeProjectFile) {
  errorBox([
    pc.bold(`Unsafe project file: ${unsafeProjectFile.filePath}.`),
    "",
    pc.dim(`The path ${unsafeProjectFile.reason}.`),
    pc.dim(
      "Replace it with a regular file inside this project, then run uninstall again.",
    ),
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
} catch {
  errorBox([
    pc.bold("Invalid package.json."),
    "",
    pc.dim("Fix package.json so it contains valid JSON, then try again."),
  ]);
  process.exit(1);
}

const standalone = readStandalonePrecommitConfig();
if (standalone.error) {
  errorBox([
    pc.bold(`Invalid ${STANDALONE_CONFIG_FILE}.`),
    "",
    pc.dim(`The file ${escapeTerminalText(standalone.error)}.`),
    pc.dim(
      "Fix or remove it, then run uninstall again. No files were changed.",
    ),
  ]);
  process.exit(1);
}

const managedScripts = {
  prepare: [
    `${BIN} doctor --quiet`,
    ...HOOK_MANAGERS.map(
      (manager) => `${BIN} doctor --quiet --integration=${manager}`,
    ),
    "node scripts/doctor.mjs --quiet",
  ],
  postprepare: [`${BIN} doctor --quiet`, "node scripts/doctor.mjs --quiet"],
  "commit:fix": [`${BIN} commit-fix`, "node scripts/commit-fix.mjs"],
  "fix:staged": [`${BIN} fix-staged`, "node scripts/fix-staged.mjs"],
  "test:precommit": [`${BIN} precommit`, "node scripts/precommit-unified.mjs"],
  doctor: [`${BIN} doctor`, "node scripts/doctor.mjs"],
};
const repairSuffixes = [
  ` && ${BIN} doctor --quiet`,
  ...HOOK_MANAGERS.map(
    (manager) => ` && ${BIN} doctor --quiet --integration=${manager}`,
  ),
];

const plannedPackageChanges = [];
for (const [name, values] of Object.entries(managedScripts)) {
  if (values.includes(pkg.scripts?.[name])) {
    delete pkg.scripts[name];
    plannedPackageChanges.push(`package.json script ${name}`);
  }
}
for (const repairSuffix of repairSuffixes) {
  if (pkg.scripts?.prepare?.endsWith(repairSuffix)) {
    pkg.scripts.prepare = pkg.scripts.prepare.slice(0, -repairSuffix.length);
    plannedPackageChanges.push("package.json prepare repair");
    break;
  }
}

if (pkg.scripts && Object.keys(pkg.scripts).length === 0) {
  delete pkg.scripts;
}

if (Object.hasOwn(pkg, "precommitChecks")) {
  delete pkg.precommitChecks;
  plannedPackageChanges.push("package.json precommitChecks config");
}

const gitState = gitWorkTreeState();
const isGitRepo = gitState.inside;
const hookCandidates = [];
const manualCleanup = [];

function displayPath(filePath) {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
  return relative && !relative.startsWith("..")
    ? relative
    : filePath.replace(/\\/g, "/");
}

function inspectHookDirectory(directory, { preserveOwnedBy = null } = {}) {
  for (const name of HOOK_NAMES) {
    const hookPath = path.resolve(directory, name);
    // Removal is an ownership/content decision, not a health decision. An
    // exact generated body remains safe to remove even if its executable bit
    // was lost, and a customized invocation still needs manual cleanup.
    // classifyHook also folds filesystem inspection failures into its
    // uninspectable state, so cleanup remains non-destructive.
    const status = classifyHook(directory, name, {
      requireExecutable: false,
      recognizeLegacyCommand: true,
    });
    if (status === "wired" || status === "stale-wired") {
      if (preserveOwnedBy) {
        manualCleanup.push(
          `${displayPath(hookPath)} is ${preserveOwnedBy}-owned; remove its ${BIN} command manually.`,
        );
      } else {
        hookCandidates.push(hookPath);
      }
    } else if (
      status === "custom-with-command" ||
      status === "custom-with-legacy-command"
    ) {
      manualCleanup.push(
        `${displayPath(hookPath)} is customized; remove its ${BIN} command manually.`,
      );
    } else if (status === "uninspectable") {
      manualCleanup.push(
        `${displayPath(hookPath)} could not be inspected; it was left unchanged.`,
      );
    }
  }
}

if (isGitRepo) {
  const hooksPathState = hooksPathConfigState();
  if (hooksPathState.error) {
    manualCleanup.push(
      "Git could not determine core.hooksPath, so hook files were left unchanged.",
    );
  } else {
    const inspected = new Set();
    const nativeHooksDir = gitHooksDir();
    if (nativeHooksDir) {
      const absolute = path.resolve(nativeHooksDir);
      inspected.add(absolute);
      inspectHookDirectory(absolute);
    } else {
      manualCleanup.push(
        "Git could not locate the hooks directory, so hook files were left unchanged.",
      );
    }

    const configuredHooksPath = hooksPathState.value;
    if (hooksPathState.present) {
      const huskyEraHooksPath = isHuskyHooksPath(configuredHooksPath);
      const legacyHuskyState = huskyEraHooksPath
        ? legacyHuskyDirectoryState()
        : null;
      const configuredDir = huskyEraHooksPath
        ? legacyHuskyState.status === "uninspectable"
          ? null
          : path.resolve(".husky")
        : effectiveHooksDir();
      if (!configuredDir) {
        manualCleanup.push(
          huskyEraHooksPath && legacyHuskyState.status === "uninspectable"
            ? "The legacy .husky path could not be safely inspected and was left unchanged; review a symbolic link or non-directory path manually."
            : "Git could not resolve the configured hooks directory, so those hooks were left unchanged.",
        );
      } else if (!inspected.has(configuredDir)) {
        inspectHookDirectory(configuredDir, {
          preserveOwnedBy: huskyEraHooksPath ? "Husky" : null,
        });
      }
    }
  }
} else {
  manualCleanup.push(
    gitState.bare
      ? "This is a bare git repository, so local commit and push hooks were not inspected."
      : "This is not a git repository, so local hook files could not be inspected.",
  );
}

const managerDetection = detectHookManagers(process.cwd(), pkg);
for (const manager of managerDetection.managers) {
  const report = inspectHookManagerForCleanup(manager, HOOK_NAMES);
  const wired = report.hooks
    .filter(({ status }) => status === "wired")
    .map(({ name }) => name);
  if (wired.length > 0) {
    manualCleanup.push(
      `${manager} configuration is user-owned; remove the Commitment Issues ${wired.join(", ")} ${wired.length === 1 ? "entry" : "entries"} manually.`,
    );
  } else if (report.status === "uninspectable") {
    manualCleanup.push(
      `${manager} configuration could not be inspected safely and was left unchanged.`,
    );
  }
}

const planned = [
  ...plannedPackageChanges,
  ...(standalone.exists ? [STANDALONE_CONFIG_FILE] : []),
  ...hookCandidates.map(displayPath),
];
const removed = [];

if (!dryRun) {
  const projectFilesToMutate = [
    ...(plannedPackageChanges.length > 0
      ? [["package.json", projectFileStates.get("package.json"), false]]
      : []),
    ...(standalone.exists
      ? [
          [
            STANDALONE_CONFIG_FILE,
            projectFileStates.get(STANDALONE_CONFIG_FILE),
            true,
          ],
        ]
      : []),
  ];
  for (const [filePath, state, remove] of projectFilesToMutate) {
    if (!preflightMutableProjectFile(state, { remove })) {
      errorBox([
        pc.bold(`Could not update ${filePath}.`),
        "",
        pc.dim(
          "Make the project path and its directory writable, then run uninstall again.",
        ),
        pc.dim("No files or hooks were changed."),
      ]);
      process.exit(1);
    }
  }

  if (plannedPackageChanges.length > 0) {
    try {
      writeMutableProjectFile(
        projectFileStates.get("package.json"),
        `${JSON.stringify(pkg, null, 2)}\n`,
      );
      /* node:coverage ignore next 13 */
    } catch {
      // Permission failures are exercised by the access preflight above. This
      // fallback handles only a post-preflight filesystem race/failure.
      errorBox([
        pc.bold("Could not update package.json."),
        "",
        pc.dim("The filesystem write failed before hook cleanup began."),
        pc.dim("Every project file remains a complete old or new version."),
        pc.dim("Fix storage or permissions, then rerun uninstall safely."),
      ]);
      process.exit(1);
    }
    removed.push(...plannedPackageChanges);
  }
  if (standalone.exists) {
    try {
      removeMutableProjectFile(projectFileStates.get(STANDALONE_CONFIG_FILE));
    } catch {
      errorBox([
        pc.bold(`Could not remove ${STANDALONE_CONFIG_FILE}.`),
        "",
        pc.dim("Hook cleanup did not begin."),
        pc.dim(
          "Package metadata may already contain the complete intended cleanup.",
        ),
        pc.dim("Fix storage or permissions, then rerun uninstall safely."),
      ]);
      process.exit(1);
    }
    removed.push(STANDALONE_CONFIG_FILE);
  }
  for (const hookPath of hookCandidates) {
    try {
      fs.rmSync(hookPath);
      removed.push(displayPath(hookPath));
    } catch {
      manualCleanup.push(`Could not remove ${displayPath(hookPath)}.`);
    }
  }
}

const actions = dryRun ? planned : removed;
function actionSummaryLines(items, label) {
  const scripts = [];
  const remaining = [];
  for (const item of items) {
    const match = item.match(/^package\.json script (.+)$/);
    if (match) {
      scripts.push(match[1]);
    } else {
      remaining.push(item);
    }
  }
  return [
    pc.dim(label),
    ...(scripts.length > 0
      ? [pc.dim(`- package scripts: ${escapeTerminalText(scripts.join(", "))}`)]
      : []),
    ...remaining.map((item) => pc.dim(`- ${escapeTerminalText(item)}`)),
  ];
}

const summary =
  actions.length > 0
    ? actionSummaryLines(actions, dryRun ? "Would remove:" : "Removed:")
    : [pc.dim("No generated setup was found to remove.")];

function manualCleanupSummaryLines(items) {
  return items.flatMap((item) => {
    const customized = item.match(
      /^(.*) is customized; remove its (.*) command manually\.$/,
    );
    return customized
      ? [
          pc.dim(`- ${escapeTerminalText(customized[1])} is customized.`),
          pc.dim(
            `  Remove its ${escapeTerminalText(customized[2])} command manually.`,
          ),
        ]
      : [pc.dim(`- ${escapeTerminalText(item)}`)];
  });
}

const preservedIgnores = [
  ".eslintcache",
  ".prettiercache",
  "node_modules/",
].filter(
  (entry) =>
    fs.existsSync(".gitignore") &&
    fs
      .readFileSync(".gitignore", "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(entry),
);

const body = [
  pc.bold(
    dryRun
      ? "Commitment Issues uninstall preview."
      : manualCleanup.length > 0
        ? "Managed Commitment Issues setup was removed."
        : "Commitment Issues setup was removed.",
  ),
  "",
  ...summary,
  ...(preservedIgnores.length > 0
    ? [
        "",
        pc.dim("Preserved shared .gitignore entries:"),
        ...preservedIgnores.map((entry) =>
          pc.dim(`- ${escapeTerminalText(entry)}`),
        ),
      ]
    : []),
  ...(manualCleanup.length > 0
    ? [
        "",
        pc.bold(
          dryRun
            ? "Manual cleanup would still be needed:"
            : "Manual cleanup still needed:",
        ),
        ...manualCleanupSummaryLines(manualCleanup),
      ]
    : []),
  "",
  ...(dryRun
    ? [
        pc.dim("No files were written."),
        pc.dim("Run again without --dry-run to apply these changes."),
      ]
    : [
        pc.dim("Finish by removing the package and updating the lockfile:"),
        pc.dim(`  ${escapeTerminalText(removeCommand([BIN]))}`),
      ]),
];

if (manualCleanup.length > 0) {
  warningBox(body);
} else if (dryRun) {
  infoBox(body);
} else {
  successBox(body);
}
