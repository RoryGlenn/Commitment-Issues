// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  inspectMutableProjectFile,
  parseNulPaths,
  readMutableProjectFile,
} from "./files.mjs";
import { run, withoutGitLocalEnvironment } from "./process.mjs";

const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
const MAX_GIT_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_MATERIALIZED_BLOB_BYTES = 128 * 1024 * 1024;
const TARGET_BLOB_BATCH_BYTES = 8 * 1024 * 1024;
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

function stagedTreeError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "ERR_STAGED_TREE";
  return error;
}

function requireSuccessful(result, message) {
  if (result.error || result.status !== 0) {
    throw stagedTreeError(message, result.error);
  }
  return result.stdout;
}

function oneLine(result, message) {
  const value = String(requireSuccessful(result, message)).replace(
    /\r?\n$/u,
    "",
  );
  if (!value || value.includes("\0") || value.includes("\n")) {
    throw stagedTreeError(message);
  }
  return value;
}

function gitEnvironment(overrides = {}) {
  return {
    ...withoutGitLocalEnvironment(),
    GIT_OPTIONAL_LOCKS: "0",
    ...overrides,
  };
}

function activeIndexEnvironment() {
  const environment = gitEnvironment();
  // `git commit --all` prepares the future commit in a temporary index and
  // routes hooks to it through GIT_INDEX_FILE. Preserve only that Git-local
  // variable while locating the active index; every other repository probe
  // continues to rediscover this worktree from its explicit cwd.
  if (process.env.GIT_INDEX_FILE !== undefined) {
    environment.GIT_INDEX_FILE = process.env.GIT_INDEX_FILE;
  }
  return environment;
}

function resolveGitPath(projectRoot, name) {
  const value = oneLine(
    run("git", ["rev-parse", "--path-format=absolute", "--git-path", name], {
      cwd: projectRoot,
      env: name === "index" ? activeIndexEnvironment() : gitEnvironment(),
    }),
    `Unable to locate Git ${name}.`,
  );
  return path.resolve(value);
}

function captureIndex(projectRoot) {
  const indexPath = resolveGitPath(projectRoot, "index");
  const indexState = inspectMutableProjectFile(indexPath);
  if (indexState.status === "missing") {
    return {
      indexContent: null,
      indexPath,
      indexState,
    };
  }
  if (indexState.status !== "regular") {
    throw stagedTreeError("The active Git index is not a regular file.");
  }
  return {
    indexContent: readMutableProjectFile(indexState),
    indexPath,
    indexState,
  };
}

function currentHead(projectRoot) {
  const result = run("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: projectRoot,
    env: gitEnvironment(),
  });
  if (!result.error && result.status === 1) {
    return null;
  }
  return oneLine(result, "Unable to inspect HEAD.");
}

function currentBranchRef(projectRoot) {
  const result = run("git", ["symbolic-ref", "--quiet", "HEAD"], {
    cwd: projectRoot,
    env: gitEnvironment(),
  });
  if (!result.error && result.status === 1) {
    return null;
  }
  return oneLine(result, "Unable to inspect the current branch.");
}

function emptyTree(projectRoot) {
  return oneLine(
    run("git", ["hash-object", "-t", "tree", "--stdin"], {
      cwd: projectRoot,
      env: gitEnvironment(),
      input: "",
    }),
    "Unable to identify Git's empty tree.",
  );
}

function treeDiff(projectRoot, baseTree, stagedTree, args) {
  return requireSuccessful(
    run(
      "git",
      [
        ...GIT_PATH_ARGS,
        "diff-tree",
        "--no-commit-id",
        "--no-renames",
        "-r",
        ...args,
        baseTree,
        stagedTree,
      ],
      {
        cwd: projectRoot,
        env: gitEnvironment(),
        maxBuffer: MAX_GIT_METADATA_BYTES,
      },
    ),
    "Unable to compare the staged tree with HEAD.",
  );
}

/**
 * Read the exact zero-context patch between HEAD and a captured staged tree.
 * Keeping this separate lets secret/debug policy classify a patch failure
 * without discarding the otherwise valid immutable tree.
 * @param {ReturnType<typeof captureStagedTree>} snapshot - Captured tree.
 * @returns {string} Git patch with canonical a/ and b/ prefixes.
 */
export function stagedTreePatch(snapshot) {
  return treeDiff(snapshot.projectRoot, snapshot.baseTree, snapshot.tree, [
    "-U0",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]);
}

