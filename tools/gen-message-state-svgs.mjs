// Copyright (c) 2026 RoryGlenn and commitment-issues contributors
// SPDX-License-Identifier: MIT

// Maintainer tool: renders the docs/message-states.md gallery SVGs into
// assets/. Not shipped in the npm tarball (tools/ is outside the package.json
// files allowlist).
//
// Each entry below is a hand-specified mockup of real box output. To document
// a new message state: append a boxSvg()/bareSvg() entry with the exact
// wording the command prints, run `node tools/gen-message-state-svgs.mjs`, and
// add the state to docs/message-states.md — the metadata doc-drift test fails
// until every box title appears in the gallery. Re-running regenerates exactly
// the files defined here; the original hand-authored SVGs (README journey —
// e.g. precommit-all-passed.svg, prepush-success.svg) live only in assets/.
//
// Geometry (matches the hand-authored originals):
//   outer bg #181818 rounded 8; group translate(20 24); inner rect stroke 1.3
//   title tab centered at y=-10 (info 63 / error 74 / success|warning 97 wide)
//   first line y=44; +30 per line; +44 across a blank; inner H = lastY + 24
//   total W = inner W + 40; total H = inner H + 44
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
);

const SEV = {
  info: { color: "#68d8ff", tab: 63 },
  success: { color: "#2ee993", tab: 97 },
  warning: { color: "#dfff00", tab: 97 },
  error: { color: "#ff5f7a", tab: 74 },
};
const DIM = "#858b91";
const BRIGHT = "#e8edf2";
const FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

// Approximate monospace advance widths used to size boxes.
const W17 = 10.3;
const W18 = 11;

function esc(s) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// line kinds:
//  t  -> severity-colored bold title (18px, x=34)
//  d  -> dim body (17px, x=34)
//  di -> dim indented (17px, x=54)
//  a  -> accent line in severity color (17px, x=34)
//  cmd-> bold bright command (18px, x=54)
//  bt -> bright bold body line (18px, x=34)
//  b  -> blank
//  raw-> {kind:"raw", color, x, size, weight, text} fully custom
function lineSpec(l, sevColor) {
  switch (l.k) {
    case "t":
      return { x: 34, size: 18, weight: 700, fill: sevColor, text: l.text };
    case "d":
      return { x: 34, size: 17, weight: 0, fill: DIM, text: l.text };
    case "di":
      return { x: 54, size: 17, weight: 0, fill: DIM, text: l.text };
    case "a":
      return { x: 34, size: 17, weight: 0, fill: sevColor, text: l.text };
    case "cmd":
      return { x: 54, size: 18, weight: 700, fill: BRIGHT, text: l.text };
    case "bt":
      return { x: 34, size: 18, weight: 700, fill: BRIGHT, text: l.text };
    case "raw":
      return {
        x: l.x ?? 34,
        size: l.size ?? 17,
        weight: l.weight ?? 0,
        fill: l.color ?? DIM,
        text: l.text,
        extra: l.extra,
      };
    default:
      throw new Error(`unknown kind ${l.k}`);
  }
}

function textWidth(spec) {
  const per = spec.size >= 18 ? W18 : W17;
  let w = spec.x + spec.text.length * per;
  if (spec.extra) {
    w = Math.max(w, spec.extra.x + spec.extra.text.length * per);
  }
  return w;
}

function buildBoxSvg({
  file,
  severity,
  title,
  desc,
  lines,
  minInnerWidth = 0,
}) {
  const sev = severity ? SEV[severity] : null;
  const sevColor = sev ? sev.color : "#2ee993";

  // Lay out y positions.
  let y = 44;
  const placed = [];
  let first = true;
  for (const l of lines) {
    if (l.k === "b") {
      y += 14; // a blank adds 14 on top of the normal 30 step
      continue;
    }
    if (!first) {
      y += 30;
    }
    first = false;
    const spec = lineSpec(l, sevColor);
    placed.push({ ...spec, y });
  }
  const innerH = y + 24;
  const innerW = Math.max(
    minInnerWidth,
    Math.ceil(Math.max(...placed.map(textWidth)) + 34),
  );
  const W = innerW + 40;
  const H = innerH + 44;

  let tab = "";
  if (sev) {
    const tabX = (innerW - sev.tab) / 2;
    tab =
      `    <rect x="${tabX}" y="-10" width="${sev.tab}" height="20" fill="#181818"/>\n` +
      `    <text x="${innerW / 2}" y="5" fill="${sevColor}" text-anchor="middle" font-family="${FONT}" font-size="18" font-weight="700">${severity}</text>\n`;
  }

  const borderColor = sev ? sevColor : "#2ee993";
  const spacePreserve = (text) =>
    /^\s|\s{2,}/.test(text) ? ' xml:space="preserve"' : "";
  const body = placed
    .map((p) => {
      const weight = p.weight ? ` font-weight="${p.weight}"` : "";
      let t = `    <text x="${p.x}" y="${p.y}" fill="${p.fill}" font-family="${FONT}" font-size="${p.size}"${weight}${spacePreserve(p.text)}>${esc(p.text)}</text>`;
      if (p.extra) {
        const ew = p.extra.weight ? ` font-weight="${p.extra.weight}"` : "";
        t += `\n    <text x="${p.extra.x}" y="${p.y}" fill="${p.extra.color}" font-family="${FONT}" font-size="${p.extra.size ?? p.size}"${ew}${spacePreserve(p.extra.text)}>${esc(p.extra.text)}</text>`;
      }
      return t;
    })
    .join("\n");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  <rect width="${W}" height="${H}" rx="8" ry="8" fill="#181818"/>
  <g transform="translate(20 24)">
    <rect x="0" y="0" width="${innerW}" height="${innerH}" rx="5" ry="5" fill="none" stroke="${borderColor}" stroke-width="1.3"/>
${tab}${body}
  </g>
</svg>
`;
  return { file, content: svg, dims: `${W}x${H}` };
}

// Boxless output (bare console lines, e.g. quiet-mode one-liners).
function buildBareSvg({ file, title, desc, lines }) {
  let y = 40;
  const placed = [];
  let first = true;
  for (const l of lines) {
    if (l.k === "b") {
      y += 14;
      continue;
    }
    if (!first) y += 30;
    first = false;
    placed.push({ ...lineSpec(l, "#dfff00"), x: 24, y });
  }
  const W = Math.ceil(
    Math.max(...placed.map((p) => 24 + p.text.length * W17)) + 24,
  );
  const H = y + 40;
  const body = placed
    .map(
      (p) =>
        `  <text x="${p.x}" y="${p.y}" fill="${p.fill}" font-family="${FONT}" font-size="17">${esc(p.text)}</text>`,
    )
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  <rect width="${W}" height="${H}" rx="8" ry="8" fill="#181818"/>
${body}
</svg>
`;
  return { file, content: svg, dims: `${W}x${H}` };
}

