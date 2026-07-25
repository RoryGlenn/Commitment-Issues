// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  inspectMutableProjectFile,
  readMutableProjectFile,
  writeMutableProjectFile,
} from "./files.mjs";
import { run, runTool, toolTimeoutMs } from "./process.mjs";

const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
const REGULAR_INDEX_MODES = new Set(["100644", "100755"]);
const FIX_TOOL_CONCURRENCY = 4;
const FIX_TOOL_INTERRUPTION_OUTCOMES = new Set([
  "missing-tool",
  "signal",
  "spawn-error",
  "timeout",
]);

function fixError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function inspectionError(message, cause) {
  return fixError("ERR_FIX_STATE_INSPECTION", message, cause);
}

function changedError(message, cause) {
  return fixError("ERR_FIX_STATE_CHANGED", message, cause);
}

function applyError(message, cause) {
  return fixError("ERR_FIX_APPLY", message, cause);
}

function requireSuccessful(result, message) {
  if (result.error || result.status !== 0) {
    throw inspectionError(message, result.error);
  }
  return result.stdout;
}

function currentHead({ allowUnbornHead }) {
  const result = run("git", ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (!result.error && result.status === 0) {
    const head = result.stdout.trim();
    if (head) {
      return head;
    }
  }
  if (allowUnbornHead && !result.error && result.status === 1) {
    return null;
  }
  throw inspectionError("Unable to inspect HEAD.", result.error);
}

function currentIndexTree() {
  return requireSuccessful(
    run("git", ["write-tree"]),
    "Unable to inspect the Git index.",
  ).trim();
}

function currentIndexPath() {
  const value = requireSuccessful(
    run("git", ["rev-parse", "--git-path", "index"]),
    "Unable to locate the Git index.",
  ).trim();
  if (!value) {
    throw inspectionError("Git returned an empty index path.");
  }
  return path.resolve(value);
}

function captureIndexFile(indexPath) {
  const state = inspectMutableProjectFile(indexPath);
  if (state.status !== "regular") {
    throw inspectionError("The Git index is not a regular file.");
  }
  try {
    return { state, content: readMutableProjectFile(state) };
  } catch (error) {
    if (error?.code === "ESTALE") {
      throw changedError("The Git index changed during inspection.", error);
    }
    throw inspectionError("Unable to read the Git index.", error);
  }
}

function assertIndexFileUnchanged(snapshot) {
  let content;
  try {
    content = readMutableProjectFile(snapshot.indexState);
  } catch (error) {
    if (error?.code === "ESTALE") {
      throw changedError("The Git index file changed.", error);
    }
    throw inspectionError("Unable to re-read the Git index.", error);
  }
  if (!content.equals(snapshot.indexContent)) {
    throw changedError("The Git index bytes changed.");
  }
}

/**
 * Parse NUL-delimited `git ls-files --stage` output without changing path
 * bytes that are valid in JavaScript strings.
 * @param {string} output - Raw Git output.
 * @returns {Array<{mode: string, oid: string, stage: number, file: string}>} Entries.
 */
export function parseIndexStageEntries(output) {
  if (output === "") {
    return [];
  }
  if (!output.endsWith("\0")) {
    throw inspectionError("Git returned malformed index entries.");
  }

  return output
    .slice(0, -1)
    .split("\0")
    .map((record) => {
      const separator = record.indexOf("\t");
      if (separator < 0) {
        throw inspectionError("Git returned malformed index entries.");
      }
      const metadata = record.slice(0, separator);
      const match = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/u.exec(
        metadata,
      );
      const file = record.slice(separator + 1);
      if (!match || file.length === 0) {
        throw inspectionError("Git returned malformed index entries.");
      }
      return {
        mode: match[1],
        oid: match[2],
        stage: Number(match[3]),
        file,
      };
    });
}

function targetEntries(files) {
  const output = requireSuccessful(
    run("git", [...GIT_PATH_ARGS, "ls-files", "--stage", "-z", "--", ...files]),
    "Unable to inspect target index entries.",
  );
  const byFile = new Map();
  for (const entry of parseIndexStageEntries(output)) {
    const entries = byFile.get(entry.file) ?? [];
    entries.push(entry);
    byFile.set(entry.file, entries);
  }

  return files.map((file) => {
    const entries = byFile.get(file) ?? [];
    if (
      entries.length !== 1 ||
      entries[0].stage !== 0 ||
      !REGULAR_INDEX_MODES.has(entries[0].mode)
    ) {
      throw changedError(`Target index entry changed: ${file}`);
    }
    return entries[0];
  });
}

function blobContents(oid) {
  const result = run("git", ["cat-file", "blob", oid], { encoding: null });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw inspectionError(`Unable to read indexed blob ${oid}.`, result.error);
  }
  return result.stdout;
}

