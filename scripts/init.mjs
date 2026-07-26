#!/usr/bin/env node
// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import pc from "picocolors";
import { errorBox, infoBox, printBox, warningBox } from "./lib/ui.mjs";
import {
  BIN,
  HOOK_MANAGERS,
  classifyHook,
  detectHookManagers,
  gitWorkTreeState,
  gitHooksDir,
  hookInvocation,
  hookManagerInstallCommand,
  hookManagerSnippets,
  hookNamesForConfig,
  hooksPathConfigState,
  composePrepareRepair,
  inspectPrepareRepairScript,
  inspectHookManager,
  inspectHookManagerRunner,
  isHuskyHooksPath,
  legacyHuskyDirectoryState,
  leftoverHuskyHooks,
  legacyHuskyWiringPaths,
  prepareRepairCommand,
  removeLegacyHuskyWiring,
  writeHook,
} from "./lib/hooks.mjs";
import {
  precommitConfigWarningMessages,
  readStandalonePrecommitConfig,
  resolvePrecommitConfigSources,
  STANDALONE_CONFIG_FILE,
} from "./lib/config.mjs";
import { isWorktreeRoot, resolveWorktreeRoot, run } from "./lib/process.mjs";
import { logoLines } from "./lib/logo.mjs";
import { escapeTerminalText } from "./lib/terminal.mjs";
import {
  inspectMutableProjectFile,
  preflightMutableProjectFile,
  writeMutableProjectFile,
} from "./lib/files.mjs";

// One-command setup for a consuming repo: wires up the git hooks, npm scripts,
// and gitignored caches without clobbering existing values. Hooks are plain
// `.git/hooks` files running the installed `commitment-issues` bin — no hook
// manager, nothing vendored. Also migrates husky-era wiring from pre-3.0
// setups. Safe to re-run.

const worktreeRoot = resolveWorktreeRoot();
if (worktreeRoot && !isWorktreeRoot(process.cwd(), worktreeRoot)) {
  errorBox([
    pc.bold("Project root required."),
    "",
    pc.dim("Init only changes files and hooks from a worktree root."),
    pc.dim(`Run this command from: ${escapeTerminalText(worktreeRoot)}`),
  ]);
  process.exit(1);
}

const packageFileState = inspectMutableProjectFile("package.json");
if (packageFileState.status === "missing") {
  errorBox([
    pc.bold("No package.json found."),
    "",
    pc.dim("Run this from your project root."),
  ]);
  process.exit(1);
}