// Every generator-owned asset, collected in definition order. The builder
// functions stay pure; these thin collectors record each rendered result so
// the mode handlers below can either write or verify the full set.
const assets = [];
function boxSvg(spec) {
  const result = buildBoxSvg(spec);
  assets.push(result);
  return result;
}
function bareSvg(spec) {
  const result = buildBareSvg(spec);
  assets.push(result);
  return result;
}

// ---- Heart logo rows for the init boxes ----
const HEART = [
  "  ▄██▄   ▄██▄",
  " ██████ ██████",
  " ▀█████ █████▀",
  "   ▀███ ███▀",
  "     ▀█ █▀",
];
const HEART_COLORS = ["#ff8095", "#ff5f7a", "#ff5f7a", "#d16dff", "#eb8cff"];
const WORDMARK_X = 209;

function heartLines() {
  return HEART.map((row, i) => {
    const base = {
      k: "raw",
      color: HEART_COLORS[i],
      x: 34,
      size: 17,
      weight: 700,
      text: row,
    };
    if (i === 2) {
      base.extra = {
        x: WORDMARK_X,
        color: BRIGHT,
        weight: 700,
        size: 18,
        text: "commitment-issues",
      };
    }
    if (i === 3) {
      base.extra = {
        x: WORDMARK_X,
        color: DIM,
        size: 17,
        text: "For developers who overthink every commit.",
      };
    }
    return base;
  });
}

const INIT_ADDED = [
  "- script prepare",
  "- script commit:fix",
  "- script fix:staged",
  "- script test:precommit",
  "- script doctor",
  "- precommitChecks config",
  "- pre-push advisory config",
  "- .git/hooks/pre-commit",
  "- .git/hooks/pre-push",
  "- .gitignore defaults",
];

// ---------------- Pre-commit ----------------

boxSvg({
  file: "precommit-cannot-inspect-staged.svg",
  severity: "warning",
  title: "Pre-commit cannot inspect staged files terminal output",
  desc: "A terminal-style warning box saying staged files could not be inspected and the commit will continue.",
  lines: [
    { k: "t", text: "Unable to inspect staged files." },
    { k: "b" },
    { k: "d", text: "Commit will continue. Verify Git is available in PATH." },
  ],
});

boxSvg({
  file: "precommit-autofixable-lint.svg",
  severity: "warning",
  title: "Auto-fixable ESLint issues terminal output",
  desc: "A terminal-style warning box showing auto-fixable ESLint issues and the commit fix command.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 2 auto-fixable ESLint issues found" },
    { k: "b" },
    { k: "d", text: "apply automatic fixes and amend it:" },
    { k: "cmd", text: "npm run commit:fix" },
  ],
});

boxSvg({
  file: "precommit-staged-test-failure.svg",
  severity: "warning",
  title: "Failing staged tests terminal output",
  desc: "A terminal-style warning box showing that a staged test file is failing.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 1 staged test file failing" },
    { k: "di", text: "test/widget.test.mjs" },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-tool-crash.svg",
  severity: "warning",
  title: "Tool crash terminal output",
  desc: "A terminal-style warning box showing that ESLint failed to complete.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ ESLint failed to complete" },
    { k: "di", text: "Check ESLint install and project config" },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-tool-unavailable.svg",
  severity: "warning",
  title: "Tool unavailable terminal output",
  desc: "A terminal-style warning box showing that ESLint could not be run at all.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ ESLint is not installed locally" },
    { k: "di", text: "Install it: npm install -D eslint" },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-amend-blocked.svg",
  severity: "warning",
  title: "Amend blocked by other tracked changes terminal output",
  desc: "A terminal-style warning box explaining that other tracked changes suppress the automatic amend command.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 1 file with formatting issues" },
    { k: "di", text: "src/config.json" },
    { k: "b" },
    {
      k: "d",
      text: "Other tracked changes will still be present after commit, so no automatic amend command is shown.",
    },
    { k: "di", text: "src/app.js" },
  ],
});

boxSvg({
  file: "precommit-amend-uninspectable.svg",
  severity: "warning",
  title: "Worktree not inspectable for amend terminal output",
  desc: "A terminal-style warning box explaining that the working tree could not be inspected for a safe post-commit amend.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 1 file with formatting issues" },
    { k: "di", text: "src/config.json" },
    { k: "b" },
    {
      k: "d",
      text: "The working tree could not be inspected for a safe post-commit amend.",
    },
  ],
});

