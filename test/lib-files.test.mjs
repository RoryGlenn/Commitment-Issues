// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  globToRegExp,
  isTestExemptFile,
  isTestFile,
  isInTestDir,
  isConfigFile,
  isThirdPartyPath,
  findTestFile,
  findTestFiles,
  collectTestsForFiles,
  parseLsFilesStage,
  parseNameStatusPaths,
  parseNulPaths,
  inspectMutableProjectFile,
  mutableProjectFileUnchanged,
  preflightMutableProjectFile,
  removeMutableProjectFile,
  removeOwnedPath,
  shortFileList,
  writeMutableProjectFile,
} from "../scripts/lib/files.mjs";

function mutableProjectFileArtifacts(directory, basename) {
  const prefix = `.${basename}.commitment-issues-`;
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".tmp"));
}

function filesystemError(code) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function replaceProcessPropertyForTest(t, name, value) {
  const original = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, {
    configurable: true,
    enumerable: original?.enumerable ?? true,
    writable: original?.writable ?? true,
    value,
  });
  t.after(() => {
    if (original) {
      Object.defineProperty(process, name, original);
    } else {
      delete process[name];
    }
  });
}

function exitedChildPid() {
  const result = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(result.status, 0);
  return result.pid;
}

function mutableProjectFileArtifactPath(
  directory,
  basename,
  pid,
  uuid = "00000000-0000-4000-8000-000000000000",
) {
  return path.join(
    directory,
    `.${basename}.commitment-issues-${pid}-${uuid}.tmp`,
  );
}

test("isTestExemptFile recognizes files that don't need a unit test", () => {
  assert.equal(isTestExemptFile("src/foo.test.ts"), true);
  assert.equal(isTestExemptFile("test/helpers/util.mjs"), true);
  assert.equal(isTestExemptFile("eslint.config.js"), true);
  assert.equal(isTestExemptFile(".prettierrc.cjs"), true);
  assert.equal(isTestExemptFile("src/types.d.ts"), true);
  assert.equal(isTestExemptFile("src/Button.stories.tsx"), true);
  assert.equal(isTestExemptFile("src/api.generated.ts"), true);
  assert.equal(isTestExemptFile("src/generated/schema.ts"), true);
});

test("isTestExemptFile still requires tests for ordinary source files", () => {
  assert.equal(isTestExemptFile("src/widget.ts"), false);
  assert.equal(isTestExemptFile("src/lib/math.js"), false);
});

test("isThirdPartyPath spots node_modules segments in any form", () => {
  assert.equal(isThirdPartyPath("node_modules/pkg/index.js"), true);
  assert.equal(isThirdPartyPath("vendor/node_modules/pkg/a.test.js"), true);
  assert.equal(
    isThirdPartyPath("packages\\app\\node_modules\\dep\\b.js"),
    true,
  );
  assert.equal(isThirdPartyPath("src/node_modules.js"), false);
  assert.equal(isThirdPartyPath("src/widget.js"), false);
});

test("collectTestsForFiles never runs vendored node_modules tests", () => {
  assert.deepEqual(
    collectTestsForFiles(["vendor/node_modules/pkg/foo.test.js"]),
    [],
  );
});

test("parseNameStatusPaths preserves deletions and rename relationships", () => {
  const output = [
    "M",
    "src/changed.mjs",
    "D",
    "src/deleted.mjs",
    "R100",
    "src/old name.mjs",
    "src/new\nname.mjs",
    "C100",
    "src/original.mjs",
    "src/copied.mjs",
    "",
  ].join("\0");

  assert.deepEqual(parseNameStatusPaths(output), [
    "src/changed.mjs",
    "src/deleted.mjs",
    "src/old name.mjs",
    "src/new\nname.mjs",
    "src/original.mjs",
    "src/copied.mjs",
  ]);
});

test("parseNameStatusPaths rejects malformed output", () => {
  assert.deepEqual(parseNameStatusPaths(""), []);
  assert.equal(parseNameStatusPaths("M"), null);
  assert.equal(parseNameStatusPaths("R100\0src/old.mjs"), null);
  assert.equal(parseNameStatusPaths("\0src/path.mjs"), null);
  assert.equal(parseNameStatusPaths("Q\0src/path.mjs\0"), null);
  assert.equal(parseNameStatusPaths("M\0\0"), null);
});

test("parseNulPaths preserves every legal pathname character", () => {
  const paths = [
    "src/ leading.mjs",
    "src/trailing /file.mjs",
    "src/line\nbreak.mjs",
    "src/tab\tname.mjs",
    "src/unicode-猫.mjs",
  ];

  assert.deepEqual(parseNulPaths(`${paths.join("\0")}\0`), paths);
  assert.deepEqual(parseNulPaths(""), []);
  assert.equal(parseNulPaths("src/unterminated.mjs"), null);
  assert.equal(parseNulPaths("src/a.mjs\0\0"), null);
});

test("parseLsFilesStage separates metadata from tab-bearing paths", () => {
  const output =
    "100644 0123456789abcdef 0\tsrc/tab\tand\nnewline.mjs\0" +
    "100755 fedcba9876543210 2\t leading-and-trailing \0";

  assert.deepEqual(parseLsFilesStage(output), [
    {
      mode: "100644",
      object: "0123456789abcdef",
      stage: 0,
      file: "src/tab\tand\nnewline.mjs",
    },
    {
      mode: "100755",
      object: "fedcba9876543210",
      stage: 2,
      file: " leading-and-trailing ",
    },
  ]);
  assert.equal(parseLsFilesStage("100644 bad\tfile\0"), null);
  assert.equal(parseLsFilesStage("100644 bad\tunterminated"), null);
  assert.equal(parseLsFilesStage("100644 deadbeef 0 file\0"), null);
});

