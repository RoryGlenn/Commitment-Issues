// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseMetadata } from "../tools/validate-release-metadata.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const validatorPath = path.join(
  repositoryRoot,
  "tools",
  "validate-release-metadata.mjs",
);
const ledgerPath = path.join(".github", "release-history.json");
const actualLedger = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, ledgerPath), "utf8"),
);
const reviewedNotes = "### Fixed\n\n- Exact reviewed release notes.";
const validChangelog = `# Changelog

## [Unreleased]

### Added

- Work for a later release.

## [3.3.2] - 2026-07-12

${reviewedNotes}

## [3.3.1] - 2026-07-12

### Fixed

- Historical attempted release.
`;

function writeJson(root, relativePath, value) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "commitment-issues-release-metadata-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(root, "package.json", {
    name: "commitment-issues",
    version: "3.3.2",
  });
  writeJson(root, "package-lock.json", {
    name: "commitment-issues",
    version: "3.3.2",
    lockfileVersion: 3,
    packages: {
      "": { name: "commitment-issues", version: "3.3.2" },
    },
  });
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), validChangelog);
  writeJson(root, ledgerPath, actualLedger);
  return root;
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function mutateJson(root, relativePath, mutate) {
  const value = readJson(root, relativePath);
  mutate(value);
  writeJson(root, relativePath, value);
}

