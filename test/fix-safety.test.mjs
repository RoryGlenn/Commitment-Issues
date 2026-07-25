// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyFixOutputs,
  assertFixSnapshotUnchanged,
  captureFixSnapshot,
  eslintDiagnostics,
  eslintFixedOutput,
  isFixStateChangedError,
  parseIndexStageEntries,
  runFixTools,
  stageFixOutputs,
} from "../scripts/lib/fix-safety.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  run as runCommand,
  writeFile,
} from "./helpers/temp-repo.mjs";

function inRepo(tempDir, action) {
  const previous = process.cwd();
  process.chdir(tempDir);
  try {
    return action();
  } finally {
    process.chdir(previous);
  }
}

function createStagedTarget(t, options = {}) {
  const {
    commit = true,
    content = '{"alpha":1}\n',
    file = "src/input.json",
  } = options;
  const tempDir = createTempRepo({ commit });
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, ...file.split("/")), content);
  runCommand("git", ["add", "--", file], tempDir);
  return { tempDir, file };
}

function captureStagedTarget(tempDir, file, options) {
  return inRepo(tempDir, () => captureFixSnapshot([file], options));
}

function canonicalTarget(tempDir, file) {
  return inRepo(tempDir, () => path.resolve(...file.split("/")));
}

function fixedOutputs(snapshot, content = '{ "alpha": 1 }\n') {
  return new Map([[snapshot.targets[0].file, content]]);
}

function alternateHead(tempDir) {
  const head = runCommand("git", ["rev-parse", "HEAD"], tempDir);
  const tree = runCommand("git", ["write-tree"], tempDir);
  const commit = runCommand(
    "git",
    ["commit-tree", tree.stdout.trim(), "-p", head.stdout.trim(), "-m", "race"],
    tempDir,
  );
  assert.equal(head.status, 0);
  assert.equal(tree.status, 0);
  assert.equal(commit.status, 0);
  return commit.stdout.trim();
}

function runCaptureProbe(tempDir, env, options = {}) {
  const moduleUrl = pathToFileURL(
    path.join(tempDir, "scripts", "lib", "fix-safety.mjs"),
  ).href;
  const source = `
import { captureFixSnapshot } from ${JSON.stringify(moduleUrl)};
try {
  captureFixSnapshot(["src/input.json"], ${JSON.stringify(options)});
  process.stdout.write("OK");
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}
`;
  return runCommand(
    process.execPath,
    ["--input-type=module", "-e", source],
    tempDir,
    { env },
  );
}

test("parseIndexStageEntries preserves exact Git paths and hash formats", () => {
  const first = "src/ leading\t\u732b\nfile.js";
  const second = "src/sha256.json";
  const output =
    `100755 ${"a".repeat(40)} 0\t${first}\0` +
    `100644 ${"b".repeat(64)} 0\t${second}\0`;

  assert.deepEqual(parseIndexStageEntries(output), [
    {
      mode: "100755",
      oid: "a".repeat(40),
      stage: 0,
      file: first,
    },
    {
      mode: "100644",
      oid: "b".repeat(64),
      stage: 0,
      file: second,
    },
  ]);
  assert.deepEqual(parseIndexStageEntries(""), []);
});

test("parseIndexStageEntries rejects incomplete and malformed records", () => {
  for (const output of [
    `100644 ${"a".repeat(40)} 0\tsrc/a.js`,
    `100644 ${"a".repeat(39)} 0\tsrc/a.js\0`,
    `100644 ${"a".repeat(40)} 4\tsrc/a.js\0`,
    `100644 ${"a".repeat(40)} 0\t\0`,
    `100644 ${"a".repeat(40)} 0 src/a.js\0`,
  ]) {
    assert.throws(
      () => parseIndexStageEntries(output),
      (error) => error.code === "ERR_FIX_STATE_INSPECTION",
    );
  }
});

test("eslintFixedOutput accepts only the expected single-file report", () => {
  const file = path.resolve("src/input.js");
  const input = "let value=1\n";
  const fixed = "let value = 1;\n";

  assert.equal(
    eslintFixedOutput(
      JSON.stringify([{ filePath: file, output: fixed, messages: [] }]),
      file,
      input,
    ),
    fixed,
  );
  assert.equal(
    eslintFixedOutput(
      JSON.stringify([{ filePath: file, messages: [] }]),
      file,
      input,
    ),
    input,
  );

  for (const output of [
    "not json",
    "[]",
    JSON.stringify([null]),
    JSON.stringify([{ filePath: path.resolve("src/other.js") }]),
  ]) {
    assert.throws(
      () => eslintFixedOutput(output, file, input),
      (error) => error.code === "ERR_FIX_APPLY",
    );
  }
});

