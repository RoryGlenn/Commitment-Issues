// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KNOWN_PRECOMMIT_CONFIG_KEYS } from "../scripts/lib/config.mjs";
import { DCO_ENFORCEMENT_BASELINE } from "../tools/check-dco-range.mjs";
import { globToRegExp } from "../scripts/lib/files.mjs";
import { run } from "../scripts/lib/process.mjs";
import {
  BRANCH_COVERAGE_EXCLUDED_SOURCE_FILES,
  BRANCH_COVERAGE_SOURCE_FILES,
  RUNTIME_COVERAGE_THRESHOLD,
  updateReadmeCoverageBadge,
} from "../scripts/lib/coverage-badge.mjs";
import {
  findBrokenPackedMarkdownLinks,
  formatBrokenMarkdownLink,
} from "../tools/packed-markdown-links.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DCO_POLICY_ADOPTION_BASELINE = "81a9e412bc347f01300df62505ee378284646d15";
const DCO_PRIOR_OPERATIONAL_BASELINE =
  "265d2e6c9c12349a1c06fa8a9a6c6d3ac957e6d5";

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function readText(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownProse(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) =>
      block
        .split(/\r?\n/)
        .map(() => "")
        .join("\n"),
    )
    .replace(/`([^`\n]+)`/g, "$1");
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function markdownTableKeys(markdown, heading) {
  const section = markdown.split(heading)[1]?.split(/\n##\s/)[0] ?? "";
  return [...section.matchAll(/^\|\s*`([a-z][A-Za-z0-9]*)`\s*\|/gm)].map(
    ([, key]) => key,
  );
}

function packageFilePatterns(pkg) {
  return new Set(pkg.files || []);
}

function isPackaged(relativePath, pkg) {
  const patterns = packageFilePatterns(pkg);
  return (
    patterns.has(relativePath) ||
    [...patterns].some((pattern) => {
      if (pattern.endsWith("/")) {
        return relativePath.startsWith(pattern);
      }
      return globToRegExp(pattern).test(relativePath);
    })
  );
}

function readmeImagePaths(readme) {
  const markdownImages = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(
    ([, imagePath]) => imagePath,
  );
  const htmlImages = [
    ...readme.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi),
  ].map(([, imagePath]) => imagePath);
  return [...markdownImages, ...htmlImages];
}

function relativeModuleSpecifiers(source) {
  return [
    ...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/gu),
    ...source.matchAll(/^\s*import\s+["'](\.[^"']+)["']/gmu),
    ...source.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/gu),
  ].map((match) => match[1]);
}

function cliDispatchTargets(source) {
  return [
    ...source.matchAll(/const (?:PUBLIC|HIDDEN)_COMMANDS = \{([\s\S]*?)\};/gu),
  ]
    .flatMap(([, block]) => [...block.matchAll(/:\s*["']([^"']+\.mjs)["']/gu)])
    .map(([, target]) => `scripts/${target}`);
}

test("package-lock root metadata stays in sync with package.json", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const rootPackage = lock.packages[""];

  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(rootPackage.name, pkg.name);
  assert.equal(rootPackage.version, pkg.version);
  assert.deepEqual(rootPackage.bin, pkg.bin);
  assert.deepEqual(rootPackage.engines, pkg.engines);
  assert.deepEqual(rootPackage.dependencies, pkg.dependencies);
  assert.deepEqual(rootPackage.devDependencies, pkg.devDependencies);
  assert.deepEqual(rootPackage.peerDependencies, pkg.peerDependencies);
});

test("package-manager lifecycle CI covers supported OSes and the Node floor", () => {
  const pkg = readJson("package.json");
  const lock = readJson("package-lock.json");
  const berryFixture = readJson("test/fixtures/yarn-berry/package.json");
  const berryLock = readJson("test/fixtures/yarn-berry/package-lock.json");
  const lifecycle = readText("test/integration/helpers/lifecycle-fixture.mjs");
  const workflow = readText(".github/workflows/ci.yml");
  const windowsNpmJob = workflow
    .split(/^ {2}windows-npm-lifecycle:$/m)[1]
    ?.split(/^ {2}shell-compat:$/m)[0];
  const job = workflow
    .split(/^ {2}pm-lifecycle:$/m)[1]
    ?.split(/^ {2}ci-success:$/m)[0];
  assert.ok(job, "ci.yml should define the pm-lifecycle job");
  assert.ok(
    windowsNpmJob,
    "ci.yml should define the parallel Windows npm lifecycle job",
  );

  assert.match(windowsNpmJob, /runs-on: windows-latest/);
  assert.match(windowsNpmJob, /node-version: \["22\.11\.0", "24"\]/);
  assert.match(
    windowsNpmJob,
    /run: node tools\/run-prebuilt-lifecycle-test\.mjs/,
  );

  assert.match(job, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(job, /node-version: \["24"\]/);
  for (const manager of ["pnpm", "yarn", "yarn-berry", "bun"]) {
    assert.match(
      job,
      new RegExp(
        `- pm: ${manager}\\s+os: ubuntu-latest\\s+node-version: "22\\.11\\.0"`,
      ),
    );
  }
  assert.equal(pkg.devDependencies.yarn, "1.22.22");
  assert.equal(
    pkg.scripts["test:lifecycle:yarn-berry"],
    "node scripts/run-lifecycle-test.mjs yarn-berry",
  );
  assert.equal(
    pkg.scripts["test:migration:yarn"],
    "node tools/run-migration-lifecycle-test.mjs yarn",
  );
  assert.deepEqual(
    Object.keys(pkg.scripts).filter((name) => name.startsWith("test:smoke")),
    [],
    "the structured lifecycle suite should have one canonical script family",
  );
  assert.equal(lock.packages["node_modules/yarn"].version, "1.22.22");
  assert.match(lock.packages["node_modules/yarn"].integrity, /^sha512-/);
  assert.equal(berryFixture.dependencies["@yarnpkg/cli-dist"], "4.17.0");
  assert.equal(
    berryLock.packages[""].dependencies["@yarnpkg/cli-dist"],
    "4.17.0",
  );
  assert.equal(
    berryLock.packages["node_modules/@yarnpkg/cli-dist"].version,
    "4.17.0",
  );
  assert.match(
    berryLock.packages["node_modules/@yarnpkg/cli-dist"].integrity,
    /^sha512-/,
  );
  assert.doesNotMatch(job, /npm install --global yarn/u);
  assert.match(
    job,
    /npm ci --ignore-scripts --prefix test\/fixtures\/yarn-berry/u,
  );
  assert.match(
    job,
    /npm audit --audit-level=high --prefix test\/fixtures\/yarn-berry/u,
  );
  assert.match(job, /Yarn Classic 1\.22\.22 lifecycle integration/u);
  assert.match(job, /Yarn Berry 4\.17\.0 node-modules lifecycle integration/u);
  assert.match(job, /bun-version: "1\.3\.14"/);
  assert.match(
    lifecycle,
    /function yarnBerryTarballSpec\(tarball, tempRoot\)[\s\S]*?sha256\(artifact\) === sha256\(tarball\)[\s\S]*?return "commitment-issues@file:\.\.\/yarn-berry-artifact\/commitment-issues\.tgz"/u,
    "Yarn Berry should receive an identified, digest-checked relative tarball locator",
  );
  assert.match(
    lifecycle,
    /case "yarn-berry":[\s\S]*?yarnBerryTarballSpec\(tarball, tempRoot\)[\s\S]*?case "bun":/u,
    "the Yarn Berry install should use the portable staged locator",
  );
});

test("public Bun support stays pinned to the exact CI-tested version", () => {
  for (const file of [
    "README.md",
    "CHANGELOG.md",
    ".github/skills/github-governance/SKILL.md",
    "docs/compatibility.md",
    "docs/faq.md",
    "docs/scenario-coverage.md",
  ]) {
    const contents = readText(file);
    assert.match(contents, /Bun 1\.3\.14/, `${file} should name Bun 1.3.14`);
    assert.doesNotMatch(
      contents,
      /Bun 1\.3(?!\.14)/,
      `${file} should not broaden Bun support beyond CI evidence`,
    );
  }
});

test("public Yarn support keeps Classic and Berry evidence distinct", () => {
  for (const file of [
    "README.md",
    "docs/compatibility.md",
    "docs/faq.md",
    "docs/scenario-coverage.md",
    "docs/yarn-berry.md",
  ]) {
    const contents = readText(file);
    assert.match(contents, /Yarn Classic 1\.22\.22/u);
    assert.match(contents, /Yarn Berry 4\.17\.0/u);
    assert.match(contents, /nodeLinker: node-modules/u);
    assert.match(contents, /Plug'n'Play[^.\n]*(?:unsupported|not supported)/iu);
  }
});

test("the hook contract documents local-only missing-bin behavior", () => {
  const contract = readText("docs/external-interface.md");
  const configuration = readText("docs/configuration.md");
  assert.match(contract, /node_modules\/\.bin\/commitment-issues precommit/);
  assert.match(contract, /skip notice to stderr and exit 0/);
  assert.match(contract, /ordered project-local launcher/u);
  assert.match(contract, /\.exe.*\.cmd.*\.bat/u);
  assert.match(contract, /never\s+consults `PATH`/u);
  assert.match(contract, /selected launcher's nonzero result/u);
  assert.doesNotMatch(contract, /exit silently/);
  assert.match(
    configuration,
    /health verifier accepts only the exact generated candidate-selector line/u,
  );
  assert.match(
    configuration,
    /terminal `exec` forms, remain recognizable only for cleanup and remediation/u,
  );
  assert.doesNotMatch(configuration, /verifier also accepts/u);
});

test("bootstrap dependency ranges stay inside the verified Node and tool matrix", () => {
  const pkg = readJson("package.json");
  assert.deepEqual(pkg.peerDependencies, {
    eslint: "^9.0.0 || ^10.0.0",
    prettier: "^3.0.0",
  });
  assert.match(
    readText("test/integration/helpers/lifecycle-fixture.mjs"),
    /"globals@\^17"/,
  );

  for (const file of [
    "README.md",
    "docs/framework-recipes.md",
    "docs/how-it-works.md",
    "docs/migration.md",
    "docs/monorepo.md",
    "docs/yarn-berry.md",
  ]) {
    const contents = readText(file);
    assert.match(contents, /eslint@\^9/);
    assert.match(contents, /prettier@\^3/);
  }
});

test("the published package has no dependency install lifecycle scripts", () => {
  const pkg = readJson("package.json");
  for (const script of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(
      Object.hasOwn(pkg.scripts ?? {}, script),
      false,
      `${script} should not make a dependency install execute package code`,
    );
  }
  assert.equal(pkg.scripts.doctor, "node scripts/doctor.mjs");
});

test("contributor guidance separates first-time setup from hook repair", () => {
  const pkg = readJson("package.json");
  const contributing = readText(".github/CONTRIBUTING.md");
  const configuration = readText("docs/configuration.md");
  const messageStates = readText("docs/message-states.md");
  const readme = readText("README.md");
  const firstTime = "**First-time setup: `npm ci`**";
  const repair = "**Verify or repair the hooks anytime: `npm run doctor`**";

  assert.ok(contributing.includes(firstTime));
  assert.ok(contributing.includes(repair));
  assert.ok(contributing.indexOf(firstTime) < contributing.indexOf(repair));
  assert.match(
    configuration,
    /Verify or repair the hooks anytime: pnpm run doctor/,
  );
  assert.match(
    messageStates,
    /Verify or repair the hooks anytime: npm run doctor/,
  );
  assert.doesNotMatch(messageStates, /Check your setup anytime/);
  assert.match(readme, /\[contribution guide\]\([^)]*CONTRIBUTING\.md\)/u);
  assert.equal(Object.hasOwn(pkg.scripts, "setup"), false);
  assert.doesNotMatch(contributing, /npm run setup/);
});

test("husky and lint-staged stay out of the dependency tree", () => {
  const pkg = readJson("package.json");
  // v3 owns the hook wiring (.git/hooks) and the staged-fix pipeline
  // directly; reintroducing either package would be an architectural
  // regression, not a routine dependency add.
  for (const banned of ["husky", "lint-staged"]) {
    assert.equal(banned in (pkg.dependencies ?? {}), false);
    assert.equal(banned in (pkg.devDependencies ?? {}), false);
    assert.equal(banned in (pkg.peerDependencies ?? {}), false);
  }
});

test("optional commitlint integration adds no package dependency", () => {
  const pkg = readJson("package.json");
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of Object.keys(pkg[section] ?? {})) {
      assert.doesNotMatch(
        name,
        /^(?:@commitlint\/|commitlint$)/,
        `${name} must remain consumer-provided, not a package ${section} entry`,
      );
    }
  }
  assert.equal(isPackaged("scripts/commit-msg.mjs", pkg), true);
});

test("commit-message schema and local-only boundary are documented", () => {
  const docs = readText("docs/configuration.md");
  for (const key of ["commitMessage", "enabled", "blockOnFailure"]) {
    assert.match(docs, new RegExp(`\\b${key}\\b`));
  }
  assert.match(docs, /node_modules\/\.bin\/commitlint/);
  assert.match(
    docs,
    /never falls back to `npx`, a global\s+binary, or the network/,
  );
  assert.match(docs, /does not add commitlint as a dependency/);
  assert.match(docs, /does not.*built-in.*Conventional Commits/is);
});

test("bin entries are tracked with the executable bit", () => {
  const pkg = readJson("package.json");
  // npm's fix-bin chmods bins for registry installs, but git clones and
  // `file:` self-links (this repo's own hooks) use the tracked mode as-is.
  // Without 100755 the generated hooks silently self-neutralize.
  for (const binPath of Object.values(pkg.bin ?? {})) {
    const output = execFileSync("git", ["ls-files", "-s", "--", binPath], {
      cwd: root,
      encoding: "utf8",
    });
    const mode = output.trim().split(/\s+/)[0];
    assert.equal(mode, "100755", `${binPath} must be tracked as 100755`);
  }
});

test("README documents the package engine exactly", () => {
  const pkg = readJson("package.json");
  const readme = readText("README.md");
  const engine = escapeRegExp(pkg.engines.node);

  assert.match(readme, new RegExp(`Node(?:\\.js)?\\s+${engine}`));
});

test("supported Node version stays consistent across docs and workflows", () => {
  const pkg = readJson("package.json");
  const version = pkg.engines.node.match(/\d+\.\d+\.\d+/)?.[0];
  assert.ok(version, "engines.node should pin a concrete version");

  // Every surface that states the supported Node version should track
  // package.json engines.node, so a Node bump cannot silently leave one behind.
  const surfaces = [
    "README.md",
    "docs/faq.md",
    "docs/configuration.md",
    "docs/branch-coverage.md",
    ".github/CONTRIBUTING.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/copilot-instructions.md",
    ".github/workflows/ci.yml",
    ".github/skills/authoring-checks/SKILL.md",
    ".github/skills/github-governance/SKILL.md",
    "ADOPTION.md",
  ];

  for (const file of surfaces) {
    assert.ok(
      readText(file).includes(version),
      `${file} should reference the supported Node version ${version} from package.json engines.node`,
    );
  }
});

test("repository metadata uses canonical sponsor and version values", () => {
  const funding = readText(".github/FUNDING.yml");
  const bugReport = readText(".github/ISSUE_TEMPLATE/bug_report.yml");

  assert.match(funding, /^ko_fi:\s+roryglenn\s*$/m);
  assert.doesNotMatch(funding, /^ko_fi:\s+https?:\/\//m);
  assert.match(bugReport, /npx --no-install commitment-issues --version/);
  assert.doesNotMatch(
    bugReport,
    /commitment-issues --help[^\n]*(?:header|version)/i,
  );
});

test("Scorecard SARIF runs only for default-branch events", () => {
  const workflow = readText(".github/workflows/scorecard.yml");

  assert.match(workflow, /^\s*branch_protection_rule:\s*$/m);
  assert.match(workflow, /^\s+branches:\s*\[main\]\s*$/m);
  assert.doesNotMatch(workflow, /^\s*pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
  assert.match(workflow, /^\s+security-events:\s+write(?:\s+#.*)?\s*$/m);
  assert.match(
    workflow,
    /github\/codeql-action\/upload-sarif@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/,
  );
  assert.match(workflow, /sarif_file:\s+results\.sarif/);
  assert.match(workflow, /^\s+publish_results:\s+true\s*$/m);
});

test("CI enforces 100% runtime coverage on both Node lines and badge freshness", () => {
  const pkg = readJson("package.json");
  const workflow = readText(".github/workflows/ci.yml");
  const coverageRunner = readText("scripts/run-branch-coverage.mjs");
  const readme = readText("README.md");
  const minimumVersion = pkg.engines.node.match(/\d+\.\d+\.\d+/)?.[0];
  assert.ok(minimumVersion, "engines.node should pin a concrete version");
  const escapedMinimumVersion = escapeRegExp(minimumVersion);

  assert.equal(
    pkg.scripts["test:coverage"],
    "node scripts/run-branch-coverage.mjs",
  );
  assert.equal(
    pkg.scripts["coverage:check"],
    "node scripts/update-readme-coverage-badge.mjs --check",
  );
  for (const metric of ["lines", "branches", "functions"]) {
    assert.match(
      coverageRunner,
      new RegExp(
        `--test-coverage-${metric}=\\$\\{RUNTIME_COVERAGE_THRESHOLD\\}`,
      ),
    );
  }
  assert.match(
    workflow,
    new RegExp(
      `100% runtime coverage \\(Node ${escapedMinimumVersion}\\)[\\s\\S]*matrix\\.node-version == '${escapedMinimumVersion}'[\\s\\S]*npm run test:coverage`,
    ),
  );
  assert.match(
    workflow,
    /100% runtime coverage and badge freshness \(Node 24\)[\s\S]*matrix\.node-version == '24'[\s\S]*npm run coverage:check/,
  );
  assert.match(
    workflow,
    /Message-state single-box invariant[\s\S]*matrix\.node-version == '24'[\s\S]*npm run states/,
  );
  assert.match(readme, /\[!\[Branch coverage: [0-9.]+%\]/);
  assert.match(readme, /docs\/branch-coverage\.md/);
  assert.equal(
    updateReadmeCoverageBadge(readme, RUNTIME_COVERAGE_THRESHOLD),
    readme,
    "the small documentation route must reject a stale or falsified coverage badge",
  );
});

test("package description does not contradict configurable blocking", () => {
  const pkg = readJson("package.json");

  assert.doesNotMatch(pkg.description, /\bnever blocks?\b/i);
  assert.match(pkg.description, /advisory|configurable|enforcement|hook/i);
});

test("README does not make unconditional non-blocking claims", () => {
  const prose = markdownProse(readText("README.md"));
  const bannedClaims = [
    {
      pattern: /\bnever blocks?\b/i,
      message:
        "Avoid claiming the tool never blocks; push blocking is configurable.",
    },
    {
      pattern: /\b(?:cannot|can't) block\b/i,
      message:
        "Avoid claiming the tool cannot block; push blocking is configurable.",
    },
    {
      pattern: /\balways (?:allows?|continues?|passes?)\b/i,
      message: "Avoid claiming checks always allow work to continue.",
    },
  ];

  for (const { pattern, message } of bannedClaims) {
    const match = pattern.exec(prose);
    assert.equal(
      match,
      null,
      match
        ? `${message} README.md:${lineNumberAt(prose, match.index)}`
        : message,
    );
  }
});

test("README documents both advisory and blocking push modes", () => {
  const prose = markdownProse(readText("README.md"));

  assert.match(prose, /## From advisory to enforced/);
  assert.match(prose, /Runs related pushed-file tests in advisory mode/);
  assert.match(prose, /Enable blockPushOnTestFailure/);
  assert.match(
    prose,
    /blockPushOnTestFailure and advisePushTests are both set/i,
  );
});

test("all supported precommitChecks keys appear on canonical reference surfaces", () => {
  const expected = [...KNOWN_PRECOMMIT_CONFIG_KEYS].sort();
  const externalInterface = readText("docs/external-interface.md");
  const authoringSection = readText(".github/skills/authoring-checks/SKILL.md")
    .split("The supported keys are grouped by behavior:")[1]
    ?.split("`KNOWN_PRECOMMIT_CONFIG_KEYS`")[0];
  assert.ok(authoringSection, "authoring skill should have a config-key list");

  const documented = new Map([
    [
      "docs/configuration.md",
      markdownTableKeys(
        readText("docs/configuration.md"),
        "## Configuration reference",
      ),
    ],
    [
      ".github/skills/authoring-checks/SKILL.md",
      [...authoringSection.matchAll(/`([a-z][A-Za-z0-9]*)`/g)].map(
        ([, key]) => key,
      ),
    ],
  ]);

  for (const [file, keys] of documented) {
    assert.deepEqual(
      [...new Set(keys)].sort(),
      expected,
      `${file} config keys should exactly match the source allowlist`,
    );
  }

  assert.match(
    externalInterface,
    /\[configuration reference\]\(configuration\.md\)/,
  );
  assert.equal(
    markdownTableKeys(externalInterface, "## Configuration interface").length,
    0,
    "external interface should link to the canonical configuration table instead of duplicating it",
  );
});

test("CI Success includes DCO and all DCO baselines stay documented", () => {
  const ci = readText(".github/workflows/ci.yml");
  const governance = readText("GOVERNANCE.md");
  const roles = readText("docs/project-roles.md");

  assert.match(
    ci,
    /needs:\s+\[\s+classify,\s+dco,\s+quality,\s+check,\s+windows-tests,\s+windows-npm-lifecycle,\s+shell-compat,\s+pm-lifecycle,\s+migration-lifecycle,\s+codeql,\s+\]/,
  );
  assert.match(ci, /node tools\/check-dco-range\.mjs/);
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /GITHUB_EVENT_NAME.*pull_request/);
  assert.match(ci, /check-dco-range\.mjs --merge-base/);
  assert.doesNotMatch(
    ci,
    /ref:.*github\.event\.pull_request\.head\.sha/,
    "CI should keep the default merge-ref checkout for fork PR history",
  );
  for (const [file, text] of [
    [".github/workflows/ci.yml", ci],
    ["GOVERNANCE.md", governance],
    ["docs/project-roles.md", roles],
  ]) {
    assert.ok(
      text.includes(DCO_ENFORCEMENT_BASELINE),
      `${file} should reference the prospective DCO baseline`,
    );
  }
  assert.ok(
    governance.includes(DCO_POLICY_ADOPTION_BASELINE),
    "governance should preserve the original policy-adoption baseline",
  );
  for (const [file, text] of [
    ["GOVERNANCE.md", governance],
    ["docs/project-roles.md", roles],
  ]) {
    assert.ok(
      text.includes(DCO_PRIOR_OPERATIONAL_BASELINE),
      `${file} should preserve the prior operational baseline`,
    );
  }
  assert.match(
    governance,
    /issues\/160/,
    "governance should link the first operational-baseline exception",
  );
  assert.match(
    governance,
    /issues\/221/,
    "governance should link the current operational-baseline exception",
  );
  assert.ok(
    readText("docs/security-review-2026-07.md").includes(
      DCO_POLICY_ADOPTION_BASELINE,
    ),
    "the July security-review evidence snapshot should remain unchanged",
  );
});

test("sensitive access record names effective authority and recurring review", () => {
  const roles = readText("docs/project-roles.md");
  const governance = readText("GOVERNANCE.md");
  const operations = readText("docs/maintainer-operations.md");

  for (const account of ["RoryGlenn", "tdkchandler", "rahul-aravind-opti"]) {
    assert.match(roles, new RegExp(`github\\.com/${account}`));
  }
  for (const issue of [141, 142]) {
    assert.match(roles, new RegExp(`issues/${issue}`));
  }
  for (const ruleset of [18531369, 18965736, 18965738]) {
    assert.match(roles, new RegExp(`rules/${ruleset}`));
  }
  for (const authority of [
    "Repository administration and rulesets",
    "`main` changes and merges",
    "`v*` release tags",
    "GitHub Actions, secrets, and environments",
    "GitHub Releases",
    "npm package",
    "Private vulnerability reports",
  ]) {
    assert.match(roles, new RegExp(escapeRegExp(authority)));
  }

  assert.match(roles, /Owner:\*\* Rory Glenn/);
  assert.match(roles, /Cadence:\*\* monthly, before every release/);
  assert.match(roles, /### 2026-07-15/);
  assert.match(roles, /### 2026-07-16 — npm release-control follow-up/);
  assert.match(roles, /Next scheduled review:\*\* \*\*2026-08-15\*\*/);
  assert.match(roles, /no browser session was available/);
  assert.match(roles, /RoryGlenn\/commitment-issues/);
  assert.match(roles, /`publish\.yml`/);
  assert.match(roles, /`mfa=publish`/);
  assert.match(roles, /zero\s+tokens/);
  assert.doesNotMatch(
    roles,
    /[a-z\d._%+-]+@[a-z\d.-]+\.[a-z]{2,}/i,
    "the public access record should not contain email addresses",
  );
  assert.match(governance, /time-bounded write access/);
  assert.match(governance, /They may not merge, create or edit\s+Releases/);
  assert.match(
    operations,
    /\[sensitive-access checklist\]\(project-roles\.md#recurring-access-review\)/,
  );
});

test("Audit 7 records the completed npm publication control", () => {
  const audit = readText("docs/audits/release-packaging-and-upgrades.md");
  const roles = readText("docs/project-roles.md");

  assert.match(audit, /Status: \*\*complete\*\* as of 2026-07-16/);
  assert.match(audit, /issues\/195/);
  assert.match(audit, /owner-authenticated npm control/);
  assert.match(audit, /`mfa=publish`/);
  assert.match(audit, /zero\s+account tokens/);
  assert.doesNotMatch(audit, /not yet authorized to publish/);
  assert.match(audit, /Addressed with named `node:test` phases/);
  assert.match(audit, /failures identify their phase directly/);
  assert.match(
    audit,
    /01cbf76a27b0bc82d4334021a067fcd34ad7a62aa0ec9c6044efe78c5932551e/,
  );
  assert.match(audit, /npm audit signatures/);
  assert.match(roles, /issues\/195/);
});

test("Audit reports record the completed external launch controls", () => {
  const audit6 = readText("docs/audits/ci-cd-and-github-actions.md");
  const audit8 = readText(
    "docs/audits/documentation-governance-and-promotional-assets.md",
  );
  const audit9 = readText("docs/audits/independent-final-verification.md");
  const release = readText("docs/audits/release-packaging-and-upgrades.md");
  const evidence = readText("docs/openssf-best-practices.md");

  assert.match(audit8, /2026-07-16 owner-authenticated OpenSSF follow-up/);
  assert.match(audit8, /2026-07-16T20:44:46\.606Z/);
  assert.match(audit8, /`badge_level` as `passing`/);
  assert.match(audit8, /tiered percentage\s+193/);
  assert.match(
    audit8,
    /Local Git hooks for JavaScript and TypeScript projects/,
  );
  assert.match(audit6, /PR #227/);
  assert.match(audit6, /run 29546132668/);
  assert.match(audit6, /run 29546490643 attempt 2/);
  assert.match(audit6, /Secret source: None/);
  assert.match(audit9, /Final Audit 9: pass with explicit GUI-client deferral/);
  assert.match(audit9, /post-launch issue #231 owns their execution/);
  assert.match(audit9, /run\s+\[29552910864\]/);
  assert.match(audit9, /No Critical\/High blocker/);
  assert.match(evidence, /2026-07-16 owner-authenticated correction/);
  assert.doesNotMatch(audit9, /After #180 is complete/);
  assert.doesNotMatch(audit9, /release readiness:\s*blocked/i);
  assert.doesNotMatch(audit9, /unresolved #199 gate/);
  assert.doesNotMatch(release, /external-fork, OpenSSF/);
});

test("package files entries exist", () => {
  const pkg = readJson("package.json");
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  for (const entry of pkg.files || []) {
    const exists = /[*?]/.test(entry)
      ? trackedFiles.some((file) => globToRegExp(entry).test(file))
      : fs.existsSync(path.join(root, entry));
    assert.equal(exists, true, `${entry} should exist or match a tracked file`);
  }
});

test("package files explicitly classify runtime and maintenance scripts", () => {
  const pkg = readJson("package.json");
  const scriptFiles = fs
    .readdirSync(path.join(root, "scripts"), { recursive: true })
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => `scripts/${file.replaceAll(path.sep, "/")}`)
    .sort();
  const runtimeFiles = [...BRANCH_COVERAGE_SOURCE_FILES].sort();
  const maintenanceFiles = [...BRANCH_COVERAGE_EXCLUDED_SOURCE_FILES].sort();

  assert.deepEqual(
    [...new Set([...runtimeFiles, ...maintenanceFiles])].sort(),
    scriptFiles,
    "every scripts module should be classified as installed runtime or repository-only maintenance",
  );
  assert.deepEqual(
    runtimeFiles.filter((file) => maintenanceFiles.includes(file)),
    [],
    "runtime and maintenance classifications must not overlap",
  );
  assert.equal(
    packageFilePatterns(pkg).has("scripts/"),
    false,
    "the package must not include every future script by default",
  );
  for (const file of runtimeFiles) {
    assert.equal(isPackaged(file, pkg), true, `${file} should be packaged`);
  }
  for (const file of maintenanceFiles) {
    assert.equal(
      isPackaged(file, pkg),
      false,
      `${file} should remain repository-only`,
    );
  }
});

test("documentation index links every retained Markdown document", () => {
  const index = readText("docs/index.md");
  const markdownFiles = fs
    .readdirSync(path.join(root, "docs"), { recursive: true })
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replaceAll(path.sep, "/"))
    .filter((file) => file !== "index.md");

  for (const file of markdownFiles) {
    assert.match(
      index,
      new RegExp(`\\(${escapeRegExp(file)}(?:#.*?)?\\)`),
      `docs/index.md should intentionally link ${file}`,
    );
  }
});