function runCli(root, args = []) {
  return spawnSync(process.execPath, [validatorPath, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

test("the repository release metadata is consistent without a historical exception", () => {
  const result = validateReleaseMetadata({ root: repositoryRoot });

  assert.equal(result.version, "3.5.1");
  assert.equal(result.tag, "v3.5.1");
  assert.equal(result.title, result.tag);
  assert.match(result.notes, /exact copy of the\s+active Git index/u);
  assert.equal(result.historical, null);
});

test("a prospective release validates without a historical exception", (t) => {
  const root = createFixture(t);
  mutateJson(root, "package.json", (pkg) => {
    pkg.version = "3.3.3";
  });
  mutateJson(root, "package-lock.json", (lock) => {
    lock.version = "3.3.3";
    lock.packages[""].version = "3.3.3";
  });
  fs.writeFileSync(
    path.join(root, "CHANGELOG.md"),
    validChangelog.replace(
      "## [3.3.2] - 2026-07-12",
      "## [3.3.3] - 2026-07-15",
    ),
  );

  const result = validateReleaseMetadata({ root, tag: "v3.3.3" });
  assert.equal(result.version, "3.3.3");
  assert.equal(result.title, "v3.3.3");
  assert.equal(result.notes, reviewedNotes);
  assert.equal(result.historical, null);
});

test("the legacy ledger precisely classifies the three immutable historical states", () => {
  assert.equal(actualLedger.policy.releaseNotesRequiredAfter, "3.3.2");
  assert.deepEqual(
    actualLedger.releases.map(
      ({ version, classification, releaseNotesState }) => ({
        classification,
        releaseNotesState,
        version,
      }),
    ),
    [
      {
        version: "3.3.0",
        classification: "published-partial-legacy-empty-notes",
        releaseNotesState: "legacy-empty",
      },
      {
        version: "3.3.1",
        classification: "consumed-tag-unpublished",
        releaseNotesState: "not-applicable",
      },
      {
        version: "3.3.2",
        classification: "artifact-complete-legacy-empty-notes",
        releaseNotesState: "legacy-empty",
      },
    ],
  );

  const consumed = actualLedger.releases[1];
  assert.equal(
    consumed.tagObjectSha,
    "93981768f8a1b9872fd36494b822b614a6338019",
  );
  assert.equal(consumed.commitSha, "b37d060139717460c20ea0de87b38ca7e18d7d64");
  assert.deepEqual(consumed.workflowRun, {
    id: 29193471004,
    conclusion: "startup_failure",
    url: "https://github.com/RoryGlenn/commitment-issues/actions/runs/29193471004",
  });
  assert.equal(consumed.npm.state, "absent");
  assert.equal(consumed.githubRelease.state, "absent");
  assert.equal(consumed.replacement, "3.3.2");
});

test("validation extracts only the exact current section and writes reviewed notes", (t) => {
  const root = createFixture(t);
  const outputDirectory = path.join(root, "release output");
  const output = path.join(outputDirectory, "notes ü.md");
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(output, "stale\n");

  const result = validateReleaseMetadata({
    root,
    tag: "v3.3.2",
    notesFile: output,
  });

  assert.equal(result.notes, reviewedNotes);
  assert.equal(result.title, "v3.3.2");
  assert.equal(fs.readFileSync(output, "utf8"), `${reviewedNotes}\n`);
  assert.doesNotMatch(result.notes, /Historical attempted release/u);
});

for (const fixture of [
  {
    name: "missing package.json",
    change(root) {
      fs.rmSync(path.join(root, "package.json"));
    },
    expected: /Unable to read package\.json/u,
  },
  {
    name: "malformed package.json",
    change(root) {
      fs.writeFileSync(path.join(root, "package.json"), "{\n");
    },
    expected: /package\.json is not valid JSON/u,
  },
  {
    name: "missing package version",
    change(root) {
      mutateJson(root, "package.json", (pkg) => delete pkg.version);
    },
    expected: /package\.json version.*exact semantic version.*<missing>/u,
  },
  {
    name: "malformed package version",
    change(root) {
      mutateJson(root, "package.json", (pkg) => {
        pkg.version = "v3.3";
      });
    },
    expected: /package\.json version.*exact semantic version.*v3\.3/u,
  },
]) {
  test(`validation rejects ${fixture.name}`, (t) => {
    const root = createFixture(t);
    fixture.change(root);
    assert.throws(() => validateReleaseMetadata({ root }), fixture.expected);
  });
}

for (const fixture of [
  {
    name: "missing top-level lockfile version",
    change(lock) {
      delete lock.version;
    },
    expected: /package-lock\.json top-level version.*3\.3\.2.*<missing>/u,
  },
  {
    name: "mismatched top-level lockfile version",
    change(lock) {
      lock.version = "3.3.1";
    },
    expected: /package-lock\.json top-level version.*3\.3\.2.*3\.3\.1/u,
  },
  {
    name: "missing lockfile root package version",
    change(lock) {
      delete lock.packages[""].version;
    },
    expected: /package-lock\.json packages\[""\] version.*3\.3\.2.*<missing>/u,
  },
  {
    name: "mismatched lockfile root package version",
    change(lock) {
      lock.packages[""].version = "3.3.0";
    },
    expected: /package-lock\.json packages\[""\] version.*3\.3\.2.*3\.3\.0/u,
  },
]) {
  test(`validation rejects ${fixture.name}`, (t) => {
    const root = createFixture(t);
    mutateJson(root, "package-lock.json", fixture.change);
    assert.throws(() => validateReleaseMetadata({ root }), fixture.expected);
  });
}

test("validation rejects a missing or malformed package lock", (t) => {
  const root = createFixture(t);
  fs.rmSync(path.join(root, "package-lock.json"));
  assert.throws(
    () => validateReleaseMetadata({ root }),
    /Unable to read package-lock\.json/u,
  );

  fs.writeFileSync(path.join(root, "package-lock.json"), "not json\n");
  assert.throws(
    () => validateReleaseMetadata({ root }),
    /package-lock\.json is not valid JSON/u,
  );
});

for (const fixture of [
  {
    name: "a missing current section",
    changelog: validChangelog.replace("3.3.2", "3.4.0"),
    expected: /missing a release heading.*3\.3\.2/u,
  },
  {
    name: "a malformed current heading",
    changelog: validChangelog.replace("## [3.3.2] - 2026-07-12", "## [3.3.2]"),
    expected: /heading.*malformed.*## \[3\.3\.2\] - YYYY-MM-DD/u,
  },
  {
    name: "an impossible release date",
    changelog: validChangelog.replace("2026-07-12", "2026-02-31"),
    expected: /3\.3\.2 has invalid date.*2026-02-31/u,
  },
  {
    name: "duplicate current headings",
    changelog: `${validChangelog}\n## [3.3.2] - 2026-07-13\n\n- Duplicate.\n`,
    expected: /duplicate release headings for 3\.3\.2/u,
  },
  {
    name: "blank release notes",
    changelog: validChangelog.replace(reviewedNotes, "   "),
    expected: /3\.3\.2 must contain substantive reviewed release notes/u,
  },
  {
    name: "a section containing only a Markdown subheading",
    changelog: validChangelog.replace(reviewedNotes, "### Fixed"),
    expected: /3\.3\.2 must contain substantive reviewed release notes/u,
  },
]) {
  test(`validation rejects CHANGELOG.md with ${fixture.name}`, (t) => {
    const root = createFixture(t);
    fs.writeFileSync(path.join(root, "CHANGELOG.md"), fixture.changelog);
    assert.throws(() => validateReleaseMetadata({ root }), fixture.expected);
  });
}

test("validation rejects missing and mismatched release tags", (t) => {
  const root = createFixture(t);
  for (const tag of ["3.3.2", "v3.3.1", "release-3.3.2", ""]) {
    assert.throws(
      () => validateReleaseMetadata({ root, tag }),
      /Release tag must exactly match package\.json as v3\.3\.2/u,
    );
  }
});

test("HTML comments do not count as substantive release notes", (t) => {
  const root = createFixture(t);
  for (const replacement of [
    "<!-- internal release reminder -->",
    "<!-- unclosed internal release reminder",
    "<!-- nested <!-- reminder -->",
  ]) {
    fs.writeFileSync(
      path.join(root, "CHANGELOG.md"),
      validChangelog.replace(reviewedNotes, replacement),
    );
    assert.throws(
      () => validateReleaseMetadata({ root }),
      /must contain substantive reviewed release notes/u,
    );
  }

  fs.writeFileSync(
    path.join(root, "CHANGELOG.md"),
    validChangelog.replace(
      reviewedNotes,
      `<!-- internal reminder -->\n\n${reviewedNotes}`,
    ),
  );
  assert.equal(
    validateReleaseMetadata({ root }).notes.includes(reviewedNotes),
    true,
  );
});

for (const fixture of [
  {
    name: "missing ledger",
    change(root) {
      fs.rmSync(path.join(root, ledgerPath));
    },
    expected: /Unable to read \.github[\\/]release-history\.json/u,
  },
  {
    name: "malformed ledger JSON",
    change(root) {
      fs.writeFileSync(path.join(root, ledgerPath), "{\n");
    },
    expected: /release-history\.json is not valid JSON/u,
  },
  {
    name: "unsupported ledger schema",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.schemaVersion = 2;
      });
    },
    expected: /schemaVersion must be 1/u,
  },
  {
    name: "changed prospective notes cutoff",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.policy.releaseNotesRequiredAfter = "3.3.3";
      });
    },
    expected: /releaseNotesRequiredAfter must remain 3\.3\.2/u,
  },
  {
    name: "duplicate historical version",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases.push(structuredClone(ledger.releases[0]));
      });
    },
    expected: /duplicate version 3\.3\.0/u,
  },
  {
    name: "a prospective ledger exception",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        const prospective = structuredClone(ledger.releases[2]);
        prospective.version = "3.3.3";
        prospective.tag = "v3.3.3";
        ledger.releases.push(prospective);
      });
    },
    expected: /version 3\.3\.3 is after the legacy-notes cutoff 3\.3\.2/u,
  },
  {
    name: "missing consumed-tag classification",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases = ledger.releases.filter(
          ({ version }) => version !== "3.3.1",
        );
      });
    },
    expected: /must retain the historical 3\.3\.1 classification/u,
  },
  {
    name: "unknown ledger field",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases[0].unreviewed = true;
      });
    },
    expected: /releases\[0\].*must contain exactly.*unreviewed/u,
  },
  {
    name: "unsupported release-note state",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases[0].releaseNotesState = "unknown";
      });
    },
    expected:
      /releaseNotesState must be reviewed, legacy-empty, or not-applicable/u,
  },
  {
    name: "release-note state that contradicts classification",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases[1].releaseNotesState = "legacy-empty";
      });
    },
    expected: /releaseNotesState contradicts consumed-tag-unpublished/u,
  },
  {
    name: "published npm evidence for the unpublished consumed tag",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases[1].npm = {
          state: "published",
          url: "https://www.npmjs.com/package/commitment-issues/v/3.3.1",
        };
      });
    },
    expected: /npm\.state contradicts consumed-tag-unpublished/u,
  },
  {
    name: "altered immutable workflow evidence",
    change(root) {
      mutateJson(root, ledgerPath, (ledger) => {
        ledger.releases[1].workflowRun.id = 29193471005;
        ledger.releases[1].workflowRun.url =
          "https://github.com/RoryGlenn/commitment-issues/actions/runs/29193471005";
      });
    },
    expected: /historical 3\.3\.1 workflowId must be 29193471004/u,
  },
]) {
  test(`validation rejects ${fixture.name}`, (t) => {
    const root = createFixture(t);
    fixture.change(root);
    assert.throws(() => validateReleaseMetadata({ root }), fixture.expected);
  });
}