test("eslintDiagnostics keeps only usable messages and optional metadata", () => {
  assert.deepEqual(
    eslintDiagnostics(
      JSON.stringify([
        {
          messages: [
            null,
            {},
            { message: "plain problem" },
            {
              message: "located problem",
              line: 2,
              column: 7,
              ruleId: "example-rule",
            },
          ],
        },
      ]),
      "src/input.js",
    ),
    [
      "src/input.js: plain problem\n",
      "src/input.js:2:7: located problem (example-rule)\n",
    ],
  );
  assert.deepEqual(
    eslintDiagnostics(JSON.stringify([{ messages: null }]), "src/input.js"),
    [],
  );
});

test("captureFixSnapshot supports an unborn HEAD only when requested", (t) => {
  const { tempDir, file } = createStagedTarget(t, { commit: false });

  const snapshot = captureStagedTarget(tempDir, file, {
    allowUnbornHead: true,
  });
  assert.equal(snapshot.head, null);
  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) => error.code === "ERR_FIX_STATE_INSPECTION",
  );
});

test("captureFixSnapshot rejects empty Git identity output", (t) => {
  const { tempDir } = createStagedTarget(t);
  const emptyHead = runCaptureProbe(
    tempDir,
    fakeGitEnv(tempDir, "rev-parse --verify --quiet HEAD", 0, "\n"),
  );
  assert.deepEqual(JSON.parse(emptyHead.stdout), {
    code: "ERR_FIX_STATE_INSPECTION",
    message: "Unable to inspect HEAD.",
  });

  const emptyIndex = runCaptureProbe(
    tempDir,
    fakeGitEnv(tempDir, "rev-parse --git-path index", 0, "\n"),
  );
  assert.deepEqual(JSON.parse(emptyIndex.stdout), {
    code: "ERR_FIX_STATE_INSPECTION",
    message: "Git returned an empty index path.",
  });
});

test("captureFixSnapshot rejects invalid targets and unreadable blobs", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  assert.throws(
    () => captureStagedTarget(tempDir, "src/not-staged.json"),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );

  fs.rmSync(path.join(tempDir, file));
  fs.mkdirSync(path.join(tempDir, file));
  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
  fs.rmSync(path.join(tempDir, file), { recursive: true });
  writeFile(path.join(tempDir, file), '{"worktree":"different"}\n');
  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );

  const fakeEntry = `100644 ${"f".repeat(40)} 0\t${file}\0`;
  const unreadable = runCaptureProbe(
    tempDir,
    fakeGitEnv(tempDir, "ls-files --stage -z --", 0, fakeEntry),
  );
  assert.match(
    JSON.parse(unreadable.stdout).message,
    /Unable to read indexed blob/,
  );
});

for (const [code, expectedCode] of [
  ["ELOOP", "ERR_FIX_STATE_CHANGED"],
  ["EACCES", "ERR_FIX_STATE_INSPECTION"],
]) {
  test(`captureFixSnapshot classifies a target read ${code}`, (t) => {
    const { tempDir, file } = createStagedTarget(t);
    const target = canonicalTarget(tempDir, file);
    const originalOpen = fs.openSync;
    t.mock.method(fs, "openSync", (filePath, ...args) => {
      if (path.resolve(String(filePath)) === target) {
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return originalOpen(filePath, ...args);
    });

    assert.throws(
      () => captureStagedTarget(tempDir, file),
      (error) => error.code === expectedCode,
    );
  });
}

test("captureFixSnapshot rejects a non-regular Git index", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const indexPath = inRepo(tempDir, () => path.resolve(".git", "index"));
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    const stats = originalLstat(filePath, ...args);
    if (path.resolve(String(filePath)) === indexPath) {
      return {
        ...stats,
        isFile: () => false,
        isSymbolicLink: () => false,
      };
    }
    return stats;
  });

  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) => error.code === "ERR_FIX_STATE_INSPECTION",
  );
});