function captureTarget(entry) {
  const indexedContent = blobContents(entry.oid);
  const state = inspectMutableProjectFile(entry.file);
  if (state.status !== "regular") {
    throw changedError(
      `Target file is no longer a regular file: ${entry.file}`,
    );
  }

  let worktreeContent;
  try {
    worktreeContent = readMutableProjectFile(state);
  } catch (error) {
    if (error?.code === "ESTALE") {
      throw changedError(`Target file changed: ${entry.file}`, error);
    }
    throw inspectionError(`Unable to read target file: ${entry.file}`, error);
  }
  if (!worktreeContent.equals(indexedContent)) {
    throw changedError(`Target bytes differ from the index: ${entry.file}`);
  }
  return {
    file: entry.file,
    mode: entry.mode,
    oid: entry.oid,
    initialContent: Buffer.from(indexedContent),
    expectedContent: Buffer.from(indexedContent),
    state,
  };
}

/**
 * Bind a fixer run to the exact current HEAD, index file/tree, and target bytes.
 * @param {string[]} files - Project-relative target paths.
 * @param {{allowUnbornHead?: boolean}} [options] - Whether a missing HEAD is valid.
 * @returns {{allowUnbornHead: boolean, head: string|null, indexTree: string, indexPath: string, indexState: ReturnType<typeof inspectMutableProjectFile>, indexContent: Buffer, targets: ReturnType<typeof captureTarget>[]}} Snapshot.
 */
export function captureFixSnapshot(files, { allowUnbornHead = false } = {}) {
  const uniqueFiles = [...new Set(files)];
  const head = currentHead({ allowUnbornHead });
  const indexTree = currentIndexTree();
  const indexPath = currentIndexPath();
  const indexFile = captureIndexFile(indexPath);
  const entries = targetEntries(uniqueFiles);
  const targets = entries.map(captureTarget);
  const targetIdentities = new Set();
  for (const target of targets) {
    const identity = `${target.state.stats.dev}:${target.state.stats.ino}`;
    if (targetIdentities.has(identity)) {
      throw inspectionError(
        `Fix targets share a hardlinked file: ${target.file}`,
      );
    }
    targetIdentities.add(identity);
  }

  return {
    allowUnbornHead,
    head,
    indexTree,
    indexPath,
    indexState: indexFile.state,
    indexContent: indexFile.content,
    targets,
  };
}

function readExpectedTarget(target) {
  try {
    return readMutableProjectFile(target.state);
  } catch (error) {
    if (error?.code === "ESTALE") {
      throw changedError(`Target file changed: ${target.file}`, error);
    }
    throw inspectionError(
      `Unable to re-read target file: ${target.file}`,
      error,
    );
  }
}

/**
 * Fail unless every repository identity bound by a snapshot remains exact.
 * @param {ReturnType<typeof captureFixSnapshot>} snapshot - Bound state.
 * @returns {void}
 */
export function assertFixSnapshotUnchanged(snapshot) {
  if (
    currentHead({ allowUnbornHead: snapshot.allowUnbornHead }) !== snapshot.head
  ) {
    throw changedError("HEAD changed while automatic fixes were running.");
  }
  if (currentIndexPath() !== snapshot.indexPath) {
    throw changedError("The active Git index changed.");
  }
  // The exact file identity and bytes are stronger than a tree-only check.
  // Do not run `git write-tree` against the live index here: some Git versions
  // rewrite an equivalent index during that inspection, which would make the
  // safety probe itself look like concurrent user work.
  assertIndexFileUnchanged(snapshot);
  assertFixTargetsUnchanged(snapshot);
}

function assertFixTargetsUnchanged(snapshot) {
  for (const target of snapshot.targets) {
    if (!readExpectedTarget(target).equals(target.expectedContent)) {
      throw changedError(`Target bytes changed: ${target.file}`);
    }
  }
}

/**
 * Parse one ESLint JSON formatter result and retain its attributable fixed
 * output when present.
 * @param {string} output - ESLint JSON stdout.
 * @param {string} file - Expected stdin filename.
 * @param {string} input - Exact input text.
 * @returns {string} Fixed output or the unchanged input.
 */