test("isTestExemptFile honors package.json testExempt globs", () => {
  // The repo's package.json exempts scripts/lib/**.
  assert.equal(isTestExemptFile("scripts/lib/util.mjs"), true);
});

test("globToRegExp supports *, ** and ?", () => {
  assert.match("src/legacy/old.js", globToRegExp("src/legacy/**"));
  assert.match("docs/line\nbreak.js", globToRegExp("docs/**"));
  assert.match("a/line\nbreak/file.js", globToRegExp("**/file.js"));
  assert.match("Button.stories.tsx", globToRegExp("*.stories.tsx"));
  assert.doesNotMatch(
    "src/ui/Button.stories.tsx",
    globToRegExp("*.stories.tsx"),
  );
  assert.match("src/ui/Button.stories.tsx", globToRegExp("**/*.stories.tsx"));
  assert.match("a/b.ts", globToRegExp("a/?.ts"));
  assert.doesNotMatch("a/bc.ts", globToRegExp("a/?.ts"));
});

test("predicate helpers classify files", () => {
  assert.equal(isTestFile("src/a.test.js"), true);
  assert.equal(isTestFile("src/a.js"), false);
  assert.equal(isInTestDir("src/__tests__/a.js"), true);
  assert.equal(isInTestDir("src/a.js"), false);
  assert.equal(isConfigFile("vite.config.ts"), true);
  assert.equal(isConfigFile(".eslintrc.cjs"), true);
  assert.equal(isConfigFile("src/a.js"), false);
});

test("shortFileList compacts long lists and handles empty input", () => {
  assert.equal(shortFileList([]), "");
  assert.equal(shortFileList(["a", "b"]), "a, b");
  assert.equal(shortFileList(["a", "b", "c", "d"]), "a, b, c, d");
  assert.equal(
    shortFileList(["a", "b", "c", "d", "e", "f"]),
    "a, b, c, d, e (+1 more)",
  );
  assert.equal(
    shortFileList(["evil\rline\n\t\b\u001b[31mred\u001b[39m.mjs"]),
    "evil\rline\n\t\b\u001b[31mred\u001b[39m.mjs",
  );
});

test("mutable project files distinguish regular, missing, linked, and unsafe paths", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-project-file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const regular = path.join(dir, "regular.json");
  const linked = path.join(dir, "linked.json");
  const directory = path.join(dir, "directory.json");
  const blocked = path.join(dir, "blocked.json");
  fs.writeFileSync(regular, "{}\n");
  fs.symlinkSync(regular, linked);
  fs.mkdirSync(directory);

  const regularState = inspectMutableProjectFile(regular);
  assert.equal(regularState.status, "regular");
  assert.equal(typeof regularState.stats.ino, "bigint");
  assert.deepEqual(inspectMutableProjectFile(path.join(dir, "missing.json")), {
    filePath: path.join(dir, "missing.json"),
    status: "missing",
  });
  assert.deepEqual(inspectMutableProjectFile(linked), {
    filePath: linked,
    status: "unsafe",
    reason: "is a symbolic link",
  });
  assert.deepEqual(inspectMutableProjectFile(directory), {
    filePath: directory,
    status: "unsafe",
    reason: "is not a regular file",
  });

  const originalLstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (filePath, ...args) => {
    if (filePath === blocked) {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return originalLstat(filePath, ...args);
  });
  assert.deepEqual(inspectMutableProjectFile(blocked), {
    filePath: blocked,
    status: "unsafe",
    reason: "could not be inspected safely",
  });
});

test("mutable project file preflight checks writes and removals without following replacements", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-preflight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const regular = path.join(dir, "regular.json");
  const missing = path.join(dir, "missing.json");
  const directory = path.join(dir, "directory.json");
  fs.writeFileSync(regular, "{}\n");
  fs.mkdirSync(directory);

  const regularState = inspectMutableProjectFile(regular);
  const missingState = inspectMutableProjectFile(missing);
  const unsafeState = inspectMutableProjectFile(directory);
  assert.equal(preflightMutableProjectFile(regularState), true);
  assert.equal(preflightMutableProjectFile(missingState), true);
  assert.equal(
    preflightMutableProjectFile(regularState, { remove: true }),
    true,
  );
  assert.equal(
    preflightMutableProjectFile(missingState, { remove: true }),
    false,
  );
  assert.equal(preflightMutableProjectFile(unsafeState), false);

  const originalAccess = fs.accessSync;
  t.mock.method(fs, "accessSync", (filePath, ...args) => {
    if (filePath === regular) {
      throw new Error("permission denied");
    }
    return originalAccess(filePath, ...args);
  });
  assert.equal(preflightMutableProjectFile(regularState), false);
});

