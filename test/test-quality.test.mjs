// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BRANCH_COVERAGE_SOURCE_FILES } from "../scripts/lib/coverage-badge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const runtimeTestOwners = {
  "scripts/cli.mjs": ["test/cli.test.mjs"],
  "scripts/commit-fix.mjs": ["test/commit-fix.test.mjs"],
  "scripts/commit-msg.mjs": ["test/commit-msg.test.mjs"],
  "scripts/doctor.mjs": ["test/doctor.test.mjs"],
  "scripts/fix-staged-js.mjs": ["test/fix-staged-js.test.mjs"],
  "scripts/fix-staged.mjs": ["test/fix-staged.test.mjs"],
  "scripts/init.mjs": ["test/init.test.mjs"],
  "scripts/lefthook-files.mjs": ["test/hooks.test.mjs"],
  "scripts/lib/checks.mjs": ["test/checks.test.mjs"],
  "scripts/lib/commit-guards.mjs": ["test/commit-guards.test.mjs"],
  "scripts/lib/config.mjs": ["test/config.test.mjs"],
  "scripts/lib/debug-artifacts.mjs": [
    "test/debug-artifacts.test.mjs",
    "test/debug-artifacts-integration.test.mjs",
  ],
  "scripts/lib/files.mjs": [
    "test/lib-files.test.mjs",
    "test/path-normalization.test.mjs",
    "test/property.test.js",
  ],
  "scripts/lib/fix-safety.mjs": [
    "test/fix-safety.test.mjs",
    "test/fix-staged.test.mjs",
    "test/commit-fix.test.mjs",
  ],
  "scripts/lib/hooks.mjs": ["test/hooks.test.mjs"],
  "scripts/lib/json-output.mjs": ["test/json-output.test.mjs"],
  "scripts/lib/local-tool.mjs": ["test/local-tool.test.mjs"],
  "scripts/lib/logo.mjs": ["test/logo.test.mjs"],
  "scripts/lib/message.mjs": ["test/message.test.mjs"],
  "scripts/lib/package-manager.mjs": ["test/package-manager.test.mjs"],
  "scripts/lib/panic.mjs": ["test/panic.test.mjs"],
  "scripts/lib/process.mjs": ["test/process.test.mjs"],
  "scripts/lib/push-base.mjs": ["test/push-base.test.mjs"],
  "scripts/lib/runtime.mjs": ["test/runtime.test.mjs"],
  "scripts/lib/secret-scan.mjs": [
    "test/secret-scan.test.mjs",
    "test/secret-scan-integration.test.mjs",
  ],
  "scripts/lib/staged-tree.mjs": ["test/staged-tree.test.mjs"],
  "scripts/lib/terminal.mjs": ["test/terminal.test.mjs"],
  "scripts/lib/ui.mjs": ["test/ui.test.mjs"],
  "scripts/lib/vows.mjs": ["test/vows.test.mjs"],
  "scripts/lib/welcome.mjs": ["test/welcome.test.mjs"],
  "scripts/panic.mjs": ["test/panic.test.mjs"],
  "scripts/precommit.mjs": ["test/precommit.test.mjs"],
  "scripts/prepush.mjs": ["test/prepush.test.mjs"],
  "scripts/uninstall.mjs": ["test/uninstall.test.mjs"],
  "scripts/vows.mjs": ["test/cli.test.mjs", "test/vows.test.mjs"],
};

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function scriptFiles(dir = path.join(root, "scripts")) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory()
      ? scriptFiles(file)
      : entry.isFile() && entry.name.endsWith(".mjs")
        ? [file]
        : [];
  });
}

test("every runtime source has an explicit test owner", () => {
  assert.deepEqual(
    Object.keys(runtimeTestOwners).sort(),
    [...BRANCH_COVERAGE_SOURCE_FILES].sort(),
  );

  for (const [source, owners] of Object.entries(runtimeTestOwners)) {
    assert.ok(owners.length > 0, `${source} should have a test owner`);
    const ownerSources = [];
    for (const owner of owners) {
      assert.equal(
        fs.existsSync(path.join(root, owner)),
        true,
        `${source} test owner ${owner} should exist`,
      );
      ownerSources.push(read(owner));
    }
    assert.ok(
      ownerSources.some((ownerSource) =>
        ownerSource.includes(path.posix.basename(source)),
      ),
      `${source} should be referenced by at least one named test owner`,
    );
  }
});

test("coverage suppressions stay limited to documented filesystem races", () => {
  const suppressions = scriptFiles()
    .flatMap((file) => {
      const relative = path.relative(root, file).split(path.sep).join("/");
      const source = fs.readFileSync(file, "utf8");
      return source
        .split("\n")
        .filter((line) => line.includes("node:coverage"))
        .map((line) => ({ file: relative, directive: line.trim(), source }));
    })
    .sort((left, right) => left.file.localeCompare(right.file));

  assert.deepEqual(
    suppressions.map(({ file, directive }) => ({ file, directive })),
    [
      {
        file: "scripts/init.mjs",
        directive: "/* node:coverage ignore next 15 */",
      },
      {
        file: "scripts/uninstall.mjs",
        directive: "/* node:coverage ignore next 13 */",
      },
    ],
  );
  for (const { file, source } of suppressions) {
    assert.match(
      source,
      /post-preflight|nondeterministic post-preflight/,
      `${file} should explain why its defensive filesystem race is suppressed`,
    );
  }
});

test("CI Success accepts only explicit success from every required job", () => {
  const ci = read(".github/workflows/ci.yml");

  assert.match(ci, /name: CI Success/);
  assert.match(ci, /if: always\(\)/);
  assert.match(
    ci,
    /needs:\s+\[\s+classify,\s+dco,\s+quality,\s+check,\s+windows-tests,\s+windows-npm-lifecycle,\s+shell-compat,\s+pm-lifecycle,\s+migration-lifecycle,\s+codeql,\s+\]/,
  );
  for (const job of ["classify", "dco", "quality", "check", "codeql"]) {
    assert.match(ci, new RegExp(`needs\\.${job}\\.result != 'success'`));
  }
  assert.match(ci, /needs\['shell-compat'\]\.result != 'success'/);
  assert.match(ci, /needs\['windows-tests'\]\.result != 'success'/);
  assert.match(ci, /needs\['windows-npm-lifecycle'\]\.result != 'success'/);
  assert.match(ci, /needs\['pm-lifecycle'\]\.result != 'success'/);
  assert.match(ci, /needs\['migration-lifecycle'\]\.result != 'success'/);
  for (const job of [
    "check",
    "codeql",
    "shell-compat",
    "windows-tests",
    "windows-npm-lifecycle",
    "pm-lifecycle",
    "migration-lifecycle",
  ]) {
    const access = job.includes("-") ? `needs['${job}']` : `needs.${job}`;
    assert.match(
      ci,
      new RegExp(
        `${access.replaceAll("[", "\\[").replaceAll("]", "\\]")}\\.result != 'skipped'`,
      ),
    );
  }
  assert.match(ci, /outputs\.route != 'docs'/);
  assert.match(ci, /outputs\.route != 'full'/);
  assert.match(ci, /outputs\.categories != 'documentation-metadata'/);
  assert.match(ci, /outputs\.reason != 'docs-only'/);
  assert.doesNotMatch(ci, /contains\(needs\.\*\.result/);
});
