# Adoption Checklist

A living, maintainer-facing checklist for growing adoption of `commitment-issues`.
Check items off as they land. (Not shipped in the npm package — it's not listed
in `package.json` `files`.)

## Positioning & first impression

- [x] One-line positioning tagline in the README ("For developers who overthink every commit").
- [x] "How it compares" table (vs a hand-rolled husky + lint-staged setup, lefthook, pre-commit).
- [x] "Package managers" section (npm, pnpm, yarn, bun).
- [x] Demo GIF near the top of the README — rendered from `promo/demo.tape` (regenerate with `vhs promo/demo.tape`).
- [x] Before/after workflow graphic with SVG for README/docs and a 16:9 PNG for
      social posts.
- [x] Product Hunt-ready media pack with a square thumbnail and four static
      gallery cards covering the plain-language value story, setup, advisory
      warning, and safe fix.
- [x] Consistent "Catch mistakes while they're still cheap to fix" messaging in
      the README, live npm metadata, rationale, and launch kit.
- [x] Confirm the live npm page carries the new story from v3.5.1.
- [x] Simple logo / wordmark for the README header and social preview.

## Trust signals

- [x] `CHANGELOG.md` in Keep a Changelog format, shipped in the tarball.
- [x] Current immutable GitHub Release with independently verified assets
      (v3.5.1). The legacy empty notes through v3.3.2 are documented; current
      and future releases require reviewed changelog notes.
- [x] Cross-platform CI (Ubuntu/macOS/Windows × Node 22.11.0/24) with coverage.
- [x] Scenario-coverage tracker mapping the full test suite.
- [x] `CONTRIBUTING.md`, issue/PR templates, and a Code of Conduct.
- [x] "good first issue" labels to invite contributors.

## Supply-chain & security trust

The hooks execute inside a consumer's commit/push flow, so "safe to run" is a
direct adoption lever.

- [x] `SECURITY.md` with a private vulnerability-disclosure policy.
- [x] Publish via npm **Trusted Publishing** (OIDC from the `publish.yml`
      release workflow) — tokenless, with npm provenance. Live since v2.4.0.
- [x] Publish the exact npm tarball and matching signed SLSA provenance on one
      immutable GitHub Release. End-to-end validated with v3.5.1.
- [x] `.github/dependabot.yml` (or Renovate) for automated dependency-update PRs.
- [x] OpenSSF Scorecard workflow + badge.
- [x] Coverage badge in the README — surfaces the CI coverage result.

## Reach & compatibility (remove adoption blockers)

- [x] npm, pnpm 10, Yarn Classic 1.22.22, and Bun 1.3.14 supported — each with
      an end-to-end packed CI lifecycle.
- [x] Yarn Berry: documented `nodeLinker: node-modules` support path and
      Plug'n'Play boundary (PM-006).
- [x] Monorepo / workspaces support (MONO-001/002).
- [x] Framework recipes: Next.js, Vite, a TypeScript library.
- [x] CI-provider recipes for skipping hooks in CI (GitHub Actions / GitLab / CircleCI).

## Onboarding & DX

- [x] `commitment-issues --version` / `-v` — prints the package version from the CLI.
- [x] `init --dry-run` to preview changes before writing to `package.json` / `.gitignore`.
- [x] Migration guide: raw husky + lint-staged / lefthook / pre-commit → `commitment-issues`.
- [x] Before/after migration examples showing the hook / `package.json` / `.gitignore` changes to review.
- [x] Uninstall/removal docs — step-by-step manual removal in the [FAQ](docs/faq.md#how-do-i-remove-it).
- [x] FAQ page expanding the README troubleshooting section.

## Discoverability

- [x] npm keywords set in `package.json`.
- [x] GitHub repo topics: `git-hooks`, `husky`, `lint-staged`, `pre-commit`, `eslint`, `prettier`, `developer-tools`.
- [x] Social preview image (Settings → General → Social preview).
- [x] Link the docs (message-states gallery, configuration) prominently from the README.
- [ ] Submit to awesome lists (`awesome-nodejs`, `awesome-eslint`, an awesome-git-hooks list).
- [ ] Publish to **JSR** (jsr.io) alongside npm.
- [x] Enable GitHub Discussions for Q&A.

## Content & community

- [ ] Prepare and execute the Product Hunt launch tracked in
      [#240](https://github.com/RoryGlenn/commitment-issues/issues/240). The
      checklist is in `promo/launch.md`; the maintainer reviews the final listing,
      first maker comment, and replies for accuracy and tone.
- [ ] Blog post: "Why I stopped letting pre-commit hooks block my commits." Draft ready in `promo/launch.md`.
- [ ] Answer relevant threads (r/javascript, r/node, StackOverflow, "husky is annoying" discussions) — genuinely, not spammy.
- [ ] Cross-post to DEV with the original article set as the canonical URL.
- [x] Public roadmap (`ROADMAP.md` or a GitHub Project).
- [x] `FUNDING.yml` / GitHub Sponsors (optional).

## Measure & iterate

Keep measurement lightweight and manual. The package does not add telemetry;
these signals come from public sources or the repository's GitHub Insights.

### Weekly signals

- [ ] npm weekly downloads from the
      [package page](https://www.npmjs.com/package/commitment-issues) or
      [downloads API](https://api.npmjs.org/downloads/point/last-week/commitment-issues).
- [ ] GitHub star trend, treated as context rather than a success target.
- [ ] New issues that reveal install or first-run friction.
- [ ] Discussions and recurring questions.

### Monthly signals

- [ ] GitHub traffic and referrers from Insights → Traffic.
- [ ] Common installation or first-run failures worth a documentation fix or
      safer default.
- [ ] Repeated questions that one README or FAQ sentence could prevent.
- [ ] Checklist items that should be completed, retired, or reprioritized.

Prefer a few notes after each release to a dashboard that becomes another
maintenance burden. Turn repeated friction into documentation before adding a
new configuration option.

- [ ] Track npm weekly downloads and GitHub traffic/referrers.
- [ ] Note where first-run drop-off happens and smooth it.
- [x] "No telemetry by design" — the
      [README Privacy section](README.md#privacy-and-trust) states the posture
      explicitly.
- [x] Maintainer adoption metrics are recorded in this checklist.
- [ ] Revisit this checklist after each release.