test("mutable project file preflight notices a replacement during its permission probe", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-preflight-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const outside = path.join(dir, "outside.json");
  fs.writeFileSync(file, "{}\n");
  fs.writeFileSync(outside, '{"outside":true}\n');
  const state = inspectMutableProjectFile(file);

  const originalAccess = fs.accessSync;
  t.mock.method(fs, "accessSync", (filePath, ...args) => {
    const result = originalAccess(filePath, ...args);
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    return result;
  });

  assert.equal(preflightMutableProjectFile(state), false);
  assert.equal(fs.readFileSync(outside, "utf8"), '{"outside":true}\n');
});

test("mutable project file preflight requires a writable destination directory", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-preflight-parent-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, "{}\n");
  const state = inspectMutableProjectFile(file);
  const originalAccess = fs.accessSync;
  t.mock.method(fs, "accessSync", (filePath, ...args) => {
    if (filePath === dir) {
      throw filesystemError("EACCES");
    }
    return originalAccess(filePath, ...args);
  });

  assert.equal(preflightMutableProjectFile(state), false);
});

test("mutable project file writes atomically replace existing files and exclusively create new files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const existing = path.join(dir, "package.json");
  const existingAlias = path.join(dir, "package-alias.json");
  const missing = path.join(dir, ".gitignore");
  const originalContent = '{"before":true}\n';
  fs.writeFileSync(existing, originalContent, { mode: 0o640 });
  fs.linkSync(existing, existingAlias);

  const existingState = inspectMutableProjectFile(existing);
  const missingState = inspectMutableProjectFile(missing);
  assert.equal(mutableProjectFileUnchanged(existingState), true);
  assert.equal(mutableProjectFileUnchanged(missingState), true);
  writeMutableProjectFile(existingState, '{"after":true}\n');
  writeMutableProjectFile(missingState, "node_modules/\n");

  assert.equal(fs.readFileSync(existing, "utf8"), '{"after":true}\n');
  assert.equal(fs.readFileSync(existingAlias, "utf8"), originalContent);
  assert.equal(fs.readFileSync(missing, "utf8"), "node_modules/\n");
  assert.notEqual(
    fs.lstatSync(existing, { bigint: true }).ino,
    existingState.stats.ino,
  );
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(existing).mode & 0o777, 0o640);
  }
  assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
  assert.deepEqual(mutableProjectFileArtifacts(dir, ".gitignore"), []);
});

test("mutable project file writes reject destination links inserted after inspection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-write-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const outside = path.join(dir, "outside.json");
  const outsideContent = '{"outside":true}\n';
  fs.writeFileSync(file, "{}\n");
  fs.writeFileSync(outside, outsideContent);
  const state = inspectMutableProjectFile(file);
  fs.rmSync(file);
  fs.symlinkSync(outside, file);

  assert.equal(mutableProjectFileUnchanged(state), false);
  assert.throws(
    () => writeMutableProjectFile(state, '{"changed":true}\n'),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(outside, "utf8"), outsideContent);
});

test("missing mutable project files use an atomic no-replace commit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-create-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".gitignore");
  const state = inspectMutableProjectFile(file);
  const originalLink = fs.linkSync;
  t.mock.method(fs, "linkSync", (stagedPath, destination) => {
    fs.writeFileSync(destination, "concurrent\n");
    return originalLink(stagedPath, destination);
  });

  assert.throws(() => writeMutableProjectFile(state, "changed\n"));
  assert.equal(fs.readFileSync(file, "utf8"), "concurrent\n");
  assert.deepEqual(mutableProjectFileArtifacts(dir, ".gitignore"), []);
});

test("missing mutable project files detect replacement after link commit", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-create-postlink-race-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".gitignore");
  const committed = path.join(dir, "committed.gitignore");
  const state = inspectMutableProjectFile(file);
  const originalLink = fs.linkSync;
  t.mock.method(fs, "linkSync", (stagedPath, destination) => {
    const result = originalLink(stagedPath, destination);
    fs.renameSync(destination, committed);
    fs.writeFileSync(destination, "concurrent\n");
    return result;
  });

  assert.throws(
    () => writeMutableProjectFile(state, "intended\n"),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), "concurrent\n");
  assert.equal(fs.readFileSync(committed, "utf8"), "intended\n");
  assert.equal(mutableProjectFileArtifacts(dir, ".gitignore").length, 1);
});

test("mutable project file cleanup leaves active and unrecognized stages alone", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-active-stage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const activeArtifact = mutableProjectFileArtifactPath(
    dir,
    "package.json",
    process.pid,
  );
  const invalidArtifact = path.join(
    dir,
    ".package.json.commitment-issues-not-owned.tmp",
  );
  const outOfRangeArtifact = mutableProjectFileArtifactPath(
    dir,
    "package.json",
    "99999999999999999999",
  );
  fs.writeFileSync(file, '{"before":true}\n');
  fs.writeFileSync(activeArtifact, "active\n");
  fs.writeFileSync(invalidArtifact, "unrecognized\n");
  fs.writeFileSync(outOfRangeArtifact, "out-of-range\n");

  writeMutableProjectFile(inspectMutableProjectFile(file), '{"after":true}\n');

  assert.equal(fs.readFileSync(file, "utf8"), '{"after":true}\n');
  assert.equal(fs.readFileSync(activeArtifact, "utf8"), "active\n");
  assert.equal(fs.readFileSync(invalidArtifact, "utf8"), "unrecognized\n");
  assert.equal(fs.readFileSync(outOfRangeArtifact, "utf8"), "out-of-range\n");
});

