// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureStagedTree,
  materializeStagedTree,
  parseBlobBatch,
  parseTreeEntries,
  stagedTreePatch,
} from "../scripts/lib/staged-tree.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  run,
  writeFile,
} from "./helpers/temp-repo.mjs";

function withProcessEnvironment(environment, callback) {
  const previous = new Map();
  const changed = [];
  for (const [key, value] of Object.entries(environment)) {
    if (process.env[key] === value) continue;
    previous.set(key, process.env[key]);
    changed.push(key);
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const key of changed) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function activeIndexPath(tempDir) {
  return path.resolve(
    tempDir,
    run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "index"],
      tempDir,
    ).stdout.trim(),
  );
}

function captureFile(t, name = "src/snapshot.mjs", content = "export {};\n") {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, name), content);
  run("git", ["add", name], tempDir);
  const snapshot = captureStagedTree({ cwd: tempDir });
  t.after(() => snapshot.cleanup());
  return { snapshot, tempDir };
}

function assertDependencyLink(source, target) {
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.equal(fs.realpathSync.native(target), fs.realpathSync.native(source));
}

test("parses exact staged-tree and blob batch records", () => {
  const object = "a".repeat(40);
  assert.deepEqual(parseTreeEntries(`100644 blob ${object}\todd name.js\0`), [
    {
      file: "odd name.js",
      mode: "100644",
      object,
      type: "blob",
    },
  ]);
  const sizes = new Map([[object, 4]]);
  assert.deepEqual(
    parseBlobBatch(
      Buffer.concat([
        Buffer.from(`${object} blob 4\n`, "ascii"),
        Buffer.from([0x00, 0x0a, 0xff, 0x01, 0x0a]),
      ]),
      [object],
      sizes,
    ).get(object),
    Buffer.from([0x00, 0x0a, 0xff, 0x01]),
  );
});

test("rejects malformed staged-tree and blob batch records", () => {
  const object = "b".repeat(40);
  assert.throws(() => parseTreeEntries("unterminated"), /malformed/);
  assert.throws(() => parseTreeEntries("metadata-only\0"), /malformed/);
  assert.throws(
    () => parseTreeEntries(`100644 blob ${object}\t\0`),
    /malformed/,
  );
  assert.throws(
    () => parseBlobBatch(Buffer.alloc(0), [object], new Map([[object, 1]])),
    /malformed/,
  );
  assert.throws(
    () =>
      parseBlobBatch(
        Buffer.from(`${"c".repeat(40)} blob 1\nx\n`, "ascii"),
        [object],
        new Map([[object, 1]]),
      ),
    /malformed/,
  );
  assert.throws(
    () =>
      parseBlobBatch(
        Buffer.from(`${object} blob 2\nx\n`, "ascii"),
        [object],
        new Map([[object, 2]]),
      ),
    /truncated/,
  );
  assert.throws(
    () =>
      parseBlobBatch(
        Buffer.from(`${object} blob 1\nx\nextra`, "ascii"),
        [object],
        new Map([[object, 1]]),
      ),
    /unexpected/,
  );
});

test("captures and materializes one immutable future commit tree", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const staged = "export let value=1\n";
  const worktree = "export const value = 1;\n";
  writeFile(path.join(tempDir, "src", "snapshot.mjs"), staged);
  run("git", ["add", "src/snapshot.mjs"], tempDir);
  writeFile(path.join(tempDir, "src", "snapshot.mjs"), worktree);

  const snapshot = captureStagedTree({ cwd: tempDir });
  t.after(() => snapshot.cleanup());
  const root = materializeStagedTree(snapshot);

  assert.deepEqual(snapshot.files, ["src/snapshot.mjs"]);
  assert.deepEqual(snapshot.deletedFiles, []);
  assert.match(stagedTreePatch(snapshot), /export let value=1/);
  assert.equal(
    fs.readFileSync(path.join(root, "src", "snapshot.mjs"), "utf8"),
    staged,
  );
  assert.equal(
    run("git", ["show", "HEAD:src/snapshot.mjs"], root).stdout,
    staged,
  );
  assert.equal(run("git", ["status", "--short"], root).stdout, "");
  assert.equal(
    fs.readFileSync(path.join(tempDir, "src", "snapshot.mjs"), "utf8"),
    worktree,
  );
  assertDependencyLink(
    path.join(tempDir, "node_modules"),
    path.join(root, "node_modules"),
  );
  assert.equal(materializeStagedTree(snapshot), root);
});

