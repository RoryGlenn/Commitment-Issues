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
  inspectGitOperationState,
  isFixStateChangedError,
  parseIndexFlagEntries,
  parseIndexStageEntries,
  parseTargetStatusEntries,
  runFixTools,
  stageFixOutputs,
} from "../scripts/lib/fix-safety.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  fakeGitEnv,
  fsFailurePreload,
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

function gitMarkerPath(tempDir, marker) {
  const result = runCommand(
    "git",
    ["rev-parse", "--git-path", marker],
    tempDir,
  );
  assert.equal(result.status, 0, result.stderr);
  return path.resolve(tempDir, result.stdout.replace(/\r?\n$/u, ""));
}

function runOperationProbe(tempDir, env = process.env) {
  const moduleUrl = pathToFileURL(
    path.join(tempDir, "scripts", "lib", "fix-safety.mjs"),
  ).href;
  const source = `
import { inspectGitOperationState } from ${JSON.stringify(moduleUrl)};
try {
  process.stdout.write(JSON.stringify({ state: inspectGitOperationState() }));
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

test("inspectGitOperationState classifies every amend-blocking marker", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const fixtures = [
    { marker: "rebase-apply/applying", kind: "file", operation: "git am" },
    { marker: "rebase-apply", kind: "directory", operation: "rebase" },
    { marker: "rebase-merge", kind: "directory", operation: "rebase" },
    { marker: "MERGE_HEAD", kind: "file", operation: "merge" },
    { marker: "CHERRY_PICK_HEAD", kind: "file", operation: "cherry-pick" },
    { marker: "REVERT_HEAD", kind: "file", operation: "revert" },
    { marker: "sequencer", kind: "directory", operation: "sequencer" },
  ];

  assert.deepEqual(inRepo(tempDir, inspectGitOperationState), {
    operation: null,
    markers: [],
  });
  for (const fixture of fixtures) {
    const markerPath = gitMarkerPath(tempDir, fixture.marker);
    if (fixture.kind === "directory") {
      fs.mkdirSync(markerPath, { recursive: true });
    } else {
      writeFile(markerPath, "operation state\n");
    }

    const state = inRepo(tempDir, inspectGitOperationState);
    assert.equal(state.operation, fixture.operation, fixture.marker);
    assert.ok(state.markers.includes(fixture.marker), fixture.marker);

    const cleanupMarker = fixture.marker.startsWith("rebase-apply")
      ? gitMarkerPath(tempDir, "rebase-apply")
      : markerPath;
    fs.rmSync(cleanupMarker, { recursive: true, force: true });
  }
});

test("inspectGitOperationState fails closed on Git and path inspection errors", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const match = "rev-parse --git-path rebase-apply/applying";

  const failed = runOperationProbe(tempDir, fakeGitEnv(tempDir, match));
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).code, "ERR_FIX_STATE_INSPECTION");

  const missingGit = runOperationProbe(tempDir, {
    ...process.env,
    PATH: fs.mkdtempSync(path.join(tempDir, "empty-path-")),
  });
  assert.equal(missingGit.status, 0, missingGit.stderr);
  assert.equal(JSON.parse(missingGit.stdout).code, "ERR_FIX_STATE_INSPECTION");

  for (const output of ["\n", "invalid\0path\n"]) {
    const malformed = runOperationProbe(
      tempDir,
      fakeGitEnv(tempDir, match, 0, output),
    );
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).code, "ERR_FIX_STATE_INSPECTION");
  }

  const markerPath = gitMarkerPath(tempDir, "MERGE_HEAD");
  const preload = fsFailurePreload(tempDir);
  const unreadable = runOperationProbe(tempDir, {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`]
      .filter(Boolean)
      .join(" "),
    TEST_FS_FAILURE_METHOD: "lstatSync",
    TEST_FS_FAILURE_PATH: markerPath,
  });
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.equal(JSON.parse(unreadable.stdout).code, "ERR_FIX_STATE_INSPECTION");
});

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

test("parseIndexFlagEntries preserves tags and exact Git paths", () => {
  const first = "src/ leading\t\u732b\nfile.js";
  const second = "src/skipped.json";

  assert.deepEqual(parseIndexFlagEntries(`h ${first}\0S ${second}\0`), [
    { tag: "h", file: first },
    { tag: "S", file: second },
  ]);
  assert.deepEqual(parseIndexFlagEntries(""), []);
});