test("mutable project file cleanup refuses an unsafe dead-writer stage", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-unsafe-stage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const outside = path.join(dir, "outside.json");
  const artifact = mutableProjectFileArtifactPath(
    dir,
    "package.json",
    exitedChildPid(),
  );
  fs.writeFileSync(file, '{"before":true}\n');
  fs.writeFileSync(outside, '{"outside":true}\n');
  fs.symlinkSync(outside, artifact);

  assert.throws(
    () =>
      writeMutableProjectFile(
        inspectMutableProjectFile(file),
        '{"after":true}\n',
      ),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), '{"before":true}\n');
  assert.equal(fs.readFileSync(outside, "utf8"), '{"outside":true}\n');
  assert.equal(fs.lstatSync(artifact).isSymbolicLink(), true);
});

test(
  "mutable project file cleanup refuses a differently owned dead-writer stage",
  { skip: typeof process.getuid !== "function" },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-owner-stage-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "package.json");
    const artifact = mutableProjectFileArtifactPath(
      dir,
      "package.json",
      exitedChildPid(),
    );
    fs.writeFileSync(file, '{"before":true}\n');
    fs.writeFileSync(artifact, "staged\n");
    const originalLstat = fs.lstatSync;
    t.mock.method(fs, "lstatSync", (filePath, ...args) => {
      const stats = originalLstat(filePath, ...args);
      return filePath === artifact
        ? {
            ...stats,
            uid: stats.uid + 1n,
            isFile: () => stats.isFile(),
          }
        : stats;
    });

    assert.throws(
      () =>
        writeMutableProjectFile(
          inspectMutableProjectFile(file),
          '{"after":true}\n',
        ),
      (error) => error.code === "ESTALE",
    );
    assert.equal(fs.readFileSync(file, "utf8"), '{"before":true}\n');
    assert.equal(fs.readFileSync(artifact, "utf8"), "staged\n");
  },
);

test("mutable project file cleanup supports platforms without user IDs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-no-uid-stage-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const artifact = mutableProjectFileArtifactPath(
    dir,
    "package.json",
    exitedChildPid(),
  );
  fs.writeFileSync(file, '{"before":true}\n');
  fs.writeFileSync(artifact, "staged\n");
  replaceProcessPropertyForTest(t, "getuid", undefined);

  writeMutableProjectFile(inspectMutableProjectFile(file), '{"after":true}\n');

  assert.equal(fs.readFileSync(file, "utf8"), '{"after":true}\n');
  assert.equal(fs.existsSync(artifact), false);
});

test("mutable project file cleanup detects destination changes while recovering", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-recovery-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const artifact = mutableProjectFileArtifactPath(
    dir,
    "package.json",
    exitedChildPid(),
  );
  fs.writeFileSync(file, '{"before":true}\n');
  fs.writeFileSync(artifact, "staged\n");
  const state = inspectMutableProjectFile(file);
  const originalRemove = fs.rmSync;
  t.mock.method(fs, "rmSync", (filePath, ...args) => {
    const result = originalRemove(filePath, ...args);
    if (filePath === artifact) {
      fs.writeFileSync(file, '{"concurrent":true}\n');
    }
    return result;
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"after":true}\n'),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), '{"concurrent":true}\n');
});

test("unrelated artifact cleanup does not relax destination identity checks", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-recovery-identity-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const temporaryLink = path.join(dir, "package-link.json");
  const artifact = mutableProjectFileArtifactPath(
    dir,
    "package.json",
    exitedChildPid(),
  );
  const originalContent = '{"before":true}\n';
  fs.writeFileSync(file, originalContent);
  fs.writeFileSync(artifact, "staged\n");
  const state = inspectMutableProjectFile(file);
  const originalRemove = fs.rmSync;
  t.mock.method(fs, "rmSync", (filePath, ...args) => {
    const result = originalRemove(filePath, ...args);
    if (filePath === artifact) {
      fs.linkSync(file, temporaryLink);
      originalRemove(temporaryLink);
    }
    return result;
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"after":true}\n'),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
});

test("mutable project file staging completes short writes before commit", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-short-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const replacement = '{"multibyte":"safe 🦉 content"}\n';
  fs.writeFileSync(file, '{"before":true}\n');
  const state = inspectMutableProjectFile(file);
  const originalWrite = fs.writeSync;
  let writeCalls = 0;
  t.mock.method(
    fs,
    "writeSync",
    (descriptor, buffer, offset, length, position) => {
      writeCalls += 1;
      return originalWrite(
        descriptor,
        buffer,
        offset,
        Math.min(length, 3),
        position,
      );
    },
  );

  writeMutableProjectFile(state, replacement);

  assert.ok(writeCalls > 1);
  assert.equal(fs.readFileSync(file, "utf8"), replacement);
  assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
});

for (const code of ["ENOSPC", "EIO"]) {
  test(`mutable project file staging preserves the original after ${code}`, (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mutable-write-failure-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "package.json");
    const originalContent = '{"sentinel":"original"}\n';
    fs.writeFileSync(file, originalContent);
    const state = inspectMutableProjectFile(file);
    const originalWrite = fs.writeSync;
    t.mock.method(
      fs,
      "writeSync",
      (descriptor, buffer, offset, length, position) => {
        originalWrite(
          descriptor,
          buffer,
          offset,
          Math.min(length, 4),
          position,
        );
        throw filesystemError(code);
      },
    );

    assert.throws(
      () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
      (error) => error.code === code,
    );
    assert.equal(fs.readFileSync(file, "utf8"), originalContent);
    assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
  });
}