test("captures and materializes an unborn repository with no index", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "staged-tree-unborn-"));
  t.after(() => fs.rmSync(tempDir, { force: true, recursive: true }));
  run("git", ["init"], tempDir);
  const snapshot = captureStagedTree({ cwd: tempDir });
  t.after(() => snapshot.cleanup());
  const root = materializeStagedTree(snapshot);

  assert.equal(snapshot.head, null);
  assert.deepEqual(snapshot.files, []);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(run("git", ["status", "--short"], root).stdout, "");
});

test("capture rejects malformed Git identities and unsafe index paths", (t) => {
  const malformedDir = createTempRepo();
  t.after(() => cleanupTempRepo(malformedDir));
  const malformedEnv = fakeGitEnv(
    malformedDir,
    "symbolic-ref --quiet HEAD",
    0,
    "\n",
  );
  assert.throws(
    () =>
      withProcessEnvironment(malformedEnv, () =>
        captureStagedTree({ cwd: malformedDir }),
      ),
    /Unable to inspect the current branch/,
  );

  const unsafeDir = createTempRepo();
  t.after(() => cleanupTempRepo(unsafeDir));
  const indexPath = activeIndexPath(unsafeDir);
  fs.rmSync(indexPath);
  fs.mkdirSync(indexPath);
  assert.throws(
    () => captureStagedTree({ cwd: unsafeDir }),
    /index is not a regular file/,
  );
});

test(
  "capture wraps an index read failure",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const indexPath = activeIndexPath(tempDir);
    fs.chmodSync(indexPath, 0o000);
    try {
      assert.throws(
        () => captureStagedTree({ cwd: tempDir }),
        /Unable to capture the staged tree/,
      );
    } finally {
      fs.chmodSync(indexPath, 0o600);
    }
  },
);

test("materialization rejects every captured-state race", async (t) => {
  await t.test("HEAD changes", (t) => {
    const { snapshot, tempDir } = captureFile(t);
    run("git", ["commit", "-m", "advance"], tempDir);
    assert.throws(
      () => materializeStagedTree(snapshot),
      /HEAD changed during staged-tree inspection/,
    );
  });

  await t.test("the index path changes", (t) => {
    const { snapshot, tempDir } = captureFile(t);
    snapshot.indexPath = path.join(tempDir, "other-index");
    assert.throws(
      () => materializeStagedTree(snapshot),
      /active Git index changed/,
    );
  });

  await t.test("a missing index appears", (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "staged-tree-race-"));
    t.after(() => fs.rmSync(tempDir, { force: true, recursive: true }));
    run("git", ["init"], tempDir);
    const snapshot = captureStagedTree({ cwd: tempDir });
    t.after(() => snapshot.cleanup());
    fs.writeFileSync(snapshot.indexPath, "new index");
    assert.throws(
      () => materializeStagedTree(snapshot),
      /active Git index changed/,
    );
  });

  await t.test("the index becomes unreadable", (t) => {
    const { snapshot } = captureFile(t);
    fs.rmSync(snapshot.indexPath);
    fs.mkdirSync(snapshot.indexPath);
    assert.throws(
      () => materializeStagedTree(snapshot),
      /active Git index changed/,
    );
  });

  await t.test("captured index bytes differ", (t) => {
    const { snapshot } = captureFile(t);
    snapshot.indexContent = Buffer.alloc(snapshot.indexContent.length);
    assert.throws(() => materializeStagedTree(snapshot), /index bytes changed/);
  });
});