test("notes output stays inside the repository and cannot overwrite protected inputs", (t) => {
  const root = createFixture(t);
  assert.throws(
    () => validateReleaseMetadata({ root, notesFile: "CHANGELOG.md" }),
    /Refusing to overwrite release metadata input/u,
  );

  const target = path.join(root, "target.md");
  const link = path.join(root, "notes.md");
  fs.writeFileSync(target, "preserve\n");
  fs.symlinkSync(target, link);
  assert.throws(
    () => validateReleaseMetadata({ root, notesFile: link }),
    /Notes output must be a regular file/u,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "preserve\n");

  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), "commitment-issues-release-notes-outside-"),
  );
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(
    () =>
      validateReleaseMetadata({
        root,
        notesFile: path.join(outside, "notes.md"),
      }),
    /Notes output directory must stay within the release root/u,
  );

  const linkedDirectory = path.join(root, "linked-output");
  fs.symlinkSync(outside, linkedDirectory);
  assert.throws(
    () =>
      validateReleaseMetadata({
        root,
        notesFile: path.join(linkedDirectory, "notes.md"),
      }),
    /Notes output directory must stay within the release root/u,
  );
});

test("the CLI validates defaults and writes a path with spaces without a shell", (t) => {
  const root = createFixture(t);
  const directory = path.join(root, "notes output");
  const output = path.join(directory, "v3.3.2 notes.md");
  fs.mkdirSync(directory);
  const result = runCli(root, ["--tag", "v3.3.2", "--notes-file", output]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /consistent for v3\.3\.2/u);
  assert.equal(fs.readFileSync(output, "utf8"), `${reviewedNotes}\n`);

  const defaults = runCli(root);
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.match(defaults.stdout, /consistent for v3\.3\.2/u);
});

for (const fixture of [
  {
    name: "unknown options",
    args: ["--unknown"],
    expected: /Unknown release metadata option: --unknown/u,
  },
  {
    name: "duplicate tags",
    args: ["--tag", "v3.3.2", "--tag", "v3.3.2"],
    expected: /--tag may be provided only once/u,
  },
  {
    name: "duplicate notes files",
    args: ["--notes-file", "one.md", "--notes-file", "two.md"],
    expected: /--notes-file may be provided only once/u,
  },
  {
    name: "a missing tag value",
    args: ["--tag"],
    expected: /--tag requires a value/u,
  },
  {
    name: "a tag value replaced by another option",
    args: ["--tag", "--notes-file", "notes.md"],
    expected: /--tag requires a value/u,
  },
  {
    name: "a missing notes-file value",
    args: ["--notes-file"],
    expected: /--notes-file requires a value/u,
  },
]) {
  test(`the CLI rejects ${fixture.name}`, (t) => {
    const root = createFixture(t);
    const result = runCli(root, fixture.args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, fixture.expected);
  });
}
