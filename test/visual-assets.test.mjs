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
const flowchartPaths = [
  "assets/project-flowchart-light.svg",
  "assets/project-flowchart-dark.svg",
];
const productHuntPngs = [
  {
    path: "assets/product-hunt-thumbnail.png",
    width: 240,
    height: 240,
    maximumBytes: 3 * 1024 * 1024,
  },
  ...[
    "assets/product-hunt-01-before-after.png",
    "assets/product-hunt-02-setup.png",
    "assets/product-hunt-03-advisory.png",
    "assets/product-hunt-04-safe-fix.png",
  ].map((assetPath) => ({
    path: assetPath,
    width: 1270,
    height: 760,
    maximumBytes: 130 * 1024,
  })),
];
const productHuntSvgSources = [
  "assets/product-hunt-thumbnail.svg",
  "assets/product-hunt-02-setup.svg",
  "assets/product-hunt-03-advisory.svg",
  "assets/product-hunt-04-safe-fix.svg",
];
const productHuntRenderMappings = [
  ["assets/product-hunt-thumbnail.svg", "assets/product-hunt-thumbnail.png"],
  ["assets/before-after.svg", "assets/product-hunt-01-before-after.png"],
  ["assets/product-hunt-02-setup.svg", "assets/product-hunt-02-setup.png"],
  [
    "assets/product-hunt-03-advisory.svg",
    "assets/product-hunt-03-advisory.png",
  ],
  [
    "assets/product-hunt-04-safe-fix.svg",
    "assets/product-hunt-04-safe-fix.png",
  ],
];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function semanticText(svg) {
  return [...svg.matchAll(/<(title|desc|text)\b[^>]*>([^<]*)<\/\1>/g)].map(
    ([, tag, content]) => `${tag}:${content.trim()}`,
  );
}

function elementCounts(svg) {
  return Object.fromEntries(
    [
      "svg",
      "title",
      "desc",
      "defs",
      "style",
      "g",
      "rect",
      "circle",
      "path",
      "text",
    ].map((tag) => [
      tag,
      [...svg.matchAll(new RegExp(`<${tag}\\b`, "g"))].length,
    ]),
  );
}

function pngDimensions(buffer) {
  assert.deepEqual(
    buffer.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function gifMetrics(buffer) {
  assert.equal(buffer.subarray(0, 3).toString("ascii"), "GIF");
  let frames = 0;
  let durationCentiseconds = 0;

  for (let index = 0; index + 7 < buffer.length; index += 1) {
    if (
      buffer[index] === 0x21 &&
      buffer[index + 1] === 0xf9 &&
      buffer[index + 2] === 0x04
    ) {
      frames += 1;
      durationCentiseconds += buffer.readUInt16LE(index + 4);
    }
  }

  return {
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
    frames,
    durationSeconds: durationCentiseconds / 100,
  };
}

test("every repository SVG exposes an accessible name and description", () => {
  const tracked = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.svg"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(tracked.status, 0, tracked.stderr);
  const assetNames = [
    ...new Set(
      tracked.stdout
        .trim()
        .split(/\r?\n/)
        .filter((name) => name && fs.existsSync(path.join(root, name))),
    ),
  ];

  assert.ok(assetNames.length > 0);
  for (const name of assetNames) {
    const svg = read(name);
    assert.match(svg, /\brole="img"/);
    assert.match(svg, /\baria-labelledby="title desc"/);
    assert.match(svg, /<title id="title">[^<]+<\/title>/);
    assert.match(svg, /<desc id="desc">[^<]+<\/desc>/);
  }
});

test("message-state SVG generator exactly reproduces its committed assets", (t) => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "message-state-assets-"),
  );
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tempDir, "tools"));
  fs.mkdirSync(path.join(tempDir, "assets"));
  fs.copyFileSync(
    path.join(root, "tools", "gen-message-state-svgs.mjs"),
    path.join(tempDir, "tools", "gen-message-state-svgs.mjs"),
  );

  const result = spawnSync(
    process.execPath,
    ["tools/gen-message-state-svgs.mjs"],
    { cwd: tempDir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);

  const generated = fs.readdirSync(path.join(tempDir, "assets")).sort();
  const gallery = read("docs/message-states.md");
  assert.equal(generated.length, 70);
  for (const file of generated) {
    assert.ok(
      gallery.includes(`../assets/${file}`),
      `${file} should be referenced by the message-state gallery`,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(tempDir, "assets", file)),
      fs.readFileSync(path.join(root, "assets", file)),
      `${file} should be regenerated before its source definition is committed`,
    );
  }
});

