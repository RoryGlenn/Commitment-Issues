# Runtime Coverage Policy

The README badge reports **branch coverage for the user-facing
`commitment-issues` runtime**, not every JavaScript file in the repository.
Run the canonical measurement with:

```bash
npm run test:coverage
```

Inspect the exact denominator and test inputs without running tests or writing
a report with:

```bash
npm run coverage:scope
```

The read-only report lists the measured runtime sources, explicit maintenance
exclusions, top-level test patterns, and required line, branch, and function
threshold. It reads the same constants as the real coverage runner, sorts each
path group deterministically, and creates no LCOV or temporary report files.

The command uses Node's built-in test coverage on both supported Node lines and
requires **100% line, branch, and function coverage**. It passes every source
file explicitly, writes a temporary LCOV report, and fails if any intended
runtime source is missing from that report. The README badge displays the
aggregate branch metric for the same source and test scope.

## Source scope

Every `scripts/**/*.mjs` file enters the public-runtime denominator
automatically unless it appears in the exact maintenance-only list below.
`package.json` separately allowlists every runtime module by path, and a package
regression requires that list to equal the measured runtime set. This keeps both
boundaries closed by default: a new hook, command, or runtime helper cannot
silently escape coverage or enter the tarball accidentally.

These repository-only maintenance files are neither published nor included in
the runtime percentage:

```text
scripts/lib/coverage-badge.mjs
scripts/lib/lifecycle-managers.mjs
scripts/run-branch-coverage.mjs
scripts/run-lifecycle-test.mjs
scripts/update-readme-coverage-badge.mjs
```

They still have unit or integration tests. The repository-only lifecycle
fixture lives under `test/integration/helpers/`, so it never enters the
automatic `scripts/**/*.mjs` denominator. Static invariants require every
script to be classified exactly once, every runtime script and relative import
to be packed, every maintenance script to be absent, and the public bin target
to exist. New runtime files are therefore covered but not shipped until the
allowlist is reviewed; adding a maintenance-only script requires an explicit
exclusion.

## Test scope

The percentage is driven by every top-level test matching these non-recursive
patterns:

```text
test/*.test.mjs
test/*.test.js
```

Test files, `test/helpers/**`, and `test/integration/helpers/**` drive execution
but are not source files in the percentage denominator.

The nested `test/integration/lifecycle-manager.test.mjs` suite is reported as a
separate **package lifecycle integration** pass/fail gate. It installs and runs
an exact packed package in a temporary repository; mixing those duplicate,
temporary source paths into the source-tree percentage would make the badge
less reproducible rather than more complete. CI runs the npm lifecycle gate in
the Node/OS matrix and separate pnpm, Yarn Classic, Yarn Berry `node-modules`,
and Bun lifecycle gates.

## Runtime behavior ownership

Coverage is not treated as proof by itself. This map assigns every measured
runtime module to the test file that owns its behavior. The executable
invariant in `test/test-quality.test.mjs` fails if a runtime source is missing,
an owner disappears, or no named owner references its source. The finer-grained
claim-to-scenario map remains in
[Scenario Coverage](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/scenario-coverage.md).