test("README relative image assets exist and are included in npm package files", () => {
  const pkg = readJson("package.json");
  const readme = readText("README.md");
  const imagePaths = readmeImagePaths(readme);

  for (const imagePath of imagePaths) {
    if (/^(https?:)?\/\//.test(imagePath) || imagePath.startsWith("#")) {
      continue;
    }

    assert.equal(
      fs.existsSync(path.join(root, imagePath)),
      true,
      `${imagePath} should exist`,
    );

    assert.equal(
      isPackaged(imagePath, pkg),
      true,
      `${imagePath} should be included by package.json files`,
    );
  }
});

test("npm package contains only reviewed runtime, docs, and assets within budget", (t) => {
  const pkg = readJson("package.json");
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "npm-pack-cache-"));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const result = run(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const [pack] = JSON.parse(result.stdout);
  const files = new Set(pack.files.map((file) => file.path));
  const docs = readText("docs/maintainer-operations.md");
  const readme = readText("README.md");
  const packagedDocs = new Set(
    [...files].filter((file) => file.startsWith("docs/")),
  );
  const packagedScripts = new Set(
    [...files].filter((file) => file.startsWith("scripts/")),
  );
  const brokenMarkdownLinks = findBrokenPackedMarkdownLinks({
    files,
    readFile: readText,
  });
  const expectedDocs = new Set([
    "docs/branch-coverage.md",
    "docs/ci-recipes.md",
    "docs/compatibility.md",
    "docs/configuration.md",
    "docs/external-interface.md",
    "docs/faq.md",
    "docs/framework-recipes.md",
    "docs/how-it-works.md",
    "docs/json-output.md",
    "docs/json-output.schema.json",
    "docs/migration.md",
    "docs/monorepo.md",
    "docs/release-verification.md",
    "docs/try-it-safely.md",
    "docs/why-before-ci.md",
    "docs/yarn-berry.md",
  ]);

  for (const promotionalAsset of [
    "assets/commitment-issues.png",
    "assets/before-after.svg",
    "assets/before-after.png",
    "assets/demo.gif",
    "assets/product-hunt-thumbnail.svg",
    "assets/product-hunt-thumbnail.png",
    "assets/product-hunt-01-before-after.png",
    "assets/product-hunt-02-setup.svg",
    "assets/product-hunt-02-setup.png",
    "assets/product-hunt-03-advisory.svg",
    "assets/product-hunt-03-advisory.png",
    "assets/product-hunt-04-safe-fix.svg",
    "assets/product-hunt-04-safe-fix.png",
  ]) {
    assert.equal(
      files.has(promotionalAsset),
      false,
      `${promotionalAsset} should remain repository-only`,
    );
  }
  for (const semanticContextFile of [
    ".claude/settings.json",
    ".codex/hooks.json",
    "CLAUDE.md",
    "docs/semantic-context.md",
    "docs/semantic-context.schema.json",
    "tools/lib/semantic-context.mjs",
    "tools/semantic-context-hook.mjs",
    "tools/semantic-context.mjs",
  ]) {
    assert.equal(
      files.has(semanticContextFile),
      false,
      `${semanticContextFile} should remain repository-only`,
    );
  }
  assert.ok(
    [...files].every((file) =>
      file.startsWith("assets/") ? file.endsWith(".svg") : true,
    ),
  );
  assert.deepEqual(
    packagedScripts,
    new Set(BRANCH_COVERAGE_SOURCE_FILES),
    "the tarball should contain the complete runtime classification and no maintenance scripts",
  );
  for (const binTarget of Object.values(pkg.bin ?? {})) {
    assert.equal(files.has(binTarget), true, `${binTarget} should be packaged`);
  }
  for (const commandTarget of cliDispatchTargets(readText("scripts/cli.mjs"))) {
    assert.equal(
      files.has(commandTarget),
      true,
      `${commandTarget} should be packaged for CLI dispatch`,
    );
  }
  for (const modulePath of packagedScripts) {
    for (const specifier of relativeModuleSpecifiers(readText(modulePath))) {
      const target = path
        .normalize(path.join(path.dirname(modulePath), specifier))
        .replaceAll(path.sep, "/");
      assert.equal(
        files.has(target),
        true,
        `${modulePath} imports ${target}, which should be packaged`,
      );
    }
  }
  assert.deepEqual(packagedDocs, expectedDocs);
  assert.deepEqual(
    brokenMarkdownLinks.map(formatBrokenMarkdownLink),
    [],
    "relative Markdown links should resolve inside the exact npm pack manifest",
  );
  assert.equal(files.has("docs/index.md"), false);
  assert.equal(files.has("docs/maintainer-operations.md"), false);
  assert.equal(files.has("docs/message-states.md"), false);
  assert.equal(files.has("docs/scenario-coverage.md"), false);
  assert.equal(files.has("docs/feature-ideas.md"), false);
  assert.match(
    readme,
    /raw\.githubusercontent\.com\/RoryGlenn\/commitment-issues\/main\/assets\/commitment-issues\.png/,
  );
  assert.match(
    readme,
    /raw\.githubusercontent\.com\/RoryGlenn\/commitment-issues\/main\/assets\/before-after\.svg/,
  );
  assert.match(
    readme,
    /raw\.githubusercontent\.com\/RoryGlenn\/commitment-issues\/main\/assets\/demo\.gif/,
  );
  assert.ok(
    pack.size <= 350 * 1024,
    `packed size ${pack.size} exceeds 350 KiB`,
  );
  assert.ok(
    pack.unpackedSize <= 800 * 1024,
    `unpacked size ${pack.unpackedSize} exceeds 800 KiB`,
  );
  assert.match(docs, /350 KiB compressed/);
  assert.match(docs, /800 KiB\s+unpacked/);
});