test("flowchart themes remain accessible and semantically equivalent", () => {
  const [light, dark] = flowchartPaths.map(read);

  for (const [index, svg] of [light, dark].entries()) {
    assert.match(svg, /^<svg\b[^>]*\bwidth="1024"[^>]*\bheight="848"/);
    assert.match(svg, /\bviewBox="0 0 1024 848"/);
    assert.match(svg, /<rect width="1024" height="848" fill="url\(#bg\)"\/>/);
    assert.match(svg, /\brole="img"/);
    assert.match(svg, /\baria-labelledby="title desc"/);
    assert.match(svg, /<title id="title">[^<]+<\/title>/);
    assert.match(svg, /<desc id="desc">[^<]+<\/desc>/);
    assert.match(svg, /<\/svg>\s*$/);
    assert.doesNotMatch(svg, /<script\b/i);
    assert.ok(
      semanticText(svg).length > 30,
      `${flowchartPaths[index]} should expose its labels as text`,
    );
  }

  assert.deepEqual(semanticText(light), semanticText(dark));
  assert.deepEqual(elementCounts(light), elementCounts(dark));
});

test("flowcharts cover code checks and every major guard category", () => {
  const requiredLabels = [
    "Code checks",
    "lint • format • tests",
    "Guard checks",
    "branch • upstream • secrets",
    "commit shape • large/generated files",
  ];

  for (const relativePath of flowchartPaths) {
    const svg = read(relativePath);
    for (const label of requiredLabels) {
      assert.ok(svg.includes(label), `${relativePath} should include ${label}`);
    }
  }
});

test("README and how-it-works reference both refreshed flowchart themes", () => {
  const readme = read("README.md");
  const guide = read("docs/how-it-works.md");

  for (const [document, prefix] of [
    [readme, "assets/"],
    [guide, "../assets/"],
  ]) {
    assert.ok(document.includes(`${prefix}project-flowchart-light.svg`));
    assert.ok(document.includes(`${prefix}project-flowchart-dark.svg`));
    assert.match(document, /code and guard checks before commit/i);
  }
});