test("mutable project file staging rejects a zero-byte short write", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-zero-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const originalContent = '{"sentinel":"original"}\n';
  fs.writeFileSync(file, originalContent);
  const state = inspectMutableProjectFile(file);
  t.mock.method(fs, "writeSync", () => 0);

  assert.throws(
    () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
    (error) => error.code === "EIO",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
});

for (const invalidWrite of [
  { article: "a", name: "noninteger", result: Number.NaN },
  { article: "an", name: "oversized", result: 1_000_000 },
]) {
  test(`mutable project file staging rejects ${invalidWrite.article} ${invalidWrite.name} write result`, (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mutable-invalid-write-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "package.json");
    const originalContent = '{"sentinel":"original"}\n';
    fs.writeFileSync(file, originalContent);
    const state = inspectMutableProjectFile(file);
    t.mock.method(fs, "writeSync", () => invalidWrite.result);

    assert.throws(
      () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
      (error) => error.code === "EIO",
    );
    assert.equal(fs.readFileSync(file, "utf8"), originalContent);
    assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
  });
}

test("mutable project file staging leaves an unverified stage for a later process", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-unverified-stage-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const originalContent = '{"sentinel":"original"}\n';
  fs.writeFileSync(file, originalContent);
  const state = inspectMutableProjectFile(file);
  t.mock.method(fs, "fstatSync", () => {
    throw filesystemError("EIO");
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
    (error) => error.code === "EIO",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  assert.equal(mutableProjectFileArtifacts(dir, "package.json").length, 1);
});

test("mutable project file staging preserves the primary error when cleanup fails", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-cleanup-failure-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const originalContent = '{"sentinel":"original"}\n';
  fs.writeFileSync(file, originalContent);
  const state = inspectMutableProjectFile(file);
  const originalRemove = fs.rmSync;
  t.mock.method(fs, "writeSync", () => {
    throw filesystemError("ENOSPC");
  });
  t.mock.method(fs, "rmSync", (filePath, ...args) => {
    if (String(filePath).includes(".commitment-issues-")) {
      throw filesystemError("EACCES");
    }
    return originalRemove(filePath, ...args);
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
    (error) => error.code === "ENOSPC",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  assert.equal(mutableProjectFileArtifacts(dir, "package.json").length, 1);
});

test("mutable project file staging validates the complete staged size", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-stage-size-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const originalContent = '{"sentinel":"original"}\n';
  fs.writeFileSync(file, originalContent);
  const state = inspectMutableProjectFile(file);
  const originalFstat = fs.fstatSync;
  let calls = 0;
  t.mock.method(fs, "fstatSync", (descriptor, ...args) => {
    calls += 1;
    const stats = originalFstat(descriptor, ...args);
    return calls === 2
      ? {
          ...stats,
          size: stats.size + 1n,
          isFile: () => stats.isFile(),
        }
      : stats;
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
    (error) => error.code === "EIO",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
});

test("mutable project file writes skip unsupported directory sync on Windows", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-windows-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, '{"before":true}\n');
  const state = inspectMutableProjectFile(file);
  const originalSync = fs.fsyncSync;
  let syncCalls = 0;
  replaceProcessPropertyForTest(t, "platform", "win32");
  t.mock.method(fs, "fsyncSync", (descriptor) => {
    syncCalls += 1;
    return originalSync(descriptor);
  });

  writeMutableProjectFile(state, '{"after":true}\n');

  assert.equal(syncCalls, 1);
  assert.equal(fs.readFileSync(file, "utf8"), '{"after":true}\n');
});

for (const failure of [
  {
    name: "permission preservation",
    install(t) {
      t.mock.method(fs, "fchmodSync", () => {
        throw filesystemError("EPERM");
      });
    },
    code: "EPERM",
  },
  {
    name: "staged-file sync",
    install(t) {
      t.mock.method(fs, "fsyncSync", () => {
        throw filesystemError("EIO");
      });
    },
    code: "EIO",
  },
  {
    name: "staged-file close",
    install(t) {
      const originalClose = fs.closeSync;
      let injected = false;
      t.mock.method(fs, "closeSync", (descriptor) => {
        if (!injected) {
          injected = true;
          originalClose(descriptor);
          throw filesystemError("EIO");
        }
        return originalClose(descriptor);
      });
    },
    code: "EIO",
  },
  {
    name: "final replacement",
    install(t) {
      t.mock.method(fs, "renameSync", () => {
        throw filesystemError("EIO");
      });
    },
    code: "EIO",
  },
]) {
  test(`mutable project file ${failure.name} failure preserves the original`, (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mutable-commit-failure-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "package.json");
    const originalContent = '{"sentinel":"original"}\n';
    fs.writeFileSync(file, originalContent);
    const state = inspectMutableProjectFile(file);
    failure.install(t);

    assert.throws(
      () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
      (error) => error.code === failure.code,
    );
    assert.equal(fs.readFileSync(file, "utf8"), originalContent);
    assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
  });
}