| Runtime source                    | Meaningful behavior owned                                                               | Primary automated evidence                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/cli.mjs`                 | command dispatch, argument contracts, help/version, exit status                         | `test/cli.test.mjs`                                                                    |
| `scripts/commit-fix.mjs`          | snapshot-bound fix-and-amend flow, pushed/dirty/concurrent/empty refusal, child cleanup | `test/commit-fix.test.mjs`                                                             |
| `scripts/lib/fix-safety.mjs`      | exact fixer inputs, repository snapshots, index-lock staging, concurrency refusal       | `test/fix-safety.test.mjs`, `test/fix-staged.test.mjs`, `test/commit-fix.test.mjs`     |
| `scripts/commit-msg.mjs`          | optional local commitlint execution, advisory/blocking policy                           | `test/commit-msg.test.mjs`                                                             |
| `scripts/doctor.mjs`              | hook inspection, bounded repair, quiet install behavior                                 | `test/doctor.test.mjs`                                                                 |
| `scripts/fix-staged-js.mjs`       | explicit-file formatter/linter execution and error propagation                          | `test/fix-staged-js.test.mjs`                                                          |
| `scripts/fix-staged.mjs`          | safe staged-file repair without overwriting partial work                                | `test/fix-staged.test.mjs`                                                             |
| `scripts/init.mjs`                | idempotent setup, validation, preflight, and hook ownership                             | `test/init.test.mjs`                                                                   |
| `scripts/panic.mjs`               | optional-lock-free repository inspection and one-box recovery guidance                  | `test/panic.test.mjs`                                                                  |
| `scripts/precommit.mjs`           | staged checks, findings, secret/test policy, JSON and protected-branch outcomes         | `test/precommit.test.mjs`                                                              |
| `scripts/prepush.mjs`             | pushed-range test selection, deleted/renamed paths, blocking/advisory outcomes          | `test/prepush.test.mjs`                                                                |
| `scripts/uninstall.mjs`           | exact owned cleanup, dry run, preservation of custom state                              | `test/uninstall.test.mjs`                                                              |
| `scripts/vows.mjs`                | hidden read-only command entrypoint                                                     | `test/cli.test.mjs`, `test/vows.test.mjs`                                              |
| `scripts/lib/checks.mjs`          | lint, formatting, test, timeout, and finding classification                             | `test/checks.test.mjs`                                                                 |
| `scripts/lib/commit-guards.mjs`   | branch and worktree guards across Git states                                            | `test/commit-guards.test.mjs`                                                          |
| `scripts/lib/config.mjs`          | package/standalone precedence, validation, defaults, and diagnostics                    | `test/config.test.mjs`                                                                 |
| `scripts/lib/debug-artifacts.mjs` | opt-in staged debug rules, false-positive policy, exemptions, and aggregate findings    | `test/debug-artifacts.test.mjs`, `test/debug-artifacts-integration.test.mjs`           |
| `scripts/lib/files.mjs`           | NUL-safe Git paths, ownership, stable project-file writes, workspace roots, and paths   | `test/lib-files.test.mjs`, `test/path-normalization.test.mjs`, `test/property.test.js` |
| `scripts/lib/hooks.mjs`           | native/manager hook classification, resolution, snippets, ownership, and safe writes    | `test/hooks.test.mjs`                                                                  |
| `scripts/lib/json-output.mjs`     | stable machine-readable schema and status mapping                                       | `test/json-output.test.mjs`                                                            |
| `scripts/lib/local-tool.mjs`      | project-local executable discovery without global/network fallback                      | `test/local-tool.test.mjs`                                                             |
| `scripts/lib/logo.mjs`            | exact branded header and fresh return values                                            | `test/logo.test.mjs`                                                                   |
| `scripts/lib/message.mjs`         | severity, tone, wrapping, and single-summary composition                                | `test/message.test.mjs`                                                                |
| `scripts/lib/package-manager.mjs` | package-manager detection and command construction                                      | `test/package-manager.test.mjs`                                                        |
| `scripts/lib/panic.mjs`           | read-only Git-state parsing, safe guide selection, and one-presentation modeling        | `test/panic.test.mjs`                                                                  |
| `scripts/lib/process.mjs`         | shell-free child execution, environment isolation, timeout and process-tree cleanup     | `test/process.test.mjs`                                                                |
| `scripts/lib/push-base.mjs`       | upstream, first-push, remote, and range-base inference                                  | `test/push-base.test.mjs`                                                              |
| `scripts/lib/runtime.mjs`         | package-engine minimum parsing and unsupported-Node diagnostics                         | `test/runtime.test.mjs`; normal CLI subprocess coverage                                |
| `scripts/lib/secret-scan.mjs`     | staged-added-line parsing, credential patterns, exemptions, and fail-closed scan state  | `test/secret-scan.test.mjs`, `test/secret-scan-integration.test.mjs`                   |
| `scripts/lib/ui.mjs`              | terminal capability detection, output routing, colors, and width                        | `test/ui.test.mjs`                                                                     |
| `scripts/lib/vows.mjs`            | deterministic vow content, ANSI behavior, wrapping, and immutability                    | `test/vows.test.mjs`                                                                   |
| `scripts/lib/welcome.mjs`         | once-per-clone marker ownership, fail-open behavior, and Commit Owl onboarding          | `test/welcome.test.mjs`                                                                |

## Maintenance and integration ownership

The five percentage exclusions plus the integration fixture are not test
exclusions:

| Maintenance source                               | Why it is outside the runtime percentage                        | Automated evidence                                                        |
| ------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `test/integration/helpers/lifecycle-fixture.mjs` | packed-package integration fixture executed in disposable repos | `test/integration/lifecycle-manager.test.mjs`; CI manager matrix          |
| `scripts/lib/coverage-badge.mjs`                 | coverage policy and badge parser                                | `test/coverage-badge.test.mjs`, `test/test-quality.test.mjs`              |
| `scripts/lib/lifecycle-managers.mjs`             | integration harness command definitions                         | `test/integration/lifecycle-manager.test.mjs`                             |
| `scripts/run-branch-coverage.mjs`                | the coverage runner and read-only scope report                  | `npm run test:coverage`; `test/coverage-scope.test.mjs`; metadata checks  |
| `scripts/run-lifecycle-test.mjs`                 | outer package-manager integration launcher                      | `npm run test:lifecycle:*`; `test/integration/lifecycle-manager.test.mjs` |
| `scripts/update-readme-coverage-badge.mjs`       | maintainer badge updater                                        | `test/update-readme-coverage-badge.test.mjs`                              |

## Suppressions and meaningful-coverage rules

There are exactly two `node:coverage` suppressions: the fallback error boxes
after mutation preflight in `scripts/init.mjs` and `scripts/uninstall.mjs`.
Permission and identity preflight, replacement races, open-descriptor
comparison, and exclusive creation are exercised deterministically. The
remaining post-preflight operating-system write failure is nondeterministic.
An executable inventory prevents new or enlarged suppressions from being added
silently.

The test strategy also enforces behavior that a percentage cannot:

- pushed-range selection blocks when a source is deleted, when a source is
  renamed but its old test remains, and when source and test are renamed
  together and the renamed test fails;
- generated message-state SVGs are regenerated in a private temporary
  directory and compared byte-for-byte with all 66 committed assets;
- `test/ci-change-classifier.test.mjs` exercises every path category, both
  fields of rename/copy records, unusual NUL-delimited filenames, a 20,000-file
  diff, divergent fork-shaped history, shallow/missing history, malformed
  output, and failed Git commands. Only pure explicit documentation/metadata
  additions and modifications select the small route; every deletion, rename,
  copy, executable editor config, and other result selects the full graph. The
  focused metadata invariant also derives the exact 100% badge from the
  coverage threshold so README-only edits retain badge freshness. PRs run the
  immutable base-commit classifier, while a missing trusted copy takes the
  fixed full route;
- the aggregate `CI Success` job requires explicit classifier, DCO, and quality
  success. It accepts compatibility-job skips only for the exact
  documentation-only tuple and otherwise requires explicit success from the
  full OS/Node, npm lifecycle, shell, non-npm package-manager, migration, and
  CodeQL graph;
- property tests exercise path normalization and ownership invariants, while
  real disposable Git repositories cover CLI and hook behavior;
- no snapshot update can mask behavior: assertions target exact structured
  values, exit statuses, filesystem/Git state, or narrowly normalized visual
  properties.

## CI and badge freshness

Ubuntu CI enforces 100% lines, branches, and functions on Node 22.11.0 and Node 24. Node 24 is the canonical badge producer: `npm run coverage:check` runs the
same gated command and fails if the committed README badge differs from the
generated value.

Windows runs the same top-level test-file set through complementary native Node
shards `1/2` and `2/2` on both Node lines. Their union assigns every test file
exactly once, while the packed npm lifecycle remains in separate parallel
required jobs. The two Ubuntu coverage lanes stay complete and unsharded, so
the Windows scheduling change does not alter either coverage denominator or
the badge-freshness gate.

The badge rounds to one decimal place, while all three CI thresholds evaluate
Node's unrounded coverage result. Rounding therefore never relaxes the 100%
gate.

To refresh it locally:

```bash
npm run coverage:badge
```

Badge colors are derived from the percentage: `brightgreen` at 90%+, `green`
at 80%+, `yellowgreen` at 70%+, `yellow` at 60%+, `orange` at 50%+, and `red`
below 50%.