test("parseIndexFlagEntries rejects incomplete and malformed records", () => {
  for (const output of [
    "H src/a.js",
    "H\tsrc/a.js\0",
    "HH src/a.js\0",
    "H \0",
    " src/a.js\0",
  ]) {
    assert.throws(
      () => parseIndexFlagEntries(output),
      (error) => error.code === "ERR_FIX_STATE_INSPECTION",
    );
  }
});

test("parseTargetStatusEntries preserves modes, object ids, and paths", () => {
  const first = "src/ leading\t\u732b\nfile.js";
  const second = "src/sha256.json";
  const sha1 = "a".repeat(40);
  const sha256 = "b".repeat(64);
  const output =
    `1 .M N... 100644 100644 100755 ${sha1} ${sha1} ${first}\0` +
    `1 A. N... 000000 100644 100644 ${"0".repeat(64)} ${sha256} ${second}\0`;

  assert.deepEqual(parseTargetStatusEntries(output), [
    {
      headMode: "100644",
      indexMode: "100644",
      worktreeMode: "100755",
      headOid: sha1,
      indexOid: sha1,
      file: first,
    },
    {
      headMode: "000000",
      indexMode: "100644",
      worktreeMode: "100644",
      headOid: "0".repeat(64),
      indexOid: sha256,
      file: second,
    },
  ]);
  assert.deepEqual(parseTargetStatusEntries(""), []);
});

test("parseTargetStatusEntries rejects unsupported and malformed records", () => {
  const oid = "a".repeat(40);
  for (const output of [
    `1 .M N... 100644 100644 100644 ${oid} ${oid} src/a.js`,
    `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 src/a.js\0src/b.js\0`,
    `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} src/a.js\0`,
    `1 .M N... 10064 100644 100644 ${oid} ${oid} src/a.js\0`,
    `1 .M N... 100644 100644 100644 ${"a".repeat(39)} ${oid} src/a.js\0`,
    `1 .M N... 100644 100644 100644 ${oid} ${oid} \0`,
  ]) {
    assert.throws(
      () => parseTargetStatusEntries(output),
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

test("captureFixSnapshot preserves an unresolved target conflict", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const objectIds = ["base\n", "ours\n", "theirs\n"].map((content) => {
    const result = runCommand(
      "git",
      ["hash-object", "-w", "--stdin"],
      tempDir,
      {
        input: content,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  });
  const removed = runCommand(
    "git",
    ["update-index", "--force-remove", "--", file],
    tempDir,
  );
  assert.equal(removed.status, 0, removed.stderr);
  const conflicted = runCommand(
    "git",
    ["update-index", "--index-info"],
    tempDir,
    {
      input: objectIds
        .map((oid, index) => `100644 ${oid} ${index + 1}\t${file}\n`)
        .join(""),
    },
  );
  assert.equal(conflicted.status, 0, conflicted.stderr);
  const indexPath = path.join(tempDir, ".git", "index");
  const before = fs.readFileSync(indexPath);

  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
  );
  assert.deepEqual(fs.readFileSync(indexPath), before);
});

test("captureFixSnapshot rejects assume-unchanged and skip-worktree targets", (t) => {
  const { tempDir, file } = createStagedTarget(t);

  for (const [flag, expected] of [
    ["--assume-unchanged", /assume-unchanged index state/],
    ["--skip-worktree", /skip-worktree index state/],
  ]) {
    const clear = runCommand(
      "git",
      [
        "update-index",
        "--no-assume-unchanged",
        "--no-skip-worktree",
        "--",
        file,
      ],
      tempDir,
    );
    const update = runCommand(
      "git",
      ["update-index", flag, "--", file],
      tempDir,
    );
    assert.equal(clear.status, 0, clear.stderr);
    assert.equal(update.status, 0, update.stderr);
    assert.throws(
      () => captureStagedTarget(tempDir, file),
      (error) =>
        error.code === "ERR_FIX_TARGET_UNSAFE" && expected.test(error.message),
    );
  }
});

test("captureFixSnapshot fails closed on unsafe index flag probe results", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const match = "ls-files -v -z --";

  const failed = runCaptureProbe(tempDir, fakeGitEnv(tempDir, match));
  assert.deepEqual(JSON.parse(failed.stdout), {
    code: "ERR_FIX_STATE_INSPECTION",
    message: "Unable to inspect target index flags.",
  });

  const missing = runCaptureProbe(
    tempDir,
    fakeGitEnv(tempDir, match, 0, "H src/other.json\0"),
  );
  assert.match(
    JSON.parse(missing.stdout).message,
    /Target index entry changed/,
  );

  const nonordinary = runCaptureProbe(
    tempDir,
    fakeGitEnv(tempDir, match, 0, `X ${file}\0`),
  );
  assert.deepEqual(JSON.parse(nonordinary.stdout), {
    code: "ERR_FIX_TARGET_UNSAFE",
    message: `Target has non-ordinary index state: ${file}`,
  });
});

test("captureFixSnapshot fails closed on unsafe target status probes", (t) => {
  const { tempDir } = createStagedTarget(t);
  const match = "status --porcelain=v2 -z";

  const failed = runCaptureProbe(tempDir, fakeGitEnv(tempDir, match));
  assert.deepEqual(JSON.parse(failed.stdout), {
    code: "ERR_FIX_STATE_INSPECTION",
    message: "Unable to inspect target index intent.",
  });

  const oid = "a".repeat(40);
  const unexpected = runCaptureProbe(
    tempDir,
    fakeGitEnv(
      tempDir,
      match,
      0,
      `1 .M N... 100644 100644 100644 ${oid} ${oid} src/other.json\0`,
    ),
  );
  assert.deepEqual(JSON.parse(unexpected.stdout), {
    code: "ERR_FIX_STATE_INSPECTION",
    message: "Git returned an unexpected target status path.",
  });
});

test("captureFixSnapshot rejects core.ignoreStat assume-unchanged targets", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const configured = runCommand(
    "git",
    ["config", "core.ignoreStat", "true"],
    tempDir,
  );
  const refreshed = runCommand(
    "git",
    ["update-index", "--really-refresh", "--", file],
    tempDir,
  );
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.match(
    runCommand("git", ["ls-files", "-v", "--", file], tempDir).stdout,
    /^h /u,
  );

  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) =>
      error.code === "ERR_FIX_TARGET_UNSAFE" &&
      /assume-unchanged index state/u.test(error.message),
  );
});