test(
  "materialization preserves executable files and POSIX symbolic links",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const executable = path.join(tempDir, "bin", "run.sh");
    writeFile(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
    fs.symlinkSync("run.sh", path.join(tempDir, "bin", "current"));
    run("git", ["add", "bin/run.sh", "bin/current"], tempDir);
    const snapshot = captureStagedTree({ cwd: tempDir });
    t.after(() => snapshot.cleanup());
    const root = materializeStagedTree(snapshot);

    assert.equal(
      fs.statSync(path.join(root, "bin", "run.sh")).mode & 0o111,
      0o111,
    );
    assert.equal(fs.readlinkSync(path.join(root, "bin", "current")), "run.sh");
  },
);

test("Windows materialization represents Git symlinks without privileges", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const target = run("git", ["hash-object", "-w", "--stdin"], tempDir, {
    input: "run.sh",
  }).stdout.trim();
  run(
    "git",
    ["update-index", "--add", "--cacheinfo", `120000,${target},bin/current`],
    tempDir,
  );
  const snapshot = captureStagedTree({ cwd: tempDir });
  t.after(() => snapshot.cleanup());
  const root = materializeStagedTree(snapshot, { platform: "win32" });
  const materialized = path.join(root, "bin", "current");

  assert.equal(fs.lstatSync(materialized).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(materialized, "utf8"), "run.sh");
  assert.equal(
    run("git", ["config", "--bool", "core.symlinks"], root).stdout.trim(),
    "false",
  );
  assert.equal(run("git", ["status", "--short"], root).stdout, "");
});

test("materialization streams large blob batches without changing bytes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const first = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const second = Buffer.alloc(5 * 1024 * 1024, 0x62);
  const third = Buffer.alloc(5 * 1024 * 1024, 0x63);
  fs.writeFileSync(path.join(tempDir, "first.bin"), first);
  fs.writeFileSync(path.join(tempDir, "second.bin"), second);
  fs.writeFileSync(path.join(tempDir, "third.bin"), third);
  run("git", ["add", "first.bin", "second.bin", "third.bin"], tempDir);
  const snapshot = captureStagedTree({ cwd: tempDir });
  t.after(() => snapshot.cleanup());
  const root = materializeStagedTree(snapshot);

  assert.deepEqual(fs.readFileSync(path.join(root, "first.bin")), first);
  assert.deepEqual(fs.readFileSync(path.join(root, "second.bin")), second);
  assert.deepEqual(fs.readFileSync(path.join(root, "third.bin")), third);
});

test("materialization rejects malformed and oversized blob metadata", async (t) => {
  await t.test("missing metadata", (t) => {
    const { snapshot, tempDir } = captureFile(t);
    const env = fakeGitEnv(tempDir, "cat-file --batch-check", 0, "");
    assert.throws(
      () => withProcessEnvironment(env, () => materializeStagedTree(snapshot)),
      /malformed staged blob sizes/,
    );
  });

  await t.test("an unsupported size", (t) => {
    const { snapshot, tempDir } = captureFile(t);
    const objects = [
      ...new Set(
        snapshot.entries
          .filter((entry) => entry.type === "blob")
          .map((entry) => entry.object),
      ),
    ];
    const stdout = objects
      .map(
        (object, index) =>
          `${object} blob ${index === 0 ? 128 * 1024 * 1024 + 1 : 1}`,
      )
      .join("\n");
    const env = fakeGitEnv(tempDir, "cat-file --batch-check", 0, `${stdout}\n`);
    assert.throws(
      () => withProcessEnvironment(env, () => materializeStagedTree(snapshot)),
      /unsupported staged blob size/,
    );
  });

  await t.test("an unsupported record", (t) => {
    const { snapshot, tempDir } = captureFile(t);
    const objects = [
      ...new Set(
        snapshot.entries
          .filter((entry) => entry.type === "blob")
          .map((entry) => entry.object),
      ),
    ];
    const stdout = objects
      .map((object, index) => (index === 0 ? "invalid" : `${object} blob 1`))
      .join("\n");
    const env = fakeGitEnv(tempDir, "cat-file --batch-check", 0, `${stdout}\n`);
    assert.throws(
      () => withProcessEnvironment(env, () => materializeStagedTree(snapshot)),
      /unsupported staged blob size/,
    );
  });
});

