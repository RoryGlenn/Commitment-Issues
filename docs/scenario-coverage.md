# Scenario Coverage

> **Audience:** maintainers and auditors. This repository-only matrix is not
> installed with the npm package. Scenario identifiers map claims to concrete
> tests, workflows, or an explicit manual/deferred disposition; update the map
> whenever that evidence changes.

This tracker turns the exhaustive scenario list into an implementation plan. Update it whenever a scenario is covered, deferred, or intentionally left manual.

The command, Git-state, lifecycle, finding, and file-ownership evidence for
production-readiness workstream #130 is consolidated in the
[core CLI and Git behavior audit](audits/core-cli-git.md).

## Status values

- **Covered** — automated coverage exists and is expected to run in CI.
- **Partial** — some coverage exists, but important variants remain.
- **Not covered** — no meaningful automated coverage yet.
- **Manual** — best validated manually for now.
- **Deferred** — intentionally not implemented yet.
- **Not applicable** — out of scope for this package.

## Covered

### Test strategy and coverage enforcement

- **TEST-001** — every published runtime module has an explicit, existing test
  owner that references it, and the ownership set exactly matches the
  fail-closed coverage denominator. Unit/invariant: `test/test-quality.test.mjs`;
  map: `docs/branch-coverage.md`.
- **TEST-002** — the only coverage suppressions are the two documented
  post-preflight filesystem races; new or enlarged suppressions fail the
  inventory. Unit/invariant: `test/test-quality.test.mjs`.
- **TEST-003** — deleted tests are not executed, while a deleted source, a
  source-only rename, and a combined source+test rename cannot evade blocking
  related-test selection. Real-Git fixture: `test/prepush.test.mjs`.
- **TEST-004** — all 66 generated message-state assets are gallery-owned and
  exactly reproducible in a private temporary directory. Unit/subprocess:
  `test/visual-assets.test.mjs`.
- **TEST-005** — the aggregate branch-protection gate succeeds only when DCO,
  the complete OS/Node test and npm lifecycle graph, and the non-npm
  package-manager lifecycle matrix each report explicit success. Every
  complementary Windows test shard and the parallel npm lifecycle matrix must
  succeed; skipped or incomplete results fail closed. Unit/invariant:
  `test/test-quality.test.mjs`; CI: `.github/workflows/ci.yml`.
- **TEST-006** — exact logo content and fresh-value behavior are directly
  asserted rather than credited through incidental coverage. Unit:
  `test/logo.test.mjs`.
- **TEST-007** — Windows assigns the same top-level test-file set to the exact
  native Node shard pair `1/2` and `2/2` on Node 22.11.0 and Node 24. The union
  executes every test file exactly once on each Node line. The packed npm
  lifecycle remains separate, while authoritative Ubuntu coverage stays
  complete and unsharded. No test or lifecycle assertion is removed by the
  split. Workflow/invariant: `test/ci-policy.test.mjs`,
  `test/release-integrity.test.mjs`; CI: `.github/workflows/ci.yml`.
- **TEST-008** — the required-CI classifier reads the complete local
  merge-base diff with NUL-delimited path records and classifies runtime/CLI,
  package-manager, test/fixture, workflow/release, documentation/metadata,
  demo/asset, and unknown changes. Only pure allowlisted documentation adds and
  modifications take the small route. Deletes, renames, and copies retain all
  paths but take the full graph; unusual names and large diffs are not
  truncated; executable editor config, mixed/unknown changes, unsupported
  statuses, shallow or missing history, malformed output, and Git failures
  also take the full graph. The small route derives the canonical 100% badge.
  Fork PRs execute classifier code from the immutable base commit, with a fixed
  full-route bootstrap when it is unavailable. An always-running job summary
  exposes the fixed route, flags, categories, and reason, using `unavailable`
  when trusted outputs are absent. `CI Success` distinguishes the small route's
  expected skips from missing or failed work. Hosted route evidence is recorded
  in the [CI audit](audits/ci-cd-and-github-actions.md). Unit/real-Git fixture:
  `test/ci-change-classifier.test.mjs`; workflow invariant:
  `test/ci-policy.test.mjs`; CI: `.github/workflows/ci.yml`.

### Package publishing

- **PKG-001** — package metadata stays consistent with lockfile. Unit: `test/metadata.test.mjs`.
- **PKG-002** — package README documents the Node engine. Unit: `test/metadata.test.mjs`.
- **PKG-003** — package description does not contradict configurable blocking. Unit: `test/metadata.test.mjs`.
- **PKG-004** — package `files` entries exist. Unit: `test/metadata.test.mjs`.
- **PKG-005** — package bin works from a packed tarball across the OS / Node matrix. CI lifecycle integration: `.github/workflows/ci.yml`; runner: `scripts/run-lifecycle-test.mjs`.
- **PKG-006** — README relative image assets, including HTML `<img>` sources, exist and are included in package `files`. Unit: `test/metadata.test.mjs`.
- **PKG-007** — package includes only README-required SVG assets and the explicit
  user-documentation allowlist; repository-only galleries and maintainer
  evidence stay out of the tarball. Unit: `test/metadata.test.mjs` using
  `npm pack --dry-run --json`.
- **PKG-008** — the packed script set equals the complete runtime coverage set,
  includes every relative runtime import and public bin target, and excludes
  every lifecycle/coverage maintenance module. Unit:
  `test/metadata.test.mjs`; full installed behavior: package-manager lifecycle
  matrix.
- **PKG-009** — exact minimum supported Node version runs the full npm test and
  lifecycle matrix on Ubuntu, macOS, and Windows, plus every supported non-npm
  lifecycle on Ubuntu. CI: `.github/workflows/ci.yml`.
- **PKG-010** — package excludes promotional raster/video media and enforces compressed/unpacked size budgets. Unit: `test/metadata.test.mjs`.
- **PKG-011** — the publish workflow packs once, lifecycle-tests the exact
  tarball, confirms its CLI bin/shebang/version on every platform and normalized
  0755/0644 file modes on POSIX/release producers, then hashes, uploads, and
  stages that unchanged artifact. Before maintainer 2FA approval, the workflow
  prepares a complete exact GitHub draft and durable stage record. The hosted
  pack becomes the authoritative byte-level candidate only after the
  recovery/publication gates accept it, and its run summary keeps the SHA-256,
  source, tag, runner OS/image, and exact Node/npm toolchain together without
  blessing a rejected rebuild. Local packs qualify tree contents and behavior
  without promising cross-toolchain archive-byte identity. Windows lanes retain
  platform-relevant bin-shim, installability, and digest checks. SLSA generation
  remains separate, and an npm-incapable finalizer publishes only the already
  complete draft.
  Unit/invariant:
  `test/release-integrity.test.mjs`; integration:
  `test/integration/lifecycle-manager.test.mjs` and
  `test/integration/helpers/lifecycle-fixture.mjs`; tracking: #182.
- **PKG-012** — release preflight rejects local/remote tag, GitHub Release, and
  npm-version collisions and fails closed when a registry cannot be checked.
  Unit: `test/release-integrity.test.mjs`.
- **PKG-013** — release verification uses supported npm signature/attestation
  surfaces rather than the absent `npm view ... provenance` field. Unit:
  `test/release-integrity.test.mjs`.
- **PKG-014** — version tags fetch complete canonical history and fail before
  release-capable work unless their commit is an ancestor of `origin/main`.
  Repository tag rules remain the external release-authority boundary.
  Unit/fixture: `test/release-integrity.test.mjs`; tracking: #94.
- **PKG-015** — partial-publication recovery distinguishes `before-stage`,
  `staged`, `after-npm`, and `complete`; inconsistent or unavailable evidence
  and source/run/stage/digest mismatches fail closed. The immutable stage record
  binds exact package bytes and tag source to one workflow run/attempt. Approval
  requires a complete exact draft, and the explicit finalizer validates the
  successful source run, exact approved stage ID, npm provenance, and retained
  artifacts while holding no npm publishing authority. Post-approval checks
  poll only exact-version and exact-attestation HTTP 404 propagation inside a
  hard 60-second deadline. Full tag reruns after staging, published partial
  release repair, registry metadata changes, and unpublish remain outside
  automation. Mocked unit: `test/release-recovery.test.mjs` and
  `test/release-stage.test.mjs`; workflow invariant:
  `test/release-integrity.test.mjs`; classifiers:
  `tools/release-recovery.mjs` and `tools/release-stage.mjs`; tracking: #183,
  #234, and #236.
- **PKG-016** — release validation requires `package.json`, both root lockfile
  version records, the exact `vX.Y.Z` tag, one dated changelog section, the
  GitHub Release title, and its non-empty reviewed body to agree. The final
  action publishes the extracted changelog section instead of generating or
  maintaining separate notes. A schema-checked ledger preserves the exact
  v3.3.0–v3.3.2 irregularities without allowing prospective empty-note
  exceptions. Unit: `test/release-metadata.test.mjs` and
  `test/release-recovery.test.mjs`; workflow invariant:
  `test/release-integrity.test.mjs`; validator:
  `tools/validate-release-metadata.mjs`; tracking: #184.
