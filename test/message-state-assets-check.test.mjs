// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generator = path.join(root, "tools", "gen-message-state-svgs.mjs");

// The generator resolves its output directory from its own module path, so the
// copied script in a temp project writes to that project's assets/. Callers
// must therefore run the copied script, not the repository one.
function runGenerator(cwd, script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

function stageGenerator(t, prefix) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempDir, "tools"));
  fs.mkdirSync(path.join(tempDir, "assets"));
  const script = path.join(tempDir, "tools", path.basename(generator));
  fs.copyFileSync(generator, script);
  return { tempDir, script };
}

// Build a temp project with the generator and a freshly generated gallery so
// each test starts from a byte-for-byte current baseline it can perturb.
function seedGallery(t) {
  const { tempDir, script } = stageGenerator(t, "message-state-assets-check-");
  const generate = runGenerator(tempDir, script);
  assert.equal(generate.status, 0, generate.stderr);
  return { tempDir, script };
}

function galleryFiles(tempDir) {
  return fs
    .readdirSync(path.join(tempDir, "assets"))
    .filter((name) => name.endsWith(".svg"))
    .sort();
}

test("check mode passes against the committed gallery", () => {
  const result = runGenerator(root, generator, ["--check"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /generated message-state SVGs are current/i);
});

test("check mode reports a missing generated asset", (t) => {
  const { tempDir, script } = seedGallery(t);
  const [target] = galleryFiles(tempDir);
  fs.rmSync(path.join(tempDir, "assets", target));

  const result = runGenerator(tempDir, script, ["--check"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`missing:\\s+assets/${target}`));
});

test("check mode reports a stale generated asset", (t) => {
  const { tempDir, script } = seedGallery(t);
  const [target] = galleryFiles(tempDir);
  const targetPath = path.join(tempDir, "assets", target);
  fs.writeFileSync(
    targetPath,
    `${fs.readFileSync(targetPath, "utf8")}<!--x-->`,
  );

  const result = runGenerator(tempDir, script, ["--check"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`stale:\\s+assets/${target}`));
});

test("check mode never rewrites file contents or modification times", (t) => {
  const { tempDir, script } = seedGallery(t);
  const files = galleryFiles(tempDir);
  const before = files.map((name) => {
    const filePath = path.join(tempDir, "assets", name);
    return {
      name,
      bytes: fs.readFileSync(filePath),
      mtimeMs: fs.statSync(filePath).mtimeMs,
    };
  });

  const result = runGenerator(tempDir, script, ["--check"]);
  assert.equal(result.status, 0, result.stderr);

  for (const record of before) {
    const filePath = path.join(tempDir, "assets", record.name);
    assert.deepEqual(fs.readFileSync(filePath), record.bytes);
    assert.equal(fs.statSync(filePath).mtimeMs, record.mtimeMs);
  }
});

test("normal mode still writes the full generated gallery", (t) => {
  const { tempDir, script } = stageGenerator(t, "message-state-assets-write-");

  const result = runGenerator(tempDir, script);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\ndone\n?$/);

  const generated = galleryFiles(tempDir);
  assert.equal(generated.length, 70);
  for (const name of generated) {
    assert.deepEqual(
      fs.readFileSync(path.join(tempDir, "assets", name)),
      fs.readFileSync(path.join(root, "assets", name)),
      `${name} should match the committed asset`,
    );
  }
});

test("unknown options exit nonzero with usage guidance", () => {
  const result = runGenerator(root, generator, ["--bogus"]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option/);
  assert.match(result.stderr, /Usage: node tools\/gen-message-state-svgs\.mjs/);
});