boxSvg({
  file: "precommit-fun-tone.svg",
  severity: "warning",
  title: "Fun tone suggestions terminal output",
  desc: "A terminal-style warning box showing the fun tone wording for pre-commit suggestions.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Relationship notes:" },
    { k: "b" },
    { k: "a", text: '→ 1 file told Prettier "this is just how I am"' },
    { k: "di", text: "src/config.json" },
    { k: "b" },
    { k: "d", text: "send the apology text and amend it:" },
    { k: "cmd", text: "npm run commit:fix" },
  ],
});

boxSvg({
  file: "precommit-commit-guards.svg",
  severity: "warning",
  title: "Commit guard suggestions terminal output",
  desc: "A terminal-style warning box showing protected-branch, behind-upstream, and commit-shape advisories.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: '→ Committing directly to protected branch "main"' },
    { k: "di", text: "Consider a branch: git switch -c <name>" },
    { k: "a", text: "→ Branch is 7 commits behind origin/main" },
    { k: "di", text: "Pull or rebase before stacking more commits." },
    { k: "a", text: "→ Large commit: 47 staged files (limit 30)" },
    { k: "di", text: "Consider splitting this into smaller commits." },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-protected-branch.svg",
  severity: "warning",
  title: "Protected-branch commit advisory terminal output",
  desc: "A terminal-style warning box advising against committing directly to a protected branch.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: '→ Committing directly to protected branch "main"' },
    { k: "di", text: "Consider a branch: git switch -c <name>" },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-behind-upstream.svg",
  severity: "warning",
  title: "Behind upstream advisory terminal output",
  desc: "A terminal-style warning box saying the branch is behind its upstream and suggesting a pull or rebase.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ Branch is 7 commits behind origin/main" },
    { k: "di", text: "Pull or rebase before stacking more commits." },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-large-commit.svg",
  severity: "warning",
  title: "Large commit advisory terminal output",
  desc: "A terminal-style warning box saying the commit exceeds the file-count and changed-line limits.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ Large commit: 47 staged files (limit 30)" },
    { k: "di", text: "Consider splitting this into smaller commits." },
    { k: "a", text: "→ Large commit: 3204 changed lines (limit 2000)" },
    { k: "di", text: "Consider splitting this into smaller commits." },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-large-file.svg",
  severity: "warning",
  title: "Large staged file advisory terminal output",
  desc: "A terminal-style warning box listing a staged file over the size threshold with a Git LFS pointer.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 1 staged file over 5 MB" },
    { k: "di", text: "42.0 MB  demo.mov" },
    { k: "di", text: "Did you mean to use Git LFS?" },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-generated-files.svg",
  severity: "warning",
  title: "Generated files staged advisory terminal output",
  desc: "A terminal-style warning box flagging staged build artifacts that are usually ignored.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 2 generated files staged" },
    { k: "di", text: "coverage/index.html, dist/bundle.js" },
    { k: "di", text: "These are usually ignored, not committed." },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-secrets-advisory.svg",
  severity: "warning",
  title: "Possible secrets staged advisory terminal output",
  desc: "A terminal-style warning box listing a staged .env file and an AWS key finding with rotation guidance.",
  lines: [
    { k: "t", text: "Pre-commit suggestions found" },
    { k: "b" },
    { k: "d", text: "Commit will continue. Suggestions:" },
    { k: "b" },
    { k: "a", text: "→ 2 possible secrets staged" },
    { k: "di", text: ".env (.env file)" },
    { k: "di", text: "src/auth.ts:12 (AWS access key ID)" },
    {
      k: "di",
      text: "Never commit real credentials — rotate anything already exposed.",
    },
    { k: "b" },
    { k: "d", text: "No automatic fix command for these issues." },
  ],
});

boxSvg({
  file: "precommit-blocked-secrets.svg",
  severity: "error",
  title: "Commit blocked on staged secret terminal output",
  desc: "A terminal-style error box showing a commit refused because a possible secret is staged.",
  lines: [
    { k: "t", text: "Commit blocked: possible secret staged." },
    { k: "b" },
    { k: "d", text: "src/auth.ts:12 (AWS access key ID)" },
    { k: "b" },
    { k: "d", text: "Remove the secret and rotate anything already exposed." },
    { k: "d", text: "To bypass once: git commit --no-verify" },
  ],
});

boxSvg({
  file: "precommit-blocked-protected-branch.svg",
  severity: "error",
  title: "Commit blocked on protected branch terminal output",
  desc: "A terminal-style error box showing a commit refused on a protected branch with bypass instructions.",
  lines: [
    { k: "t", text: "Commit blocked: protected branch." },
    { k: "b" },
    {
      k: "d",
      text: 'Committing to "main" is blocked by blockProtectedBranches.',
    },
    { k: "b" },
    { k: "d", text: "Create a branch: git switch -c <name>" },
    { k: "d", text: "To bypass once: git commit --no-verify" },
  ],
});

// ---------------- Commit fix ----------------

boxSvg({
  file: "commit-fix-protected-reference.svg",
  severity: "error",
  title: "Commit retained by protected reference terminal output",
  desc: "A terminal-style error box refusing to amend a commit retained by a local tag or known remote ref.",
  lines: [
    {
      k: "t",
      text: "The latest commit is retained by a protected Git reference.",
    },
    { k: "b" },
    {
      k: "d",
      text: "A local tag or locally known remote ref already contains it:",
    },
    { k: "b" },
    { k: "di", text: "refs/remotes/origin/main" },
    { k: "b" },
    {
      k: "d",
      text: "Make a new commit with the fixes instead of rewriting this one.",
    },
  ],
});