export function eslintFixedOutput(output, file, input) {
  let reports;
  try {
    reports = JSON.parse(output);
  } catch (error) {
    throw applyError("ESLint returned malformed fix output.", error);
  }
  if (
    !Array.isArray(reports) ||
    reports.length !== 1 ||
    typeof reports[0] !== "object" ||
    reports[0] === null
  ) {
    throw applyError("ESLint returned malformed fix output.");
  }
  const report = reports[0];
  if (
    typeof report.filePath === "string" &&
    path.resolve(report.filePath) !== path.resolve(file)
  ) {
    throw applyError("ESLint reported fixes for an unexpected path.");
  }
  return typeof report.output === "string" ? report.output : input;
}

function appendDiagnostic(diagnostics, result) {
  if (result.stderr) {
    diagnostics.push(result.stderr);
  }
}

async function runBoundedFixTasks(
  items,
  runTask,
  { concurrency, deadline, maximumTimeoutMs, now },
) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;

  async function worker() {
    while (!stopped) {
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;
      const remainingMs = Math.min(
        maximumTimeoutMs,
        Math.ceil(deadline - now()),
      );
      if (remainingMs <= 0) {
        stopped = true;
        return;
      }
      const result = await runTask(items[index], remainingMs);
      results[index] = { item: items[index], result };
      if (FIX_TOOL_INTERRUPTION_OUTCOMES.has(result.outcome)) {
        stopped = true;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => worker()));
  return results.filter(Boolean);
}

/**
 * Convert one ESLint JSON report into stable path-attributed diagnostics.
 * @param {string} output - ESLint JSON stdout.
 * @param {string} file - Expected stdin filename.
 * @returns {string[]} Diagnostics suitable for stderr.
 */
export function eslintDiagnostics(output, file) {
  const diagnostics = [];
  const [report] = JSON.parse(output);
  if (!Array.isArray(report.messages)) {
    return diagnostics;
  }
  for (const message of report.messages) {
    if (typeof message?.message !== "string") {
      continue;
    }
    const location =
      Number.isInteger(message.line) && Number.isInteger(message.column)
        ? `:${message.line}:${message.column}`
        : "";
    const rule =
      typeof message.ruleId === "string" ? ` (${message.ruleId})` : "";
    diagnostics.push(`${file}${location}: ${message.message}${rule}\n`);
  }
  return diagnostics;
}

/**
 * Run ESLint and Prettier against exact in-memory inputs. Neither tool receives
 * a live path it can rewrite.
 * @param {ReturnType<typeof captureFixSnapshot>["targets"]} targets - Inputs.
 * @param {{eslintFiles: string[], prettierFiles: string[]}} files - Tool sets.
 * @param {{concurrency?: number, now?: () => number, runToolCommand?: typeof runTool, timeoutMs?: number}} [options] - Bounded runner options.
 * @returns {Promise<{outputs: Map<string, string>, toolFailed: boolean, missingTools: string[], diagnostics: string[]}>} Attributable outputs.
 */
export async function runFixTools(
  targets,
  { eslintFiles, prettierFiles },
  {
    concurrency = FIX_TOOL_CONCURRENCY,
    now = Date.now,
    runToolCommand = runTool,
    timeoutMs = toolTimeoutMs(),
  } = {},
) {
  const outputs = new Map(
    targets.map((target) => [
      target.file,
      target.expectedContent.toString("utf8"),
    ]),
  );
  const targetFiles = new Set(outputs.keys());
  const missingTools = new Set();
  const diagnostics = [];
  let toolFailed = false;

  for (const [tool, files] of [
    ["ESLint", eslintFiles],
    ["Prettier", prettierFiles],
  ]) {
    for (const file of files) {
      if (!targetFiles.has(file)) {
        throw applyError(`${tool} target was not captured: ${file}`);
      }
    }
  }

  const deadline = now() + timeoutMs;
  const runnerOptions = {
    concurrency,
    deadline,
    maximumTimeoutMs: timeoutMs,
    now,
  };
  const eslintResults = await runBoundedFixTasks(
    eslintFiles,
    (file, remainingMs) =>
      runToolCommand(
        "eslint",
        [
          "--fix-dry-run",
          "--stdin",
          "--stdin-filename",
          file,
          "--format",
          "json",
        ],
        { input: outputs.get(file), timeoutMs: remainingMs },
      ),
    runnerOptions,
  );
  if (eslintResults.length !== eslintFiles.length) {
    toolFailed = true;
  }
  for (const { item: file, result } of eslintResults) {
    const input = outputs.get(file);
    appendDiagnostic(diagnostics, result);
    if (result.outcome === "missing-tool") {
      missingTools.add(result.missingTool);
      toolFailed = true;
      continue;
    }
    if (result.outcome !== "success") {
      toolFailed = true;
    }
    if (result.stdout) {
      try {
        outputs.set(file, eslintFixedOutput(result.stdout, file, input));
        diagnostics.push(...eslintDiagnostics(result.stdout, file));
      } catch (error) {
        diagnostics.push(`${error.message}\n`);
        toolFailed = true;
      }
    }
  }

  const prettierResults = await runBoundedFixTasks(
    prettierFiles,
    (file, remainingMs) =>
      runToolCommand("prettier", ["--stdin-filepath", file], {
        input: outputs.get(file),
        timeoutMs: remainingMs,
      }),
    runnerOptions,
  );
  if (prettierResults.length !== prettierFiles.length) {
    toolFailed = true;
  }
  for (const { item: file, result } of prettierResults) {
    appendDiagnostic(diagnostics, result);
    if (result.outcome === "missing-tool") {
      missingTools.add(result.missingTool);
      toolFailed = true;
      continue;
    }
    if (result.outcome === "success") {
      outputs.set(file, result.stdout);
    } else {
      toolFailed = true;
    }
  }

  return {
    outputs,
    toolFailed,
    missingTools: [...missingTools],
    diagnostics,
  };
}