- **PKG-017** — every relative link in shipped Markdown resolves inside the
  exact `npm pack` manifest; repository-only targets use canonical GitHub URLs
  instead of entering the package accidentally. Positive and negative unit:
  `test/packed-markdown-links.test.mjs`; real manifest:
  `test/metadata.test.mjs`; clean installed copy across package managers:
  `test/integration/helpers/lifecycle-fixture.mjs`; tracking: #186.

### Path normalization

- **PATH-001** — POSIX paths normalize correctly. Unit: `test/path-normalization.test.mjs`.
- **PATH-002** — Windows backslash paths normalize correctly. Unit: `test/path-normalization.test.mjs`.
- **PATH-003** — mixed separators normalize correctly. Unit: `test/path-normalization.test.mjs`.
- **PATH-004** — spaces and Unicode survive path normalization. Unit: `test/path-normalization.test.mjs`.
- **PATH-005** — equivalent test paths dedupe after normalization. Unit: `test/path-normalization.test.mjs`.

### Docs drift

- **DOC-001** — README avoids unconditional non-blocking claims. Unit: `test/metadata.test.mjs`.
- **DOC-002** — README documents advisory push mode. Unit: `test/metadata.test.mjs`.
- **DOC-003** — README documents blocking push mode. Unit: `test/metadata.test.mjs`.
- **DOC-004** — README image references cannot drift away from packaged assets. Unit: `test/metadata.test.mjs`.
- **DOC-005** — supported Node version stays consistent across the README, docs, and workflows. Unit: `test/metadata.test.mjs`.
- **DOC-006** — every allowlisted `precommitChecks` key appears in the canonical
  user configuration reference and maintainer authoring skill; the external
  interface links to that canonical table. Unit: `test/metadata.test.mjs`.
- **DOC-007** — the aggregate CI gate includes DCO and every prospective-enforcement surface names the same immutable baseline. Unit: `test/metadata.test.mjs`.

### Promotional demo

- **DEMO-001** — the render workflow preserves the generated artifact and
  independently enforces dimensions, frame-count drift, duration drift, and
  normalized visual similarity. Unit: `test/visual-assets.test.mjs`.
- **DEMO-002** — visual comparison masks only the four documented volatile
  values, searches only the metadata-bounded frame offsets, accepts those
  differences, and rejects synthetic missing-scene, color, layout, and clipping
  regressions. Unit/integration: `test/demo-visual-comparison.test.mjs`.
- **DEMO-003** — the reusable before/after SVG and 16:9 PNG preserve the
  CI-only and immediate-local-feedback timelines, the exact fix command, and
  the canonical value promise; README, next-release npm sources, rationale, and
  launch surfaces link the story before feature detail. The real workflow GIF
  remains between 20 and 30 seconds, while render CI requires the social PNG to
  byte-match a fresh SVG render. Unit/CI: `test/visual-assets.test.mjs`,
  `.github/workflows/render-demo.yml`.

### Config

- **CFG-001** — valid `precommitChecks` loads. Unit: `test/config.test.mjs`.
- **CFG-002** — missing `package.json` degrades to `{}`. Unit: `test/config.test.mjs`.
- **CFG-003** — invalid package JSON degrades to `{}` with an explicit source warning. Unit: `test/config.test.mjs`.
- **CFG-004** — missing `precommitChecks` degrades to `{}`. Unit: `test/config.test.mjs`.
- **CFG-005** — malformed `precommitChecks` containers are ignored with an explicit source warning. Fuzz unit: `test/config.test.mjs`.
- **CFG-006** — malformed option values inside an object are tolerated. Fuzz unit: `test/config.test.mjs`.
- **CFG-007** — `.commitmentrc.json` loads direct top-level options without executing code. Unit/subprocess: `test/config.test.mjs`, `test/precommit.test.mjs`.
- **CFG-008** — standalone keys shallowly override matching package keys while preserving unmatched package options; invalid higher-priority values do not revive lower-priority values. Unit/subprocess: `test/config.test.mjs`, `test/precommit.test.mjs`, `test/prepush.test.mjs`.
- **CFG-009** — malformed JSON and non-object standalone roots warn at hook time and fall back to package configuration. Unit/subprocess: `test/config.test.mjs`, `test/precommit.test.mjs`, `test/prepush.test.mjs`.
- **CFG-010** — nested `commitMessage` keys are allowlisted, sanitized, typo-diagnosed, and disabled unless `enabled: true`. Unit: `test/config.test.mjs`.
- **CFG-011** — valid standalone values remain active when the package source is malformed; hooks surface the package failure instead of changing policy silently. Unit/subprocess: `test/config.test.mjs`, `test/precommit.test.mjs`.
- **CFG-012** — `scanDebugArtifacts` and `debugArtifactExempt` are allowlisted,
  type-checked, sanitized, and remain disabled unless explicitly enabled. Unit:
  `test/config.test.mjs`, `test/debug-artifacts.test.mjs`.

### CLI command matrix

- **CLI-001** — `commitment-issues --help` exits 0. Subprocess: `test/cli.test.mjs`.
- **CLI-002** — `commitment-issues -h` exits 0. Subprocess: `test/cli.test.mjs`.
- **CLI-003** — no command prints usage and exits 1. Subprocess: `test/cli.test.mjs`.
- **CLI-004** — unknown command exits 1. Subprocess: `test/cli.test.mjs`.
- **CLI-005** — `doctor` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-006** — `precommit` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-007** — extra args forward to subcommands. Subprocess: `test/cli.test.mjs`.
- **CLI-008** — `init` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-009** — `prepush` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-010** — `commit-fix` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-011** — `fix-staged` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-012** — `fix-staged-js` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-013** — command runs from project root. Subprocess: `test/cli.test.mjs` and other fixture tests.
- **CLI-014** — command runs from a subdirectory. Subprocess: `test/cli.test.mjs`.
- **CLI-015** — CLI help and subcommand error reporting work outside a Git repo / Node project. Subprocess: `test/cli.test.mjs`.
- **CLI-016** — shell-sensitive command tokens are not shell-expanded by the CLI wrapper. Subprocess: `test/cli.test.mjs`.
- **CLI-017** — `uninstall` dispatches through the bin. Subprocess: `test/cli.test.mjs`.
- **CLI-018** — `commit-msg` dispatches through the bin and preserves its message-file argument. Subprocess: `test/cli.test.mjs`.
- **CLI-019** — `--json` forwards to precommit/prepush and is rejected for unsupported subcommands. Subprocess: `test/json-output.test.mjs`.
- **CLI-020** — the hidden `vows` command dispatches successfully, renders one deterministic color-aware box, wraps in narrow terminals, and leaves worktree, package, Git config, and hook state unchanged. Unit/subprocess: `test/vows.test.mjs`, `test/cli.test.mjs`.
- **CLI-021** — every public command's option/positional boundary is documented; unsupported options and excess arguments fail before dispatch can mutate state. Subprocess: `test/cli.test.mjs`, `test/init.test.mjs`, `test/doctor.test.mjs`, `test/uninstall.test.mjs`.
- **CLI-022** — `panic` is public in global and command help, dispatches through
  the bin, accepts no arguments, and remains outside the versioned JSON surface.
  Subprocess: `test/cli.test.mjs`, `test/panic.test.mjs`.

### Panic recovery guide

- **PANIC-001** — outside-repository, clean, detached-HEAD, and verified
  previous-branch states start with the observed state and `git status`, render
  one deterministic box, and explain every displayed command. Unit/real-Git
  fixture: `test/panic.test.mjs`.
- **PANIC-002** — merge, rebase, and cherry-pick conflicts show only inspection
  guidance; no state-changing option is displayed until both the active
  operation and unresolved paths are absent. Real-Git fixture:
  `test/panic.test.mjs`.
- **PANIC-003** — staged changes, staged and unstaged deletions, untracked files,
  and an unborn HEAD receive context-supported guidance. Unstaging is offered
  only with an existing HEAD and preserves working-tree content. Unit/real-Git
  fixture: `test/panic.test.mjs`.
- **PANIC-004** — the command uses only a fixed allowlist of optional-lock-free,
  non-interactive Git probes, never executes a displayed recovery step, and
  never interpolates hostile paths into shell examples. Repository bytes remain
  unchanged, and commands that discard work or force history changes are absent.
  Unit/real-Git fixture: `test/panic.test.mjs`.

### Init

