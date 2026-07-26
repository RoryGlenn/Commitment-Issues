// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildAdvisoryMessage,
  buildCommitFixHistoryRefusalMessage,
  buildCommitFixOperationRefusalMessage,
  buildConcurrentFixRefusalMessage,
} from "../scripts/lib/message.mjs";
import {
  cleanupTempRepo,
  createTempRepo,
  run,
  setPrecommitConfig,
  writeFile,
} from "./helpers/temp-repo.mjs";

test("precommit uses fun tone from package config", (t) => {
  const tempDir = createTempRepo();
  t.after(() => cleanupTempRepo(tempDir));

  setPrecommitConfig(tempDir, { tone: "fun" });
  writeFile(
    path.join(tempDir, "src", "lonely.mjs"),
    "export const lonely = 1;\n",
  );

  run("git", ["add", "src/lonely.mjs"], tempDir);

  const result = run("node", ["scripts/precommit.mjs"], tempDir);
  const text = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0);
  assert.match(text, /Relationship notes/);
  assert.match(text, /Pre-commit suggestions found/);
});

// Each canonical (standard-tone) message string has a fun-tone rewrite in
// funIssueMessage. Exercise every variant in-process, singular and plural,
// so the regex mappings stay in sync with the wording precommit produces.
function funText(message, autoFixable = false) {
  return buildAdvisoryMessage([{ type: "check", autoFixable, message }], {
    tone: "fun",
  }).lines.join("\n");
}

test("fun tone rewrites the Prettier formatting message", () => {
  assert.match(
    funText("1 file need Prettier formatting", true),
    /1 file told Prettier "this is just how I am"/,
  );
  assert.match(
    funText("2 files need Prettier formatting", true),
    /2 files told Prettier "this is just how we are"/,
  );
});

test("fun tone rewrites the missing unit tests message", () => {
  assert.match(
    funText("1 staged source file missing unit tests"),
    /1 staged source file won't commit to a unit test/,
  );
  assert.match(
    funText("2 staged source files missing unit tests"),
    /2 staged source files won't commit to unit tests/,
  );
});

test("fun tone rewrites the manual ESLint issues message", () => {
  assert.match(
    funText("1 ESLint issue needing manual fixes"),
    /1 ESLint issue that flowers won't fix/,
  );
  assert.match(
    funText("2 ESLint issues needing manual fixes"),
    /2 ESLint issues that flowers won't fix/,
  );
});

test("fun tone rewrites the auto-fixable ESLint issues message", () => {
  assert.match(
    funText("1 auto-fixable ESLint issue found", true),
    /1 ESLint issue ready to take you back, no questions asked/,
  );
  assert.match(
    funText("2 auto-fixable ESLint issues found", true),
    /2 ESLint issues ready to take you back, no questions asked/,
  );
});

test("fun tone rewrites the failing staged tests message", () => {
  assert.match(
    funText("1 staged test file failing"),
    /1 staged test file just said "we need to talk"/,
  );
  assert.match(
    funText("2 staged test files failing"),
    /2 staged test files just said "we need to talk"/,
  );
});

test("fun tone rewrites the exact tool timeout and unavailable messages", () => {
  assert.match(
    funText("ESLint timed out"),
    /ESLint needed space and never texted back/,
  );
  assert.match(
    funText("Prettier timed out"),
    /Prettier needed space and never texted back/,
  );
  assert.match(
    funText("Staged tests timed out"),
    /The staged tests needed space and never texted back/,
  );
  assert.match(
    funText("Unable to run ESLint"),
    /ESLint won't even pick up the phone/,
  );
  assert.match(
    funText("Unable to run Prettier"),
    /Prettier won't even pick up the phone/,
  );
  assert.match(
    funText("Unable to run staged tests"),
    /The staged tests won't even pick up the phone/,
  );
  assert.match(
    funText("Staged file-size check unavailable"),
    /would not say how much baggage they are carrying/,
  );
});

test("standard tone keeps the exact tool timeout and unavailable messages", () => {
  const standard = buildAdvisoryMessage([
    { type: "check", autoFixable: false, message: "ESLint timed out" },
  ]).lines.join("\n");
  assert.match(standard, /ESLint timed out/);
});

test("fun tone rewrites the protected-branch message", () => {
  assert.match(
    funText('Committing directly to protected branch "main"'),
    /"main" deserves a feature branch, not surprise commits/,
  );
  assert.match(
    funText('Committing directly to protected branch "release/1.2"'),
    /"release\/1\.2" deserves a feature branch, not surprise commits/,
  );
});

test("fun tone rewrites the large-commit file-count message", () => {
  assert.match(
    funText("Large commit: 1 staged file (limit 0)"),
    /1 staged file — less a commit, more a lifestyle choice/,
  );
  assert.match(
    funText("Large commit: 47 staged files (limit 30)"),
    /47 staged files — less a commit, more a lifestyle choice/,
  );
});