function outputBuffer(outputs, target) {
  const output = outputs.get(target.file);
  if (typeof output !== "string") {
    throw applyError(`No attributable tool output exists for ${target.file}.`);
  }
  return Buffer.from(output, "utf8");
}

/**
 * Apply known outputs to still-identical target files with crash-safe writes.
 * @param {ReturnType<typeof captureFixSnapshot>} snapshot - Bound state.
 * @param {Map<string, string>} outputs - Exact tool-produced contents.
 * @returns {ReturnType<typeof captureFixSnapshot>} Snapshot after writes.
 */
export function applyFixOutputs(snapshot, outputs) {
  assertFixSnapshotUnchanged(snapshot);
  const targets = snapshot.targets.map((target) => {
    const output = outputBuffer(outputs, target);
    if (output.equals(target.expectedContent)) {
      return target;
    }
    try {
      writeMutableProjectFile(target.state, output.toString("utf8"));
      const state = inspectMutableProjectFile(target.file);
      if (state.status !== "regular") {
        throw changedError(`Target file changed: ${target.file}`);
      }
      const written = readMutableProjectFile(state);
      if (!written.equals(output)) {
        throw changedError(`Target bytes changed: ${target.file}`);
      }
      return {
        ...target,
        expectedContent: output,
        state,
      };
    } catch (error) {
      if (error?.code === "ESTALE" || error?.code === "ERR_FIX_STATE_CHANGED") {
        throw changedError(`Target file changed: ${target.file}`, error);
      }
      throw applyError(`Unable to apply fixes to ${target.file}.`, error);
    }
  });
  const updated = { ...snapshot, targets };
  assertFixSnapshotUnchanged(updated);
  return updated;
}

function removeIfOwned(filePath, identity) {
  if (!identity) {
    return;
  }
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) {
      fs.rmSync(filePath);
    }
  } catch {
    // The primary transaction result remains authoritative.
  }
}

function writeIndexInfo(tempIndex, entries, recordIdentity) {
  const input = entries
    .map(({ target, oid }) => `${target.mode} ${oid} 0\t${target.file}\0`)
    .join("");
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  const updateResult = run("git", ["update-index", "-z", "--index-info"], {
    env,
    input,
  });
  requireSuccessful(updateResult, "Unable to prepare exact staged fixes.");
  recordIdentity(fs.lstatSync(tempIndex, { bigint: true }));
  const treeResult = run("git", ["write-tree"], { env });
  const tree = requireSuccessful(
    treeResult,
    "Unable to verify exact staged fixes.",
  ).trim();
  recordIdentity(fs.lstatSync(tempIndex, { bigint: true }));
  return tree;
}

/**
 * Install only attributable output blobs under Git's cooperative index lock.
 * @param {ReturnType<typeof captureFixSnapshot>} snapshot - Post-write state.
 * @returns {{snapshot: ReturnType<typeof captureFixSnapshot>, changedFiles: string[]}} Staged state.
 */