- **INIT-001** — init wires hooks, scripts, config, and is idempotent. Fixture: `test/init.test.mjs`.
- **INIT-002** — init upgrades legacy vendored setup. Fixture: `test/init.test.mjs`.
- **INIT-003** — init preserves explicit push blocking config. Fixture: `test/init.test.mjs`.
- **INIT-004** — init leaves customized pre-commit and pre-push hooks untouched. Fixture: `test/init.test.mjs`.
- **INIT-005** — init errors when `package.json` is missing. Fixture: `test/init.test.mjs`.
- **INIT-006** — init creates `.gitignore` when absent. Fixture: `test/init.test.mjs`.
- **INIT-007** — init appends cache ignores with no trailing newline. Fixture: `test/init.test.mjs`.
- **INIT-008** — init preserves an unrelated existing `prepare` command and appends automatic repair. Fixture: `test/init.test.mjs`.
- **INIT-009** — init leaves an existing lint-staged config exactly as the user wrote it (no adoption, no edits). Fixture: `test/init.test.mjs`.
- **INIT-010** — init migrates a husky-era 2.x setup: retires `core.hooksPath`, removes generated `.husky` wiring, writes native hooks. Fixture: `test/init.test.mjs`.
- **INIT-011** — init errors clearly when `package.json` is invalid JSON. Fixture: `test/init.test.mjs`.
- **INIT-012** — init setup summary renders as a readable list instead of one wide line. Fixture: `test/init.test.mjs`.
- **INIT-013** — init succeeds from the packed package in a fresh Git repo. CI lifecycle integration: `test/integration/lifecycle-manager.test.mjs`.
- **INIT-014** — init adds `node_modules/` to `.gitignore` defaults and avoids duplicate existing entries. Fixture: `test/init-gitignore.test.mjs`.
- **INIT-015** — init keeps user-authored `.husky` hooks and warns they no longer run. Fixture: `test/init.test.mjs`.
- **INIT-016** — init warns about a foreign `core.hooksPath` and leaves it alone. Fixture: `test/init.test.mjs`.
- **INIT-017** — init warns when run outside a git repository but still writes scripts/config. Fixture: `test/init.test.mjs`.
- **INIT-018** — init preserves custom native hooks, accepts those that invoke `commitment-issues`, and withholds setup-complete claims while listing exact commands for those that do not. Fixture: `test/init.test.mjs`.
- **INIT-019** — init preserves an unrelated `postprepare` while composing repair into the project-owned `prepare`. Fixture: `test/init.test.mjs`.
- **INIT-020** — init rejects primitive, null, and array package roots or `scripts`/`precommitChecks` containers before writing; missing and empty object containers remain valid. Fixture: `test/init.test.mjs`.
- **INIT-021** — an existing standalone file receives the generated advisory-push default without creating a package configuration block; dry-run previews without writing. Fixture: `test/init.test.mjs`.
- **INIT-022** — malformed standalone configuration stops init before package, hook, or gitignore writes. Fixture: `test/init.test.mjs`.
- **INIT-023** — commit-msg wiring is opt-in, dry-run aware, executable, idempotent, and never overwrites a custom hook. Fixture: `test/init.test.mjs`, unit: `test/hooks.test.mjs`.
- **INIT-024** — init derives commit-msg wiring from the merged effective
  package/standalone configuration; standalone-only enablement, disabled or
  invalid standalone precedence, dry-run, idempotence, and a packed mixed-source
  lifecycle are covered. Fixture: `test/init.test.mjs`; CI lifecycle integration:
  `test/integration/helpers/lifecycle-fixture.mjs`.
- **INIT-025** — bare repositories never receive or report active local commit/push hooks. Fixture: `test/init.test.mjs`.
- **INIT-026** — failed `core.hooksPath` and common-directory probes withhold hook-health claims and do not write potentially shadowed hooks. Unit/fixture: `test/hooks.test.mjs`, `test/init.test.mjs`.
- **INIT-027** — uninspectable and unwritable hook paths are preserved and reported without raw exceptions or false success. Fixture: `test/init.test.mjs`.
- **INIT-028** — relative native/common hook paths and tilde-based configured paths are resolved through the correct Git/cwd semantics. Unit/fixture: `test/hooks.test.mjs`, `test/doctor.test.mjs`.
- **INIT-029** — unknown setup options fail before project files or hooks change, including misspelled dry-run flags. Fixture: `test/init.test.mjs`.
- **INIT-030** — rerunning setup repairs a deliberately interrupted/partial hook installation idempotently. Fixture: `test/init.test.mjs`.
- **INIT-031** — uninspectable `.gitignore` and unwritable project files fail before hook installation with bounded diagnostics. Fixture: `test/init-gitignore.test.mjs`, `test/init.test.mjs`.
- **INIT-032** — shallow clones and submodules install hooks in their own Git common directories without requiring full history. Fixture: `test/repository-shapes.test.mjs`.
- **INIT-033** — setup and dry-run refuse linked or non-regular mutable project
  files before package, configuration, gitignore, or hook changes; stable
  staged-file and destination identity checks protect the final write boundary.
  Unit/fixture:
  `test/lib-files.test.mjs`, `test/init-gitignore.test.mjs`,
  `test/init.test.mjs`.
- **INIT-034** — Husky, Lefthook, and pre-commit coexistence prints exact
  manager snippets, keeps Lefthook commands free of positional templates,
  targets either supported pre-commit YAML destination (including the `.yml`
  install command),
  writes no manager/native hooks, preserves manager files byte-for-byte,
  composes owner-specific prepare verification, and is idempotent in normal
  and dry-run modes. Unit/fixture:
  `test/hooks.test.mjs`, `test/init.test.mjs`.
- **INIT-035** — automatic integration selection accepts exactly one detected
  owner and refuses zero/multiple owners before writes; explicit selection does
  not override unsafe, duplicate, or unsupported selected config; lint-staged
  names and package YAML keys are reported only as separate, non-executed
  composition evidence. Unit/fixture: `test/hooks.test.mjs`,
  `test/init.test.mjs`.
- **INIT-036** — package, standalone-configuration, and gitignore replacements
  stage complete bytes and verify them byte-for-byte through a no-follow
  descriptor before commit. Short, failed, unsynced, unclosed, changed, or
  uncommitted writes preserve complete old bytes; forced termination across
  every staging phase leaves complete old or new content, retries remove only
  dead-writer transaction files, concurrent readers never parse a partial
  file, original permission bits survive, and hooks remain untouched until all
  required project-file writes complete. Existing hardlinked package and
  gitignore paths are replaced only inside the repository, preserving external
  aliases. Unit/subprocess:
  `test/lib-files.test.mjs`, `test/init.test.mjs`.

## Uninstall

- **UNINST-001** — uninstall removes exact generated scripts and native hook bodies plus the package-specific configuration block while preserving dependencies and shared `.gitignore` entries. Fixture: `test/uninstall.test.mjs`.
- **UNINST-002** — uninstall is idempotent. Fixture: `test/uninstall.test.mjs`.
- **UNINST-003** — `uninstall --dry-run` previews package and hook cleanup without writing. Fixture: `test/uninstall.test.mjs`.
- **UNINST-004** — customized scripts and hooks are preserved and reported for manual cleanup. Fixture: `test/uninstall.test.mjs`.
- **UNINST-005** — package cleanup still works outside a Git repository while uninspectable hooks are reported. Fixture: `test/uninstall.test.mjs`.
- **UNINST-006** — missing and invalid `package.json` states fail clearly. Fixture: `test/uninstall.test.mjs`.
- **UNINST-007** — an active foreign hooks directory is inspected; exact generated bodies are removed while customized commands are preserved. Fixture: `test/uninstall.test.mjs`.
- **UNINST-008** — legacy commands in an active Husky directory are reported and preserved. Fixture: `test/uninstall.test.mjs`.
- **UNINST-009** — a configured native hooks path is deduplicated during inspection. Fixture: `test/uninstall.test.mjs`.
- **UNINST-010** — an unreadable or malformed hook path is reported and left unchanged. Fixture: `test/uninstall.test.mjs`.
- **UNINST-011** — uninstall removes the appended repair suffix while restoring the project's unrelated `prepare`. Fixture: `test/uninstall.test.mjs`.
- **UNINST-012** — standalone configuration is included in dry-run and removed during uninstall. Fixture: `test/uninstall.test.mjs`.
- **UNINST-013** — malformed standalone configuration stops uninstall before partial cleanup. Fixture: `test/uninstall.test.mjs`.
- **UNINST-014** — uninstall previews/removes an exact owned commit-msg hook and preserves customized variants for manual cleanup. Fixture: `test/uninstall.test.mjs`.
- **UNINST-015** — a failed `core.hooksPath` probe leaves all hook files untouched while package cleanup remains available. Fixture: `test/uninstall.test.mjs`.
- **UNINST-016** — tilde-based active hook directories are resolved through Git and exact owned hooks are removed from the effective path. Fixture: `test/uninstall.test.mjs`.
- **UNINST-017** — unknown options and an unwritable package fail before generated hooks or configuration are removed. Fixture: `test/uninstall.test.mjs`.
- **UNINST-018** — removal and dry-run refuse linked or non-regular package and
  standalone-configuration paths before project or hook cleanup; configuration
  deletion rechecks the inspected file identity. Unit/fixture:
  `test/lib-files.test.mjs`, `test/uninstall.test.mjs`.
- **UNINST-019** — uninstall and dry-run remove exact owner-specific prepare
  repair while preserving recognized current and pre-dispatch Husky, Lefthook,
  and pre-commit content byte-for-byte and reporting manual cleanup. Fixture:
  `test/uninstall.test.mjs`.