test(
  "a parent-directory sync failure reports an error after a complete commit",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "mutable-directory-sync-"),
    );
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "package.json");
    const replacement = '{"sentinel":"replacement"}\n';
    fs.writeFileSync(file, '{"sentinel":"original"}\n');
    const state = inspectMutableProjectFile(file);
    const originalSync = fs.fsyncSync;
    let syncCalls = 0;
    t.mock.method(fs, "fsyncSync", (descriptor) => {
      syncCalls += 1;
      if (syncCalls === 2) {
        throw filesystemError("EIO");
      }
      return originalSync(descriptor);
    });

    assert.throws(
      () => writeMutableProjectFile(state, replacement),
      (error) => error.code === "EIO",
    );
    assert.equal(fs.readFileSync(file, "utf8"), replacement);
    assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
  },
);

test("mutable project file writes reject a replaced staging path", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-stage-race-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const outside = path.join(dir, "outside.json");
  const originalContent = '{"sentinel":"original"}\n';
  const outsideContent = '{"outside":true}\n';
  fs.writeFileSync(file, originalContent);
  fs.writeFileSync(outside, outsideContent);
  const state = inspectMutableProjectFile(file);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stagedPath;
  let stagedDescriptor;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (String(filePath).includes(".commitment-issues-")) {
      stagedPath = String(filePath);
      stagedDescriptor = descriptor;
    }
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    const result = originalClose(descriptor);
    if (descriptor === stagedDescriptor) {
      fs.renameSync(stagedPath, `${stagedPath}.parked`);
      fs.symlinkSync(outside, stagedPath);
    }
    return result;
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  assert.equal(fs.readFileSync(outside, "utf8"), outsideContent);
});

test("mutable project file writes reject in-place staging changes after close", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-stage-content-race-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const originalContent = '{"sentinel":"original"}\n';
  const replacement = '{"sentinel":"replacement"}\n';
  fs.writeFileSync(file, originalContent);
  const state = inspectMutableProjectFile(file);
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  let stagedPath;
  let stagedDescriptor;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    const descriptor = originalOpen(filePath, ...args);
    if (String(filePath).includes(".commitment-issues-")) {
      stagedPath = String(filePath);
      stagedDescriptor = descriptor;
    }
    return descriptor;
  });
  t.mock.method(fs, "closeSync", (descriptor) => {
    const result = originalClose(descriptor);
    if (descriptor === stagedDescriptor) {
      fs.writeFileSync(stagedPath, "x".repeat(Buffer.byteLength(replacement)));
    }
    return result;
  });

  assert.throws(
    () => writeMutableProjectFile(state, replacement),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
});

test("mutable project file writes reject a destination replaced before commit", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "mutable-destination-race-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const originalContent = '{"sentinel":"original"}\n';
  const concurrentContent = '{"sentinel":"concurrent"}\n';
  fs.writeFileSync(file, originalContent);
  const state = inspectMutableProjectFile(file);
  const originalClose = fs.closeSync;
  let firstClose = true;
  t.mock.method(fs, "closeSync", (descriptor) => {
    const result = originalClose(descriptor);
    if (firstClose) {
      firstClose = false;
      fs.renameSync(file, `${file}.original`);
      fs.writeFileSync(file, concurrentContent);
    }
    return result;
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"sentinel":"replacement"}\n'),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), concurrentContent);
  assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
});

for (const field of ["dev", "ino"]) {
  test(`mutable project file writes reject a mismatched descriptor ${field}`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-fstat-race-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "package.json");
    const originalContent = "{}\n";
    fs.writeFileSync(file, originalContent);
    const state = inspectMutableProjectFile(file);
    const originalFstat = fs.fstatSync;
    t.mock.method(fs, "fstatSync", (descriptor, ...args) => {
      const stats = originalFstat(descriptor, ...args);
      return {
        ...stats,
        [field]: stats[field] + 1n,
        isFile: () => true,
      };
    });

    assert.throws(
      () => writeMutableProjectFile(state, '{"changed":true}\n'),
      (error) => error.code === "ESTALE",
    );
    assert.equal(fs.readFileSync(file, "utf8"), originalContent);
  });
}

test("mutable project file writes reject a non-file descriptor", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-fstat-type-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  fs.writeFileSync(file, "{}\n");
  const state = inspectMutableProjectFile(file);
  const originalFstat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (descriptor, ...args) => {
    const stats = originalFstat(descriptor, ...args);
    return { ...stats, isFile: () => false };
  });

  assert.throws(
    () => writeMutableProjectFile(state, '{"changed":true}\n'),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(file, "utf8"), "{}\n");
});