for (const [code, expectedCode] of [
  ["ELOOP", "ERR_FIX_STATE_CHANGED"],
  ["EACCES", "ERR_FIX_STATE_INSPECTION"],
]) {
  test(`captureFixSnapshot classifies an index read ${code}`, (t) => {
    const { tempDir, file } = createStagedTarget(t);
    const indexPath = inRepo(tempDir, () => path.resolve(".git", "index"));
    const originalOpen = fs.openSync;
    t.mock.method(fs, "openSync", (filePath, ...args) => {
      if (path.resolve(String(filePath)) === indexPath) {
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return originalOpen(filePath, ...args);
    });

    assert.throws(
      () => captureStagedTarget(tempDir, file),
      (error) => error.code === expectedCode,
    );
  });
}

test("snapshot revalidation distinguishes index identity and target bytes", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);

  assert.throws(
    () =>
      inRepo(tempDir, () =>
        assertFixSnapshotUnchanged({
          ...snapshot,
          indexPath: `${snapshot.indexPath}.other`,
        }),
      ),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );

  const alteredExpectation = {
    ...snapshot,
    targets: snapshot.targets.map((target) => ({
      ...target,
      expectedContent: Buffer.from("different\n"),
    })),
  };
  assert.throws(
    () => inRepo(tempDir, () => assertFixSnapshotUnchanged(alteredExpectation)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("snapshot revalidation detects index metadata changes with the same tree", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);

  const update = runCommand(
    "git",
    ["update-index", "--assume-unchanged", "--", file],
    tempDir,
  );
  assert.equal(update.status, 0);
  assert.equal(
    runCommand("git", ["write-tree"], tempDir).stdout.trim(),
    snapshot.indexTree,
  );
  assert.throws(
    () => inRepo(tempDir, () => assertFixSnapshotUnchanged(snapshot)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("snapshot revalidation does not run a mutating live write-tree probe", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const env = fakeGitEnv(tempDir, "write-tree");
  const keys = [
    "PATH",
    "FAKE_GIT_MATCH",
    "FAKE_GIT_EXIT",
    "FAKE_GIT_STDOUT_BASE64",
    "FAKE_GIT_STDERR_BASE64",
    "FAKE_GIT_REAL",
  ];
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  for (const key of keys) {
    process.env[key] = env[key];
  }

  assert.doesNotThrow(() =>
    inRepo(tempDir, () => assertFixSnapshotUnchanged(snapshot)),
  );
});

test("snapshot revalidation compares the exact index bytes", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  let indexDescriptor;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === snapshot.indexPath) {
      indexDescriptor = descriptor;
    }
    return descriptor;
  });
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    const content = originalRead(filePath, ...args);
    return filePath === indexDescriptor
      ? Buffer.concat([content, Buffer.from("changed")])
      : content;
  });

  assert.throws(
    () => inRepo(tempDir, () => assertFixSnapshotUnchanged(snapshot)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("snapshot revalidation classifies an ordinary target read failure", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const target = canonicalTarget(tempDir, file);
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    if (path.resolve(String(filePath)) === target) {
      throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    }
    return originalOpen(filePath, ...args);
  });

  assert.throws(
    () => inRepo(tempDir, () => assertFixSnapshotUnchanged(snapshot)),
    (error) => error.code === "ERR_FIX_STATE_INSPECTION",
  );
});

test("runFixTools rejects an uncaptured Prettier target", async () => {
  await assert.rejects(
    runFixTools([], {
      eslintFiles: [],
      prettierFiles: ["src/not-captured.json"],
    }),
    (error) => error.code === "ERR_FIX_APPLY",
  );
});

test("applyFixOutputs requires attributable output for every target", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);

  assert.throws(
    () => inRepo(tempDir, () => applyFixOutputs(snapshot, new Map())),
    (error) => error.code === "ERR_FIX_APPLY",
  );
});

for (const [code, expectedCode] of [
  ["ESTALE", "ERR_FIX_STATE_CHANGED"],
  ["EACCES", "ERR_FIX_APPLY"],
]) {
  test(`applyFixOutputs classifies a destination write ${code}`, (t) => {
    const { tempDir, file } = createStagedTarget(t);
    const snapshot = captureStagedTarget(tempDir, file);
    const target = canonicalTarget(tempDir, file);
    const originalRename = fs.renameSync;
    t.mock.method(fs, "renameSync", (source, destination) => {
      if (path.resolve(String(destination)) === target) {
        throw Object.assign(new Error(`injected ${code}`), { code });
      }
      return originalRename(source, destination);
    });

    assert.throws(
      () =>
        inRepo(tempDir, () =>
          applyFixOutputs(snapshot, fixedOutputs(snapshot)),
        ),
      (error) => error.code === expectedCode,
    );
  });
}