- **UNINST-020** — an interrupted or failed package replacement leaves complete
  project-file bytes and preserves standalone configuration plus generated hook
  state; retry safely completes removal and clears any dead-writer transaction
  file. Hardlinked package replacement and standalone-configuration removal
  preserve the external alias, and dry-run changes neither link. Unit/subprocess:
  `test/lib-files.test.mjs`, `test/uninstall.test.mjs`.

### Pre-commit checks

- **PRE-001** — auto-fixable formatting/lint warnings recommend `npm run commit:fix` (and pluralize). Fixture: `test/precommit.test.mjs`.
- **PRE-002** — a mix of fixable and manual issues recommends `commit:fix` and still flags the manual work. Fixture: `test/precommit.test.mjs`.
- **PRE-003** — `commit:fix` is suppressed when tracked worktree changes would block a safe amend. Fixture: `test/precommit.test.mjs`.
- **PRE-004** — non-fixable ESLint issues are labeled manual with no `commit:fix`, including messages with no rule id. Fixture: `test/precommit.test.mjs`.
- **PRE-005** — staged JS/TS source files without a matching test are flagged as missing unit tests. Fixture: `test/precommit.test.mjs`.
- **PRE-006** — files in test dirs, files with a matching test, config, Storybook, generated, `.d.ts`, and `testExempt` globs are not flagged. Fixture: `test/precommit.test.mjs`.
- **PRE-007** — `requireTests: false` disables the missing-test check. Fixture: `test/precommit.test.mjs`.
- **PRE-008** — nothing staged, only non-checkable files, and deletion-only commits each show the correct info box. Fixture: `test/precommit.test.mjs`.
- **PRE-009** — opt-in staged tests run and warn on failure or stay clean on success (pluralized). Fixture: `test/precommit.test.mjs`.
- **PRE-010** — tool failures stay advisory: ESLint/Prettier/test errors, timeouts, and unreadable staged/unstaged probes never crash the commit. Fixture: `test/precommit.test.mjs`.
- **PRE-011** — `blockProtectedBranches` blocks ordinary, deletion-only, allow-empty, and first commits on an unborn protected branch; genuinely unidentifiable branches still fail open. Fixture: `test/commit-guards-integration.test.mjs`.
- **PRE-012** — JSON mode covers skipped, clean, advisory, and invalid-argument results without changing human output or exit codes. Fixture: `test/json-output.test.mjs`.
- **PRE-013** — staged test selection preserves leading/trailing whitespace, tabs, newlines, and Unicode in real Git pathnames. Fixture: `test/precommit.test.mjs`.
- **PRE-014** — detached HEAD intentionally skips only the branch-name guard while unrelated staged guards continue. Fixture: `test/commit-guards-integration.test.mjs`.
- **PRE-015** — the default-on Commit Owl welcome appears once per clone as the sole final box for an eligible clean/informational result, uses a Git-common-directory marker shared by linked worktrees, stays readable at narrow widths, and supports an explicit opt-out. Unit/fixture: `test/welcome.test.mjs`.
- **PRE-016** — JSON mode, `--no-verify`, `COMMITMENT_ISSUES=0`, and legacy `HUSKY=0` neither display nor consume the welcome; marker probe/write/render failures never block checks. Unit/real-Git fixture: `test/welcome.test.mjs`.
- **PRE-017** — a first-run warning or error takes priority without rendering or consuming the welcome, preserving the one-box invariant in both hook-output modes. Unit/fixture: `test/welcome.test.mjs`.

### Debug-artifact advisory

- **DBG-001** — every curated JavaScript, Python, Ruby, TODO-remove, and
  FIXME-temporary rule has a unique stable ID, rationale, language scope, and
  positive fixture. Unit: `test/debug-artifacts.test.mjs`.
- **DBG-002** — same-line strings, prose, comment-prefixed statements, inline
  comments, unsupported files, removed lines, and unchanged context do not
  fire. Multiline block comments, template strings, and triple-quoted strings
  document and test the zero-context scanner's physical-line limitation plus
  path-exemption escape hatch. Default docs, fixture, snapshot, and effective
  generated-path exclusions are explicit and may be replaced by repository
  exemptions. Unit/fixture:
  `test/debug-artifacts.test.mjs`, `test/debug-artifacts-integration.test.mjs`.
- **DBG-003** — the shared staged-patch parser preserves quoted control-byte,
  Unicode, newline, and literal-backslash paths, reports accurate added-line
  numbers, accepts binary, rename, and deletion sections, and rejects malformed
  structure. Canonical CLI prefixes defeat hostile repository diff-prefix
  configuration, and newline-bearing paths still honor glob exemptions.
  Unit/fixture:
  `test/debug-artifacts.test.mjs`, `test/debug-artifacts-integration.test.mjs`.
- **DBG-004** — all matches aggregate into one advisory human finding and one
  command-level presentation; JSON publishes the stable `debug-artifacts`
  check, detected/unavailable subtype IDs inside extensible check details, and
  structured rule details while preserving both exit `0` and the strict JSON
  schema-v1 finding shape. Subprocess:
  `test/debug-artifacts-integration.test.mjs`,
  `test/json-output.test.mjs`.
- **DBG-005** — enabled secret and debug checks reuse one staged-patch Git
  invocation; launch, nonzero, and malformed results remain visible
  debug-artifact advisories rather than blockers or false clean states.
  Unit/subprocess: `test/debug-artifacts.test.mjs`,
  `test/debug-artifacts-integration.test.mjs`.

### Commit-message linting

- **CMSG-001** — disabled by default: no commit-msg hook and a direct invocation is silent. Fixture: `test/commit-msg.test.mjs`, `test/init.test.mjs`.
- **CMSG-002** — advisory findings preserve commitlint detail and allow; explicit `blockOnFailure` rejects the same result. Fixture: `test/commit-msg.test.mjs`.
- **CMSG-003** — only an absolute project `node_modules/.bin/commitlint` invocation is allowed; message paths containing spaces/metacharacters stay one argv value and no npx/global/network fallback exists. Unit: `test/process.test.mjs`; fixture: `test/commit-msg.test.mjs`.
- **CMSG-004** — missing local CLI, missing consumer config, unreadable message files, and successful runs have distinct outcomes; no built-in rules are substituted. Fixture: `test/commit-msg.test.mjs`.
- **CMSG-005** — generated hooks block when configured and Git `--no-verify` bypasses without invoking commitlint. Real-Git fixture: `test/commit-msg.test.mjs`.
- **CMSG-006** — standard and fun tones preserve severity/exit behavior. Unit: `test/message.test.mjs`; fixture: `test/commit-msg.test.mjs`.
- **CMSG-007** — Lefthook's static `--git-path` mode selects
  `COMMIT_EDITMSG` for ordinary commits and manually completed merges,
  `MERGE_MSG` for direct automatic merges, preserves linked-worktree and
  whitespace-bearing paths, and fails through the configured policy when Git
  or filesystem probes are unsafe. Real-Git/subprocess fixture:
  `test/commit-msg.test.mjs`.

### Commit fix (amend)

- **CFIX-001** — amends the latest commit when all fixes are automatic. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-002** — amends and warns when non-fixable lint issues remain. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-003** — reports the latest commit is already clean when nothing changes (pluralized). Fixture: `test/commit-fix.test.mjs`.
- **CFIX-004** — the amend summary pluralizes for multiple updated files. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-005** — refuses to amend a commit retained by any local tag or known
  remote-tracking ref. Direct remote-only tags remain outside the deliberately
  offline proof until fetched, and that boundary is regression-tested.
  Fixture: `test/commit-fix.test.mjs`.
- **CFIX-006** — refuses to amend when tracked worktree changes exist. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-007** — shows info when the latest commit has no fixable files. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-008** — guides the user to `git reset --soft HEAD^` when the fixes would empty the commit. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-009** — warns when a format-only file cannot be fixed automatically. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-010** — Git failures error clearly: no commit, worktree/file-list/staging/staged-fix inspection, and amend failure. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-011** — committed pathnames with leading/trailing whitespace, tabs, newlines, and Unicode are fixed and amended exactly. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-012** — deterministic concurrent auto-save, deletion, directory
  replacement, index update, and `HEAD` movement are refused without amending
  or absorbing the concurrent state. Fixture: `test/commit-fix.test.mjs`.
- **CFIX-013** — publication while tools run is detected before mutation;
  standard and fun refusals preserve the original commit. Fixture:
  `test/commit-fix.test.mjs`; unit: `test/message.test.mjs`,
  `test/fun-tone.test.mjs`.
- **CFIX-014** — detached or non-branch `HEAD`, signed commit headers, and
  mid-run branch-attachment changes are refused without moving the commit.
  Real SSH and OpenPGP signatures are exercised where the host tools support
  them; synthetic headers keep detection deterministic everywhere. Fixture:
  `test/commit-fix.test.mjs`; unit: `test/message.test.mjs`,
  `test/fun-tone.test.mjs`.