export function stageFixOutputs(snapshot) {
  const changedTargets = snapshot.targets.filter(
    (target) => !target.expectedContent.equals(target.initialContent),
  );
  if (changedTargets.length === 0) {
    assertFixSnapshotUnchanged(snapshot);
    return { snapshot, changedFiles: [] };
  }

  const entries = changedTargets.map((target) => {
    const oid = requireSuccessful(
      run("git", ["hash-object", "-w", "--stdin"], {
        input: target.expectedContent,
      }),
      `Unable to store fixed content for ${target.file}.`,
    ).trim();
    return { target, oid };
  });

  const indexDirectory = path.dirname(snapshot.indexPath);
  const tempIndex = path.join(
    indexDirectory,
    `index.commitment-issues-${process.pid}-${randomUUID()}.tmp`,
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  let tempIdentity;
  let lockIdentity;
  let lockDescriptor;
  let committed = false;
  let result;
  let failure;
  try {
    assertFixSnapshotUnchanged(snapshot);
    fs.copyFileSync(snapshot.indexPath, tempIndex, fs.constants.COPYFILE_EXCL);
    tempIdentity = fs.lstatSync(tempIndex, { bigint: true });
    const expectedTree = writeIndexInfo(tempIndex, entries, (identity) => {
      tempIdentity = identity;
    });
    const indexMode = fs.statSync(snapshot.indexPath).mode & 0o777;
    lockDescriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      indexMode,
    );
    lockIdentity = fs.fstatSync(lockDescriptor, { bigint: true });

    // Holding index.lock makes this the final cooperative-writer check before
    // installation. HEAD and target bytes remain separate explicit guards.
    assertIndexFileUnchanged(snapshot);
    if (
      currentHead({ allowUnbornHead: snapshot.allowUnbornHead }) !==
      snapshot.head
    ) {
      throw changedError("HEAD changed before staging.");
    }
    assertFixTargetsUnchanged(snapshot);
    const preparedIndex = fs.readFileSync(tempIndex);
    fs.writeFileSync(lockDescriptor, preparedIndex);
    fs.fchmodSync(lockDescriptor, indexMode);
    fs.fsyncSync(lockDescriptor);
    fs.closeSync(lockDescriptor);
    lockDescriptor = undefined;
    assertFixTargetsUnchanged(snapshot);
    if (
      currentHead({ allowUnbornHead: snapshot.allowUnbornHead }) !==
      snapshot.head
    ) {
      throw changedError("HEAD changed while staging automatic fixes.");
    }
    fs.renameSync(lockPath, snapshot.indexPath);
    committed = true;

    const installedIndex = captureIndexFile(snapshot.indexPath);
    if (
      installedIndex.state.stats.dev !== lockIdentity.dev ||
      installedIndex.state.stats.ino !== lockIdentity.ino ||
      !installedIndex.content.equals(preparedIndex)
    ) {
      throw changedError("The Git index changed as fixes were staged.");
    }
    if (
      currentHead({ allowUnbornHead: snapshot.allowUnbornHead }) !==
      snapshot.head
    ) {
      throw changedError("HEAD changed as automatic fixes were staged.");
    }
    assertFixTargetsUnchanged(snapshot);
    const updated = { ...snapshot, indexTree: expectedTree };
    assertIndexFileUnchanged({
      ...updated,
      indexState: installedIndex.state,
      indexContent: installedIndex.content,
    });
    result = {
      snapshot: {
        ...updated,
        indexState: installedIndex.state,
        indexContent: installedIndex.content,
      },
      changedFiles: changedTargets.map((target) => target.file),
    };
  } catch (error) {
    if (
      error?.code === "EEXIST" ||
      error?.code === "ERR_FIX_STATE_CHANGED" ||
      error?.code === "ESTALE"
    ) {
      failure = changedError("Repository state changed before staging.", error);
    } else if (
      error?.code === "ERR_FIX_STATE_INSPECTION" ||
      error?.code === "ERR_FIX_APPLY"
    ) {
      failure = error;
    } else {
      failure = applyError("Unable to stage exact automatic fixes.", error);
    }
  }
  if (lockDescriptor !== undefined) {
    try {
      fs.closeSync(lockDescriptor);
    } catch {
      // The transaction error remains authoritative.
    }
  }
  if (!committed) {
    removeIfOwned(lockPath, lockIdentity);
  }
  removeIfOwned(tempIndex, tempIdentity);
  if (failure) {
    throw failure;
  }
  return result;
}

/**
 * Whether an error represents a changed repository rather than an inspection
 * or tool-application failure.
 * @param {unknown} error - Caught value.
 * @returns {boolean} True for safe concurrency refusal.
 */
export function isFixStateChangedError(error) {
  return error?.code === "ERR_FIX_STATE_CHANGED";
}