test("applyFixOutputs rejects a destination replaced during commit", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const target = canonicalTarget(tempDir, file);
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    const result = originalRename(source, destination);
    if (path.resolve(String(destination)) === target) {
      fs.rmSync(target);
      fs.mkdirSync(target);
    }
    return result;
  });

  assert.throws(
    () =>
      inRepo(tempDir, () => applyFixOutputs(snapshot, fixedOutputs(snapshot))),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("applyFixOutputs verifies the exact bytes read after writing", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const target = canonicalTarget(tempDir, file);
  const originalRead = fs.readFileSync;
  const originalRename = fs.renameSync;
  let committed = false;
  t.mock.method(fs, "renameSync", (source, destination) => {
    const result = originalRename(source, destination);
    if (path.resolve(String(destination)) === target) {
      committed = true;
    }
    return result;
  });
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    if (committed && typeof filePath === "number") {
      return Buffer.from("injected different bytes\n");
    }
    return originalRead(filePath, ...args);
  });

  assert.throws(
    () =>
      inRepo(tempDir, () => applyFixOutputs(snapshot, fixedOutputs(snapshot))),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs preserves an unchanged snapshot", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const result = inRepo(tempDir, () => stageFixOutputs(snapshot));

  assert.equal(result.snapshot, snapshot);
  assert.deepEqual(result.changedFiles, []);
});

test("stageFixOutputs stages exact outputs and removes its temporary index", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const result = inRepo(tempDir, () => stageFixOutputs(applied));

  assert.deepEqual(result.changedFiles, [file]);
  assert.equal(
    runCommand("git", ["show", `:${file}`], tempDir).stdout,
    '{ "alpha": 1 }\n',
  );
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(snapshot.indexPath))
      .filter((entry) => entry.startsWith("index.commitment-issues-")),
    [],
  );
});

test("stageFixOutputs refuses an existing cooperative index lock", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    if (path.resolve(String(filePath)) === lockPath) {
      const otherDescriptor = originalOpen(
        lockPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      );
      fs.closeSync(otherDescriptor);
    }
    return originalOpen(filePath, ...args);
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs rechecks raw index bytes while holding the lock", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === lockPath) {
      fs.appendFileSync(snapshot.indexPath, "changed");
    }
    return descriptor;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs rechecks index identity while holding the lock", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const replacement = `${snapshot.indexPath}.replacement`;
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === lockPath) {
      fs.copyFileSync(snapshot.indexPath, replacement);
      fs.renameSync(replacement, snapshot.indexPath);
    }
    return descriptor;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs wraps an ordinary filesystem failure", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const originalCopy = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", (source, destination, ...args) => {
    if (String(destination).includes("index.commitment-issues-")) {
      throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    }
    return originalCopy(source, destination, ...args);
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_APPLY",
  );
});

test("stageFixOutputs classifies a stale temporary-index write", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const originalCopy = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", (source, destination, ...args) => {
    if (String(destination).includes("index.commitment-issues-")) {
      throw Object.assign(new Error("injected ESTALE"), { code: "ESTALE" });
    }
    return originalCopy(source, destination, ...args);
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs rechecks HEAD immediately after locking", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const nextHead = alternateHead(tempDir);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === lockPath) {
      const updated = runCommand(
        "git",
        ["update-ref", "HEAD", nextHead],
        tempDir,
      );
      assert.equal(updated.status, 0);
    }
    return descriptor;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs rechecks HEAD after syncing the lock", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const nextHead = alternateHead(tempDir);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let lockDescriptor;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === lockPath) {
      lockDescriptor = descriptor;
    }
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    const result = originalClose(descriptor);
    if (descriptor === lockDescriptor) {
      lockDescriptor = undefined;
      const updated = runCommand(
        "git",
        ["update-ref", "HEAD", nextHead],
        tempDir,
      );
      assert.equal(updated.status, 0);
    }
    return result;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs rechecks target bytes after syncing the lock", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const target = canonicalTarget(tempDir, file);
  const concurrent = Buffer.from('{"user":"late"}\n');
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let lockDescriptor;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === lockPath) {
      lockDescriptor = descriptor;
    }
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    const result = originalClose(descriptor);
    if (descriptor === lockDescriptor) {
      lockDescriptor = undefined;
      fs.writeFileSync(target, concurrent);
    }
    return result;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
  assert.deepEqual(fs.readFileSync(target), concurrent);
  assert.equal(
    runCommand("git", ["show", `:${file}`], tempDir).stdout,
    '{"alpha":1}\n',
  );
});