- **CFIX-015** — a hardlinked fixer target is atomically replaced only at the
  repository path; the external alias retains its original inode bytes while
  the amended commit receives the fixed bytes. Two selected paths sharing one
  inode are refused before either path or `HEAD` changes. Fixture:
  `test/commit-fix.test.mjs`.

### Staged fixes

- **STG-001** — `fix:staged` applies auto-fixes and refreshes the index; reports already clean when nothing changes and fails closed when the exact index snapshot is unreadable. Fixture: `test/fix-staged.test.mjs`.
- **STG-002** — `fix:staged` warns when fixes apply but non-fixable lint issues remain. Fixture: `test/fix-staged.test.mjs`.
- **STG-003** — `fix:staged` shows an info box when there are no staged fixable files. Fixture: `test/fix-staged.test.mjs`.
- **STG-004** — `fix:staged` refuses partially staged files and files missing from the working tree. Fixture: `test/fix-staged.test.mjs`.
- **STG-005** — `fix:staged` errors when staged or unstaged files cannot be inspected. Fixture: `test/fix-staged.test.mjs`.
- **STG-006** — `fix-staged-js` formats JS/TS and exits 0 when everything is auto-fixable. Fixture: `test/fix-staged-js.test.mjs`.
- **STG-007** — `fix-staged-js` exits 1 on remaining non-fixable lint or a Prettier parse error. Fixture: `test/fix-staged-js.test.mjs`.
- **STG-008** — `fix-staged-js` exits 0 immediately when given no file arguments. Fixture: `test/fix-staged-js.test.mjs`.
- **STG-009** — staged pathnames with leading/trailing whitespace, tabs, newlines, and Unicode are fixed and restaged exactly. Fixture: `test/fix-staged.test.mjs`.
- **STG-010** — deterministic concurrent auto-save, deletion, directory
  replacement, index update, and `HEAD` movement are refused without staging
  the conflicting state. Fixture: `test/fix-staged.test.mjs`.
- **STG-011** — only captured stdin-derived tool output is installed under
  Git's index lock; standard and fun concurrency refusals direct the user back
  to `git status`. Unit/fixture: `test/fix-safety.test.mjs`,
  `test/fix-staged.test.mjs`, `test/message.test.mjs`,
  `test/fun-tone.test.mjs`.
- **STG-012** — a hardlinked target is replaced only at the repository path,
  preserving the external alias. Co-selected aliases to one inode are refused
  before either path changes; a hardlink added while a fixer runs is detected
  through link-count revalidation and refused before staging. Unit/fixture:
  `test/lib-files.test.mjs`, `test/fix-staged.test.mjs`.

### Doctor and hook health

- **HOOK-001** — doctor wires native `.git/hooks` files in a fresh repo. Fixture: `test/doctor.test.mjs`.
- **HOOK-002** — doctor reports healthy when the wiring is intact. Fixture: `test/doctor.test.mjs`.
- **HOOK-003** — doctor migrates husky-era wiring (retires `core.hooksPath`, writes native hooks) and warns about stranded user `.husky` hooks. Fixture: `test/doctor.test.mjs`.
- **HOOK-004** — doctor recreates a missing hook file without overwriting existing ones. Fixture: `test/doctor.test.mjs`.
- **HOOK-005** — custom hooks that still invoke `commitment-issues` are accepted as healthy. Fixture: `test/doctor.test.mjs`.
- **HOOK-006** — custom pre-commit/pre-push hooks that never invoke `commitment-issues` are reported and left untouched. Fixture: `test/doctor.test.mjs`.
- **HOOK-007** — `doctor --quiet` warns but exits 0 when a custom hook does not invoke `commitment-issues`. Fixture: `test/doctor.test.mjs`.
- **HOOK-008** — `doctor --quiet` stays silent when healthy and reports repairs in one line. Fixture: `test/doctor.test.mjs`.
- **HOOK-009** — `doctor --quiet` never breaks an install (no git repo, or repair cannot complete). Fixture: `test/doctor.test.mjs`.
- **HOOK-010** — interactive doctor errors clearly: no `package.json`, unrepairable wiring, or still broken after repair. Fixture: `test/doctor.test.mjs`.
- **HOOK-011** — a foreign `core.hooksPath` is respected: healthy when its hooks invoke the tool, reported (never rewired) when they do not. Fixture: `test/doctor.test.mjs`.
- **HOOK-012** — doctor reports malformed standalone configuration while continuing hook repair; quiet mode remains one-line and exit-zero. Fixture: `test/doctor.test.mjs`.
- **HOOK-013** — comments, echo/printf output, assignments, and quoted examples do not count as hook wiring; executable custom invocations and exact generated hooks remain healthy for all hook names. Unit/fixture: `test/hooks.test.mjs`, `test/init.test.mjs`, `test/doctor.test.mjs`.
- **HOOK-014** — non-executable custom hooks are reported with shell-safe `chmod +x` guidance on POSIX and are never modified by init or doctor. Unit/fixture: `test/hooks.test.mjs`, `test/init.test.mjs`, `test/doctor.test.mjs`.
- **HOOK-015** — doctor creates and fresh-clone repairs configured commit-msg wiring, preserves custom bodies, requires quoted `$1`, and warns without failing when the local CLI is absent. Fixture: `test/doctor.test.mjs`.
- **HOOK-016** — bare repositories are rejected for local hook health; quiet install-time repair remains silent and exit-zero. Unit/fixture: `test/hooks.test.mjs`, `test/doctor.test.mjs`.
- **HOOK-017** — failed `core.hooksPath` probes fail safely instead of being mistaken for an unset value. Unit/fixture: `test/hooks.test.mjs`, `test/doctor.test.mjs`.
- **HOOK-018** — directory, unreadable, and otherwise uninspectable hook paths are preserved and reported without raw exceptions. Unit/fixture: `test/hooks.test.mjs`, `test/doctor.test.mjs`.
- **HOOK-019** — configured hook paths use Git's effective path resolution, including tilde expansion. Unit/fixture: `test/hooks.test.mjs`, `test/doctor.test.mjs`, `test/uninstall.test.mjs`.
- **HOOK-020** — doctor verifies Husky, Lefthook, and pre-commit manager wiring
  read-only, requires Husky's active hooksPath and valid explicitly sourced
  runtime, Lefthook stdin plus effective `"$@"` forwarding, and a real
  executable Lefthook/pre-commit dispatch in Git's effective hooks directory;
  binds supported pre-commit 3.2+, Lefthook 2.1.10, Husky 8.0.1–8.0.3, and
  Husky 9.0.2–9.1.7 wrapper/runtime templates to the selected config/hook;
  rejects incomplete, nested-example, duplicate, conditional,
  argument-altering, commented, ambiguous, non-executable, linked-runtime, or
  uninspectable state; and keeps quiet install-time failures exit-zero.
  Unit/fixture: `test/hooks.test.mjs`, `test/doctor.test.mjs`.
- **HOOK-021** — manager-composed pre-commit, pre-push, and commit-msg entry
  points retain `COMMITMENT_ISSUES=0` and legacy `HUSKY=0` through the hidden
  hook dispatcher without suppressing explicit direct commands; Husky snippets
  preserve nonzero blocking exits before later custom commands. All three
  manager forms silently succeed without a PATH/global fallback when every
  permitted project-local launcher is absent, wrong-kind, or non-executable;
  extensionless and Windows `.exe`/`.cmd`/`.bat` launchers use one exact
  inspect-then-invoke path, while hostile literal argv and real nonzero exits
  remain intact. Unit/packed lifecycle: `test/hooks.test.mjs`,
  `test/precommit.test.mjs`, `test/prepush.test.mjs`,
  `test/commit-msg.test.mjs`,
  `test/integration/helpers/lifecycle-fixture.mjs`.
- **HOOK-022** — hook-path probes require exactly one NUL-delimited config
  record, preserve configured whitespace, empty values, POSIX backslashes,
  CRLF, and unterminated resolved Git paths, and reject malformed config output;
  init, doctor, uninstall, and Husky recognition distinguish present-empty from
  unset and apply Git-compatible Windows separator rules without changing POSIX
  ownership. Unit/fixture:
  `test/hooks.test.mjs`, `test/init.test.mjs`, `test/doctor.test.mjs`,
  `test/uninstall.test.mjs`.
- **HOOK-023** — manager health validates the whole selected YAML document,
  including nested Lefthook siblings and every supported pre-commit root,
  local, meta, and remote field; PATH/runtime inspection matches shell ordering,
  effective execute access, special-node and symlink-loop behavior, platform
  separators, resolved executable identity, and supported Unicode/Python
  names without executing a repository-controlled probe. Unit/real-shell
  fixtures: `test/hooks.test.mjs`.

### Pre-push modes