test("captureFixSnapshot rejects intent-to-add targets even when empty", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = "src/intent.json";
  writeFile(path.join(tempDir, file), "");
  const intent = runCommand(
    "git",
    ["add", "--intent-to-add", "--", file],
    tempDir,
  );
  assert.equal(intent.status, 0, intent.stderr);

  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) =>
      error.code === "ERR_FIX_TARGET_UNSAFE" &&
      /intent-to-add index state/u.test(error.message),
  );
});

test("captureFixSnapshot rejects a sparse-checkout target before reading it", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = "hidden/input.json";
  writeFile(path.join(tempDir, file), '{"hidden":true}\n');
  writeFile(path.join(tempDir, "visible", "keep.txt"), "visible\n");
  runCommand("git", ["add", "hidden/input.json", "visible/keep.txt"], tempDir);
  runCommand("git", ["commit", "-m", "add sparse targets"], tempDir);
  const initialized = runCommand(
    "git",
    ["sparse-checkout", "init", "--cone"],
    tempDir,
  );
  const selected = runCommand(
    "git",
    ["sparse-checkout", "set", "visible"],
    tempDir,
  );
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(fs.existsSync(path.join(tempDir, file)), false);
  assert.match(
    runCommand("git", ["ls-files", "-v", "--", file], tempDir).stdout,
    /^S /u,
  );

  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) =>
      error.code === "ERR_FIX_TARGET_UNSAFE" &&
      /skip-worktree index state/u.test(error.message),
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
  const initialTree = runCommand("git", ["write-tree"], tempDir).stdout.trim();
  const snapshot = captureStagedTarget(tempDir, file);

  const update = runCommand(
    "git",
    ["update-index", "--assume-unchanged", "--", file],
    tempDir,
  );
  assert.equal(update.status, 0);
  assert.equal(
    runCommand("git", ["write-tree"], tempDir).stdout.trim(),
    initialTree,
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

  assert.doesNotThrow(() => captureStagedTarget(tempDir, file));
  assert.doesNotThrow(() =>
    inRepo(tempDir, () => assertFixSnapshotUnchanged(snapshot)),
  );
});