boxSvg({
  file: "commit-fix-detached.svg",
  severity: "error",
  title: "Detached commit amend refusal terminal output",
  desc: "A terminal-style error box refusing to amend a detached commit.",
  lines: [
    { k: "t", text: "Cannot amend a detached commit." },
    { k: "b" },
    {
      k: "d",
      text: "The latest commit is not attached to a local branch. Amending it",
    },
    {
      k: "d",
      text: "could leave the replacement reachable only through Git's reflog.",
    },
    {
      k: "d",
      text: "Switch to or create the branch that should own it, then try again:",
    },
    { k: "b" },
    { k: "bt", text: "npm run commit:fix" },
  ],
});

boxSvg({
  file: "commit-fix-signed.svg",
  severity: "error",
  title: "Signed commit amend refusal terminal output",
  desc: "A terminal-style error box refusing to replace a signed commit without an explicit signing workflow.",
  lines: [
    { k: "t", text: "Cannot automatically amend a signed commit." },
    { k: "b" },
    {
      k: "d",
      text: "Automatic amend would replace it without an explicitly approved",
    },
    { k: "d", text: "signature." },
    {
      k: "d",
      text: "Apply fixes manually, then use your normal signed-amend workflow.",
    },
    { k: "d", text: "No index or history was changed." },
  ],
});

boxSvg({
  file: "commit-fix-dirty-worktree.svg",
  severity: "error",
  title: "Dirty worktree amend refusal terminal output",
  desc: "A terminal-style error box refusing to amend while tracked changes exist in the worktree.",
  lines: [
    { k: "t", text: "Cannot safely amend the latest commit." },
    { k: "b" },
    { k: "d", text: "Commit, stash, or discard tracked changes first:" },
    { k: "b" },
    { k: "di", text: "src/app.js" },
  ],
});

boxSvg({
  file: "commit-fix-already-clean.svg",
  severity: "success",
  title: "Latest commit already clean terminal output",
  desc: "A terminal-style success box saying the latest commit needed no automatic fixes.",
  lines: [
    { k: "t", text: "Latest commit already clean." },
    { k: "b" },
    { k: "d", text: "Checked 2 files from the latest commit." },
    { k: "di", text: "src/app.js, src/utils.js" },
  ],
});

boxSvg({
  file: "commit-fix-partial.svg",
  severity: "warning",
  title: "Commit amended with available fixes terminal output",
  desc: "A terminal-style warning box saying the commit was amended but manual issues remain.",
  lines: [
    { k: "t", text: "Latest commit amended with available fixes." },
    { k: "b" },
    { k: "d", text: "Some issues still need manual attention." },
    { k: "d", text: "Updated files: src/warn.js" },
  ],
});

boxSvg({
  file: "commit-fix-manual-only.svg",
  severity: "warning",
  title: "No automatic fixes landed terminal output",
  desc: "A terminal-style warning box saying no automatic changes were added and manual fixes are needed.",
  lines: [
    { k: "t", text: "Manual attention still needed." },
    { k: "b" },
    { k: "d", text: "No automatic changes were added to the latest commit." },
    {
      k: "d",
      text: "Review the ESLint or Prettier output above and amend manually after fixing.",
    },
  ],
});

boxSvg({
  file: "commit-fix-emptied-commit.svg",
  severity: "warning",
  title: "Fixes emptied the commit terminal output",
  desc: "A terminal-style warning box explaining the fixes reverted the commit's only changes.",
  lines: [
    { k: "t", text: "Nothing to amend — the fixes emptied the latest commit." },
    { k: "b" },
    {
      k: "d",
      text: "The automatic fixes reverted the only changes in the latest",
    },
    { k: "d", text: "commit, so amending it would create an empty commit." },
    { k: "b" },
    {
      k: "d",
      text: "Drop the now-redundant commit with:  git reset --soft HEAD^",
    },
  ],
});

boxSvg({
  file: "commit-fix-no-commit.svg",
  severity: "error",
  title: "No commit to inspect terminal output",
  desc: "A terminal-style error box saying the latest commit could not be inspected.",
  lines: [
    { k: "t", text: "Unable to inspect the latest commit." },
    { k: "b" },
    {
      k: "d",
      text: "Check that Git is available and the current directory has at least one commit.",
    },
  ],
});

boxSvg({
  file: "commit-fix-unverified.svg",
  severity: "error",
  title: "Cannot inspect commit history safety terminal output",
  desc: "A terminal-style error box refusing to amend because Git could not inspect the commit's attachment, metadata, tags, or known remote refs.",
  lines: [
    {
      k: "t",
      text: "Unable to prove the latest commit is safe to amend.",
    },
    { k: "b" },
    {
      k: "d",
      text: "Amending rewrites history, so nothing was changed.",
    },
    {
      k: "d",
      text: "Check that Git can inspect HEAD, commit metadata, tags, and",
    },
    { k: "d", text: "remote-tracking refs, then try again." },
  ],
});

boxSvg({
  file: "commit-fix-no-fixable-files.svg",
  severity: "info",
  title: "No fixable files in commit terminal output",
  desc: "A terminal-style info box saying the latest commit has no staged-fixer targets.",
  lines: [
    { k: "t", text: "No fixable files in the latest commit." },
    { k: "b" },
    {
      k: "d",
      text: "The latest commit does not contain staged-fixer targets.",
    },
  ],
});

boxSvg({
  file: "commit-fix-concurrent.svg",
  severity: "error",
  title: "Commit fix concurrent-state refusal terminal output",
  desc: "A terminal-style error box refusing to amend after repository state changes during automatic fixes.",
  lines: [
    {
      k: "t",
      text: "Repository state changed while automatic fixes were running.",
    },
    { k: "b" },
    { k: "d", text: "The latest commit was not amended." },
    {
      k: "d",
      text: "Concurrent work was preserved. Review git status, then try again:",
    },
    { k: "b" },
    { k: "bt", text: "npm run commit:fix" },
  ],
});