- **PUSH-001** — disabled by default: silent and allows during a real push, and explains how to enable a mode when run interactively. Fixture: `test/prepush.test.mjs`.
- **PUSH-002** — blocking mode runs only the pushed files' tests and blocks on failure; a pass shows a summary and allows. Fixture: `test/prepush.test.mjs`.
- **PUSH-003** — advisory mode runs tests and warns without blocking; a pass shows a summary. Fixture: `test/prepush.test.mjs`.
- **PUSH-004** — `blockPushOnTestFailure` takes precedence over `advisePushTests`, and the dual-mode conflict is surfaced. Fixture: `test/prepush.test.mjs`.
- **PUSH-005** — deleted test files are never executed; deleting or renaming a source file still runs any surviving related test and blocks when it fails. Fixture: `test/prepush.test.mjs`.
- **PUSH-006** — falls back to the upstream branch when run without piped refs. Fixture: `test/prepush.test.mjs`.
- **PUSH-007** — non-node test commands run through the tee/summary fallback. Fixture: `test/prepush.test.mjs`.
- **PUSH-008** — test-command failure blocks in blocking mode and warns/allows in advisory mode; a missing summary blocks. Fixture: `test/prepush.test.mjs`.
- **PUSH-009** — pushed-file diff failure or malformed name/status output fails closed in blocking mode, warns/allows in advisory mode, and stays silent when disabled. Fixture: `test/prepush.test.mjs`.
- **PUSH-010** — JSON mode preserves Git's pre-push positional arguments, keeps subprocess output off stdout, and reports advisory, clean, and blocking outcomes. Fixture: `test/json-output.test.mjs`.
- **PUSH-011** — the first push of a based branch uses its closest safe remote merge base; orphan histories fall back to the empty tree, and multiple pushed refs are evaluated independently. Fixture: `test/prepush.test.mjs`.
- **PUSH-012** — same-basename sources in separate packages select only their own package-relative tests; a root basename fallback cannot steal the match. Fixture: `test/prepush.test.mjs`.
- **PUSH-013** — a complete pre-commit framework `PRE_COMMIT_*` environment
  reconstructs the pushed range and remote identity after the framework
  consumes Git stdin; an all-files first push recovers from the documented
  branch and remote identity when the framework omits `FROM_REF`/`TO_REF`,
  while any other partial range is ignored rather than guessed.
  Fixture: `test/prepush.test.mjs`.
- **PUSH-014** — pushed test selection passes leading/trailing whitespace, tabs, newlines, and Unicode pathnames exactly. Fixture: `test/prepush.test.mjs`.
- **PUSH-015** — missing remotes fail safely, one remote can be inferred, and multiple remotes are never guessed when selecting a first-push base. Unit: `test/push-base.test.mjs`.

### Advisory message and tone

- **MSG-001** — a success message renders when there are no issues. Unit: `test/message.test.mjs`.
- **MSG-002** — recommends `commit:fix` when amend is safe; suppressed when worktree changes block amend or it cannot be inspected. Unit: `test/message.test.mjs`.
- **MSG-003** — mixed fixable + manual issues recommend `commit:fix` and flag manual work, including when amend is blocked. Unit: `test/message.test.mjs`.
- **MSG-004** — no fix command is shown when nothing is auto-fixable. Unit: `test/message.test.mjs`.
- **MSG-005** — an issue's detail lines render. Unit: `test/message.test.mjs`.
- **MSG-006** — fun tone renders the "Relationship notes" variant from `precommitChecks.tone`. Subprocess: `test/fun-tone.test.mjs`.
- **MSG-007** — commit-message findings and setup failures render advisory/blocking and standard/fun variants with an explicit bypass. Unit: `test/message.test.mjs`.

### Internal helpers

- **LIB-001** — ESLint JSON summarizing and manual-issue extraction (totals, fixables, empty/invalid, missing rule id). Unit: `test/checks.test.mjs`.
- **LIB-002** — Prettier list parsing and Node test-summary parsing (TAP/spec, pass-only/fail-only, unrecognized → null). Unit: `test/checks.test.mjs`.
- **LIB-003** — test-exemption and glob logic: `isTestExemptFile`, `testExempt` globs, `globToRegExp`, and file classifiers. Unit: `test/lib-files.test.mjs`.
- **LIB-004** — package-aware test discovery and strict NUL-delimited Git-path helpers: `findTestFile(s)`, `collectTestsForFiles`, `parseNulPaths`, `parseLsFilesStage`, `parseNameStatusPaths`, and `shortFileList`. Unit: `test/lib-files.test.mjs`.
- **LIB-005** — shared box rendering colors the whole border, honors `NO_COLOR`/disabled color in captured CI output, preserves product-owned SGR styling while removing other terminal sequences, visibly escapes remaining C0/C1 controls, wraps long and Unicode content to the reported width, and recovers from malformed or impossibly narrow `COLUMNS` values. Unit/subprocess: `test/terminal.test.mjs`, `test/ui.test.mjs`.
- **LIB-006** — process outcomes distinguish missing tool, spawn failure, timeout, external signal, normal nonzero exit, and success. Unit: `test/process.test.mjs`.
- **LIB-007** — Prettier classification is exit-status-first; `[error]` in a filename remains a formatting path. Unit: `test/checks.test.mjs`.
- **LIB-008** — project-local optional-bin resolution walks ancestor `node_modules/.bin` directories while preserving argv and returning null instead of an implicit fallback. Unit: `test/local-tool.test.mjs`.

### Safety path matrix

- **SEC-001** — paths with spaces are passed as argv and through a staged-file flow. Unit/subprocess: `test/process.test.mjs`, `test/fix-staged.test.mjs`.
- **SEC-002** — paths with quotes are passed safely through argv and staged-file flows. Unit/subprocess: `test/process.test.mjs`, `test/fix-staged.test.mjs`.
- **SEC-003** — paths with semicolons are passed safely through argv and staged-file flows. Unit/subprocess: `test/process.test.mjs`, `test/fix-staged.test.mjs`.
- **SEC-004** — Unicode paths are passed safely through argv and staged-file flows. Unit/subprocess: `test/process.test.mjs`, `test/fix-staged.test.mjs`.
- **SEC-005** — Windows-style backslash tokens are passed as literal argv. Unit: `test/process.test.mjs`.
- **SEC-006** — glob-like filename characters are passed safely through a staged-file flow. Subprocess: `test/fix-staged.test.mjs`.
- **SEC-007** — every runtime Git pathname list uses a structured NUL-delimited format; parsers never trim or newline-split pathnames. Source/fixtures: `scripts/precommit.mjs`, `scripts/fix-staged.mjs`, `scripts/commit-fix.mjs`, `scripts/prepush.mjs`, `test/lib-files.test.mjs`.
- **SEC-008** — accidentally staged `node_modules` files are skipped by pre-commit checks. Fixture: `test/precommit-dependency-ignore.test.mjs`.
- **SEC-009** — pre-push diff uses NUL-delimited name/status output, so deletions, renames/copies, Unicode, whitespace, tabs, and newlines remain unambiguous for associated-test discovery. Unit/subprocess: `test/lib-files.test.mjs`, `test/prepush.test.mjs`.
- **SEC-010** — staged-secret parsing distinguishes file headers from added hunk content, including source lines beginning with `++ `. Unit/subprocess: `test/secret-scan.test.mjs`, `test/secret-scan-integration.test.mjs`.
- **SEC-011** — missing ESLint/Prettier peers return an advisory and package-manager install hint without invoking `npx`; explicitly configured `npx` test commands remain verbatim. Unit/subprocess: `test/process.test.mjs`, `test/precommit.test.mjs`.
- **SEC-012** — opt-in secret enforcement fails closed when the staged-diff process fails, exits nonzero, or returns malformed patch structure; advisory mode warns and continues, and JSON preserves the distinction. Unit/subprocess: `test/secret-scan.test.mjs`, `test/secret-scan-integration.test.mjs`, `test/json-output.test.mjs`.
- **SEC-013** — Git C-style quoted staged-patch paths preserve tabs, newlines, quotes, backticks, dollar signs, semicolons, spaces, and Unicode; binary, rename, deletion, missing-final-newline, malformed, and large patch shapes remain structurally distinguished. Unit/subprocess: `test/secret-scan.test.mjs`, `test/secret-scan-integration.test.mjs`.
- **SEC-014** — discovered Node test paths beginning with `-` are positional files rather than runner options at commit and push time. Unit/subprocess: `test/process.test.mjs`, `test/precommit.test.mjs`, `test/prepush.test.mjs`.
- **SEC-015** — hook repair does not follow hook-file, dangling, or hook-directory symbolic links. Unit/subprocess: `test/hooks.test.mjs`, `test/doctor.test.mjs`.
- **SEC-016** — pre-push Node reporter output uses a randomized private temporary directory and does not reuse or delete a predictable colliding path. Subprocess: `test/prepush.test.mjs`.
- **SEC-017** — hook-launched test commands and temporary-repository helpers remove Git's repository-local environment routing; representative `GIT_DIR`, work-tree, index, and counted-config variables cannot redirect fixture initialization into the caller. Unit/subprocess: `test/process.test.mjs`, `test/repository-shapes.test.mjs`, pre-push hook reproduction.
- **SEC-018** — mutable project-file writes reject symbolic links, non-regular
  paths, identity replacement, descriptor mismatch, and occupied missing-file
  paths instead of following repository-controlled links outside the checkout.
  Unit/subprocess: `test/lib-files.test.mjs`, `test/init-gitignore.test.mjs`,
  `test/init.test.mjs`, `test/uninstall.test.mjs`.