test("fun tone rewrites the large-commit line-count message", () => {
  assert.match(
    funText("Large commit: 1 changed line (limit 0)"),
    /1 changed line — that's not a commit, that's a memoir/,
  );
  assert.match(
    funText("Large commit: 2500 changed lines (limit 2000)"),
    /2500 changed lines — that's not a commit, that's a memoir/,
  );
});

test("fun tone rewrites the oversized staged file message", () => {
  assert.match(
    funText("1 staged file over 5 MB"),
    /1 staged file that should really be seeing Git LFS/,
  );
  assert.match(
    funText("3 staged files over 5 MB"),
    /3 staged files that should really be seeing Git LFS/,
  );
});

test("fun tone rewrites the generated files message", () => {
  assert.match(
    funText("1 generated file staged"),
    /1 generated file trying to sneak into the commit/,
  );
  assert.match(
    funText("4 generated files staged"),
    /4 generated files trying to sneak into the commit/,
  );
});

test("fun tone rewrites the behind-upstream message", () => {
  assert.match(
    funText("Branch is 1 commit behind origin/main"),
    /1 commit behind origin\/main — stacking more chaos on top/,
  );
  assert.match(
    funText("Branch is 7 commits behind origin/main"),
    /7 commits behind origin\/main — stacking more chaos on top/,
  );
});

test("fun tone rewrites the possible secrets message", () => {
  assert.match(
    funText("1 possible secret staged"),
    /1 possible secret this commit can't keep/,
  );
  assert.match(
    funText("2 possible secrets staged"),
    /2 possible secrets this commit can't keep/,
  );
});

test("fun tone rewrites debug-artifact findings and unavailable scans", () => {
  assert.match(
    funText("1 temporary debug artifact staged"),
    /1 temporary debug artifact hoping nobody notices/,
  );
  assert.match(
    funText("3 temporary debug artifacts staged"),
    /3 temporary debug artifacts hoping nobody notices/,
  );
  assert.match(
    funText("Debug artifact scan unavailable"),
    /could not get a straight answer from Git/,
  );
});

test("fun tone passes unrecognized messages through unchanged", () => {
  assert.match(
    funText("something completely bespoke happened"),
    /something completely bespoke happened/,
  );
});

test("fun tone rewrites concurrent fixer refusals", () => {
  const staged = buildConcurrentFixRefusalMessage({
    operation: "stage",
    tone: "fun",
    rerunCommand: "npm run fix:staged",
  });
  const amended = buildConcurrentFixRefusalMessage({
    operation: "amend",
    tone: "fun",
    rerunCommand: "npm run commit:fix",
  });

  assert.match(
    staged.lines.join("\n"),
    /repository changed the relationship status mid-fix/i,
  );
  assert.match(
    staged.lines.join("\n"),
    /No surprise changes were invited into the commit/,
  );
  assert.match(
    amended.lines.join("\n"),
    /latest commit was left out of the drama/i,
  );
});

test("fun tone rewrites every commit-fix history refusal", () => {
  const messages = {
    detached: buildCommitFixHistoryRefusalMessage({
      reason: "detached",
      tone: "fun",
    }).lines.join("\n"),
    signed: buildCommitFixHistoryRefusalMessage({
      reason: "signed",
      tone: "fun",
    }).lines.join("\n"),
    retained: buildCommitFixHistoryRefusalMessage({
      reason: "retained",
      tone: "fun",
      references: ["refs/tags/reviewed"],
    }).lines.join("\n"),
    inspection: buildCommitFixHistoryRefusalMessage({
      reason: "inspection",
      tone: "fun",
    }).lines.join("\n"),
  };

  assert.match(messages.detached, /no branch to come home to/i);
  assert.match(messages.signed, /proper second ceremony/i);
  assert.match(messages.retained, /already seeing another Git ref/i);
  assert.match(messages.inspection, /relationship status/i);
});

test("fun tone rewrites commit-fix operation refusals", () => {
  const active = buildCommitFixOperationRefusalMessage({
    operation: "git am",
    tone: "fun",
    rerunCommand: "npm run commit:fix",
  }).lines.join("\n");
  const inspection = buildCommitFixOperationRefusalMessage({
    tone: "fun",
    rerunCommand: "npm run commit:fix",
  }).lines.join("\n");

  assert.match(active, /already in a complicated relationship/i);
  assert.match(active, /git am is still in progress/i);
  assert.match(active, /left exactly where it was/i);
  assert.match(inspection, /would not explain its relationship status/i);
  assert.match(inspection, /fixer is staying out of it/i);
});
