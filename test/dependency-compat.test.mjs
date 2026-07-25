// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const expand = require("brace-expansion");
const modernBraceExpansion = require("brace-expansion-modern");
const minimatch = require("minimatch");

test("brace-expansion adapter preserves the legacy callable export", () => {
  const adapterPackage = require("brace-expansion/package.json");
  const implementationPackage = require("brace-expansion-modern/package.json");

  assert.equal(adapterPackage.version, "1.1.17");
  assert.equal(implementationPackage.version, "5.0.8");
  assert.equal(typeof expand, "function");
  assert.equal(expand, modernBraceExpansion.expand);
  assert.deepEqual(expand("file-{1..3}.mjs"), [
    "file-1.mjs",
    "file-2.mjs",
    "file-3.mjs",
  ]);
});

test("legacy minimatch consumers retain brace-pattern behavior", () => {
  assert.equal(minimatch("scripts/cli.mjs", "{scripts,test}/**/*.mjs"), true);
  assert.equal(minimatch("test/cli.test.mjs", "{scripts,test}/**/*.mjs"), true);
  assert.equal(minimatch("README.md", "{scripts,test}/**/*.mjs"), false);
});