- **SEC-019** — product-owned human output visibly escapes
  repository-controlled C0/C1 bytes, strips injected CSI/OSC sequences from
  paths, refs, configuration, argv, and captured Git diagnostics, preserves
  intentional model lines and Unicode, and leaves raw child passthrough
  unchanged; JSON round-trips the exact semantic filename.
  Unit/real-Git/subprocess: `test/terminal.test.mjs`, `test/ui.test.mjs`,
  `test/lib-files.test.mjs`, `test/cli.test.mjs`, `test/doctor.test.mjs`,
  `test/fix-staged.test.mjs`, `test/commit-guards-integration.test.mjs`,
  `test/prepush.test.mjs`, `test/json-output.test.mjs`.
- **SEC-020** — hook-manager detection and health checks use lstat-based regular
  file/directory boundaries, never follow linked config or Husky runtime
  directories, never interpolate checkout or Git-provided paths into snippets,
  and treat duplicate owner configs, Lefthook local/non-YAML/extended/overridden
  forms, advanced YAML, unsupported sibling schema, and masked linked
  dispatchers as uninspectable before init writes project files.
  Unit/subprocess: `test/hooks.test.mjs`, `test/init.test.mjs`,
  `test/doctor.test.mjs`.

### Performance

- **PERF-001** — timeout is enforced and reported separately from signals/spawn failures. Fixture: precommit / prepush / process tests.
- **PERF-002** — timeout cleanup terminates an attached grandchild on supported platforms. Fixture: `test/process.test.mjs`; CI matrix: Ubuntu, macOS, Windows.
- **PERF-003** — bounded smoke, 250-pair full-hook, and 1,000-pair
  argument-pressure tiers cover large staged sets, pushed diffs, discovered
  tests, and long hostile paths without enforcing wall time in ordinary CI.
  Harness: `tools/benchmark-hook-performance.mjs`; behavior regression:
  `test/performance-benchmark.test.mjs`; results and budgets:
  [Hook performance and scaling](performance.md).