const args = process.argv.slice(2);
const integrationOptions = args.filter(
  (argument) =>
    argument === "--integration" || argument.startsWith("--integration="),
);
const unknownOption = args.find((argument) => {
  if (["--dry-run", "-n", "--integration"].includes(argument)) {
    return false;
  }
  if (argument.startsWith("--integration=")) {
    return !HOOK_MANAGERS.includes(argument.slice("--integration=".length));
  }
  return true;
});
if (unknownOption) {
  errorBox([
    pc.bold(`Unknown init option: ${escapeTerminalText(unknownOption)}`),
    "",
    pc.dim(
      "Supported options: --dry-run, -n, --integration[=husky|lefthook|pre-commit].",
    ),
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}
if (integrationOptions.length > 1) {
  errorBox([
    pc.bold("The --integration option may be supplied only once."),
    "",
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}
const dryRun = args.includes("--dry-run") || args.includes("-n");
const requestedIntegration = integrationOptions[0]
  ? integrationOptions[0] === "--integration"
    ? "auto"
    : integrationOptions[0].slice("--integration=".length)
  : null;

const projectFileStates = new Map([
  ["package.json", packageFileState],
  [STANDALONE_CONFIG_FILE, inspectMutableProjectFile(STANDALONE_CONFIG_FILE)],
  [".gitignore", inspectMutableProjectFile(".gitignore")],
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
      "Replace it with a regular file inside this project, then run init again.",
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
    pc.dim("Fix package.json so it contains valid JSON, then run init again."),
  ]);
  process.exit(1);
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectInvalidContainer(property) {
  const location = property ? `property \`${property}\`` : "root value";
  errorBox([
    pc.bold("Invalid package.json structure."),
    "",
    pc.dim(
      `The ${escapeTerminalText(location)} must be a non-null, non-array JSON object.`,
    ),
    pc.dim("Fix package.json, then run init again. No files were changed."),
  ]);
  process.exit(1);
}

// Validate every package container before mutating anything. JSON syntax alone
// is not enough: arrays, primitives, and null cannot safely hold the values
// init adds.
if (!isJsonObject(pkg)) {
  rejectInvalidContainer();
}
for (const property of ["scripts", "precommitChecks"]) {
  if (Object.hasOwn(pkg, property) && !isJsonObject(pkg[property])) {
    rejectInvalidContainer(property);
  }
}

const managerDetection = detectHookManagers(process.cwd(), pkg);
let integrationManager = requestedIntegration;
if (requestedIntegration === "auto") {
  if (managerDetection.managers.length !== 1) {
    errorBox([
      pc.bold(
        managerDetection.managers.length === 0
          ? "No hook manager could be identified."
          : "Multiple hook managers were detected.",
      ),
      "",
      pc.dim(
        managerDetection.managers.length === 0
          ? "Choose explicitly with --integration=husky, --integration=lefthook, or --integration=pre-commit."
          : `Detected: ${managerDetection.managers.join(", ")}. Choose one explicitly with --integration=<manager>.`,
      ),
      pc.dim("No files or hooks were changed."),
    ]);
    process.exit(1);
  }
  [integrationManager] = managerDetection.managers;
}

const selectedManagerConfig = integrationManager
  ? managerDetection.configFiles[integrationManager]
  : null;
if (selectedManagerConfig?.status === "uninspectable") {
  const candidates = [
    ...selectedManagerConfig.present,
    ...selectedManagerConfig.unsafe,
  ];
  errorBox([
    pc.bold(`Could not choose a ${integrationManager} configuration safely.`),
    "",
    pc.dim(
      selectedManagerConfig.present.length > 1
        ? "Multiple recognized configuration files were detected."
        : selectedManagerConfig.unsafe.length > 0
          ? "A recognized configuration path could not be inspected safely."
          : "The recognized configuration format is not supported by the read-only inspector.",
    ),
    ...candidates.map((filePath) =>
      pc.dim(`• ${escapeTerminalText(filePath)}`),
    ),
    pc.dim(
      selectedManagerConfig.present.length === 1 &&
        selectedManagerConfig.unsafe.length === 0
        ? "Review that configuration manually or use one supported YAML main configuration."
        : "Keep one regular manager configuration, then run init again.",
    ),
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}

// Explicit setup must not write around a malformed higher-precedence config.
// Hook-time readers only warn and fall back because commits/pushes are
// advisory boundaries; init can stop safely before it mutates anything.
const standalone = readStandalonePrecommitConfig();
if (standalone.error) {
  errorBox([
    pc.bold(`Invalid ${STANDALONE_CONFIG_FILE}.`),
    "",
    pc.dim(`The file ${escapeTerminalText(standalone.error)}.`),
    pc.dim("Fix or remove it, then run init again. No files were changed."),
  ]);
  process.exit(1);
}
const created = [];
const warnings = [];

pkg.scripts ??= {};

// `doctor --quiet` re-establishes hook wiring after every fresh clone or
// reinstall. Compose it after a project-owned `prepare` command because Yarn
// Classic does not run `postprepare`. Shared structural analysis preserves
// project-owned behavior, recognizes historical generated forms, and refuses
// an ambiguous edit before any project file or hook is changed.
const desiredRepair = prepareRepairCommand(integrationManager);
const legacyPrepare = [
  "husky",
  "husky || true",
  "husky install",
  "node scripts/doctor.mjs --quiet",
];

function refusePrepareComposition(reason, { ambiguous = false } = {}) {
  errorBox([
    pc.bold(
      ambiguous
        ? "Ambiguous package.json prepare repair."
        : "Unsafe package.json prepare composition.",
    ),
    "",
    pc.dim(`${escapeTerminalText(reason)}.`),
    pc.dim(
      ambiguous
        ? "Remove only the displaced Commitment Issues repair command from scripts.prepare, keep every project-owned command, then run init again."
        : "Make scripts.prepare one complete command without an unfinished operator, quote, escape, trailing comment, or heredoc redirection, then run init again.",
    ),
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}

const prepareState = inspectPrepareRepairScript(pkg.scripts.prepare);
if (prepareState.status === "ambiguous") {
  refusePrepareComposition(prepareState.reason, { ambiguous: true });
}
const currentProjectPrepare = ["owned", "invalid"].includes(prepareState.status)
  ? prepareState.projectScript
  : pkg.scripts.prepare;
const retiringLegacyPrepare =
  !integrationManager &&
  (legacyPrepare.includes(pkg.scripts.prepare) ||
    legacyPrepare.includes(currentProjectPrepare));
if (retiringLegacyPrepare) {
  pkg.scripts.prepare = desiredRepair;
  created.push("script prepare");
} else if (prepareState.status === "owned") {
  if (prepareState.command !== desiredRepair) {
    if (prepareState.projectScript === null) {
      pkg.scripts.prepare = desiredRepair;
    } else {
      const composition = composePrepareRepair(
        prepareState.projectScript,
        desiredRepair,
      );
      pkg.scripts.prepare = composition.script;
    }
    created.push("script prepare integration");
  }
} else {
  const projectPrepare =
    prepareState.status === "invalid"
      ? prepareState.projectScript
      : pkg.scripts.prepare;
  if (!projectPrepare) {
    pkg.scripts.prepare = desiredRepair;
    created.push("script prepare");
  } else {
    const composition = composePrepareRepair(projectPrepare, desiredRepair);
    if (composition.status === "unsafe") {
      refusePrepareComposition(composition.reason);
    }
    pkg.scripts.prepare = composition.script;
    created.push("script prepare repair");
  }
}

const scripts = {
  "commit:fix": `${BIN} commit-fix`,
  "fix:staged": `${BIN} fix-staged`,
  "test:precommit": `${BIN} precommit`,
  doctor: `${BIN} doctor`,
};
// Legacy 1.x values that pointed at vendored scripts; upgrade them to the bin.
const legacyScripts = {
  "commit:fix": "node scripts/commit-fix.mjs",
  "fix:staged": "node scripts/fix-staged.mjs",
  "test:precommit": "node scripts/precommit-unified.mjs",
  doctor: "node scripts/doctor.mjs",
};
for (const [name, value] of Object.entries(scripts)) {
  const current = pkg.scripts[name];
  if ((!current || current === legacyScripts[name]) && current !== value) {
    pkg.scripts[name] = value;
    created.push(`script ${name}`);
  }
}

let standaloneChanged = false;
if (standalone.exists) {
  // Presence, not validity, decides whether init supplies a default. Keep an
  // explicitly configured invalid value intact so diagnostics can identify it
  // instead of silently rewriting the user's higher-precedence setting.
  const rawEffectiveConfig = {
    ...(pkg.precommitChecks ?? {}),
    ...standalone.config,
  };
  if (
    !("advisePushTests" in rawEffectiveConfig) &&
    !("blockPushOnTestFailure" in rawEffectiveConfig)
  ) {
    standalone.config.advisePushTests = true;
    standaloneChanged = true;
    created.push(`pre-push advisory config (${STANDALONE_CONFIG_FILE})`);
  }
} else {
  if (!pkg.precommitChecks) {
    pkg.precommitChecks = {};
    created.push("precommitChecks config");
  }

  if (
    !("advisePushTests" in pkg.precommitChecks) &&
    !("blockPushOnTestFailure" in pkg.precommitChecks)
  ) {
    pkg.precommitChecks.advisePushTests = true;
    created.push("pre-push advisory config");
  }
}

const effectiveConfig = resolvePrecommitConfigSources(
  pkg.precommitChecks ?? {},
  standalone,
);
const hookNames = hookNamesForConfig(effectiveConfig);
const configWarnings = precommitConfigWarningMessages(effectiveConfig);

// A supported filename is not sufficient evidence that the selected manager
// configuration is safe to compose with. Validate its content before the
// first package/.gitignore write so advanced, malformed, or globally
// execution-altering manager settings cannot leave a partial setup behind.
if (integrationManager) {
  const managerConfigReport = inspectHookManager(
    integrationManager,
    hookNames,
    process.cwd(),
  );
  if (managerConfigReport.status === "uninspectable") {
    errorBox([
      pc.bold(
        `Could not inspect the selected ${integrationManager} configuration safely.`,
      ),
      "",
      pc.dim(
        "Review the manager configuration manually or reduce it to the documented inspection contract.",
      ),
      pc.dim("No files or hooks were changed."),
    ]);
    process.exit(1);
  }
  const managerRunnerReport = inspectHookManagerRunner(
    integrationManager,
    hookNames,
    process.cwd(),
  );
  if (["uninspectable", "foreign"].includes(managerRunnerReport.status)) {
    errorBox([
      pc.bold(
        managerRunnerReport.status === "foreign"
          ? `The selected ${integrationManager} dispatcher is customized or unsupported.`
          : `Could not inspect the selected ${integrationManager} dispatcher safely.`,
      ),
      "",
      pc.dim(
        managerRunnerReport.status === "foreign"
          ? "Review the manager-owned wrapper manually; it was left unchanged."
          : "Fix the effective Git hooks path or manager wrapper, then run init again.",
      ),
      pc.dim("No files or hooks were changed."),
    ]);
    process.exit(1);
  }
}

let gitignore;
try {
  gitignore =
    projectFileStates.get(".gitignore").status === "regular"
      ? fs.readFileSync(".gitignore", "utf8")
      : "";
} catch {
  errorBox([
    pc.bold("Could not inspect .gitignore."),
    "",
    pc.dim("Make .gitignore a readable file, then run init again."),
    pc.dim("No files or hooks were changed."),
  ]);
  process.exit(1);
}
const gitignoreLines = gitignore.split("\n").map((line) => line.trim());
const ignores = [".eslintcache", ".prettiercache", "node_modules/"].filter(
  (entry) =>
    !gitignoreLines.includes(entry) &&
    !(entry === "node_modules/" && gitignoreLines.includes("node_modules")),
);

const projectFilesToWrite = [
  ["package.json", projectFileStates.get("package.json")],
  ...(standaloneChanged
    ? [[STANDALONE_CONFIG_FILE, projectFileStates.get(STANDALONE_CONFIG_FILE)]]
    : []),
  ...(ignores.length > 0
    ? [[".gitignore", projectFileStates.get(".gitignore")]]
    : []),
];
if (!dryRun) {
  for (const [filePath, state] of projectFilesToWrite) {
    if (!preflightMutableProjectFile(state)) {
      errorBox([
        pc.bold(`Could not update ${escapeTerminalText(filePath)}.`),
        "",
        pc.dim(
          "Make the project file and its directory writable, then run init again.",
        ),
        pc.dim("No files or hooks were changed."),
      ]);
      process.exit(1);
    }
  }
}

if (!dryRun) {
  try {
    writeMutableProjectFile(
      projectFileStates.get("package.json"),
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
    if (standaloneChanged) {
      writeMutableProjectFile(
        projectFileStates.get(STANDALONE_CONFIG_FILE),
        `${JSON.stringify(standalone.config, null, 2)}\n`,
      );
    }
    if (ignores.length > 0) {
      writeMutableProjectFile(
        projectFileStates.get(".gitignore"),
        `${gitignore}${gitignore.endsWith("\n") || gitignore === "" ? "" : "\n"}${ignores.join("\n")}\n`,
      );
    }
    /* node:coverage ignore next 15 */
  } catch {
    // Permission failures are exercised by the access preflight above. This
    // fallback is reserved for nondeterministic post-preflight failures such as
    // disk exhaustion or a concurrent permission change.
    errorBox([
      pc.bold("Could not update the project files."),
      "",
      pc.dim("A filesystem write failed before hook installation began."),
      pc.dim("Every project file remains a complete old or new version."),
      pc.dim("Fix storage or permissions, then rerun init safely."),
    ]);
    process.exit(1);
  }
}

// --- Hook wiring (native .git/hooks) ---

const gitState = gitWorkTreeState();
const isGitRepo = gitState.inside;
const hooksPathState = isGitRepo
  ? hooksPathConfigState()
  : { value: "", present: false, error: null };
const configuredHooksPath = hooksPathState.value;
const configuredHooksPathLabel =
  configuredHooksPath === "" ? '""' : configuredHooksPath;
const hooksPathInspectionFailed = hooksPathState.error !== null;
const huskyEraHooksPath =
  hooksPathState.present && isHuskyHooksPath(configuredHooksPath);
const foreignHooksPath = hooksPathState.present && !huskyEraHooksPath;
let hooksActive = false;
let integrationReport = null;
let integrationRunnerReport = null;
let integrationSnippets = [];

if (integrationManager) {
  integrationReport = inspectHookManager(
    integrationManager,
    hookNames,
    process.cwd(),
  );
  const inactive = integrationReport.hooks.filter(
    ({ status }) => status !== "wired",
  );
  integrationSnippets =
    integrationReport.status === "uninspectable"
      ? []
      : hookManagerSnippets(
          integrationManager,
          inactive
            .filter(
              ({ status, needsOwnStageEntry }) =>
                status !== "duplicate" &&
                (status !== "cross-stage" || needsOwnStageEntry),
            )
            .map(({ name }) => name),
          integrationReport.destination,
        );
  integrationRunnerReport = inspectHookManagerRunner(
    integrationManager,
    hookNames,
    process.cwd(),
  );
  const managerRunnerActive =
    (integrationManager !== "husky" || huskyEraHooksPath) &&
    integrationRunnerReport.status === "wired";
  hooksActive =
    isGitRepo &&
    !hooksPathInspectionFailed &&
    integrationReport.status === "wired" &&
    managerRunnerActive;

  const selectedEvidence = managerDetection.evidence[integrationManager];
  if (selectedEvidence.length === 0) {
    warnings.push(
      `No active ${integrationManager} configuration was detected.`,
      "Create or enable that manager first, then merge the snippets below.",
    );
  }
  const otherManagers = managerDetection.managers.filter(
    (manager) => manager !== integrationManager,
  );
  if (otherManagers.length > 0) {
    warnings.push(
      `Other hook-manager evidence was also detected: ${otherManagers.join(", ")}.`,
      `The explicit ${integrationManager} selection was honored; no owner was modified.`,
    );
  }
  if (managerDetection.unsafePaths.length > 0) {
    warnings.push(
      "Some possible manager paths could not be safely inspected and were left unchanged:",
      ...managerDetection.unsafePaths.map((filePath) => `  ${filePath}`),
    );
  }
  const duplicates = inactive.filter(({ status }) => status === "duplicate");
  const crossStage = inactive.filter(({ status }) => status === "cross-stage");
  if (inactive.length > 0) {
    warnings.push(
      `${integrationManager} does not yet have every active Commitment Issues hook.`,
      ...inactive.map(
        ({ name, status }) =>
          `  ${name}: ${
            status === "uninspectable"
              ? "could not be inspected"
              : status === "duplicate"
                ? "duplicate entries must be reduced to one"
                : status === "cross-stage"
                  ? "a Commitment Issues command targets another hook stage"
                  : status === "legacy"
                    ? "older direct entry must be replaced"
                    : "snippet not found"
          }`,
      ),
    );
  }
  if (duplicates.length > 0) {
    warnings.push(
      "Remove duplicate Commitment Issues entries; keep one exact hook-dispatch entry for each hook:",
      ...duplicates.map(({ name }) => `  ${name}`),
      ...(integrationManager === "husky"
        ? [
            "Make each retained hook-dispatch entry the first substantive command.",
          ]
        : []),
    );
  }
  if (crossStage.length > 0) {
    warnings.push(
      "Preserve unrelated commands and move each Commitment Issues entry to its matching hook stage:",
      ...crossStage.map(({ name }) => `  ${name}`),
      "For an older direct call, also insert `hook` before its subcommand; keep its arguments and relative ordering.",
    );
  }
  if (
    integrationManager === "husky" &&
    !hooksPathInspectionFailed &&
    integrationReport.status !== "uninspectable" &&
    integrationRunnerReport.status !== "uninspectable" &&
    !huskyEraHooksPath
  ) {
    warnings.push(
      "Husky's hook path is not active in Git.",
      `core.hooksPath is ${hooksPathState.present ? `set to ${configuredHooksPathLabel}` : "unset"}; run Husky's install command without replacing its hooks.`,
    );
  }
  if (integrationRunnerReport.status !== "wired") {
    const canRecommendInstall =
      !hooksPathInspectionFailed &&
      integrationReport.status !== "uninspectable" &&
      !["uninspectable", "foreign"].includes(integrationRunnerReport.status);
    warnings.push(
      `Git's effective hooks do not dispatch every active hook to ${integrationManager}.`,
      ...integrationRunnerReport.hooks
        .filter(({ status }) => status !== "wired")
        .map(({ name, status }) => `  ${name}: ${status}`),
      canRecommendInstall
        ? `Install the manager wrappers without replacing project configuration: ${hookManagerInstallCommand(
            integrationManager,
            hookNames,
            integrationReport.destination,
          )}`
        : "Review and replace the uninspectable configuration or hooks directory before running any manager install command.",
    );
  }
  if (hooksPathInspectionFailed) {
    warnings.push(
      "Git could not determine core.hooksPath, so manager activation could not be verified.",
      "Fix the Git configuration error, then run doctor again.",
    );
  }
  if (managerDetection.lintStaged) {
    warnings.push(
      "lint-staged was detected and remains unchanged.",
      "Keep lint-staged in its existing pre-commit flow; add Commitment Issues as a separate manager command.",
    );
  }
}

// Pre-3.0 setups pointed core.hooksPath at husky's shim dir; while that is
// set, git ignores `.git/hooks` entirely. Unset it (it is our own wiring, not
// the user's) so the native hooks below actually run.
let hooksPathRetired = !hooksPathInspectionFailed && !hooksPathState.present;
if (!integrationManager && huskyEraHooksPath) {
  if (!dryRun) {
    const unset = run("git", ["config", "--unset", "core.hooksPath"]);
    if (!unset.error && (unset.status || 0) === 0) {
      hooksPathRetired = true;
      created.push("retired husky-era core.hooksPath");
    } else {
      // Without the unset, git keeps ignoring .git/hooks — say so instead of
      // printing a success box over dead hooks.
      warnings.push(
        `core.hooksPath is still set to ${configuredHooksPathLabel}, so the hooks`,
        "written to .git/hooks will not run. Unset it manually:",
        "  git config --unset core.hooksPath",
      );
    }
  } else {
    hooksPathRetired = true;
    created.push("retired husky-era core.hooksPath");
  }
}

// A foreign core.hooksPath belongs to another hook manager or the user's own
// setup — never unset it or write hooks it would shadow. Explain instead.
if (!integrationManager && foreignHooksPath) {
  warnings.push(
    `core.hooksPath is set to ${configuredHooksPathLabel}, so git ignores .git/hooks.`,
    "Add these commands to the matching hooks in that directory:",
    ...hookNames.map((name) => `  ${name}: ${hookInvocation(name)}`),
    "Or unset it: git config --unset core.hooksPath",
  );
}

if (!integrationManager && hooksPathInspectionFailed) {
  warnings.push(
    "Git could not determine core.hooksPath, so no hooks were written.",
    "Fix the Git configuration error, then run:",
    `  ${BIN} doctor`,
  );
}

if (!isGitRepo) {
  if (gitState.bare) {
    warnings.push(
      "This is a bare Git repository, so local commit and push hooks were not installed.",
      `Run \`${BIN} init\` from a non-bare working tree instead.`,
    );
  } else {
    warnings.push(
      "This directory is not a git repository, so no hooks were installed.",
      `Run \`git init\`, then \`${BIN} doctor\` to wire up the hooks.`,
    );
  }
}

if (
  !integrationManager &&
  isGitRepo &&
  !foreignHooksPath &&
  !hooksPathInspectionFailed
) {
  const hooksDir = gitHooksDir();
  const unwiredHooks = [];
  const legacyHooks = [];
  const nonExecutableHooks = [];
  const uninspectableHooks = [];
  const failedHooks = [];

  if (!hooksDir) {
    warnings.push(
      "Git could not locate the git hooks directory, so no hooks were written.",
      `Fix the Git repository error, then run \`${BIN} doctor\`.`,
    );
  } else {
    for (const name of hookNames) {
      const status = classifyHook(hooksDir, name);
      // Create missing hooks and refresh exact older generated bodies. A hook
      // the user wrote is left exactly as-is. A custom hook that invokes
      // commitment-issues is healthy, while one that does not is reported
      // below with the exact command the user needs to add.
      if (status === "missing" || status === "stale-wired") {
        let written = true;
        if (!dryRun) {
          try {
            writeHook(hooksDir, name);
          } catch {
            written = false;
            failedHooks.push(name);
          }
        }
        if (written) {
          created.push(
            status === "stale-wired"
              ? `updated .git/hooks/${name}`
              : `.git/hooks/${name}`,
          );
        }
      } else if (status === "custom-without-command") {
        unwiredHooks.push(name);
      } else if (status === "custom-with-legacy-command") {
        legacyHooks.push(name);
      } else if (status === "non-executable") {
        nonExecutableHooks.push(name);
      } else if (status === "uninspectable") {
        uninspectableHooks.push(name);
      }
    }
  }

  if (unwiredHooks.length > 0) {
    warnings.push(
      "Existing git hooks were left unchanged but do not run commitment-issues.",
      "Make each guarded command the first substantive line; keep later hook logic:",
      ...unwiredHooks.map(
        (name) => `  .git/hooks/${name}: ${hookInvocation(name)}`,
      ),
    );
  }

  if (legacyHooks.length > 0) {
    warnings.push(
      "Existing git hooks use unguarded or direct commands outside the current managed hook contract.",
      "Replace each first substantive command so package removal fails open and hook-only skip variables stay effective:",
      ...legacyHooks.map(
        (name) => `  .git/hooks/${name}: ${hookInvocation(name)}`,
      ),
    );
  }

  if (nonExecutableHooks.length > 0) {
    warnings.push(
      "Existing git hooks were left unchanged but are not executable.",
      "Make each hook executable so Git can run it:",
      ...nonExecutableHooks.map((name) => `  chmod +x .git/hooks/${name}`),
    );
  }

  if (uninspectableHooks.length > 0) {
    warnings.push(
      "Existing git hooks could not be inspected and were left unchanged.",
      "Replace each path with a readable hook file, then run doctor:",
      ...uninspectableHooks.map((name) => `  .git/hooks/${name}`),
    );
  }

  if (failedHooks.length > 0) {
    warnings.push(
      "Some git hook files could not be written.",
      "Check permissions on the hooks directory, then run doctor:",
      ...failedHooks.map((name) => `  .git/hooks/${name}`),
    );
  }

  // Missing hooks are written above (or would be written by a dry run), and
  // wired/custom-with-command hooks are already active. Native hooks remain
  // inactive when a custom hook omits the command, lacks an executable bit on
  // POSIX, or a husky hooksPath could not be retired and shadows .git/hooks.
  hooksActive =
    hooksDir !== null &&
    hooksPathRetired &&
    unwiredHooks.length === 0 &&
    legacyHooks.length === 0 &&
    nonExecutableHooks.length === 0 &&
    uninspectableHooks.length === 0 &&
    failedHooks.length === 0;

  // Clean up the husky-era artifacts this tool generated (exact-match hook
  // files and husky's runtime dir). User-authored `.husky` hooks are never
  // deleted — they are reported below so the logic can be moved. Skipped
  // while core.hooksPath still points into `.husky` (failed unset above):
  // deleting the files git currently runs would kill working hooks.
  if (hooksDir && hooksPathRetired) {
    const legacyHuskyState = legacyHuskyDirectoryState();
    if (legacyHuskyState.status === "uninspectable") {
      warnings.push(
        "The legacy .husky path could not be safely inspected and was left unchanged.",
        "If it is a symbolic link or another non-directory path, review it manually.",
      );
    } else {
      const legacyWiring = dryRun
        ? legacyHuskyWiringPaths()
        : removeLegacyHuskyWiring();
      if (legacyWiring.length > 0) {
        created.push("removed legacy .husky wiring");
      }

      const stranded = leftoverHuskyHooks();
      if (stranded.length > 0) {
        warnings.push(
          `Leftover .husky hooks no longer run: ${stranded.join(", ")}.`,
          "Move the logic into .git/hooks, or delete the files.",
        );
      }
    }
  }
}

if (ignores.length > 0) {
  created.push(".gitignore defaults");
}

const setupSummary =
  created.length > 0
    ? [
        pc.dim(dryRun ? "Would add:" : "Added:"),
        ...created.map((item) => pc.dim(`- ${escapeTerminalText(item)}`)),
      ]
    : [
        pc.dim(
          hooksActive
            ? "Already configured — nothing to change."
            : "Package settings are configured; hook wiring still needs attention.",
        ),
      ];

const footer = dryRun
  ? [
      pc.dim("No files were written."),
      ...(created.length > 0
        ? [pc.dim("Run again without --dry-run to apply these changes.")]
        : []),
    ]
  : hooksActive
    ? [
        pc.dim("Your next commit runs advisory checks."),
        ...(effectiveConfig.commitMessage?.enabled === true
          ? [
              pc.dim(
                effectiveConfig.commitMessage.blockOnFailure === true
                  ? "Commit messages must pass your project commitlint rules."
                  : "Commit messages receive advisory project commitlint feedback.",
              ),
            ]
          : []),
        pc.dim("Your next push runs advisory tests when matching tests exist."),
      ]
    : [
        pc.dim(
          effectiveConfig.commitMessage?.enabled === true
            ? "The configured Git checks are not all active yet."
            : "Pre-commit and pre-push checks are not active yet.",
        ),
        pc.dim("Complete the hook wiring steps below."),
      ];

const warningSections = [
  ...(warnings.length > 0
    ? [
        "",
        pc.bold("Hook wiring needs your attention."),
        "",
        ...warnings.map((line) => pc.dim(escapeTerminalText(line))),
      ]
    : []),
  ...(configWarnings.length > 0
    ? [
        "",
        pc.bold("Configuration needs attention."),
        "",
        ...configWarnings.map((message) =>
          pc.dim(`• ${escapeTerminalText(message)}`),
        ),
      ]
    : []),
];

const integrationSections =
  integrationSnippets.length > 0
    ? [
        "",
        pc.bold(`${integrationManager} coexistence snippets.`),
        "",
        pc.dim(
          "Manager-owned files were not changed. Apply each entry using its add or replace label without reordering unrelated commands.",
        ),
        ...(integrationReport.hooks.some(({ status }) => status === "legacy")
          ? [
              pc.dim(
                "Replace each labelled older entry in place; do not keep both the direct and hook-dispatch forms.",
              ),
            ]
          : []),
        ...(integrationReport.hooks.some(
          ({ status, needsOwnStageEntry }) =>
            status === "missing" || needsOwnStageEntry,
        ) && integrationManager === "pre-commit"
          ? [
              pc.dim(
                "Place these entries under a local repo's hooks list; keep any existing repos and hooks.",
              ),
            ]
          : integrationReport.hooks.some(
                ({ status, needsOwnStageEntry }) =>
                  status === "missing" || needsOwnStageEntry,
              ) && integrationManager === "lefthook"
            ? [
                pc.dim(
                  "Merge each command under the matching top-level hook; do not duplicate an existing hook key.",
                ),
              ]
            : integrationReport.hooks.some(
                  ({ status, needsOwnStageEntry }) =>
                    status === "missing" || needsOwnStageEntry,
                )
              ? [
                  pc.dim(
                    "Place each missing guarded line before unrelated substantive commands; an exact Husky v8 source may precede it.",
                  ),
                ]
              : []),
        ...integrationSnippets.flatMap(({ name, destination, content }) => {
          const status = integrationReport.hooks.find(
            (hook) => hook.name === name,
          )?.status;
          return [
            "",
            pc.dim(
              `${destination} (${name}; ${status === "legacy" ? "replace older entry" : "add missing entry"}):`,
            ),
            ...content.trimEnd().split("\n"),
          ];
        }),
      ]
    : [];

const body = [
  ...logoLines(),
  "",
  pc.bold(
    dryRun
      ? "Commitment Issues dry run preview."
      : hooksActive
        ? "Commitment Issues is set up."
        : "Commitment Issues needs hook wiring.",
  ),
  "",
  ...setupSummary,
  "",
  ...footer,
  ...integrationSections,
  ...warningSections,
];

if (warningSections.length > 0) {
  warningBox(body);
} else if (dryRun) {
  infoBox(body);
} else {
  printBox(body, undefined, { borderColor: "green" });
}