test("stageFixOutputs detects a target edit at the index commit boundary", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const target = canonicalTarget(tempDir, file);
  const concurrent = Buffer.from('{"user":"at-commit"}\n');
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    const result = originalRename(source, destination);
    if (
      path.resolve(String(source)) === lockPath &&
      path.resolve(String(destination)) === snapshot.indexPath
    ) {
      fs.writeFileSync(target, concurrent);
    }
    return result;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
  assert.deepEqual(fs.readFileSync(target), concurrent);
  assert.equal(
    runCommand("git", ["show", `:${file}`], tempDir).stdout,
    '{ "alpha": 1 }\n',
  );
});

test("stageFixOutputs detects HEAD movement at the index commit boundary", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const nextHead = alternateHead(tempDir);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    const result = originalRename(source, destination);
    if (
      path.resolve(String(source)) === lockPath &&
      path.resolve(String(destination)) === snapshot.indexPath
    ) {
      const updated = runCommand(
        "git",
        ["update-ref", "HEAD", nextHead],
        tempDir,
      );
      assert.equal(updated.status, 0);
    }
    return result;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs verifies the installed index identity and bytes", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const originalIndex = fs.readFileSync(snapshot.indexPath);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, destination) => {
    const result = originalRename(source, destination);
    if (
      path.resolve(String(source)) === lockPath &&
      path.resolve(String(destination)) === snapshot.indexPath
    ) {
      fs.writeFileSync(snapshot.indexPath, originalIndex);
    }
    return result;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
});

test("stageFixOutputs preserves the primary error when cleanup inspection fails", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const originalOpen = fs.openSync;
  const originalLstat = fs.lstatSync;
  let primaryFailed = false;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    if (
      path.resolve(String(filePath)) === snapshot.indexPath &&
      fs.existsSync(`${snapshot.indexPath}.lock`)
    ) {
      primaryFailed = true;
      throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    }
    return originalOpen(filePath, ...args);
  });
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (
      primaryFailed &&
      (String(filePath).endsWith(".lock") ||
        String(filePath).includes("index.commitment-issues-"))
    ) {
      throw Object.assign(new Error("injected cleanup EACCES"), {
        code: "EACCES",
      });
    }
    return originalLstat(filePath, ...args);
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_STATE_INSPECTION",
  );
});

test("stageFixOutputs preserves the primary error when lock close fails", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const lockPath = `${snapshot.indexPath}.lock`;
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let lockDescriptor;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === lockPath) {
      lockDescriptor = descriptor;
    }
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    const result = originalClose(descriptor);
    if (descriptor === lockDescriptor) {
      lockDescriptor = undefined;
      throw Object.assign(new Error("injected close EIO"), { code: "EIO" });
    }
    return result;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_APPLY",
  );
});

test("stageFixOutputs leaves a replacement cleanup artifact untouched", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const snapshot = captureStagedTarget(tempDir, file);
  const applied = inRepo(tempDir, () =>
    applyFixOutputs(snapshot, fixedOutputs(snapshot)),
  );
  const originalCopy = fs.copyFileSync;
  const originalLstat = fs.lstatSync;
  t.mock.method(fs, "copyFileSync", (source, destination, ...args) => {
    originalCopy(source, destination, ...args);
    throw Object.assign(new Error("injected EIO"), { code: "EIO" });
  });
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    const stats = originalLstat(filePath, ...args);
    if (String(filePath).includes("index.commitment-issues-")) {
      return { ...stats, ino: stats.ino + 1n };
    }
    return stats;
  });

  assert.throws(
    () => inRepo(tempDir, () => stageFixOutputs(applied)),
    (error) => error.code === "ERR_FIX_APPLY",
  );
});

test("isFixStateChangedError distinguishes safe concurrency refusals", () => {
  assert.equal(isFixStateChangedError({ code: "ERR_FIX_STATE_CHANGED" }), true);
  assert.equal(
    isFixStateChangedError({ code: "ERR_FIX_STATE_INSPECTION" }),
    false,
  );
  assert.equal(isFixStateChangedError(null), false);
});