function changedPaths(projectRoot, baseTree, stagedTree, diffFilter) {
  const output = treeDiff(projectRoot, baseTree, stagedTree, [
    "--name-only",
    "-z",
    `--diff-filter=${diffFilter}`,
  ]);
  const files = parseNulPaths(output);
  if (files === null) {
    throw stagedTreeError("Git returned malformed staged pathnames.");
  }
  return files;
}

/**
 * Parse the exact recursive entries emitted by `git ls-tree -r -z`.
 * @param {string} output - NUL-delimited tree listing.
 * @returns {Array<{mode: string, type: string, object: string, file: string}>} Entries.
 */
export function parseTreeEntries(output) {
  const records = parseNulPaths(output);
  if (records === null) {
    throw stagedTreeError("Git returned malformed staged-tree entries.");
  }
  return records.map((record) => {
    const separator = record.indexOf("\t");
    const metadata = separator < 0 ? "" : record.slice(0, separator);
    const file = separator < 0 ? "" : record.slice(separator + 1);
    const match =
      /^([0-7]{6}) (blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(metadata);
    if (!match || file.length === 0) {
      throw stagedTreeError("Git returned malformed staged-tree entries.");
    }
    return {
      mode: match[1],
      type: match[2],
      object: match[3],
      file,
    };
  });
}

function stagedTreeEntries(projectRoot, tree) {
  return parseTreeEntries(
    requireSuccessful(
      run(
        "git",
        [...GIT_PATH_ARGS, "ls-tree", "-r", "-z", "--full-tree", tree],
        {
          cwd: projectRoot,
          env: gitEnvironment(),
          maxBuffer: MAX_GIT_METADATA_BYTES,
        },
      ),
      "Unable to list the staged tree.",
    ),
  );
}

function assertCapturedState(snapshot) {
  if (currentHead(snapshot.projectRoot) !== snapshot.head) {
    throw stagedTreeError("HEAD changed during staged-tree inspection.");
  }
  if (resolveGitPath(snapshot.projectRoot, "index") !== snapshot.indexPath) {
    throw stagedTreeError("The active Git index changed during inspection.");
  }
  if (snapshot.indexState.status === "missing") {
    if (inspectMutableProjectFile(snapshot.indexPath).status !== "missing") {
      throw stagedTreeError("The active Git index changed during inspection.");
    }
    return;
  }
  let currentIndex;
  try {
    currentIndex = readMutableProjectFile(snapshot.indexState);
  } catch (error) {
    throw stagedTreeError(
      "The active Git index changed during inspection.",
      error,
    );
  }
  if (!currentIndex.equals(snapshot.indexContent)) {
    throw stagedTreeError(
      "The active Git index bytes changed during inspection.",
    );
  }
}

function filesystemIdentity(file) {
  const resolved = fs.realpathSync.native(file);
  return `${path.parse(resolved).root.toLowerCase()}:${fs.statSync(resolved).dev}`;
}

export function temporaryRootParent(
  projectRoot,
  {
    temporaryDirectories = [process.env.RUNNER_TEMP, os.tmpdir()].filter(
      Boolean,
    ),
  } = {},
) {
  const dependencies = path.join(projectRoot, "node_modules");
  if (
    !fs.existsSync(dependencies) ||
    !fs.statSync(dependencies).isDirectory()
  ) {
    return os.tmpdir();
  }
  const resolvedDependencies = fs.realpathSync.native(dependencies);
  const dependencyFilesystem = filesystemIdentity(resolvedDependencies);
  const compatibleTemporaryDirectory = temporaryDirectories.find(
    (candidate) =>
      fs.existsSync(candidate) &&
      filesystemIdentity(candidate) === dependencyFilesystem,
  );
  if (compatibleTemporaryDirectory) {
    return fs.realpathSync.native(compatibleTemporaryDirectory);
  }
  // Windows hosted runners can place os.tmpdir() and the checkout on different
  // volumes, where a dependency junction is not traversable. Git metadata is
  // the final same-filesystem fallback and keeps the disposable tree out of the
  // worktree whenever this is an ordinary clone.
  const dependencyParent = path.dirname(resolvedDependencies);
  const metadata = path.join(dependencyParent, ".git");
  return fs.existsSync(metadata) && fs.statSync(metadata).isDirectory()
    ? metadata
    : dependencyParent;
}

/**
 * Capture one immutable tree from an exact copy of the active index. No Git
 * command receives the live index, so inspection cannot rewrite user state.
 * @param {{cwd?: string}} [options] - Repository root override for tests.
 * @returns {object} Captured tree metadata and cleanup handle.
 */
export function captureStagedTree({ cwd = process.cwd() } = {}) {
  const projectRoot = path.resolve(cwd);
  const temporaryRoot = fs.mkdtempSync(
    path.join(
      temporaryRootParent(projectRoot),
      ".commitment-issues-staged-tree-",
    ),
  );
  try {
    const index = captureIndex(projectRoot);
    const temporaryIndex = path.join(temporaryRoot, "index");
    if (index.indexContent) {
      fs.writeFileSync(temporaryIndex, index.indexContent, {
        flag: "wx",
        mode: 0o600,
      });
    }
    const head = currentHead(projectRoot);
    const branchRef = currentBranchRef(projectRoot);
    const tree = oneLine(
      run("git", ["write-tree"], {
        cwd: projectRoot,
        env: gitEnvironment({ GIT_INDEX_FILE: temporaryIndex }),
      }),
      "Unable to create an immutable tree from the Git index.",
    );
    const baseTree = head
      ? oneLine(
          run("git", ["rev-parse", `${head}^{tree}`], {
            cwd: projectRoot,
            env: gitEnvironment(),
          }),
          "Unable to inspect the HEAD tree.",
        )
      : emptyTree(projectRoot);
    const files = changedPaths(projectRoot, baseTree, tree, "ACMRT");
    const deletedFiles = changedPaths(projectRoot, baseTree, tree, "D");
    const allChangedFiles = changedPaths(projectRoot, baseTree, tree, "ACDMRT");
    let numstat = null;
    try {
      numstat = treeDiff(projectRoot, baseTree, tree, ["--numstat", "-z"]);
    } catch {
      // Commit-shape advice is optional. Keep the immutable tree and the
      // remaining exact checks available when only numstat inspection fails.
    }
    const entries = stagedTreeEntries(projectRoot, tree);
    const snapshot = {
      ...index,
      allChangedFiles,
      baseTree,
      branchRef,
      deletedFiles,
      entries,
      files,
      head,
      numstat,
      projectRoot,
      root: null,
      temporaryRoot,
      tree,
      cleanup() {
        fs.rmSync(temporaryRoot, { force: true, recursive: true });
      },
    };
    assertCapturedState(snapshot);
    return snapshot;
  } catch (error) {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
    throw error?.code === "ERR_STAGED_TREE"
      ? error
      : stagedTreeError("Unable to capture the staged tree.", error);
  }
}

function safeTreePath(root, file) {
  const parts = file.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw stagedTreeError(`Unsafe staged-tree path: ${file}`);
  }
  for (const pathApi of [path.posix, path.win32]) {
    const target = pathApi.resolve(root, ...parts);
    const relative = pathApi.relative(root, target);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${pathApi.sep}`)
    ) {
      throw stagedTreeError(`Unsafe staged-tree path: ${file}`);
    }
  }
  return path.resolve(root, ...parts);
}

function blobSizes(projectRoot, objects) {
  if (objects.length === 0) {
    return new Map();
  }
  const output = requireSuccessful(
    run("git", ["cat-file", "--batch-check"], {
      cwd: projectRoot,
      env: gitEnvironment(),
      input: `${objects.join("\n")}\n`,
      maxBuffer: MAX_GIT_METADATA_BYTES,
    }),
    "Unable to inspect staged blob sizes.",
  );
  const lines = output.endsWith("\n") ? output.slice(0, -1).split("\n") : [];
  if (lines.length !== objects.length) {
    throw stagedTreeError("Git returned malformed staged blob sizes.");
  }
  const sizes = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u.exec(
      lines[index],
    );
    const size = match ? Number(match[2]) : Number.NaN;
    if (
      !match ||
      match[1] !== objects[index] ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_MATERIALIZED_BLOB_BYTES
    ) {
      throw stagedTreeError("Git returned an unsupported staged blob size.");
    }
    sizes.set(match[1], size);
  }
  return sizes;
}

function blobBatches(objects, sizes) {
  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const object of objects) {
    const size = sizes.get(object);
    if (batch.length > 0 && batchBytes + size > TARGET_BLOB_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(object);
    batchBytes += size;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

/**
 * Parse `git cat-file --batch` bytes for an exact ordered object list.
 * @param {Buffer} output - Raw batch output.
 * @param {string[]} objects - Requested object ids.
 * @param {Map<string, number>} sizes - Verified blob sizes.
 * @returns {Map<string, Buffer>} Exact blob contents by object id.
 */
export function parseBlobBatch(output, objects, sizes) {
  const contents = new Map();
  let offset = 0;
  for (const object of objects) {
    const newline = output.indexOf(0x0a, offset);
    const size = sizes.get(object);
    if (newline < 0 || !Number.isSafeInteger(size)) {
      throw stagedTreeError("Git returned malformed staged blob contents.");
    }
    const header = output.subarray(offset, newline).toString("ascii");
    if (header !== `${object} blob ${size}`) {
      throw stagedTreeError("Git returned malformed staged blob contents.");
    }
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw stagedTreeError("Git returned truncated staged blob contents.");
    }
    contents.set(
      object,
      Buffer.from(output.subarray(contentStart, contentEnd)),
    );
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw stagedTreeError("Git returned unexpected staged blob contents.");
  }
  return contents;
}

function writableEntries(root, entries) {
  const byObject = new Map();
  for (const entry of entries) {
    if (entry.type !== "blob") {
      throw stagedTreeError(
        `Submodule entry cannot be materialized safely: ${entry.file}`,
      );
    }
    if (!REGULAR_FILE_MODES.has(entry.mode) && entry.mode !== "120000") {
      throw stagedTreeError(`Unsupported staged-tree mode: ${entry.mode}`);
    }
    const target = safeTreePath(root, entry.file);
    const objectEntries = byObject.get(entry.object) ?? [];
    objectEntries.push({ entry, target });
    byObject.set(entry.object, objectEntries);
  }
  return byObject;
}

function writeBlobEntry(entry, target, content, materializeSymbolicLinks) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (entry.mode === "120000") {
    if (materializeSymbolicLinks) {
      fs.symlinkSync(content.toString("utf8"), target);
    } else {
      // Git for Windows uses this permission-independent representation when
      // core.symlinks=false: a regular file containing the link target.
      fs.writeFileSync(target, content, { flag: "wx", mode: 0o644 });
    }
  } else {
    fs.writeFileSync(target, content, {
      flag: "wx",
      mode: entry.mode === "100755" ? 0o755 : 0o644,
    });
  }
}

function writeTree(root, projectRoot, entries, materializeSymbolicLinks) {
  const entriesByObject = writableEntries(root, entries);
  const objects = [...entriesByObject.keys()];
  const sizes = blobSizes(projectRoot, objects);
  for (const batch of blobBatches(objects, sizes)) {
    const expectedBytes = batch.reduce(
      (total, object) => total + sizes.get(object),
      0,
    );
    const output = requireSuccessful(
      run("git", ["cat-file", "--batch"], {
        cwd: projectRoot,
        encoding: null,
        env: gitEnvironment(),
        input: Buffer.from(`${batch.join("\n")}\n`),
        maxBuffer: expectedBytes + MAX_GIT_METADATA_BYTES,
      }),
      "Unable to read staged blob contents.",
    );
    const contents = parseBlobBatch(output, batch, sizes);
    for (const object of batch) {
      for (const { entry, target } of entriesByObject.get(object)) {
        writeBlobEntry(
          entry,
          target,
          contents.get(object),
          materializeSymbolicLinks,
        );
      }
    }
  }
}

function initializeSnapshotRepository(snapshot, materializeSymbolicLinks) {
  const objectFormat = oneLine(
    run("git", ["rev-parse", "--show-object-format"], {
      cwd: snapshot.projectRoot,
      env: gitEnvironment(),
    }),
    "Unable to inspect the repository object format.",
  );
  requireSuccessful(
    run("git", ["init", "--quiet", `--object-format=${objectFormat}`], {
      cwd: snapshot.root,
      env: gitEnvironment(),
    }),
    "Unable to initialize the staged-tree repository.",
  );
  const originalObjects = resolveGitPath(snapshot.projectRoot, "objects");
  const alternates = path.join(
    snapshot.root,
    ".git",
    "objects",
    "info",
    "alternates",
  );
  fs.mkdirSync(path.dirname(alternates), { recursive: true });
  fs.writeFileSync(
    alternates,
    `${originalObjects.split(path.sep).join("/")}\n`,
  );
  const snapshotEnv = {
    ...gitEnvironment(),
    GIT_AUTHOR_EMAIL: "snapshot@commitment-issues.local",
    GIT_AUTHOR_NAME: "commitment-issues",
    GIT_COMMITTER_EMAIL: "snapshot@commitment-issues.local",
    GIT_COMMITTER_NAME: "commitment-issues",
  };
  requireSuccessful(
    run("git", ["config", "core.autocrlf", "false"], {
      cwd: snapshot.root,
      env: snapshotEnv,
    }),
    "Unable to configure the staged-tree repository.",
  );
  if (!materializeSymbolicLinks) {
    requireSuccessful(
      run("git", ["config", "core.symlinks", "false"], {
        cwd: snapshot.root,
        env: snapshotEnv,
      }),
      "Unable to configure staged-tree symbolic links.",
    );
  }
  const commitArgs = ["commit-tree", snapshot.tree];
  if (snapshot.head) {
    commitArgs.push("-p", snapshot.head);
  }
  const commit = oneLine(
    run("git", commitArgs, {
      cwd: snapshot.root,
      env: snapshotEnv,
      input: "commitment-issues staged-tree snapshot\n",
    }),
    "Unable to create the staged-tree commit.",
  );
  const branchRef = snapshot.branchRef ?? "refs/heads/staged-tree";
  requireSuccessful(
    run("git", ["symbolic-ref", "HEAD", branchRef], {
      cwd: snapshot.root,
      env: snapshotEnv,
    }),
    "Unable to set the staged-tree branch.",
  );
  requireSuccessful(
    run("git", ["update-ref", branchRef, commit], {
      cwd: snapshot.root,
      env: snapshotEnv,
    }),
    "Unable to set the staged-tree commit.",
  );
  requireSuccessful(
    run("git", ["read-tree", "--reset", snapshot.tree], {
      cwd: snapshot.root,
      env: snapshotEnv,
    }),
    "Unable to populate the staged-tree index.",
  );
}

function linkInstalledDependencies(snapshot) {
  const packageRoots = new Set([""]);
  for (const entry of snapshot.entries) {
    if (path.posix.basename(entry.file) === "package.json") {
      const directory = path.posix.dirname(entry.file);
      packageRoots.add(directory === "." ? "" : directory);
    }
  }
  for (const packageRoot of packageRoots) {
    const source = path.resolve(
      snapshot.projectRoot,
      ...packageRoot.split("/").filter(Boolean),
      "node_modules",
    );
    const target = path.resolve(
      snapshot.root,
      ...packageRoot.split("/").filter(Boolean),
      "node_modules",
    );
    if (
      fs.existsSync(source) &&
      !fs.existsSync(target) &&
      fs.statSync(source).isDirectory()
    ) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // A consumer's node_modules may itself be a link (as in the test
      // harness). Windows junctions must point at the resolved directory;
      // targeting an intermediate file symlink produces a non-directory
      // junction that Node's package resolution cannot traverse.
      fs.symlinkSync(fs.realpathSync.native(source), target, "junction");
    }
  }
}

/**
 * Materialize raw staged blobs without checkout filters or line-ending
 * conversion, then attach an isolated Git repository and installed dependencies.
 * @param {ReturnType<typeof captureStagedTree>} snapshot - Captured tree.
 * @param {{platform?: NodeJS.Platform}} [options] - Platform override for tests.
 * @returns {string} Disposable exact-tree root.
 */
export function materializeStagedTree(
  snapshot,
  { platform = process.platform } = {},
) {
  if (snapshot.root) {
    return snapshot.root;
  }
  const root = path.join(snapshot.temporaryRoot, "tree");
  fs.mkdirSync(root);
  snapshot.root = fs.realpathSync.native(root);
  const materializeSymbolicLinks = platform !== "win32";
  try {
    writeTree(
      root,
      snapshot.projectRoot,
      snapshot.entries,
      materializeSymbolicLinks,
    );
    initializeSnapshotRepository(snapshot, materializeSymbolicLinks);
    linkInstalledDependencies(snapshot);
    assertCapturedState(snapshot);
    return snapshot.root;
  } catch (error) {
    throw error?.code === "ERR_STAGED_TREE"
      ? error
      : stagedTreeError("Unable to materialize the staged tree.", error);
  }
}