boxSvg({
  file: "commit-fix-stage-failed.svg",
  severity: "error",
  title: "Commit fix safety revalidation failed terminal output",
  desc: "A terminal-style error box saying automatic fixes could not be applied or staged safely.",
  lines: [
    { k: "t", text: "Unable to apply automatic fixes safely." },
    { k: "b" },
    {
      k: "d",
      text: "The repository could not be revalidated, so the commit",
    },
    {
      k: "d",
      text: "was not amended. Review git status, then try again.",
    },
    { k: "d", text: "Unable to prepare exact staged fixes." },
  ],
});

boxSvg({
  file: "commit-fix-amend-failed.svg",
  severity: "error",
  title: "Amend failed terminal output",
  desc: "A terminal-style error box saying the staged fixes could not be amended into the commit.",
  lines: [
    {
      k: "t",
      text: "Automatic fixes were staged, but the latest commit could not be amended.",
    },
    { k: "b" },
    {
      k: "d",
      text: "Run git commit --amend --no-edit manually after reviewing the staged changes.",
    },
  ],
});

boxSvg({
  file: "commit-fix-cannot-inspect.svg",
  severity: "error",
  title: "Cannot inspect Git state terminal output",
  desc: "A terminal-style error box saying the current working tree could not be inspected.",
  lines: [
    { k: "t", text: "Unable to inspect the current working tree." },
    { k: "b" },
    {
      k: "d",
      text: "Check that Git is available and the working tree can be inspected.",
    },
  ],
});

boxSvg({
  file: "commit-fix-cannot-list-files.svg",
  severity: "error",
  title: "Cannot list latest commit files terminal output",
  desc: "A terminal-style error box saying the files from the latest commit could not be listed.",
  lines: [
    { k: "t", text: "Unable to inspect files from the latest commit." },
    { k: "b" },
    {
      k: "d",
      text: "Check that the latest commit can be read from Git history.",
    },
  ],
});

boxSvg({
  file: "commit-fix-cannot-inspect-fixes.svg",
  severity: "error",
  title: "Cannot inspect staged fixes terminal output",
  desc: "A terminal-style error box saying the staged fixes could not be inspected.",
  lines: [
    { k: "t", text: "Unable to inspect staged fixes for the latest commit." },
    { k: "b" },
    { k: "d", text: "Check the Git index and try again." },
  ],
});

// ---------------- Fix staged ----------------

boxSvg({
  file: "fix-staged-none.svg",
  severity: "info",
  title: "No staged files to fix terminal output",
  desc: "A terminal-style info box saying there are no staged fixable files.",
  lines: [
    { k: "t", text: "No staged files to fix." },
    { k: "b" },
    {
      k: "d",
      text: "Stage a JS, JSON, CSS, Markdown, HTML, or YAML file and run npm run fix:staged again.",
    },
  ],
});

boxSvg({
  file: "fix-staged-already-clean.svg",
  severity: "success",
  title: "Staged files already clean terminal output",
  desc: "A terminal-style success box saying the staged files needed no automatic changes.",
  lines: [
    { k: "t", text: "Staged files already clean." },
    { k: "b" },
    {
      k: "d",
      text: "Checked 2 staged files. No automatic changes were needed.",
    },
    { k: "di", text: "src/app.js, src/utils.js" },
  ],
});

boxSvg({
  file: "fix-staged-manual.svg",
  severity: "warning",
  title: "Staged fixes need manual attention terminal output",
  desc: "A terminal-style warning box saying fixes were applied but lint issues remain.",
  lines: [
    { k: "t", text: "Manual attention still needed." },
    { k: "b" },
    {
      k: "d",
      text: "Available fixes were applied and the index was refreshed.",
    },
    {
      k: "d",
      text: "Review the ESLint or Prettier output above, then commit again when ready.",
    },
  ],
});

boxSvg({
  file: "fix-staged-missing-file.svg",
  severity: "error",
  title: "Staged file missing from worktree terminal output",
  desc: "A terminal-style error box refusing to fix staged files that are missing from the working tree.",
  lines: [
    {
      k: "t",
      text: "Cannot safely fix staged files missing from the working tree.",
    },
    { k: "b" },
    { k: "d", text: "Restore or unstage these files first:" },
    { k: "b" },
    { k: "di", text: "src/removed.js" },
  ],
});

boxSvg({
  file: "fix-staged-cannot-inspect.svg",
  severity: "error",
  title: "Fix staged cannot inspect files terminal output",
  desc: "A terminal-style error box saying staged files could not be inspected.",
  lines: [
    { k: "t", text: "Unable to inspect staged files." },
    { k: "b" },
    {
      k: "d",
      text: "Check that Git is available and the current directory is a repository.",
    },
  ],
});

boxSvg({
  file: "fix-staged-cannot-inspect-unstaged.svg",
  severity: "error",
  title: "Fix staged cannot inspect unstaged files terminal output",
  desc: "A terminal-style error box saying unstaged files could not be inspected.",
  lines: [
    { k: "t", text: "Unable to inspect unstaged files." },
    { k: "b" },
    {
      k: "d",
      text: "Check that Git is available and the working tree can be inspected.",
    },
  ],
});

// ---------------- Pre-push ----------------

boxSvg({
  file: "prepush-protected-tests-passed.svg",
  severity: "warning",
  title: "Protected-branch push with passing tests terminal output",
  desc: "A terminal-style warning box consolidating a protected-branch advisory with passing pre-push tests.",
  lines: [
    { k: "t", text: "Push allowed with 1 warning." },
    { k: "b" },
    { k: "a", text: '→ Direct push to protected branch "main"' },
    { k: "b" },
    { k: "d", text: "All tests passed: 1 passed, 0 failed." },
  ],
});