test("hero story pairs a reusable comparison with a 20–30 second real workflow", () => {
  const svg = read("assets/before-after.svg");
  const png = fs.readFileSync(path.join(root, "assets/before-after.png"));
  const gif = fs.readFileSync(path.join(root, "assets/demo.gif"));
  const readme = read("README.md");
  const rationale = read("docs/why-before-ci.md");
  const launch = read("promo/launch.md");
  const pkg = JSON.parse(read("package.json"));
  const slogan = "Catch mistakes while they're still cheap to fix";

  assert.deepEqual(pngDimensions(png), { width: 1200, height: 675 });

  const demo = gifMetrics(gif);
  assert.deepEqual(
    { width: demo.width, height: demo.height },
    { width: 1000, height: 760 },
  );
  assert.ok(demo.frames > 0, "demo should contain animated frames");
  assert.ok(
    demo.durationSeconds >= 20 && demo.durationSeconds <= 30,
    `demo duration ${demo.durationSeconds}s should stay inside the 20–30 second story window`,
  );

  assert.match(svg, /width="1200"/);
  assert.match(svg, /height="675"/);
  assert.match(
    svg,
    /\.sans \{ font-family: "DejaVu Sans", sans-serif; \}/,
    "comparison should name the font installed by its render workflow",
  );
  assert.ok(
    svg.includes(`<title id="title">${slogan}</title>`),
    "comparison should retain the canonical promise as its accessible title",
  );

  const visibleNodes = [
    ...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g),
  ].map(([, content]) =>
    content
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  assert.deepEqual(visibleNodes, [
    "COMMITMENT",
    "ISSUES",
    "Commitment Issues spots mistakes before you send.",
    "Fix it now. Send once. Done.",
    "WITHOUT",
    "SEND",
    "WAIT",
    "MISTAKE FOUND",
    "REDO",
    "WAIT. FAIL. REPEAT.",
    "WITH",
    "SPOT IT",
    "FIX IT",
    "SEND ONCE",
    "FIX. SEND. DONE.",
  ]);
  const visibleCopy = visibleNodes.join(" ");
  assert.ok(
    visibleCopy.split(/\s+/).length <= 35,
    "comparison should stay readable at a glance with no more than 35 visible words",
  );
  assert.doesNotMatch(
    visibleCopy,
    /\b(?:CI|commit|push|npm|context|advisory|telemetry|authoritative)\b/i,
    "visible comparison should avoid software jargon",
  );

  for (const [name, surface] of [
    ["README", readme],
    ["npm description", pkg.description],
    ["rationale", rationale],
    ["launch kit", launch],
  ]) {
    assert.match(
      surface,
      new RegExp(slogan.replaceAll("'", "['’]"), "i"),
      `${name} should use the canonical promise`,
    );
  }
  assert.match(read("docs/definition-of-done.md"), /still cheap to fix/i);
  assert.match(pkg.description, /advisory-first Git hooks/i);
  assert.match(readme, /fix → commit again →\s*push → wait again/);
  assert.match(rationale, /fixes the problem, commits again, pushes again/);
  assert.match(
    launch,
    /Without Commitment Issues: send\s*work, wait, find a mistake, and do it again/,
  );
  assert.match(svg, /mistake is spotted and fixed first/);
  assert.match(launch, /next-release npm metadata/);
  assert.match(launch, /\[ \] Confirm the live npm page/);

  const comparisonIndex = readme.indexOf("assets/before-after.svg");
  const demoIndex = readme.indexOf("assets/demo.gif");
  const quickstartIndex = readme.indexOf("## Quickstart");
  assert.ok(comparisonIndex >= 0, "README should embed the comparison");
  assert.ok(
    comparisonIndex < demoIndex && demoIndex < quickstartIndex,
    "README should tell the comparison and real workflow story before setup and features",
  );
  assert.match(
    rationale,
    /raw\.githubusercontent\.com\/RoryGlenn\/commitment-issues\/main\/assets\/before-after\.svg/,
  );
  for (const surface of ["Product Hunt", "LinkedIn", "Reddit", "X"]) {
    assert.ok(launch.includes(surface), `launch kit should cover ${surface}`);
  }
  assert.doesNotMatch(launch, /Hacker News/);
  assert.match(launch, /assets\/before-after\.svg/);
  assert.match(launch, /assets\/before-after\.png/);
  assert.match(launch, /assets\/demo\.gif/);
});

