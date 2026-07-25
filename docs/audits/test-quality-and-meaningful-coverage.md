# Test Quality and Meaningful Coverage Audit

This is the completion report for
[audit workstream #132](https://github.com/RoryGlenn/commitment-issues/issues/132).
It reviews the complete automated-test strategy after the core-behavior and
security audits, including runtime units, CLI and real-Git fixtures, changed-file
selection, coverage policy, repository tools, packaging, package-manager
lifecycle tests, platform assumptions, mocks, cleanup, and generated evidence.

## Executive summary

The audit found no Critical or High issue. It found one Medium CI enforcement
defect and three Low evidence gaps; all four are fixed in this workstream with
focused regression coverage:

1. The aggregate required check rejected `failure` and `cancelled` dependency
   results but could accept a required job reported as `skipped` or another
   non-success state. It now accepts only explicit success from every required
   dependency.
2. `scripts/lib/logo.mjs` was executed incidentally but had no direct assertion
   for its exact output or fresh-value contract. It now has a semantic unit test.
3. The 66 generated message-state SVGs matched their generator, but no test
   prevented a generator edit from leaving committed assets stale. A private
   temporary regeneration now compares every asset byte-for-byte and checks
   gallery ownership.
4. Deleted-source and source-only rename behavior already blocked a push, but a
   combined source-and-test rename did not have an explicit regression. The
   new real-Git fixture proves that the renamed failing test is selected and
   blocks the push.

No dead production code, persistent fixture state, broad coverage suppression,
silent test skip, snapshot masking, or repeatable flake was found. At this
audit's snapshot, large-repo performance remained separately owned by
[#95](https://github.com/RoryGlenn/commitment-issues/issues/95); the later
[hook performance baseline](../performance.md) completes that follow-up without
changing this audit's historical findings.

## Scope inventory

| Group                     | Inventory and disposition                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published/runtime scripts | 26 files. Every file is in the 100% line/branch/function denominator and has an executable named-test owner. See [Runtime Coverage Policy](../branch-coverage.md).                    |
| Maintenance scripts       | 6 files. Every exclusion is exact, existing, and test-owned; new published scripts enter the runtime denominator by default.                                                          |
| Repository tools          | 5 files: DCO range checker, demo comparator, SVG generator, release preflight, and message-state runner. All have direct unit/integration evidence listed below.                      |
| Top-level test suites     | 42 files selected by `npm test`, including unit, property, subprocess, CLI, hook, release, visual, and real-Git fixture coverage.                                                     |
| Package lifecycle suite   | 1 nested integration file, invoked separately for npm, pnpm, Yarn, and Bun so unpacked temporary package copies do not distort runtime coverage.                                      |
| Shared test helpers       | 2 files: terminal-output inspection and disposable Git repository/process helpers. No persistent fixture directory exists; complex fixtures are built below private temp roots.       |
| Mocks and stubs           | Node's test-scoped filesystem mocks plus temporary fake executables/packages. Test context teardown or `t.after` restores state; there is no shared mutable mock server.              |
| Coverage directives       | Exactly 2 narrow post-preflight filesystem-race suppressions. Their inventory and explanations are executable assertions.                                                             |
| Conditional skips         | Exactly 2 read-only-mode checks skip only on filesystems/platforms that do not enforce the POSIX mode bit. They execute on the local macOS/Linux CI legs; no suite-level skip exists. |

The complete public-behavior-to-scenario inventory remains in
[Scenario Coverage](../scenario-coverage.md). The module-to-test ownership map,
maintenance exclusions, and meaningful-coverage rules are in
[Runtime Coverage Policy](../branch-coverage.md).

## Repository tool ownership

| Tool                               | Behavior evidence                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tools/check-dco-range.mjs`        | `test/dco.test.mjs`, metadata/workflow invariants, and both DCO workflow entrypoints                                  |
| `tools/compare-demo-gifs.mjs`      | `test/demo-visual-comparison.test.mjs`, `test/visual-assets.test.mjs`, and the render workflow contract               |
| `tools/gen-message-state-svgs.mjs` | `test/visual-assets.test.mjs` regenerates all 66 assets in a private temp directory and compares exact bytes          |
| `tools/release-preflight.mjs`      | `test/release-integrity.test.mjs` covers local/remote tag, release, registry, signal, malformed, and success outcomes |
| `tools/show-message-states.mjs`    | `test/message-state-runner.test.mjs` covers list/filter/run/error/cleanup behavior                                    |

## Findings and dispositions

| Severity  | Evidence                                                                                      | Impact                                                                                          | Disposition                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium    | `.github/workflows/ci.yml:123-142`; regression at `test/test-quality.test.mjs:124-135`        | A skipped or otherwise incomplete required dependency could leave `CI Success` green.           | Fixed fail-closed: DCO, `check`, and `pm-lifecycle` must each report exactly `success`.                                                     |
| Low       | `scripts/lib/logo.mjs:8-37`; direct evidence at `test/logo.test.mjs:10-23`                    | Coverage execution did not prove the visible wordmark, tagline, layout, or fresh return value.  | Added an exact ANSI-normalized output assertion and caller-mutation regression.                                                             |
| Low       | `tools/gen-message-state-svgs.mjs:150-196`; regression at `test/visual-assets.test.mjs:48-81` | Generator and committed gallery assets could drift while existing static SVG checks still pass. | Added isolated regeneration, exact 66-file comparison, gallery references, and automatic cleanup.                                           |
| Low       | selection evidence at `test/prepush.test.mjs:159-240`                                         | The combined rename path was implemented but not explicitly protected against a future bypass.  | Added a real-Git source+test rename whose failing renamed test must be selected and block.                                                  |
| Accepted  | `scripts/init.mjs:264`; `scripts/uninstall.mjs:211`                                           | A filesystem can change after successful preflight and before the guarded write.                | Keep the two defensive race handlers suppressed; preflight/error behavior is fully exercised and the exact suppressions are locked by test. |
| Follow-up | issue #95                                                                                     | Very large repositories may expose test-selection latency or process-volume limits.             | Kept as a dedicated benchmark issue; the later bounded baseline and Windows argv analysis are recorded in `docs/performance.md`.            |

The CI regression was demonstrated red before the workflow fix: the new focused
test failed because the old wildcard expression did not require explicit
success. It passed after the smallest workflow change. The other additions
strengthen previously unasserted contracts without changing runtime product
behavior.

## Selection, deletion, and rename evidence

`test/prepush.test.mjs` uses real commits and push input rather than mocked Git
output for the selection boundary. It now proves all of these outcomes:

- a deleted test is never passed to Node's test runner;
- deleting a source still runs its surviving related test, which fails on the
  missing import and blocks when blocking is enabled;
- renaming only a source still runs the test left at the original path and
  blocks on its missing import;
- renaming source and test together runs the new test path and blocks on its
  deliberately failing assertion;
- filenames beginning with `-`, shell metacharacters, whitespace, newlines,
  Unicode, same-basename workspace files, and multiple pushed ranges remain
  unambiguous.

CI independently runs the entire suite, not changed-file selection. A rename or
deletion therefore cannot avoid the branch gate even if a future local
selection regression is introduced.

## Flake, order, state, and platform review

- The stateful `process`, `commit-fix`, `prepush`, and demo-comparison suites
  passed five consecutive combined runs. Each round completed in 13.7-13.8s.
- All 42 top-level suites passed twice with file concurrency forced to one and
  two deterministic shuffled orders (seeds 132 and 3132), in 127.1s and 130.0s.
- The ordinary suite passed with `COMMITMENT_ISSUES=0`, matching CI's hook-
  suppression environment, and with the variable absent.
- A tracked-files-only copy was initialized as a new signed Git repository,
  installed from `package-lock.json`, and passed all 671 tests. Git metadata is
  required because four repository-shape/packaging checks intentionally inspect
  tracked modes or clone the current checkout.
- Temporary repositories, remotes, fake executables, homes, caches, images,
  reports, and package workspaces use unique `mkdtemp` roots and registered
  cleanup. The shuffled runs found no working-directory, environment, mock, or
  process state leaking into the next test.
- Local platform evidence was collected on macOS. GitHub CI owns Ubuntu,
  macOS, and Windows across Node 22.11.0 and 24; npm lifecycle runs on the main
  OS/Node matrix, while pnpm, Yarn, and Bun run in their dedicated lifecycle
  matrix.

## Coverage interpretation

The public runtime remains at 100% line, branch, and function coverage for all
26 measured files. That number is supported—not substituted for—by real Git
fixtures, subprocess and exit-status assertions, property tests, exact
structured values, filesystem state, package installation flows, and narrowly
normalized visual comparisons.

At the audit snapshot, an all-maintenance diagnostic executed the then-six
repository-only maintenance sources. Five were 100% in the locally available
path. The former monolithic lifecycle entry reported 91.46% lines, 57.63%
branches, and 92.59% functions in one local npm run because it deliberately
contained OS and npm/pnpm/Yarn/Bun branches; those variants are owned by the
GitHub lifecycle matrices rather than inflated with mocks. That behavior now
lives in named phases at `test/integration/helpers/lifecycle-fixture.mjs`. This
is a justified separate integration boundary, not an unmeasured public-runtime
module.

## Verification record

The completion branch produced the following results from the lockfile-defined
dependency tree:

| Command or probe                                       | Result                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `npm ci --ignore-scripts`                              | passed; 268 packages, 0 vulnerabilities                                |
| `npm run lint`                                         | passed                                                                 |
| `npm run format:check`                                 | passed                                                                 |
| `npm test`                                             | passed; 671 passed, 0 failed, 0 skipped                                |
| `COMMITMENT_ISSUES=0 npm test`                         | passed; 671 passed, 0 failed, 0 skipped in the CI hook environment     |
| `npm run test:coverage`                                | passed; 671 tests and 100% line, branch, and function coverage         |
| `npm run coverage:check`                               | passed; README branch badge remains current at 100.0%                  |
| `npm run test:lifecycle:npm`                           | passed; packed workspace, hook, clone, worktree, repair, and uninstall |
| `npm run test:lifecycle:pnpm`                          | passed; same packed lifecycle flow using locally available pnpm        |
| hosted Yarn and Bun lifecycle matrix                   | required pull-request evidence; those tools are not installed locally  |
| `npm pack --dry-run --json --ignore-scripts`           | passed; 56 files, 133,295-byte compressed package                      |
| clean temporary Git checkout: `npm ci` then `npm test` | passed; 268 packages, 0 vulnerabilities, 671 tests, 0 failures/skips   |
| five repeated stateful-suite rounds                    | passed; 5/5, no failures                                               |
| serial shuffled top-level suites, seeds 132 and 3132   | passed; 42/42 files in both orders, no failures                        |
| message-state generator comparison                     | passed; 66/66 generated assets present, referenced, and byte-identical |
| `git diff --check`                                     | passed                                                                 |

The pull request and CI results are the final reviewable evidence. This issue
should close only when that pull request is merged; the report does not treat a
local pass as a substitute for the required hosted platform and package-manager
checks.

## Conclusion

The workstream is complete when the verification table above is final and the
reviewed pull request is linked to #132. Every production module and repository
tool is test-owned, the coverage denominator and suppressions are fail-closed,
deleted/renamed paths cannot evade local or CI evidence, and all concrete
findings are fixed. The performance gap was explicitly owned by #95 rather
than being duplicated here and is now covered by the later bounded benchmark.
Merge of this workstream unblocks #133 and #134 as recorded in the audit
sequence.