test("forced termination at each staging phase leaves complete old or new bytes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const crashScript = path.join(dir, "crash-write.mjs");
  const filesModuleUrl = pathToFileURL(
    path.resolve("scripts/lib/files.mjs"),
  ).href;
  const originalContent = '{"sentinel":"original"}\n';
  const replacement = '{"sentinel":"replacement"}\n';
  fs.writeFileSync(
    crashScript,
    `
import fs from "node:fs";

const [phase, file, moduleUrl, replacement] = process.argv.slice(2);
const originalOpen = fs.openSync;
const originalWrite = fs.writeSync;
const originalChmod = fs.fchmodSync;
const originalSync = fs.fsyncSync;
const originalClose = fs.closeSync;
const originalRename = fs.renameSync;
let stagedDescriptor;

const terminate = () => process.kill(process.pid, "SIGKILL");
fs.openSync = (filePath, ...args) => {
  const descriptor = originalOpen(filePath, ...args);
  if (String(filePath).includes(".commitment-issues-")) {
    stagedDescriptor = descriptor;
    if (phase === "open") terminate();
  }
  return descriptor;
};
fs.writeSync = (descriptor, buffer, offset, length, position) => {
  if (descriptor === stagedDescriptor && phase === "write") {
    originalWrite(descriptor, buffer, offset, Math.min(length, 3), position);
    terminate();
  }
  return originalWrite(descriptor, buffer, offset, length, position);
};
fs.fchmodSync = (descriptor, mode) => {
  const result = originalChmod(descriptor, mode);
  if (descriptor === stagedDescriptor && phase === "chmod") terminate();
  return result;
};
fs.fsyncSync = (descriptor) => {
  const result = originalSync(descriptor);
  if (descriptor === stagedDescriptor && phase === "sync") terminate();
  return result;
};
fs.closeSync = (descriptor) => {
  const result = originalClose(descriptor);
  if (descriptor === stagedDescriptor && phase === "close") terminate();
  return result;
};
fs.renameSync = (source, destination) => {
  if (phase === "before-rename") terminate();
  const result = originalRename(source, destination);
  if (phase === "after-rename") terminate();
  return result;
};

const { inspectMutableProjectFile, writeMutableProjectFile } =
  await import(moduleUrl);
writeMutableProjectFile(inspectMutableProjectFile(file), replacement);
`,
    "utf8",
  );

  for (const phase of [
    "open",
    "write",
    "chmod",
    "sync",
    "close",
    "before-rename",
    "after-rename",
  ]) {
    fs.writeFileSync(file, originalContent);
    const result = spawnSync(
      process.execPath,
      [crashScript, phase, file, filesModuleUrl, replacement],
      { encoding: "utf8" },
    );

    assert.ok(
      result.status !== 0 || result.signal,
      `${phase} should terminate the child`,
    );
    const contentAfterCrash = fs.readFileSync(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(contentAfterCrash));
    assert.equal(
      contentAfterCrash,
      phase === "after-rename" ? replacement : originalContent,
    );

    const retryContent = `{"retry":"${phase}"}\n`;
    writeMutableProjectFile(inspectMutableProjectFile(file), retryContent);
    assert.equal(fs.readFileSync(file, "utf8"), retryContent);
    assert.deepEqual(mutableProjectFileArtifacts(dir, "package.json"), []);
  }
});

test("forced termination after a missing-file commit is recovered on retry", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-create-crash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".gitignore");
  const crashScript = path.join(dir, "crash-create.mjs");
  const filesModuleUrl = pathToFileURL(
    path.resolve("scripts/lib/files.mjs"),
  ).href;
  fs.writeFileSync(
    crashScript,
    `
import fs from "node:fs";

const [file, moduleUrl] = process.argv.slice(2);
const originalLink = fs.linkSync;
fs.linkSync = (source, destination) => {
  const result = originalLink(source, destination);
  process.kill(process.pid, "SIGKILL");
  return result;
};
const { inspectMutableProjectFile, writeMutableProjectFile } =
  await import(moduleUrl);
writeMutableProjectFile(inspectMutableProjectFile(file), "node_modules/\\n");
`,
    "utf8",
  );

  const result = spawnSync(
    process.execPath,
    [crashScript, file, filesModuleUrl],
    { encoding: "utf8" },
  );

  assert.ok(result.status !== 0 || result.signal);
  assert.equal(fs.readFileSync(file, "utf8"), "node_modules/\n");
  assert.equal(mutableProjectFileArtifacts(dir, ".gitignore").length, 1);
  writeMutableProjectFile(
    inspectMutableProjectFile(file),
    "node_modules/\n.prettiercache\n",
  );
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "node_modules/\n.prettiercache\n",
  );
  assert.deepEqual(mutableProjectFileArtifacts(dir, ".gitignore"), []);
});

test("concurrent readers see only complete old or new project files", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-readers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "package.json");
  const stop = path.join(dir, "stop");
  const readerScript = path.join(dir, "reader.mjs");
  fs.writeFileSync(file, `${JSON.stringify({ version: 0, payload: "old" })}\n`);
  fs.writeFileSync(
    readerScript,
    `
import fs from "node:fs";

const [file, stop] = process.argv.slice(2);
let reads = 0;
const failures = [];
process.stdout.write("READY\\n");
while (!fs.existsSync(stop)) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
    reads += 1;
  } catch (error) {
    failures.push(error.code ?? error.name);
  }
}
process.stdout.write(JSON.stringify({ reads, failures }) + "\\n");
`,
    "utf8",
  );
  const reader = spawn(process.execPath, [readerScript, file, stop], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  reader.stdout.setEncoding("utf8");
  reader.stderr.setEncoding("utf8");
  reader.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  reader.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  while (!stdout.includes("READY\n")) {
    await once(reader.stdout, "data");
  }

  for (let version = 1; version <= 40; version += 1) {
    const replacement = `${JSON.stringify({
      version,
      payload: String(version).repeat(32_768),
    })}\n`;
    writeMutableProjectFile(inspectMutableProjectFile(file), replacement);
  }
  fs.writeFileSync(stop, "");
  const [status] = await once(reader, "exit");

  assert.equal(status, 0, stderr);
  const report = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.ok(report.reads > 0);
  assert.deepEqual(report.failures, []);
});