boxSvg({
  file: "prepush-protected-tests-failed.svg",
  severity: "warning",
  title: "Protected-branch push with advisory test failure terminal output",
  desc: "A terminal-style warning box consolidating a protected-branch advisory with an advisory pre-push test failure.",
  lines: [
    { k: "t", text: "Push allowed with 2 warnings." },
    { k: "b" },
    {
      k: "a",
      text: "→ Tests failed (advisory): 1 related test failed (0 passed, 1 failed)",
    },
    { k: "a", text: '→ Direct push to protected branch "main"' },
    { k: "b" },
    { k: "d", text: "Review the failing test output above." },
  ],
});

boxSvg({
  file: "prepush-blocked-could-not-run.svg",
  severity: "error",
  title: "Push blocked because tests could not run terminal output",
  desc: "A terminal-style error box saying the push was blocked because the test command could not run.",
  lines: [
    { k: "t", text: "Push blocked: could not run tests" },
    { k: "b" },
    { k: "d", text: "Check precommitChecks.testCommand in package.json." },
  ],
});

boxSvg({
  file: "prepush-advisory-could-not-run.svg",
  severity: "warning",
  title: "Advisory tests could not run terminal output",
  desc: "A terminal-style warning box saying the test command could not run and the push was allowed.",
  lines: [
    { k: "t", text: "Could not run tests (advisory)" },
    { k: "b" },
    { k: "d", text: "Check precommitChecks.testCommand in package.json." },
    { k: "d", text: "Push allowed." },
  ],
});

bareSvg({
  file: "prepush-config-conflict.svg",
  title: "Pre-push config conflict warning line",
  desc: "A single yellow console warning saying both push-test modes are set and blocking wins.",
  lines: [
    {
      k: "raw",
      color: "#dfff00",
      text: "⚠ Both blockPushOnTestFailure and advisePushTests are set; using",
    },
    {
      k: "raw",
      color: "#dfff00",
      text: "blockPushOnTestFailure (block on failure). Remove advisePushTests",
    },
    { k: "raw", color: "#dfff00", text: "from package.json to silence this." },
  ],
});

bareSvg({
  file: "config-unknown-key-warning.svg",
  title: "Unknown precommitChecks key warning line",
  desc: "A single yellow console warning saying an unknown precommitChecks key is being ignored.",
  lines: [
    {
      k: "raw",
      color: "#dfff00",
      text: "⚠ Ignoring unknown precommitChecks key(s) in package.json:",
    },
    { k: "raw", color: "#dfff00", text: "requireTest. Check for typos." },
  ],
});

bareSvg({
  file: "config-invalid-value-warning.svg",
  title: "Invalid precommitChecks value warning line",
  desc: "A single yellow console warning saying an invalid precommitChecks value is being ignored.",
  lines: [
    {
      k: "raw",
      color: "#dfff00",
      text: "⚠ Ignoring invalid precommitChecks value(s) in package.json:",
    },
    { k: "raw", color: "#dfff00", text: "advisePushTests must be a boolean." },
  ],
});

boxSvg({
  file: "prepush-protected-branch-advisory.svg",
  severity: "warning",
  title: "Protected-branch push advisory terminal output",
  desc: "A terminal-style warning box consolidating an allowed push with a protected-branch advisory.",
  lines: [
    { k: "t", text: "Push allowed with 1 warning." },
    { k: "b" },
    { k: "a", text: '→ Direct push to protected branch "main"' },
  ],
});

boxSvg({
  file: "prepush-blocked-protected-branch.svg",
  severity: "error",
  title: "Push blocked on protected branch terminal output",
  desc: "A terminal-style error box showing a push refused to a protected branch with bypass instructions.",
  lines: [
    { k: "t", text: "Push blocked: protected branch." },
    { k: "b" },
    { k: "d", text: 'Pushing to "main" is blocked by blockProtectedBranches.' },
    { k: "b" },
    { k: "d", text: "Push a feature branch and open a pull request instead." },
    { k: "d", text: "To bypass once: git push --no-verify" },
  ],
});

// ---------------- Doctor ----------------

boxSvg({
  file: "doctor-healthy.svg",
  severity: "success",
  title: "Doctor healthy terminal output",
  desc: "A terminal-style success box saying git hooks are wired up and active.",
  lines: [
    { k: "t", text: "Git hooks are healthy." },
    { k: "b" },
    { k: "d", text: ".git/hooks is active — no hook manager needed." },
    { k: "d", text: "pre-commit and pre-push are wired up and active." },
  ],
});

boxSvg({
  file: "doctor-repaired-hooks.svg",
  severity: "warning",
  title: "Doctor repaired hooks terminal output",
  desc: "A terminal-style warning box saying doctor repaired the git hook wiring.",
  lines: [
    { k: "t", text: "Repaired the git hook wiring." },
    { k: "b" },
    { k: "d", text: "Was broken: missing hook file(s): pre-commit, pre-push." },
    { k: "d", text: "Fixed: .git/hooks/pre-commit, .git/hooks/pre-push." },
    { k: "b" },
    { k: "d", text: "pre-commit and pre-push are active again." },
  ],
});

boxSvg({
  file: "doctor-hook-not-wired.svg",
  severity: "warning",
  title: "Doctor hook not wired terminal output",
  desc: "A terminal-style warning box saying a custom git hook never invokes commitment-issues.",
  lines: [
    { k: "t", text: "A git hook does not invoke commitment-issues." },
    { k: "b" },
    {
      k: "d",
      text: ".git/hooks/pre-commit never runs `commitment-issues precommit`.",
    },
    { k: "b" },
    {
      k: "d",
      text: "Add the command above to each hook, or delete the hook file so",
    },
    {
      k: "d",
      text: "doctor can recreate it. Existing hooks are never overwritten.",
    },
  ],
});