- **PERF-004** — conservative Windows direct-process and `cmd.exe` accounting
  identifies bounded prefixes for Git, ESLint, Prettier, and configured tests;
  the measured large tiers require future batching/pathspec transport tracked
  in [#212](https://github.com/RoryGlenn/commitment-issues/issues/212). Harness
  and unit: `tools/benchmark-hook-performance.mjs`,
  `test/performance-benchmark.test.mjs`; boundary:
  [Current path-count boundary](performance.md#current-path-count-boundary).
- **PERF-005** — JSON hook output larger than a pipe's first write is delivered
  completely before immediate exit, including partial-write and retryable pipe
  states. Unit/subprocess: `test/json-output.test.mjs`; measured large-hook
  evidence: [Measured baseline](performance.md#measured-baseline).
- **PERF-006** — parent `SIGHUP`, `SIGINT`, and `SIGTERM` cancellation
  terminates all active attached POSIX process groups or Windows process trees,
  waits for descendant and inherited-pipe closure, preserves signal-appropriate
  parent termination, and shares idempotent cleanup with a racing timeout.
  Unit/subprocess: `test/process.test.mjs`, `test/fix-staged.test.mjs`,
  `test/commit-fix.test.mjs`, `test/precommit.test.mjs`, and
  `test/prepush.test.mjs`; CI matrix: Ubuntu, macOS, Windows.

### User lifecycle

- **LIFE-001** — user installs and immediately commits in a fresh external
  repo. Named lifecycle phase: `commit and defer the first-run welcome` in
  `test/integration/helpers/lifecycle-fixture.mjs`; suite:
  `test/integration/lifecycle-manager.test.mjs`; CI:
  `.github/workflows/ci.yml` (`check` and `pm-lifecycle`).
- **LIFE-002** — user installs and immediately pushes to a bare remote from a
  fresh external repo. Named lifecycle phase:
  `push through the real pre-push hook` in
  `test/integration/helpers/lifecycle-fixture.mjs`; suite:
  `test/integration/lifecycle-manager.test.mjs`; CI:
  `.github/workflows/ci.yml` (`check` and `pm-lifecycle`).
- **LIFE-003** — advisory-only forever. Fixture/docs: README + prepush tests.
- **LIFE-004** — blocking on push. Fixture/docs: README + prepush tests.
- **LIFE-006** — a project-owned `prepare` survives init; after commit/push, a
  fresh clone's normal npm, pnpm, Yarn Classic, or Bun install runs the composed
  repair and recreates the local hooks. Yarn Berry 4.17.0 does not support
  `prepare` and disables `postinstall` by default, so its verified clone repair
  is the explicit local `doctor` command. Named lifecycle phase:
  `repair a fresh clone` in
  `test/integration/helpers/lifecycle-fixture.mjs`; CI lifecycle matrix:
  `.github/workflows/ci.yml`.
- **LIFE-007** — pinned immutable v2.5.1, v3.2.0, and v3.3.2 release fixtures upgrade to the candidate tarball, refresh or remove only exact generated state, preserve project-owned `prepare` logic and custom hooks, and execute the migrated hooks during a real commit and push. Required PR evidence: npm on Ubuntu/Node 24; release evidence: the exact publish tarball; scheduled evidence: pnpm, Yarn Classic, and Bun. Fixture: `test/integration/lifecycle-migration.test.mjs`.
- **LIFE-008** — installing an older release over newer configured state is explicitly unsupported. The documented rollback runs the current version's `uninstall`, restores a lockfile and manifest with the pinned target and peers, installs, and runs the target version's `init` and `doctor`; custom state remains subject to manual review. Contract: [Downgrades and manual rollback](migration.md#downgrades-and-manual-rollback); ownership fixture: `test/uninstall.test.mjs`.

### Package managers

- **PM-001** — package-manager detection (npm/pnpm/yarn/bun) via `npm_config_user_agent` and lockfiles, plus package-manager-aware command hints in advisory, `fix:staged`, and `doctor` output. Unit: `test/package-manager.test.mjs`. Subprocess: `test/fix-staged.test.mjs`.
- **PM-002** — uninstall prints a package-removal command for the detected manager. Unit: `test/package-manager.test.mjs`. Fixture: `test/uninstall.test.mjs`.
- **PM-003** — pnpm 10 runs the complete named lifecycle phase sequence (pack →
  install → init → commit → push → repair → worktree → uninstall → dependency
  removal) on Ubuntu, macOS, and Windows at Node 24, plus the exact Node
  22.11.0 floor on Ubuntu. CI: `.github/workflows/ci.yml` (`pm-lifecycle`
  matrix); runner: `scripts/run-lifecycle-test.mjs`; phases:
  `test/integration/helpers/lifecycle-fixture.mjs`.
- **PM-004** — Yarn Classic 1.22.22 runs the same manager-native named phase
  sequence and platform matrix without an npm-runner fallback. CI:
  `.github/workflows/ci.yml` (`pm-lifecycle` matrix); runner:
  `scripts/run-lifecycle-test.mjs`; phases:
  `test/integration/helpers/lifecycle-fixture.mjs`.
- **PM-005** — Bun 1.3.14 runs the same named phase sequence and platform matrix
  through `bunx --no-install`. CI: `.github/workflows/ci.yml` (`pm-lifecycle`
  matrix); runner: `scripts/run-lifecycle-test.mjs`; phases:
  `test/integration/helpers/lifecycle-fixture.mjs`.
- **PM-006** — Yarn Berry 4.17.0 is pinned in an integrity-locked CLI fixture and runs the packed package with `nodeLinker: node-modules` on Ubuntu, macOS, and Windows at Node 24 plus Ubuntu at the exact Node 22.11.0 floor. The fixture verifies manager-native CLI/bin resolution, root and nested workspaces, all three real Git hooks, clone/doctor repair, linked worktrees, and uninstall. It asserts a real `node_modules` tree and no `.pnp.cjs`; Plug'n'Play remains unsupported. CI: `.github/workflows/ci.yml`; runner: `scripts/run-lifecycle-test.mjs`; fixture pin: `test/fixtures/yarn-berry/package-lock.json`.
- **PM-007** — installs with lifecycle scripts disabled leave clone-local hooks absent but keep the local CLI available; explicit `doctor` repair restores exact generated hooks for every manager. A later scripts-enabled reinstall also repairs npm, pnpm, Yarn Classic, and Bun; Berry's documented lifecycle boundary requires explicit `doctor`. CI lifecycle matrix: `.github/workflows/ci.yml`; runner: `test/integration/helpers/lifecycle-fixture.mjs`.
- **PM-008** — package-manager guidance is workspace-aware, the lifecycle strips the outer npm user agent, and pre-commit/uninstall output must name the selected manager. Unit: `test/package-manager.test.mjs`; CI lifecycle matrix: `.github/workflows/ci.yml`.

### Monorepos and workspaces

- **MONO-001** — workspace-root behavior across npm, pnpm, Yarn Classic, Yarn
  Berry `node-modules`, and Bun. The real packed package is installed at the
  root, each manager's workspace selector runs both package test scripts, root
  config owns staged checks, and root-native hooks run for commits and pushes.
  Named lifecycle phases: `install the packed artifact and discover workspaces`,
  commit, and push in `test/integration/helpers/lifecycle-fixture.mjs`; CI:
  `.github/workflows/ci.yml`.
- **MONO-002** — shallow and nested workspace packages are checked together,
  including when `git commit` starts in the nested package. Package-local
  `precommitChecks` values remain untouched and do not override the root. Named
  lifecycle phase: `commit and defer the first-run welcome` in
  `test/integration/helpers/lifecycle-fixture.mjs`; guide:
  [Monorepo & workspaces](monorepo.md); CI: `.github/workflows/ci.yml`.
- **MONO-003** — linked Git worktrees share hooks through Git's common
  directory, repair safely during a worktree-local install, and run the root
  checks from a nested package. Named lifecycle phase:
  `exercise a linked worktree` in
  `test/integration/helpers/lifecycle-fixture.mjs`; CI:
  `.github/workflows/ci.yml`.

### Shells and Git clients

- **SHELL-001** — Linux `/bin/sh`, Bash, and Fish; macOS `/bin/sh` and Zsh;
  and Windows PowerShell and Command Prompt each launch the same exact packed
  artifact through `--version`, `init`, a real advisory commit, a tested push to
  a local bare remote, `doctor`, and `uninstall`. The consumer install is forced
  offline. Required CI: `.github/workflows/ci.yml` (`shell-compat`); runner:
  `tools/run-shell-compat-test.mjs`.
- **SHELL-002** — the shared scenario runs in a path containing spaces,
  Unicode, `$`, and `&`; preserves a project-owned hook; verifies generated
  `#!/bin/sh` bodies use LF and Unix executable bits; and performs commit, push,
  doctor, and uninstall with a stripped `PATH`. Policy regression:
  `test/shell-compat.test.mjs`; hosted behavior: the required shell matrix.

### CI/CD and repository automation

- **CI-001** — every tracked workflow has read-only defaults, an explicit
  concurrency policy, bounded runnable jobs, non-persisted checkout credentials,
  and an allowlisted job-permission surface. Unit: `test/ci-policy.test.mjs`;
  semantic validation: actionlint in `.github/workflows/ci.yml`.
- **CI-002** — the sole branch-protection context fails unless DCO, static
  quality, dependency audit, every supported runtime/lifecycle/shell lane, and
  CodeQL each report exact success. Unit: `test/ci-policy.test.mjs` and
  `test/test-quality.test.mjs`; CI: `.github/workflows/ci.yml`.
- **CI-003** — CodeQL is reusable by required CI while retaining scheduled and
  manual analysis. Unit: `test/ci-policy.test.mjs`; workflow:
  `.github/workflows/codeql.yml`.
- **CI-004** — release tags serialize through GitHub's maximum 100-run pending
  queue without cancelling in-flight or already-pending publications, generated
  artifact names cross into shell through quoted environment variables, and
  every ordinary action reference is immutable. Unit: `test/ci-policy.test.mjs`
  and `test/release-integrity.test.mjs`.
- **CI-005** — routine npm and Actions releases age for seven days, security
  updates remain immediate, and both required CI and weekly health fail on
  high-severity advisories. Unit: `test/ci-policy.test.mjs`; automation:
  `.github/dependabot.yml` and `.github/workflows/repo-health.yml`.

### Semantic maintainer graph

- **SEM-001** — the repository-only graph compiler derives commands, hooks,
  configuration, ESM imports/exports, tests, Markdown references, package
  files, and high-level capability membership with stable node identifiers and
  evidence-bearing edges. Unit/repository: `test/semantic-graph.test.mjs`.
- **SEM-002** — static relationships use Espree rather than regular-expression
  parsing; literal dynamic imports are resolved, while computed imports,
  malformed source, unsupported extensions, and missing targets remain honest
  diagnostics rather than guessed edges. Unit:
  `test/semantic-graph.test.mjs`.
- **SEM-003** — source identity covers `HEAD`, staged and tracked worktree
  diffs, and current tracked-file contents. A cache below Git's common
  directory is accepted only for the exact fingerprint; stale, invalid,
  linked, and non-regular cache paths cannot be presented as current. Unit and
  subprocess: `test/semantic-graph.test.mjs`.
- **SEM-004** — focused tree and impact queries return deterministic human and
  JSON neighborhoods with selected-versus-indexable-text byte measurements;
  binary assets cannot inflate the context-reduction baseline. They do not run
  from normal hooks or enter the npm package. Unit, subprocess, and package
  boundary: `test/semantic-graph.test.mjs` and
  `test/metadata.test.mjs`.
- **SEM-005** — the accuracy check rejects dangling/unsupported claims, stale
  capability declarations, public commands without dispatch/test/docs, config
  keys without test/docs, missing package files, and nondeterministic builds;
  genuine warnings and missing caches remain non-failing. Unit/repository:
  `test/semantic-graph.test.mjs`.
- **SEM-006** — Codex and Claude project hooks call one repository-local
  adapter and receive byte-identical normalized context for the same source,
  focus, event, and limits. Session startup loads a bounded depth-zero
  capability index; prompt submission requires a case-sensitive exact semantic
  marker or resolvable backticked identifier, label, or path. Ambiguous exact
  paths fail explicitly. Unit/subprocess: `test/semantic-context.test.mjs`.
- **SEM-007** — multi-focus selection is deterministic and enforces depth,
  file-count, selected-source-byte, inner-context-byte, model-visible-context,
  and complete-host-output limits, including unavailable fallbacks. Every edge
  between selected nodes is retained. Omitted nodes produce `truncated`;
  missing, ambiguous, invalid, or over-budget inputs are never labeled
  complete. Unit: `test/semantic-context.test.mjs`.
- **SEM-008** — every delivered envelope carries the current graph fingerprint
  and a verified SHA-256 payload digest. Compilation compares source identity
  before and after every attempt, retries drift, and fails closed if the
  checkout does not stabilize. The latest local receipt is written atomically
  below Git's common directory only after stdout emission, hashes the session
  identifier, excludes prompt/repository content, and explicitly claims only
  `emitted-to-host`. Unit/worktree/subprocess:
  `test/semantic-context.test.mjs`.
- **SEM-009** — graph strings are delimited and labeled as untrusted data;
  hostile paths, labels, and prompt text remain JSON data and are never
  interpolated into adapter commands. Linked and non-regular receipt paths are
  rejected. Unit/security: `test/semantic-context.test.mjs`.
- **SEM-010** — the gateway, adapters, host configuration, receipts, and
  protocol documentation remain repository-only and absent from the npm
  package. The shared semantic policy is directly present in `AGENTS.md`, and
  `CLAUDE.md` imports that file, so neither host depends on following a policy
  link. Docs state that host emission cannot prove model comprehension.
  Unit/package: `test/semantic-context.test.mjs` and `test/metadata.test.mjs`.

Explicit non-goals are per-package configuration/tool versions, build-system dependency-graph scheduling, and an exhaustive speculative matrix of custom hoisting layouts. The tested defaults form the support contract; reproducible gaps should add focused fixtures and issues.

## Manual and production validation

- **PKG-008** — the published npm package installs and exposes the CLI bin.
  Recheck in a clean project before launch with
  `npm install -D commitment-issues@latest` and
  `npx --no-install commitment-issues --help`.
- **LIFE-005** — the complete clean-registry launch path (`init`, advisory
  commit warning, `commit:fix`, and related push-time tests) remains a launch
  gate in issue #240.
- **CLIENT-001** — VS Code, JetBrains, and GitHub Desktop require manual UI
  validation against an exact artifact before the release claims those clients
  as verified. An unavailable lane must instead be classified as
  unsupported/unverified, excluded from support claims, and assigned to a
  follow-up issue; v3.4.0 uses #231. Evidence belongs on the tracking issue
  rather than in committed machine-specific paths or logs. Checklist:
  [GUI Git-client release checklist](git-client-release-checklist.md).
- **REL-001** — the production v3.3.2 tag workflow published the exact npm
  tarball and both immutable GitHub Release assets. The npm/GitHub tarballs and
  SLSA subject share one SHA-256; independent npm signature and
  `slsa-verifier` checks passed. See the
  [release-verification baseline](release-verification.md#validated-release-baseline).
- **REL-002** — live history anchors the recovery states without creating a
  test publication: v3.3.0 is an npm-published but immutable zero-asset GitHub
  Release that cannot resume, v3.3.1 failed before npm but required a workflow
  edit, and v3.3.2 is complete. Evidence:
  [release audit](audits/release-packaging-and-upgrades.md#historical-release-and-tag-evidence).

## Not covered yet

### Release and lifecycle

- Corporate locked-down environment behavior.

## Next batches

### Post-launch support boundaries

- Yarn Berry Plug'n'Play.
- Custom no-hoist or non-`node_modules` workspace layouts outside the tested
  package-manager defaults.