test("mutable project file writes and removals reject invalid or replaced state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mutable-remove-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const removable = path.join(dir, "removable.json");
  const replaced = path.join(dir, "replaced.json");
  const missing = path.join(dir, "missing.json");
  const unsafe = path.join(dir, "unsafe.json");
  fs.writeFileSync(removable, "{}\n");
  fs.writeFileSync(replaced, "before\n");
  fs.mkdirSync(unsafe);

  const removableState = inspectMutableProjectFile(removable);
  const replacedState = inspectMutableProjectFile(replaced);
  const missingState = inspectMutableProjectFile(missing);
  const unsafeState = inspectMutableProjectFile(unsafe);
  // Keep the original inode allocated so a fast filesystem cannot immediately
  // reuse it for the replacement and turn this identity-race fixture flaky.
  fs.renameSync(replaced, `${replaced}.original`);
  fs.writeFileSync(replaced, "after\n");

  assert.throws(
    () => writeMutableProjectFile(unsafeState, "changed\n"),
    (error) => error.code === "ESTALE",
  );
  removeMutableProjectFile(removableState);
  assert.equal(fs.existsSync(removable), false);
  assert.throws(
    () => removeMutableProjectFile(replacedState),
    (error) => error.code === "ESTALE",
  );
  assert.throws(
    () => removeMutableProjectFile(missingState),
    (error) => error.code === "ESTALE",
  );
  assert.equal(fs.readFileSync(replaced, "utf8"), "after\n");
});

test("removeOwnedPath reports successful and failed cleanup", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owned-path-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "owned.json");
  fs.writeFileSync(file, "{}\n");

  assert.deepEqual(removeOwnedPath(file, "owned config"), {
    removed: ["owned config"],
    manualCleanup: [],
  });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(
    removeOwnedPath(file, "owned config", () => {
      throw new Error("permission denied");
    }),
    {
      removed: [],
      manualCleanup: ["Could not remove owned config."],
    },
  );
});

test("findTestFile and collectTestsForFiles locate sibling tests", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-"));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);
  fs.mkdirSync("src", { recursive: true });
  fs.writeFileSync("src/widget.mjs", "export const w = 1;\n");
  fs.writeFileSync("src/widget.test.mjs", "export {};\n");
  fs.mkdirSync("test/src", { recursive: true });
  fs.writeFileSync("src/mirrored.mjs", "export const m = 1;\n");
  fs.writeFileSync("test/src/mirrored.test.mjs", "export {};\n");

  assert.equal(findTestFile("src/widget.mjs"), "src/widget.test.mjs");
  assert.deepEqual(findTestFiles("src/mirrored.mjs"), [
    "test/src/mirrored.test.mjs",
  ]);
  assert.equal(findTestFile("src/missing.mjs"), null);
  assert.deepEqual(findTestFiles("/absolute-orphan.mjs"), []);

  assert.deepEqual(collectTestsForFiles(["src/widget.mjs"]), [
    "src/widget.test.mjs",
  ]);
  assert.deepEqual(collectTestsForFiles(["src/widget.test.mjs"]), [
    "src/widget.test.mjs",
  ]);
  assert.deepEqual(collectTestsForFiles(["src/missing.mjs", "a.png"]), []);
});

test("related-test lookup stays inside the nearest monorepo package", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-monorepo-"));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);

  fs.writeFileSync("package.json", '{"workspaces":["packages/*"]}\n');
  for (const workspace of ["a", "b", "c"]) {
    fs.mkdirSync(`packages/${workspace}/src`, { recursive: true });
    fs.writeFileSync(`packages/${workspace}/package.json`, "{}\n");
    fs.writeFileSync(
      `packages/${workspace}/src/index.mjs`,
      `export const workspace = "${workspace}";\n`,
    );
  }
  fs.mkdirSync("test", { recursive: true });
  fs.writeFileSync("test/index.test.mjs", "export {};\n");
  fs.mkdirSync("packages/a/test", { recursive: true });
  fs.writeFileSync("packages/a/test/index.test.mjs", "export {};\n");
  fs.writeFileSync("packages/a/test/index.spec.mjs", "export {};\n");
  fs.mkdirSync("packages/b/tests", { recursive: true });
  fs.writeFileSync("packages/b/tests/index.test.mjs", "export {};\n");

  assert.deepEqual(findTestFiles("packages/a/src/index.mjs"), [
    "packages/a/test/index.test.mjs",
    "packages/a/test/index.spec.mjs",
  ]);
  fs.rmSync("packages/a/package.json");
  assert.deepEqual(findTestFiles("packages/a/src/index.mjs"), [
    "packages/a/test/index.test.mjs",
    "packages/a/test/index.spec.mjs",
  ]);
  assert.deepEqual(collectTestsForFiles(["packages/b/src/index.mjs"]), [
    "packages/b/tests/index.test.mjs",
  ]);
  assert.equal(findTestFile("packages/c/src/index.mjs"), null);
  assert.deepEqual(collectTestsForFiles(["packages/c/src/index.mjs"]), []);
});

test("deleted package discovery supports object-form workspace declarations", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "files-workspaces-"));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.chdir(dir);

  fs.writeFileSync(
    "package.json",
    JSON.stringify({ workspaces: { packages: ["packages/*"] } }),
  );
  fs.mkdirSync("packages/app/test", { recursive: true });
  fs.writeFileSync("packages/app/test/widget.test.mjs", "export {};\n");

  assert.deepEqual(findTestFiles("packages/app/src/widget.mjs"), [
    "packages/app/test/widget.test.mjs",
  ]);
});