boxSvg({
  file: "doctor-missing-tools.svg",
  severity: "warning",
  title: "Doctor missing tools terminal output",
  desc: "A terminal-style warning box listing required tools that are not installed.",
  lines: [
    { k: "t", text: "Some required tools are not installed." },
    { k: "b" },
    { k: "d", text: "• eslint" },
    { k: "d", text: "• prettier" },
    { k: "b" },
    {
      k: "d",
      text: "commitment-issues only runs project-local copies of these tools.",
    },
    {
      k: "d",
      text: "Hooks never ask npx to download a missing peer dependency.",
    },
    {
      k: "d",
      text: "Install them: npm install -D eslint prettier",
    },
  ],
});

boxSvg({
  file: "doctor-not-git-repo.svg",
  severity: "error",
  title: "Doctor not a git repository terminal output",
  desc: "A terminal-style error box saying the current directory is not a git repository.",
  lines: [
    { k: "t", text: "Not a git repository." },
    { k: "b" },
    { k: "d", text: "Run this from inside your git project." },
  ],
});

boxSvg({
  file: "doctor-repair-failed.svg",
  severity: "error",
  title: "Doctor repair failed terminal output",
  desc: "A terminal-style error box saying the git hook wiring could not be repaired.",
  lines: [
    { k: "t", text: "Could not repair the git hook wiring." },
    { k: "b" },
    { k: "d", text: "Unsetting the husky-era core.hooksPath failed. Run:" },
    { k: "d", text: "  git config --unset core.hooksPath" },
    { k: "d", text: "Then rerun npm run doctor." },
  ],
});

boxSvg({
  file: "doctor-still-broken.svg",
  severity: "error",
  title: "Doctor wiring still broken terminal output",
  desc: "A terminal-style error box saying the hook wiring still looks broken after repair.",
  lines: [
    { k: "t", text: "Hook wiring still looks broken after repair." },
    { k: "b" },
    {
      k: "d",
      text: "Confirm core.hooksPath is unset: git config --get core.hooksPath",
    },
    { k: "d", text: "Then confirm .git/hooks/pre-commit and pre-push exist." },
  ],
});

boxSvg({
  file: "doctor-hookspath-foreign.svg",
  severity: "warning",
  title: "Doctor foreign core.hooksPath terminal output",
  desc: "A terminal-style warning box saying core.hooksPath points at a directory the tool does not manage, with the commands to add there.",
  lines: [
    { k: "t", text: "core.hooksPath points somewhere else." },
    { k: "b" },
    { k: "d", text: "git core.hooksPath is set to githooks, so git only" },
    {
      k: "d",
      text: "runs hooks from that directory. Add these commands there:",
    },
    { k: "b" },
    { k: "cmd", text: "commitment-issues precommit   (pre-commit)" },
    { k: "cmd", text: "commitment-issues prepush   (pre-push)" },
    { k: "b" },
    { k: "d", text: "Or unset it to use native .git/hooks wiring:" },
    { k: "d", text: "  git config --unset core.hooksPath" },
  ],
});

boxSvg({
  file: "doctor-leftover-husky-hooks.svg",
  severity: "warning",
  title: "Doctor leftover .husky hooks terminal output",
  desc: "A terminal-style warning box listing user-authored .husky hooks that no longer run after the husky wiring was retired.",
  lines: [
    { k: "t", text: "Leftover .husky hooks no longer run." },
    { k: "b" },
    { k: "d", text: "• .husky/commit-msg" },
    { k: "b" },
    {
      k: "d",
      text: "Git hooks now live in .git/hooks, so these files are inert.",
    },
    { k: "d", text: "Move the logic into .git/hooks, or delete the files." },
  ],
});

bareSvg({
  file: "doctor-quiet-lines.svg",
  title: "Doctor quiet mode one-line output",
  desc: "Plain console lines from doctor --quiet: a yellow missing-tool warning and a dim repaired notice.",
  lines: [
    {
      k: "raw",
      color: "#dfff00",
      text: "commitment-issues: missing required tool(s): eslint — install with `npm install -D eslint`.",
    },
    {
      k: "raw",
      color: "#858b91",
      text: "commitment-issues: repaired git hooks (.git/hooks/pre-commit, .git/hooks/pre-push).",
    },
  ],
});

// ---------------- Init ----------------

boxSvg({
  file: "init-success.svg",
  severity: null, // green printBox with no severity tab
  title: "Init success terminal output",
  desc: "A green terminal-style box with the split-heart logo saying Commitment Issues is set up.",
  lines: [
    ...heartLines(),
    { k: "b" },
    { k: "bt", text: "Commitment Issues is set up." },
    { k: "b" },
    { k: "d", text: "Added:" },
    ...INIT_ADDED.map((text) => ({ k: "d", text })),
    { k: "b" },
    { k: "d", text: "Your next commit runs advisory checks." },
    {
      k: "d",
      text: "Your next push runs advisory tests when matching tests exist.",
    },
  ],
});

boxSvg({
  file: "init-dry-run.svg",
  severity: "info",
  title: "Init dry run terminal output",
  desc: "A terminal-style info box previewing the changes init would make without writing files.",
  lines: [
    ...heartLines(),
    { k: "b" },
    { k: "t", text: "Commitment Issues dry run preview." },
    { k: "b" },
    { k: "d", text: "Would add:" },
    ...INIT_ADDED.map((text) => ({ k: "d", text })),
    { k: "b" },
    { k: "d", text: "No files were written." },
    { k: "d", text: "Run again without --dry-run to apply these changes." },
  ],
});