test("Product Hunt media pack is upload-ready and tied to approved copy", () => {
  const launch = read("promo/launch.md");
  const workflow = read(".github/workflows/render-demo.yml");
  const tagline = "Catch mistakes early with advisory-first Git hooks";
  const description =
    "Catch mistakes while they're still cheap to fix. Commitment Issues spots Git workflow problems before your first push, suggests the exact safe command, and stays advisory by default. Local-only, telemetry-free, open source, for JavaScript and TypeScript.";

  assert.equal(tagline.length, 50);
  assert.ok(tagline.length <= 60);
  assert.equal(description.length, 254);
  assert.ok(description.length <= 260);
  assert.ok(launch.includes(`**Tagline (50/60 characters):** \`${tagline}\``));
  assert.ok(
    launch.includes(`**Description (254/260 characters):** \`${description}\``),
  );
  assert.match(launch, /\*\*Pricing:\*\* Free/);
  assert.match(launch, /\*\*Status:\*\* Available now/);
  assert.match(launch, /Developer Tools, Open Source, GitHub/);
  assert.match(launch, /Human-only first maker comment worksheet/);
  assert.match(launch, /Rory must write and approve the final first/);
  assert.match(launch, /request for feedback rather than a request for votes/);
  assert.match(
    read("assets/product-hunt-03-advisory.svg"),
    /By default, your commit continues/,
  );

  for (const asset of productHuntPngs) {
    const buffer = fs.readFileSync(path.join(root, asset.path));
    assert.deepEqual(
      pngDimensions(buffer),
      { width: asset.width, height: asset.height },
      `${asset.path} should retain its Product Hunt dimensions`,
    );
    assert.ok(
      buffer.byteLength <= asset.maximumBytes,
      `${asset.path} should remain within its upload budget`,
    );
    assert.ok(launch.includes(asset.path));
  }

  for (const sourcePath of productHuntSvgSources) {
    const svg = read(sourcePath);
    const expectedSize = sourcePath.includes("thumbnail") ? 240 : 1270;
    const expectedHeight = sourcePath.includes("thumbnail") ? 240 : 760;
    assert.match(svg, new RegExp(`width="${expectedSize}"`));
    assert.match(svg, new RegExp(`height="${expectedHeight}"`));
    assert.match(svg, /font-family: "DejaVu Sans"/);
    assert.ok(launch.includes(sourcePath));
  }

  assert.match(workflow, /assets\/product-hunt-\*/);
  for (const output of productHuntPngs.map(
    ({ path: assetPath }) => assetPath,
  )) {
    assert.ok(
      workflow.includes(output),
      `render workflow should regenerate ${output}`,
    );
  }
  assert.match(
    workflow,
    /pad=1270:760:35:42:color=0x060a18/,
    "the first gallery card should deterministically pad the plain-language comparison",
  );
  const renderStep = workflow.match(
    /- name: Render Product Hunt media pack\s+run: \|\n([\s\S]*?)\n\s+- name: Render assets\/demo\.gif/,
  )?.[1];
  assert.ok(renderStep, "workflow should expose one bounded media-render step");
  const renderedPairs = [
    ...renderStep.matchAll(
      /-i (assets\/\S+)[\s\S]*?-frames:v 1 -y (assets\/\S+)/g,
    ),
  ].map(([, source, output]) => [source, output]);
  assert.deepEqual(
    renderedPairs,
    productHuntRenderMappings,
    "each Product Hunt PNG should be rendered from its documented SVG source",
  );
  assert.match(workflow, /name: Upload rendered Product Hunt media pack/);
  assert.match(
    workflow,
    /name: Verify rendered Product Hunt assets match committed exports/,
  );
});