test("captureFixSnapshot revalidates index bytes after target probes", (t) => {
  const { tempDir, file } = createStagedTarget(t);
  const indexPath = inRepo(tempDir, () => path.resolve(".git", "index"));
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  const indexDescriptors = new Set();
  let indexReads = 0;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (path.resolve(String(filePath)) === indexPath) {
      indexDescriptors.add(descriptor);
    }
    return descriptor;
  });
  t.mock.method(fs, "readFileSync", (filePath, ...args) => {
    const content = originalRead(filePath, ...args);
    if (indexDescriptors.has(filePath)) {
      indexReads += 1;
      if (indexReads === 2) {
        return Buffer.concat([content, Buffer.from("changed")]);
      }
    }
    return content;
  });

  assert.throws(
    () => captureStagedTarget(tempDir, file),
    (error) => error.code === "ERR_FIX_STATE_CHANGED",
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

test(
  "runFixTools bounds captured-input concurrency and preserves output order",
  { timeout: 2000 },
  async () => {
    const files = Array.from({ length: 6 }, (_, index) => `src/${index}.json`);
    const targets = files.map((file, index) => ({
      file,
      expectedContent: Buffer.from(`{"index":${index}}\n`),
    }));
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    let release;
    let reachedBound;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const atBound = new Promise((resolve) => {
      reachedBound = resolve;
    });

    const execution = runFixTools(
      targets,
      { eslintFiles: [], prettierFiles: files },
      {
        concurrency: 2,
        now: () => 0,
        timeoutMs: 1000,
        runToolCommand: async (name, args, options) => {
          assert.equal(name, "prettier");
          assert.equal(args.at(-1), files[started]);
          active += 1;
          started += 1;
          maximumActive = Math.max(maximumActive, active);
          if (started === 2) {
            reachedBound();
          }
          await gate;
          active -= 1;
          return {
            outcome: "success",
            status: 0,
            signal: null,
            stdout: options.input.toUpperCase(),
            stderr: "",
          };
        },
      },
    );

    await atBound;
    assert.equal(active, 2);
    release();
    const result = await execution;

    assert.equal(maximumActive, 2);
    assert.equal(result.toolFailed, false);
    assert.deepEqual(
      [...result.outputs],
      targets.map((target) => [
        target.file,
        target.expectedContent.toString("utf8").toUpperCase(),
      ]),
    );
  },
);

test("runFixTools shares one deadline across ESLint and Prettier", async () => {
  const files = ["src/first.js", "src/second.js"];
  const targets = files.map((file) => ({
    file,
    expectedContent: Buffer.from("const value = 1;\n"),
  }));
  const calls = [];
  let now = 0;

  const result = await runFixTools(
    targets,
    { eslintFiles: [files[0]], prettierFiles: files },
    {
      concurrency: 1,
      now: () => now,
      timeoutMs: 100,
      runToolCommand: async (name, _args, options) => {
        calls.push({ name, timeoutMs: options.timeoutMs });
        if (name === "eslint") {
          now = 70;
          return {
            outcome: "success",
            status: 0,
            signal: null,
            stdout: JSON.stringify([
              { filePath: path.resolve(files[0]), messages: [] },
            ]),
            stderr: "",
          };
        }
        now = 100;
        return {
          outcome: "timeout",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: true,
        };
      },
    },
  );

  assert.deepEqual(calls, [
    { name: "eslint", timeoutMs: 100 },
    { name: "prettier", timeoutMs: 30 },
  ]);
  assert.equal(result.toolFailed, true);
  assert.deepEqual(result.missingTools, []);
  assert.deepEqual(
    [...result.outputs],
    targets.map((target) => [
      target.file,
      target.expectedContent.toString("utf8"),
    ]),
  );
});

test("runFixTools stops launching files after its overall deadline", async () => {
  const file = "src/input.js";
  let now = 0;
  const calls = [];

  const result = await runFixTools(
    [{ file, expectedContent: Buffer.from("const value = 1;\n") }],
    { eslintFiles: [file], prettierFiles: [file] },
    {
      concurrency: 1,
      now: () => now,
      timeoutMs: 100,
      runToolCommand: async (name, _args, options) => {
        calls.push({ name, timeoutMs: options.timeoutMs });
        now = 100;
        return {
          outcome: "success",
          status: 0,
          signal: null,
          stdout: JSON.stringify([
            { filePath: path.resolve(file), messages: [] },
          ]),
          stderr: "",
        };
      },
    },
  );

  assert.deepEqual(calls, [{ name: "eslint", timeoutMs: 100 }]);
  assert.equal(result.toolFailed, true);
});

test("runFixTools stops ESLint fan-out after an interrupted child", async () => {
  const files = ["src/first.js", "src/second.js"];
  let calls = 0;

  const result = await runFixTools(
    files.map((file) => ({
      file,
      expectedContent: Buffer.from("const value = 1;\n"),
    })),
    { eslintFiles: files, prettierFiles: [] },
    {
      concurrency: 1,
      now: () => 0,
      timeoutMs: 100,
      runToolCommand: async () => {
        calls += 1;
        return {
          outcome: "timeout",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          timedOut: true,
        };
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(result.toolFailed, true);
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