boxSvg({
  file: "init-already-configured.svg",
  severity: null,
  title: "Init already configured terminal output",
  desc: "A green terminal-style box saying everything is already configured and nothing changed.",
  lines: [
    ...heartLines(),
    { k: "b" },
    { k: "bt", text: "Commitment Issues is set up." },
    { k: "b" },
    { k: "d", text: "Already configured — nothing to change." },
    { k: "b" },
    { k: "d", text: "Your next commit runs advisory checks." },
    {
      k: "d",
      text: "Your next push runs advisory tests when matching tests exist.",
    },
  ],
});

boxSvg({
  file: "no-package-json.svg",
  severity: "error",
  title: "No package.json terminal output",
  desc: "A terminal-style error box saying no package.json was found in the current directory.",
  lines: [
    { k: "t", text: "No package.json found." },
    { k: "b" },
    { k: "d", text: "Run this from your project root." },
  ],
});

boxSvg({
  file: "init-invalid-package-json.svg",
  severity: "error",
  title: "Invalid package.json terminal output",
  desc: "A terminal-style error box saying package.json is not valid JSON.",
  lines: [
    { k: "t", text: "Invalid package.json." },
    { k: "b" },
    {
      k: "d",
      text: "Fix package.json so it contains valid JSON, then run init again.",
    },
  ],
});

boxSvg({
  file: "init-hook-wiring-warning.svg",
  severity: "warning",
  title: "Init hook wiring warning terminal output",
  desc: "A terminal-style warning summary combining init progress with hook wiring that needs manual attention.",
  lines: [
    { k: "t", text: "Commitment Issues needs hook wiring." },
    { k: "b" },
    {
      k: "d",
      text: "Package settings are configured; hook wiring still needs attention.",
    },
    { k: "b" },
    { k: "t", text: "Hook wiring needs your attention." },
    { k: "b" },
    { k: "d", text: "Leftover .husky hooks no longer run: .husky/commit-msg." },
    { k: "d", text: "Move the logic into .git/hooks, or delete the files." },
  ],
});

boxSvg({
  file: "uninstall-manual-cleanup.svg",
  severity: "warning",
  title: "Uninstall with manual cleanup terminal output",
  desc: "A terminal-style warning summary combining completed managed cleanup with a customized hook that still needs manual work.",
  lines: [
    { k: "t", text: "Managed Commitment Issues setup was removed." },
    { k: "b" },
    { k: "d", text: "Removed:" },
    {
      k: "d",
      text: "- package scripts: prepare, commit:fix, fix:staged, doctor",
    },
    { k: "d", text: "- package.json precommitChecks config" },
    { k: "b" },
    { k: "bt", text: "Manual cleanup still needed:" },
    { k: "d", text: "- .git/hooks/pre-commit is customized." },
    { k: "di", text: "Remove its commitment-issues command manually." },
    { k: "b" },
    { k: "d", text: "Then run: npm remove commitment-issues" },
  ],
});

boxSvg({
  file: "fix-staged-concurrent.svg",
  severity: "error",
  title: "Fix staged concurrent-state refusal terminal output",
  desc: "A terminal-style error box refusing to stage after repository state changes during automatic fixes.",
  lines: [
    {
      k: "t",
      text: "Repository state changed while automatic fixes were running.",
    },
    { k: "b" },
    { k: "d", text: "Concurrent work was not staged." },
    {
      k: "d",
      text: "Concurrent work was preserved. Review git status, then try again:",
    },
    { k: "b" },
    { k: "bt", text: "npm run fix:staged" },
  ],
});

boxSvg({
  file: "fix-staged-restage-failed.svg",
  severity: "error",
  title: "Fix staged safety revalidation failed terminal output",
  desc: "A terminal-style error box saying automatic fixes could not be applied or staged safely.",
  lines: [
    { k: "t", text: "Unable to apply automatic fixes safely." },
    { k: "b" },
    { k: "d", text: "Exact staging could not be verified." },
    { k: "d", text: "Unable to prepare exact staged fixes." },
    {
      k: "d",
      text: "Review git status and the tool output, then try again.",
    },
  ],
});

// ---------------- Modes ----------------

// Normal mode: write every generator-owned asset and preserve the historical
// stdout (one "file: WxH" line per asset, then "done").
function writeAll() {
  for (const { file, content, dims } of assets) {
    fs.writeFileSync(path.join(OUT, file), content);
    console.log(`${file}: ${dims}`);
  }
  console.log("done");
}

// --check mode: render every asset in memory and compare it byte-for-byte with
// the committed file. Never creates, rewrites, or deletes anything. Reports all
// missing or stale generator-owned assets by repository-relative path and exits
// nonzero. Hand-authored SVGs are never inspected because only the generated
// set is iterated.
function checkAll() {
  const problems = [];
  for (const { file, content } of assets) {
    const target = path.join(OUT, file);
    const relative = `assets/${file}`;
    let current;
    try {
      current = fs.readFileSync(target);
    } catch (error) {
      if (error.code === "ENOENT") {
        problems.push(`missing: ${relative}`);
        continue;
      }
      throw error;
    }
    if (!current.equals(Buffer.from(content))) {
      problems.push(`stale:   ${relative}`);
    }
  }

  if (problems.length > 0) {
    console.error("Generated message-state SVGs are out of date:");
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    console.error(
      "Run `node tools/gen-message-state-svgs.mjs` and commit the result.",
    );
    process.exit(1);
  }

  console.log(`All ${assets.length} generated message-state SVGs are current.`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  writeAll();
} else if (args.length === 1 && args[0] === "--check") {
  checkAll();
} else {
  console.error(`Unknown option(s): ${args.join(" ")}`);
  console.error("Usage: node tools/gen-message-state-svgs.mjs [--check]");
  process.exit(2);
}