test("message-state SVG assets exist and only README examples enter npm", () => {
  const pkg = readJson("package.json");
  const docs = readText("docs/message-states.md");
  const readme = readText("README.md");
  const imagePaths = readmeImagePaths(docs);
  const packagedReadmeAssets = new Set(
    readmeImagePaths(readme).filter((imagePath) =>
      imagePath.startsWith("assets/"),
    ),
  );
  let packagedGalleryAssets = 0;

  assert.ok(imagePaths.length >= 15, "message states should have SVG examples");

  for (const imagePath of imagePaths) {
    const absolutePath = path.resolve(root, "docs", imagePath);
    const packagePath = path
      .relative(root, absolutePath)
      .replaceAll(path.sep, "/");

    assert.equal(
      fs.existsSync(absolutePath),
      true,
      `${imagePath} should exist`,
    );
    if (isPackaged(packagePath, pkg)) {
      packagedGalleryAssets += 1;
      assert.equal(
        packagedReadmeAssets.has(packagePath),
        true,
        `${packagePath} should be packaged only when the README uses it`,
      );
    }
  }

  assert.ok(packagedGalleryAssets > 0);
  assert.ok(packagedGalleryAssets < imagePaths.length);
});

test("every terminal box title appears in the message-states gallery", () => {
  const docs = readText("docs/message-states.md");
  const svgText = readmeImagePaths(docs)
    .map((imagePath) => readText(path.join("docs", imagePath)))
    .join("\n");
  const haystack = `${docs}\n${svgText}`;

  // User-facing entry scripts plus the advisory-message builder. Maintainer
  // lifecycle and coverage tooling is deliberately outside the gallery.
  const sources = [
    "scripts/cli.mjs",
    "scripts/commit-fix.mjs",
    "scripts/commit-msg.mjs",
    "scripts/doctor.mjs",
    "scripts/fix-staged.mjs",
    "scripts/fix-staged-js.mjs",
    "scripts/init.mjs",
    "scripts/precommit.mjs",
    "scripts/prepush.mjs",
    "scripts/uninstall.mjs",
    "scripts/lib/message.mjs",
    "scripts/lib/welcome.mjs",
  ];

  // Defensive boxes marked unreachable in practice (node:coverage-disabled)
  // stay undocumented on purpose.
  const exemptTitles = new Set(["Could not locate the git hooks directory."]);

  // Box titles are double-quoted pc.bold literals; inline emphasis uses
  // single quotes or dynamic values, so it is not captured here.
  const titles = new Set();
  for (const source of sources) {
    const text = readText(source);
    for (const [, title] of text.matchAll(/pc\.bold\(\s*"([^"]+)"/g)) {
      if (!exemptTitles.has(title)) {
        titles.add(title);
      }
    }
  }

  assert.ok(
    titles.size >= 40,
    `box-title extraction should find the catalog (found ${titles.size})`,
  );

  for (const title of titles) {
    assert.ok(
      haystack.includes(title),
      `box title "${title}" should appear in docs/message-states.md or a referenced SVG — document new message states in the gallery`,
    );
  }
});