test("demo tape records a reproducible feature-branch workflow", () => {
  const tape = read("promo/demo.tape");
  const workflow = read(".github/workflows/render-demo.yml");
  const comparator = read("tools/compare-demo-gifs.mjs");
  const initIndex = tape.indexOf("npx --no-install commitment-issues init");
  const welcomeOptOutIndex = tape.indexOf(
    "npm pkg set precommitChecks.showWelcomeOnFirstCommit=false --json",
  );
  const switchIndex = tape.indexOf("git switch -q -c feature/greeting");
  const visibleCommitIndex = tape.indexOf(
    "git commit -q -am 'print hello world'",
  );
  const fixIndex = tape.indexOf("npm run commit:fix");
  const pushIndex = tape.indexOf('Type "git push -q"', fixIndex);
  const resetIndex = tape.indexOf('Type "clear" Enter', fixIndex);
  const resetPromptIndex = tape.indexOf(
    "Wait+Line@30s /git:\\(feature.greeting\\) *$/",
    resetIndex,
  );
  const renderIndex = workflow.indexOf("run: vhs promo/demo.tape");
  const comparisonRenderIndex = workflow.indexOf(
    "name: Render assets/before-after.png from assets/before-after.svg",
  );
  const comparisonUploadIndex = workflow.indexOf(
    "name: Upload rendered before/after asset",
  );
  const comparisonVerifyIndex = workflow.indexOf(
    "name: Verify rendered before/after asset matches committed export",
  );
  const metadataIndex = workflow.indexOf(
    "name: Verify rendered demo dimensions and timing",
  );
  const verifyIndex = workflow.indexOf(
    "name: Verify rendered demo matches committed visuals",
  );
  const uploadIndex = workflow.indexOf("name: Upload rendered demo");

  assert.match(tape, /^Output assets\/demo\.gif$/m);
  assert.match(tape, /npm pack "\$REPO" --ignore-scripts/);
  assert.match(tape, /npm install -D "\$PACKAGE_DIR\/\$PACKAGE_TGZ"/);
  assert.match(tape, /--ignore-scripts --prefer-offline/);
  assert.doesNotMatch(tape, /ln -s "\$REPO\/node_modules" node_modules/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /node-version: "24\.14\.0"/);
  assert.match(
    workflow,
    /apt-get install --yes ffmpeg fonts-dejavu-core zsh/,
    "render workflow should install the comparison's exact font",
  );
  for (const input of [
    ".github/workflows/render-demo.yml",
    "assets/before-after.png",
    "assets/before-after.svg",
    "assets/demo.gif",
    "promo/demo.tape",
    "package.json",
    "package-lock.json",
    "scripts/**",
    "test/demo-visual-comparison.test.mjs",
    "test/visual-assets.test.mjs",
    "tools/compare-demo-gifs.mjs",
  ]) {
    assert.ok(
      workflow.includes(`- "${input}"`),
      `render workflow should run when ${input} changes`,
    );
  }
  assert.ok(renderIndex >= 0, "workflow should render the demo");
  assert.ok(
    comparisonRenderIndex >= 0,
    "workflow should render the before/after PNG from its SVG source",
  );
  assert.match(
    workflow,
    /cp assets\/before-after\.png "\$RUNNER_TEMP\/committed-before-after\.png"/,
  );
  assert.match(
    workflow,
    /ffmpeg -nostdin -hide_banner -loglevel error\s+-f svg_pipe -i assets\/before-after\.svg\s+-frames:v 1 -y assets\/before-after\.png/,
  );
  assert.match(
    workflow,
    /cmp --silent\s+\\\s+"\$RUNNER_TEMP\/committed-before-after\.png"\s+\\\s+assets\/before-after\.png/,
  );
  assert.ok(
    comparisonUploadIndex > comparisonRenderIndex &&
      comparisonVerifyIndex > comparisonUploadIndex,
    "workflow should preserve the rendered comparison before rejecting drift",
  );
  assert.match(
    workflow,
    /cp assets\/demo\.gif "\$RUNNER_TEMP\/committed-demo\.gif"/,
  );
  assert.match(workflow, /MINIMUM_SSIM: "0\.997"/);
  assert.match(workflow, /MAX_TEMPORAL_SHIFT_FRAMES: "2"/);
  assert.match(workflow, /node --test test\/demo-visual-comparison\.test\.mjs/);
  assert.match(
    workflow,
    /node tools\/compare-demo-gifs\.mjs\s+"\$RUNNER_TEMP\/committed-demo\.gif"\s+assets\/demo\.gif/,
  );
  assert.match(comparator, /\[committed\]\[rendered\]ssim/);
  for (const region of [
    "formatter duration",
    "amended commit abbreviation",
    "test-case duration",
    "test-suite duration",
  ]) {
    assert.ok(
      comparator.includes(`name: "${region}"`),
      `demo comparator should normalize ${region}`,
    );
  }
  assert.match(workflow, /MAX_FRAME_COUNT_DRIFT: "2"/);
  assert.match(workflow, /MAX_DURATION_DRIFT_SECONDS: "0\.10"/);
  assert.match(workflow, /execFileSync\(\s*"ffprobe"/);
  assert.match(workflow, /"-count_frames"/);
  assert.match(
    workflow,
    /stream=width,height,nb_read_frames,duration:format=duration/,
  );
  assert.match(workflow, /rendered\.width !== committed\.width/);
  assert.match(workflow, /rendered\.height !== committed\.height/);
  assert.match(workflow, /frameDrift > frameTolerance/);
  assert.match(workflow, /durationDrift > tolerance/);
  assert.ok(
    verifyIndex > renderIndex,
    "workflow should compare the rendered GIF after rendering it",
  );
  assert.ok(
    metadataIndex > uploadIndex,
    "workflow should preserve the rendered artifact before metadata checks",
  );
  assert.ok(
    verifyIndex > metadataIndex,
    "workflow should reject metadata drift before evaluating SSIM",
  );
  assert.ok(
    uploadIndex > renderIndex,
    "workflow should upload only after rendering the demo",
  );
  assert.ok(
    verifyIndex > uploadIndex,
    "workflow should preserve a mismatched render artifact before failing",
  );
  assert.match(tape, /Set FontFamily "DejaVu Sans Mono"/);
  assert.match(tape, /Set CursorBlink false/);
  assert.match(tape, /Set TypingSpeed 1ms/);
  assert.match(tape, /Set TypingSpeed 100ms/);
  assert.match(tape, /NPM_CONFIG_UPDATE_NOTIFIER=false/);
  assert.match(tape, /npx --no-install commitment-issues init/);
  assert.match(tape, /npm pkg set precommitChecks\.hookOutput=normal/);
  assert.match(
    tape,
    /npm pkg set precommitChecks\.showWelcomeOnFirstCommit=false --json/,
  );
  for (const hiddenExecution of [
    'Type "npx --no-install commitment-issues init"\nHide\nEnter',
    "Type \"git commit -q -am 'print hello world'\"\nHide\nEnter",
    'Type "npm run commit:fix"\nHide\nEnter',
    'Type "git push -q"\nHide\nEnter',
  ]) {
    assert.ok(
      tape.includes(hiddenExecution),
      `demo should hide variable command runtime for ${hiddenExecution.split("\\n")[0]}`,
    );
  }
  for (const marker of [
    "WELCOME_READY",
    "OUTPUT_READY",
    "COMMIT_READY",
    "BASELINE_READY",
  ]) {
    assert.ok(tape.includes("PROMPT='" + marker + "> '"));
    assert.ok(tape.includes("Wait+Line@30s /" + marker + ">$/"));
  }
  assert.ok(tape.includes('Type "PROMPT=$DEMO_PROMPT" Enter'));
  assert.match(tape, /PROMPT='READY> '/);
  assert.match(tape, /Wait\+Line@30s \/READY>\$\//);
  assert.match(tape, /Wait\+Screen@30s \/Your next push runs advisory tests\//);
  assert.match(tape, /Wait\+Screen@30s \/Pre-commit suggestions found\//);
  assert.match(
    tape,
    /Wait\+Screen@30s \/Latest commit amended with automatic fixes\//,
  );
  assert.match(tape, /Wait\+Line@30s \/git:\\\(feature.greeting\\\) \*\$\//);
  assert.match(tape, /Wait\+Screen@30s \/Push allowed\//);
  assert.ok(switchIndex >= 0, "demo should create a named feature branch");
  assert.ok(
    tape.lastIndexOf("Show", initIndex) > tape.lastIndexOf("Hide", initIndex),
    "the demonstrated init command should be captured rather than hidden",
  );
  assert.ok(
    tape.indexOf("Hide", initIndex) > initIndex,
    "setup bookkeeping should be hidden only after init is demonstrated",
  );
  assert.ok(
    welcomeOptOutIndex > initIndex && welcomeOptOutIndex < visibleCommitIndex,
    "the demo should opt out only after showing the default init experience",
  );
  assert.ok(
    visibleCommitIndex > switchIndex,
    "the demonstrated commit should happen after switching off main",
  );
  assert.ok(
    pushIndex > fixIndex,
    "the demonstrated push should happen after the safe amend",
  );
  assert.ok(
    resetIndex > fixIndex &&
      resetPromptIndex > resetIndex &&
      pushIndex > resetPromptIndex,
    "the demo should reset its full viewport before showing the push result",
  );
});
