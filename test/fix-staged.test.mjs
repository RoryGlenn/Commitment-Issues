// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  cleanupTempRepo,
  createExternalHardlink,
  createHardlinkOrSkip,
  createTempRepo,
  fakeGitEnv,
  installBlockingPrettierFixture,
  installInterruptibleProcessFixture,
  readFile,
  run,
  runAsync,
  waitForCompletion,
  waitForPath,
  writeFile,
} from "./helpers/temp-repo.mjs";

function runFixStaged(tempDir, options = {}) {
  const { cwd = tempDir, ...runOptions } = options;
  return run(
    "node",
    [path.join(tempDir, "scripts", "fix-staged.mjs")],
    cwd,
    runOptions,
  );
}

function gitPath(tempDir, name) {
  const result = run("git", ["rev-parse", "--git-path", name], tempDir);
  assert.equal(result.status, 0, result.stderr);
  return path.resolve(tempDir, result.stdout.replace(/\r?\n$/u, ""));
}

function snapshotSelectedPath(filePath) {
  if (!fs.existsSync(filePath)) {
    return { type: "missing" };
  }
  const stats = fs.lstatSync(filePath);
  return {
    type: stats.isFile() ? "file" : "other",
    mode: stats.mode,
    content: stats.isFile()
      ? fs.readFileSync(filePath).toString("base64")
      : null,
  };
}

function captureFixState(tempDir, files) {
  const head = run("git", ["rev-parse", "HEAD"], tempDir);
  assert.equal(head.status, 0, head.stderr);
  return {
    head: head.stdout.trim(),
    index: fs.readFileSync(gitPath(tempDir, "index")).toString("base64"),
    targets: Object.fromEntries(
      files.map((file) => [
        file,
        snapshotSelectedPath(path.join(tempDir, ...file.split("/"))),
      ]),
    ),
  };
}

function markHiddenIndexState(tempDir, file, state) {
  let result;
  if (state === "core.ignoreStat") {
    result = run("git", ["config", "core.ignoreStat", "true"], tempDir);
    assert.equal(result.status, 0, result.stderr);
    result = run(
      "git",
      ["update-index", "--really-refresh", "--", file],
      tempDir,
    );
  } else {
    result = run("git", ["update-index", `--${state}`, "--", file], tempDir);
  }
  assert.equal(result.status, 0, result.stderr);
  const tag = run("git", ["ls-files", "-v", "--", file], tempDir);
  assert.equal(tag.status, 0, tag.stderr);
  assert.match(tag.stdout, state === "skip-worktree" ? /^S /u : /^h /u);
}

async function runFixStagedDuringPrettier(tempDir, mutate, env = {}) {
  const ready = path.join(tempDir, "fixer-ready");
  const release = path.join(tempDir, "fixer-release");
  const execution = runAsync(
    process.execPath,
    [path.join(tempDir, "scripts", "fix-staged.mjs")],
    tempDir,
    {
      env: {
        ...process.env,
        ...env,
        FIXER_OUTPUT: '{ "alpha": 1 }\n',
        FIXER_READY: ready,
        FIXER_RELEASE: release,
      },
    },
  );
  try {
    await waitForPath(ready);
    await mutate();
  } finally {
    writeFile(release, "release\n");
  }
  return execution.completed;
}

test("shows info box when there are no staged fixable files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /No staged files to fix\./);
});