test("materialization rejects unsafe, submodule, and unsupported entries", async (t) => {
  await t.test("portable parent traversal", (t) => {
    const { snapshot } = captureFile(t);
    snapshot.entries[0].file = "../escape";
    assert.throws(
      () => materializeStagedTree(snapshot),
      /Unsafe staged-tree path/,
    );
  });

  await t.test("Windows parent traversal", (t) => {
    const { snapshot } = captureFile(t);
    snapshot.entries[0].file = "..\\escape";
    assert.throws(
      () => materializeStagedTree(snapshot),
      /Unsafe staged-tree path/,
    );
  });

  await t.test("submodule entries", (t) => {
    const { snapshot } = captureFile(t);
    snapshot.entries = [
      {
        file: "vendor/submodule",
        mode: "160000",
        object: snapshot.head,
        type: "commit",
      },
    ];
    assert.throws(
      () => materializeStagedTree(snapshot),
      /Submodule entry cannot be materialized safely/,
    );
  });

  await t.test("unsupported blob modes", (t) => {
    const { snapshot } = captureFile(t);
    snapshot.entries = [{ ...snapshot.entries[0], mode: "100600" }];
    assert.throws(
      () => materializeStagedTree(snapshot),
      /Unsupported staged-tree mode/,
    );
  });
});

test("materialization wraps unexpected filesystem failures", (t) => {
  const { snapshot } = captureFile(t);
  snapshot.entries = [snapshot.entries[0], { ...snapshot.entries[0] }];
  assert.throws(
    () => materializeStagedTree(snapshot),
    /Unable to materialize the staged tree/,
  );
});

test("dependency links cover root and nested package installations", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(
    path.join(tempDir, "packages", "child", "package.json"),
    '{"name":"child"}\n',
  );
  fs.mkdirSync(path.join(tempDir, "packages", "child", "node_modules"), {
    recursive: true,
  });
  run("git", ["add", "packages/child/package.json"], tempDir);
  const snapshot = captureStagedTree({ cwd: tempDir });
  t.after(() => snapshot.cleanup());
  const root = materializeStagedTree(snapshot);

  assertDependencyLink(
    path.join(tempDir, "node_modules"),
    path.join(root, "node_modules"),
  );
  assertDependencyLink(
    path.join(tempDir, "packages", "child", "node_modules"),
    path.join(root, "packages", "child", "node_modules"),
  );
});

test("dependency linking skips non-directory installations and occupied targets", async (t) => {
  await t.test("non-directory source", (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    run("git", ["rm", "--cached", "node_modules"], tempDir);
    run("git", ["commit", "-m", "untrack dependency fixture"], tempDir);
    fs.unlinkSync(path.join(tempDir, "node_modules"));
    fs.writeFileSync(path.join(tempDir, "node_modules"), "not a directory");
    const snapshot = captureStagedTree({ cwd: tempDir });
    t.after(() => snapshot.cleanup());
    const root = materializeStagedTree(snapshot);
    assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  });

  await t.test("occupied target", (t) => {
    const { snapshot, tempDir } = captureFile(t);
    const root = materializeStagedTree(snapshot);
    assertDependencyLink(
      path.join(tempDir, "node_modules"),
      path.join(root, "node_modules"),
    );
  });
});