test(
  "fix-staged cancels formatter descendants before exiting on SIGINT",
  { skip: process.platform === "win32" },
  async (t) => {
    const tempDir = createTempRepo();
    const target = path.join(tempDir, "src", "interrupt.json");
    const original = '{"safe":true}\n';
    const mutation = '{"survivor":true}\n';
    const fixture = installInterruptibleProcessFixture(tempDir, {
      target,
      mutation,
      asPrettier: true,
    });
    run("git", ["rm", "--cached", "--force", "node_modules"], tempDir);
    run("git", ["commit", "-m", "use local fixture"], tempDir);
    writeFile(target, original);
    run("git", ["add", "src/interrupt.json"], tempDir);
    const execution = runAsync(
      process.execPath,
      [path.join(tempDir, "scripts", "fix-staged.mjs")],
      tempDir,
      { env: { ...process.env, ...fixture.env } },
    );
    t.after(() => {
      execution.child.kill("SIGKILL");
      fixture.cleanup();
      cleanupTempRepo(tempDir);
    });

    await Promise.race([
      waitForPath(fixture.ready),
      execution.completed.then((result) => {
        throw new Error(
          `fix-staged exited before the fixture started: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    execution.child.kill("SIGINT");
    const result = await waitForCompletion(
      execution.completed,
      "fix-staged did not finish cancellation",
    );
    const bytesAtExit = readFile(tempDir, "src/interrupt.json");

    fixture.release();
    await delay(250);

    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGINT");
    assert.equal(bytesAtExit, original);
    assert.equal(readFile(tempDir, "src/interrupt.json"), original);
    assert.equal(
      run("git", ["show", ":src/interrupt.json"], tempDir).stdout,
      original,
    );
  },
);

test("surfaces the detected package manager in command hints", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A pnpm lockfile with no package-manager env (as at hook time) makes the
  // command hints resolve to pnpm instead of the npm default.
  writeFile(path.join(tempDir, "pnpm-lock.yaml"), "");
  const file = path.join(tempDir, "src", "partial.js");
  writeFile(file, "export const value = 1;\n");
  run("git", ["add", "src/partial.js"], tempDir);
  writeFile(file, "export const value = 2;\n");

  const env = { ...process.env };
  delete env.npm_config_user_agent;

  const result = runFixStaged(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Cannot safely fix partially staged files/);
  assert.match(output, /pnpm run fix:staged/);
});

test("refuses to fix partially staged files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "partial.js"), 'console.log("x")\n');
  run("git", ["add", "src/partial.js"], tempDir);
  writeFile(
    path.join(tempDir, "src", "partial.js"),
    'console.log("x")\nconsole.log("y")\n',
  );

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Cannot safely fix partially staged files\./);
});

for (const state of ["assume-unchanged", "skip-worktree", "core.ignoreStat"]) {
  test(`fix-staged preserves private edits hidden by ${state}`, (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const file = `src/${state.replace(".", "-")}.json`;
    writeFile(path.join(tempDir, file), '{"alpha":1}\n');
    run("git", ["add", "--", file], tempDir);
    markHiddenIndexState(tempDir, file, state);
    writeFile(path.join(tempDir, file), '{"private":true}\n');
    const hidden = run("git", ["diff", "--name-only", "--", file], tempDir);
    assert.equal(hidden.status, 0, hidden.stderr);
    assert.equal(hidden.stdout, "");
    const before = captureFixState(tempDir, [file]);

    const result = runFixStaged(tempDir);
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1, output);
    assert.match(
      output,
      state === "skip-worktree"
        ? /skip-worktree index state/
        : /assume-unchanged index state/,
    );
    assert.deepEqual(captureFixState(tempDir, [file]), before);
  });
}

test("fix-staged preserves an unavailable sparse-checkout target", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const hiddenFile = "hidden/sparse.json";
  const visibleFile = "visible/keep.txt";
  writeFile(path.join(tempDir, hiddenFile), '{"alpha":0}\n');
  writeFile(path.join(tempDir, visibleFile), "visible\n");
  run("git", ["add", hiddenFile, visibleFile], tempDir);
  const committed = run("git", ["commit", "-m", "add sparse files"], tempDir);
  assert.equal(committed.status, 0, committed.stderr);
  const initialized = run(
    "git",
    ["sparse-checkout", "init", "--cone"],
    tempDir,
  );
  const selected = run("git", ["sparse-checkout", "set", "visible"], tempDir);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(fs.existsSync(path.join(tempDir, hiddenFile)), false);

  const blob = run("git", ["hash-object", "-w", "--stdin"], tempDir, {
    input: '{"alpha":1}\n',
  });
  assert.equal(blob.status, 0, blob.stderr);
  const staged = run(
    "git",
    ["update-index", "--cacheinfo", "100644", blob.stdout.trim(), hiddenFile],
    tempDir,
  );
  assert.equal(staged.status, 0, staged.stderr);
  const skipped = run(
    "git",
    ["update-index", "--skip-worktree", "--", hiddenFile],
    tempDir,
  );
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(
    run("git", ["ls-files", "-v", "--", hiddenFile], tempDir).stdout,
    /^S /u,
  );
  assert.equal(
    run("git", ["diff", "--cached", "--name-only", "--", hiddenFile], tempDir)
      .stdout,
    `${hiddenFile}\n`,
  );
  const before = captureFixState(tempDir, [hiddenFile, visibleFile]);

  const result = runFixStaged(tempDir);

  assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /missing from the working tree/,
  );
  assert.deepEqual(captureFixState(tempDir, [hiddenFile, visibleFile]), before);
});

test(
  "escapes control characters from a real partially staged Git filename",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const file = "src/evil\rFAKE SUCCESS\n\t\b\u001b[31mRED\u001b[39m.json";
    writeFile(path.join(tempDir, file), '{"before":true}\n');
    run("git", ["add", "--", file], tempDir);
    writeFile(path.join(tempDir, file), '{"after":true}\n');

    const result = runFixStaged(tempDir, {
      env: { ...process.env, COLUMNS: "240", NO_COLOR: "1" },
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /src\/evil\\rFAKE SUCCESS\\n\\t\\x08RED\.json/);
    assert.doesNotMatch(output, /\r|\t|\x08|\u001b/);
  },
);

test("applies staged fixes successfully when all issues are auto-fixable", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "success.js"), 'console.log("x")\n');
  run("git", ["add", "src/success.js"], tempDir);

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Staged fixes applied\./);
  assert.equal(readFile(tempDir, "src/success.js"), 'console.log("x");\n');
});

test("fix-staged resolves staged root paths from a subdirectory", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "nested.json"), '{"nested":true}\n');
  run("git", ["add", "src/nested.json"], tempDir);
  const nested = path.join(tempDir, "nested path", "deeper");
  fs.mkdirSync(nested, { recursive: true });

  const result = runFixStaged(tempDir, { cwd: nested });

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(readFile(tempDir, "src/nested.json"), '{ "nested": true }\n');
  assert.equal(
    run("git", ["show", ":src/nested.json"], tempDir).stdout,
    '{ "nested": true }\n',
  );
});

test("fix-staged breaks a target hardlink without changing external bytes", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = "src/hardlinked.json";
  const originalContent = '{"alpha":1}\n';
  const fixedContent = '{ "alpha": 1 }\n';
  const linked = createExternalHardlink(t, tempDir, file, originalContent);
  if (!linked) {
    return;
  }
  run("git", ["add", file], tempDir);
  assert.equal(fs.lstatSync(linked.outsidePath).nlink, 2);

  const result = runFixStaged(tempDir);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(fs.readFileSync(linked.outsidePath, "utf8"), originalContent);
  assert.equal(fs.lstatSync(linked.outsidePath).nlink, 1);
  assert.equal(fs.readFileSync(linked.projectPath, "utf8"), fixedContent);
  assert.equal(run("git", ["show", `:${file}`], tempDir).stdout, fixedContent);
  assert.notDeepEqual(
    [
      fs.lstatSync(linked.projectPath, { bigint: true }).dev,
      fs.lstatSync(linked.projectPath, { bigint: true }).ino,
    ],
    [
      fs.lstatSync(linked.outsidePath, { bigint: true }).dev,
      fs.lstatSync(linked.outsidePath, { bigint: true }).ino,
    ],
  );
});

test("fix-staged refuses co-selected hardlink aliases before mutation", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const first = path.join(tempDir, "src", "hardlink-first.json");
  const second = path.join(tempDir, "src", "hardlink-second.json");
  const originalContent = '{"alpha":1}\n';
  writeFile(first, originalContent);
  if (!createHardlinkOrSkip(t, first, second)) {
    return;
  }
  run(
    "git",
    ["add", "src/hardlink-first.json", "src/hardlink-second.json"],
    tempDir,
  );
  const initialIndex = run("git", ["write-tree"], tempDir).stdout.trim();

  const result = runFixStaged(tempDir);

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unable to apply automatic fixes safely/,
  );
  assert.equal(fs.readFileSync(first, "utf8"), originalContent);
  assert.equal(fs.readFileSync(second, "utf8"), originalContent);
  assert.equal(fs.lstatSync(first).nlink, 2);
  assert.equal(run("git", ["write-tree"], tempDir).stdout.trim(), initialIndex);
});

test("handles shell-sensitive staged filenames safely", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const files = [
    "src/has space.js",
    "src/quote'file.js",
    "src/semi;colon.js",
    "src/unicode-猫.js",
    "src/glob[abc].js",
  ];

  for (const file of files) {
    writeFile(
      path.join(tempDir, ...file.split("/")),
      "export const value = 1;\n",
    );
  }
  run("git", ["add", ...files], tempDir);

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;
  const stagedAfter = run(
    "git",
    ["-c", "core.quotePath=false", "diff", "--cached", "--name-only"],
    tempDir,
  );

  assert.equal(result.status, 0);
  assert.match(output, /Checked 5 staged files/);
  assert.match(output, /src\/has space\.js/);
  assert.match(output, /src\/quote'file\.js/);
  assert.match(output, /src\/semi;colon\.js/);
  assert.match(output, /src\/unicode-猫\.js/);
  assert.match(output, /src\/glob\[abc\]\.js/);
  assert.deepEqual(stagedAfter.stdout.trim().split("\n").sort(), files.sort());
});

test("returns warning when fixes apply but lint issues remain", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "warn.js"), "const value=1\n");
  run("git", ["add", "src/warn.js"], tempDir);

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Manual attention still needed\./);
  assert.match(output, /no-unused-vars/);
  assert.equal(readFile(tempDir, "src/warn.js"), "const value = 1;\n");
});

test("errors when staged files cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const env = fakeGitEnv(tempDir, "--diff-filter=ACMRT");
  const result = runFixStaged(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to inspect staged files\./);
});

test("errors when staged pathname output is malformed", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  const env = fakeGitEnv(
    tempDir,
    "--name-only -z --diff-filter=ACMRT",
    0,
    "src/unterminated.js",
  );
  const result = runFixStaged(tempDir, { env });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unable to inspect staged files/,
  );
});

test("errors when unstaged files cannot be inspected", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "s.js"), 'console.log("x")\n');
  run("git", ["add", "src/s.js"], tempDir);

  // The staged probe succeeds; the later unstaged `git diff --name-only` fails.
  const env = fakeGitEnv(tempDir, "diff --name-only");
  const result = runFixStaged(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to inspect unstaged files\./);
});

test("errors when automatically fixed files cannot be restaged", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "restage.json"), '{"ok":true}\n');
  run("git", ["add", "src/restage.json"], tempDir);

  const result = runFixStaged(tempDir, {
    env: fakeGitEnv(tempDir, "update-index -z --index-info"),
  });

  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Unable to apply automatic fixes safely/,
  );
});

test("fails closed when the target index snapshot is unreadable", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Already-clean file so the fixers make no changes and exit 0.
  writeFile(path.join(tempDir, "src", "clean.js"), 'console.log("x");\n');
  run("git", ["add", "src/clean.js"], tempDir);

  // Exact staging requires a readable initial target snapshot.
  const env = fakeGitEnv(tempDir, "ls-files --stage -z --");
  const result = runFixStaged(tempDir, { env });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Unable to apply automatic fixes safely/);
});

test("refuses to fix a staged file missing from the working tree", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // A staged symlink whose target does not exist: fs.existsSync() is false, yet
  // `git diff` sees the symlink entry itself as unchanged, so it is not counted
  // as "partially staged" — exercising the missing-working-tree guard.
  fs.symlinkSync("does-not-exist", path.join(tempDir, "src", "link.js"));
  run("git", ["add", "src/link.js"], tempDir);

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /missing from the working tree/);
});

test("reports already clean and pluralizes for multiple unchanged files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  // Two already-clean files: the fixers make no change, so the index snapshot
  // is unchanged (both snapshots non-null and equal).
  writeFile(path.join(tempDir, "src", "a.js"), "export const a = 1;\n");
  writeFile(path.join(tempDir, "src", "b.js"), "export const b = 2;\n");
  run("git", ["add", "src/a.js", "src/b.js"], tempDir);

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(output, /Checked 2 staged files/);
});

test("reports one already-clean staged file in the singular", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  writeFile(path.join(tempDir, "src", "clean.js"), "export const a = 1;\n");
  run("git", ["add", "src/clean.js"], tempDir);

  const result = runFixStaged(tempDir);

  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Checked 1 staged file\. No automatic changes were needed\./,
  );
});

test("applied-fix summary pluralizes multiple changed files", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(path.join(tempDir, "src", "a.json"), '{"a":1}\n');
  writeFile(path.join(tempDir, "src", "b.json"), '{"b":2}\n');
  run("git", ["add", "src/a.json", "src/b.json"], tempDir);

  const result = runFixStaged(tempDir);
  assert.equal(result.status, 0);
  assert.match(
    `${result.stdout}${result.stderr}`,
    /Refreshed the index for 2 staged files/,
  );
});

test(
  "fixes the exact NUL-delimited path containing legal whitespace and Unicode",
  { skip: process.platform === "win32" },
  (t) => {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));

    const file = "src/ leading\t猫\ntrailing /data.json";
    writeFile(path.join(tempDir, ...file.split("/")), '{"alpha":1}\n');
    run("git", ["add", "--", file], tempDir);

    const result = runFixStaged(tempDir);
    const staged = run(
      "git",
      ["diff", "--cached", "--name-only", "-z"],
      tempDir,
    );

    assert.equal(result.status, 0);
    assert.equal(readFile(tempDir, file), '{ "alpha": 1 }\n');
    assert.equal(staged.stdout, `${file}\0`);
  },
);

test("reports local install guidance when fixer peer tools are missing", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  writeFile(
    path.join(tempDir, "src", "missing-tools.js"),
    "export const x=1;\n",
  );
  run("git", ["add", "src/missing-tools.js"], tempDir);
  fs.unlinkSync(path.join(tempDir, "node_modules"));
  fs.mkdirSync(path.join(tempDir, "node_modules"));

  const result = runFixStaged(tempDir);
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Missing local tool\(s\): eslint, prettier/);
  assert.match(output, /npm install -D eslint@\^9 prettier@\^3/);
});

test("refuses a concurrent target auto-save without staging it", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const file = path.join(tempDir, "src", "race.json");
  const initial = '{"alpha":1}\n';
  const concurrent = '{"user":true}\n';
  writeFile(file, initial);
  run("git", ["add", "src/race.json"], tempDir);
  const initialIndex = run("git", ["write-tree"], tempDir).stdout.trim();
  installBlockingPrettierFixture(tempDir);

  const result = await runFixStagedDuringPrettier(tempDir, () => {
    writeFile(file, concurrent);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.equal(readFile(tempDir, "src/race.json"), concurrent);
  assert.equal(run("git", ["show", ":src/race.json"], tempDir).stdout, initial);
  assert.equal(run("git", ["write-tree"], tempDir).stdout.trim(), initialIndex);
});

test("refuses a hardlink added while staged fixers run", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const outsideDir = fs.mkdtempSync(
    path.join(path.dirname(tempDir), "fix-hardlink-race-"),
  );
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const file = path.join(tempDir, "src", "hardlink-race.json");
  const alias = path.join(outsideDir, "hardlink-race.json");
  const probe = path.join(outsideDir, "probe.json");
  const initial = '{"alpha":1}\n';
  writeFile(file, initial);
  if (!createHardlinkOrSkip(t, file, probe)) {
    return;
  }
  fs.rmSync(probe);
  run("git", ["add", "src/hardlink-race.json"], tempDir);
  const initialIndex = run("git", ["write-tree"], tempDir).stdout.trim();
  installBlockingPrettierFixture(tempDir);

  const result = await runFixStagedDuringPrettier(tempDir, () => {
    fs.linkSync(file, alias);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /Repository state changed while automatic fixes/);
  assert.equal(fs.lstatSync(file).nlink, 2);
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  assert.equal(fs.readFileSync(alias, "utf8"), initial);
  assert.equal(run("git", ["write-tree"], tempDir).stdout.trim(), initialIndex);
});

test("refuses concurrent target deletion and type replacement", async (t) => {
  for (const replacement of ["missing", "directory"]) {
    const tempDir = createTempRepo();
    t.after(() => cleanupTempRepo(tempDir));
    const file = path.join(tempDir, "src", `${replacement}.json`);
    writeFile(file, '{"alpha":1}\n');
    run("git", ["add", `src/${replacement}.json`], tempDir);
    installBlockingPrettierFixture(tempDir);

    const result = await runFixStagedDuringPrettier(tempDir, () => {
      fs.rmSync(file);
      if (replacement === "directory") {
        fs.mkdirSync(file);
      }
    });

    assert.equal(result.status, 1);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /Repository state changed while automatic fixes/,
    );
    assert.equal(fs.existsSync(file), replacement === "directory");
    if (replacement === "directory") {
      assert.equal(fs.lstatSync(file).isDirectory(), true);
    }
  }
});

test("preserves a concurrent index update and uses the fun refusal", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const target = path.join(tempDir, "src", "index-race.json");
  writeFile(target, '{"alpha":1}\n');
  run("git", ["add", "src/index-race.json"], tempDir);
  writeFile(path.join(tempDir, ".commitmentrc.json"), '{"tone":"fun"}\n');
  installBlockingPrettierFixture(tempDir);

  const result = await runFixStagedDuringPrettier(tempDir, () => {
    writeFile(path.join(tempDir, "concurrent.txt"), "user index work\n");
    run("git", ["add", "concurrent.txt"], tempDir);
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 1);
  assert.match(output, /changed the relationship status mid-fix/);
  assert.match(output, /No surprise changes were invited/);
  assert.equal(
    run("git", ["show", ":concurrent.txt"], tempDir).stdout,
    "user index work\n",
  );
  assert.equal(readFile(tempDir, "src/index-race.json"), '{"alpha":1}\n');
});

test("refuses when HEAD moves while staged fixes are computed", async (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));
  const target = path.join(tempDir, "src", "head-race.json");
  writeFile(target, '{"alpha":1}\n');
  run("git", ["add", "src/head-race.json"], tempDir);
  const originalHead = run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim();
  installBlockingPrettierFixture(tempDir);

  const result = await runFixStagedDuringPrettier(tempDir, () => {
    run("git", ["commit", "-m", "concurrent commit"], tempDir);
  });

  assert.equal(result.status, 1);
  assert.notEqual(
    run("git", ["rev-parse", "HEAD"], tempDir).stdout.trim(),
    originalHead,
  );
  assert.equal(readFile(tempDir, "src/head-race.json"), '{"alpha":1}\n');
});
