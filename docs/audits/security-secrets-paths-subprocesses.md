# Security, Secrets, Paths, and Subprocesses Audit

This is the completion report for
[audit workstream #131](https://github.com/RoryGlenn/commitment-issues/issues/131).
It reviews the implementation at baseline
[`73def8fbb07b30604b36122abbb74200d781bf97`](https://github.com/RoryGlenn/commitment-issues/commit/73def8fbb07b30604b36122abbb74200d781bf97)
plus the fixes recorded in this report. The scope includes secrets handling,
path parsing, subprocess construction and cleanup, local file operations,
dependency state, and every GitHub Actions workflow.

## Executive summary

The audit found five implementation weaknesses and fixed each with adversarial
regression coverage:

1. Opt-in secret enforcement failed open when the staged diff command failed.
   `blockOnSecrets: true` now blocks on a spawn failure, nonzero Git result, or
   malformed patch, while advisory mode continues with an explicit warning.
2. A discovered Node test path beginning with `-` could be interpreted as a
   Node option instead of a file. Node test invocations now place paths behind
   `--` and make leading-hyphen paths absolute.
3. Hook inspection followed symbolic links. A dangling hook link could look
   absent, and repair could write through it. Hook files and hook directories
   are now classified with `lstat`; symlinks are preserved as uninspectable and
   never repaired automatically.
4. Pre-push test reporting used a predictable shared-temporary filename. It now
   creates a private randomized temporary directory and removes that directory
   after reading the report.
5. Git's repository-local hook environment reached test subprocesses. A test
   that created a temporary Git repository could instead reconfigure, commit
   to, or push from the hook caller. Hook-launched tests and the repository's
   fixture helper now remove those routing variables before spawning.

No dependency vulnerability was reported by the lockfile-defined audit. The
High integrity finding tracked by #159 was confirmed end to end and remediated
in this branch; its regression proves that the caller's ref and shared config
remain unchanged. No Critical finding or other new unresolved High finding was
found. The known High release-policy finding in #94 remains open and is
assigned to release audit #136; this audit does not lower or close it. The
historical-review assurance gap in #99 likewise remains open until the core,
security, and release findings have all settled.

## Assets, actors, and trust boundaries

| Boundary or asset                    | Attacker-controlled or fallible input                                                                              | Required treatment                                                                                  | Disposition and evidence                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Working tree, index, and Git history | Repository contents and concurrent developer actions                                                               | Never mutate an unproven file set; distinguish failed inspection from an empty result               | NUL-delimited file queries and refusal/advisory outcomes in `scripts/precommit.mjs`, `scripts/prepush.mjs`, `scripts/fix-staged.mjs`, and `scripts/commit-fix.mjs`; integration tests cover dirty, partial, deletion, rename, and failure states |
| Configuration                        | `package.json` and `.commitmentrc.json` values                                                                     | Parse as JSON, allowlist keys and types, never import project JavaScript                            | `scripts/lib/config.mjs:303-378`; `test/config.test.mjs` and setup/removal tests                                                                                                                                                                 |
| Repository filenames                 | Spaces, tabs, newlines, quotes, backticks, dollar signs, semicolons, Unicode, glob characters, and leading hyphens | Preserve path boundaries; never interpolate into a shell; protect option boundaries                 | Git lists use `-z`; subprocesses receive argv arrays; Node-discovered tests use `scripts/lib/process.mjs:210-240`; path regressions are listed below                                                                                             |
| Git process output                   | Missing Git, nonzero status, malformed NUL lists, malformed patches, ambiguous refs                                | Validate structure and choose an explicit advisory or fail-closed policy                            | Structured outcomes in `scripts/lib/process.mjs:69-75`; patch validation in `scripts/lib/secret-scan.mjs:197-339`; blocking secret and push checks fail closed                                                                                   |
| Environment and executable lookup    | Inherited `PATH`, Git hook routing variables, environment values, and platform process semantics                   | Do not invoke a shell; strip repository-local Git routing before tests; bound long-running commands | `scripts/lib/process.mjs`; `scripts/precommit.mjs`; `scripts/prepush.mjs`; ordinary `PATH` remains an accepted local-machine boundary, while test subprocesses rediscover the checkout by cwd                                                    |
| Configured local tools               | Repository-selected test command and project-local ESLint, Prettier, or commitlint                                 | Preserve configured argv; do not silently download or use a global peer                             | `scripts/lib/process.mjs:122-203`; entrypoint call sites below; executing repository-configured code is an explicit project trust decision                                                                                                       |
| Native hooks and hook directories    | Existing files, symlinks, custom bodies, configured `core.hooksPath`, and permissions                              | Prove ownership before replace/remove; do not follow symlinks during repair                         | `scripts/lib/hooks.mjs:112-283,452-566`; lifecycle tests and new symlink regressions                                                                                                                                                             |
| Push-ref input                       | Lines supplied by Git to the pre-push hook and local/remote object IDs                                             | Parse only the required fields; ignore deletions; use refs only as literal Git argv                 | `scripts/prepush.mjs:333-421`; `scripts/lib/push-base.mjs:14-115`; pre-push tests                                                                                                                                                                |
| Temporary output                     | Multi-user temporary namespace and tool-produced TAP                                                               | Use an unpredictable private directory; remove only that owned directory                            | `scripts/prepush.mjs:565-588`; collision regression in `test/prepush.test.mjs`                                                                                                                                                                   |
| Pull-request workflows               | Untrusted fork contents and pull-request metadata                                                                  | Read-only by default; no release credentials; explicit permissions                                  | `.github/workflows/ci.yml`, `codeql.yml`, `dco.yml`, `render-demo.yml`, `repo-health.yml`, and `scorecard.yml`                                                                                                                                   |
| Release credentials and artifacts    | Tags, workflow inputs, npm publication, release assets, action dependencies                                        | OIDC trusted publishing, exact artifact hashing, pinned actions, provenance, immutable release      | `.github/workflows/publish.yml`; tag reachability remains the open High finding in #94 for #136                                                                                                                                                  |
| Private reports                      | Undisclosed vulnerability details                                                                                  | Keep reports out of public issues until coordinated disclosure                                      | `.github/SECURITY.md` and `docs/vulnerability-history.md`                                                                                                                                                                                        |

The local machine, Git, Node.js, npm, and GitHub platform are trusted computing
base components. A malicious repository can already execute code through its
chosen test runner or other installed project tools; this package does not try
to sandbox that code. It does ensure that filenames and Git output do not
silently become additional command options or shell source.

## Findings and dispositions

| Severity                  | Finding                                                                                    | Impact                                                                                                                                      | Disposition                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High                      | #159: hook-launched tests inherited Git's repository-local routing environment             | Nested fixture Git commands could reconfigure or commit to the caller and push those fixture refs through the caller's authenticated remote | Fixed: test subprocesses and the fixture helper strip all supported local Git variables and counted config pairs; a real pre-push reproduction passed without changing caller or remote state |
| Medium                    | #97: blocking secret inspection failed open when `git diff --cached` failed                | An explicitly enforced secret gate could allow a commit without examining added lines                                                       | Fixed: process and patch failures have distinct outcomes; enforcement fails closed; advisory mode warns and continues; terminal and JSON contracts plus regressions were added                |
| Medium                    | A discovered Node test pathname beginning with `-` was appended as an option-like token    | The intended test could be skipped, fail unexpectedly, or hang, weakening staged/push test assurance                                        | Fixed: Node test paths follow `--`, and leading-hyphen paths become absolute; custom runner argv remains unchanged                                                                            |
| Medium                    | Hook classification followed symbolic links and repair could write through a dangling link | Repair could overwrite a target outside the hook directory or falsely claim ownership                                                       | Fixed: `lstat` classifies hook-file and hook-directory symlinks as uninspectable; setup/doctor preserve them and report bounded guidance                                                      |
| Low                       | Pre-push TAP output used `/tmp/prepush-tap-${pid}.tap`                                     | A same-user or shared-host path collision could redirect output or cause deletion of a pre-existing path                                    | Fixed: `mkdtemp` creates a randomized owned directory; only that directory is removed                                                                                                         |
| High/open                 | #94: the publish workflow does not prove that a release tag is reachable from `main`       | A maintainer able to create a tag could publish an unmerged commit                                                                          | Not hidden or downgraded. Remains open for the release and supply-chain audit in #136                                                                                                         |
| Medium/open assurance gap | #99: the July 11 security review is a historical snapshot                                  | Readers could mistake snapshot evidence for a current complete review                                                                       | The historical document is now labeled; this report is current Audit 2 evidence, while #99 stays open until release findings settle                                                           |

## Subprocess inventory

Every production or maintainer subprocess source was inspected. The common
runtime rule is `shell: false` by construction: commands and arguments are
separate arrays, and long-running children have a configured timeout.

| Call sites                                                                                                    | Purpose and input                                                                                                       | Disposition                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib/process.mjs`                                                                                     | Common probes, test-environment isolation, async local tools, and cross-platform process-tree cleanup                   | Accepted centralized boundary. No shell string is constructed; outcomes are structured; Git's repository-local routing is removed from test environments. Captured output is not size-capped before timeout because a configured local executable already has equivalent local denial-of-service authority                                                                        |
| `scripts/lib/process.mjs:122-203`; `scripts/lib/local-tool.mjs:15-40`                                         | Resolve ESLint, Prettier, and optional commitlint from ancestor `node_modules`                                          | Accepted. No implicit `npx`, registry query, install, or global fallback                                                                                                                                                                                                                                                                                                          |
| `scripts/precommit.mjs`                                                                                       | Run local lint/format/test tools and read branch, staged paths, patch, upstream, stats, blobs, and dirty worktree state | Accepted with fixes. Paths are separate argv, pathname lists are NUL-delimited, secret patch output is structurally checked, Node test paths are protected behind `--`, and tests do not inherit hook-local Git routing                                                                                                                                                           |
| `scripts/prepush.mjs`; `scripts/lib/push-base.mjs:14-115`                                                     | Resolve pushed ranges, parse NUL-delimited changes, choose a first-push base, and run related tests                     | Accepted with fixes. Blocking diff failures fail closed; refs remain literal argv; test paths are protected; the timed child does not inherit hook-local Git routing                                                                                                                                                                                                              |
| `scripts/commit-msg.mjs:46-75`                                                                                | Run an explicitly enabled project-local commitlint against one absolute message path                                    | Accepted. Local-only resolution, literal argv, timeout, and advisory/blocking outcomes are documented                                                                                                                                                                                                                                                                             |
| `scripts/commit-fix.mjs`; `scripts/fix-staged.mjs`; `scripts/lib/fix-safety.mjs`; `scripts/fix-staged-js.mjs` | Prove working-tree/ref safety, transform captured bytes, stage exact attributable blobs, and amend                      | Accepted. Snapshot identities are revalidated before mutation, tools receive target content through stdin, index installation holds Git's lock, and concurrent edit/delete/type/index/HEAD/local-ref changes fail closed. Commit amend additionally refuses detached, signed, tagged, or known-remote-retained history and documents that its proof is an offline local snapshot. |
| `scripts/lib/hooks.mjs:112-218`; `scripts/init.mjs:282-315`; `scripts/doctor.mjs:445-478`                     | Discover repository/hook state and retire only known legacy `core.hooksPath` wiring                                     | Accepted. Missing values, failed probes, bare repositories, native paths, and foreign paths remain distinct                                                                                                                                                                                                                                                                       |
| `test/integration/helpers/lifecycle-fixture.mjs`; `scripts/run-lifecycle-test.mjs`                            | Named disposable package-manager, Git, hook, clone, worktree, repair, and uninstall phases                              | Accepted maintainer/CI integration. Arguments are arrays; all mutable operations are below one private temporary root shared only by the ordered child tests                                                                                                                                                                                                                      |
| `test/helpers/temp-repo.mjs`                                                                                  | Create disposable repositories and invoke Git, Node, and fake-tool fixtures                                             | Fixed for #159. Every helper subprocess receives a copied environment without Git's repository-local routing or numbered config pairs, so fixture cwd controls the target repository                                                                                                                                                                                              |
| `scripts/run-branch-coverage.mjs:76-104`; `scripts/update-readme-coverage-badge.mjs:18-25`                    | Launch tests for coverage and badge verification                                                                        | Accepted maintainer tooling with fixed local commands and owned outputs                                                                                                                                                                                                                                                                                                           |
| `tools/check-dco-range.mjs:37-52`; `tools/release-preflight.mjs:24-63`                                        | Read Git history/tags and perform release preflight probes                                                              | Accepted fixed-command maintainer tooling. Arguments are arrays and output is parsed before policy decisions                                                                                                                                                                                                                                                                      |
| `tools/compare-demo-gifs.mjs:124-143`; `tools/show-message-states.mjs:48-61,505-512`                          | Run fixed image inspection and disposable message-state scenarios                                                       | Accepted repository-only tooling. Inputs are maintainer paths or files beneath an owned temporary repository                                                                                                                                                                                                                                                                      |

Direct `node:child_process` imports are limited to the common process helper,
the lifecycle/coverage launchers, DCO checker, release preflight, and demo GIF
comparison. Repository runtime entrypoints otherwise consume the shared
process abstraction.

## File-operation inventory

| Call sites                                                                                                                                                                                     | Data or mutation                                                                                                                     | Disposition                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/cli.mjs:34`; `scripts/lib/config.mjs:303-378`; `scripts/lib/files.mjs:294-311`; `scripts/lib/process.mjs:130-180`; `scripts/lib/local-tool.mjs:15-40`; `scripts/commit-msg.mjs:46-56` | Read fixed manifests/config, discover a root package, resolve local peer metadata, and inspect one user-supplied commit-message file | Accepted read-only operations. Config is JSON-only; missing/unreadable input becomes a bounded fallback or error appropriate to the command                     |
| `scripts/lib/hooks.mjs:240-283,452-472`                                                                                                                                                        | Classify and write native hooks                                                                                                      | Fixed. `lstat` rejects symlink/non-file hook entries and symlink/non-directory hook roots; generated bodies are written only after callers establish ownership  |
| `scripts/lib/hooks.mjs:494-566`                                                                                                                                                                | Inspect and remove exact legacy Husky bodies/runtime                                                                                 | Accepted ownership-bounded cleanup. User-authored bodies are preserved; removal targets are computed from exact generated content                               |
| `scripts/init.mjs:45-112,203-278`                                                                                                                                                              | Read/update package config, standalone JSON, and `.gitignore`                                                                        | Accepted explicit setup mutation. Container validation, read/write preflight, dry run, and bounded failure precede hook writes                                  |
| `scripts/uninstall.mjs:46-78,123-241,283-295`                                                                                                                                                  | Read/update package config, inspect/remove owned hooks/config, and preserve shared ignore entries                                    | Accepted explicit removal. Exact bodies are removed, custom/uninspectable paths are retained, and dry run reports the plan                                      |
| `scripts/prepush.mjs:569-606`                                                                                                                                                                  | Create/read/remove test-reporter output and relay captured output to stderr                                                          | Fixed. The TAP file is beneath a randomized private directory, cleanup is scoped to that directory, and `writeSync` targets the existing stderr descriptor only |
| `test/integration/helpers/lifecycle-fixture.mjs`; `scripts/run-branch-coverage.mjs:25-109`                                                                                                     | Read fixtures/reports and create/remove lifecycle or coverage temporary trees                                                        | Accepted test-only operations beneath `mkdtemp` roots with registered/finally cleanup                                                                           |
| `test/helpers/temp-repo.mjs`; `test/repository-shapes.test.mjs`                                                                                                                                | Create/remove temporary Git repositories and assert caller state                                                                     | Fixed for #159. Repository routing comes from each fixture cwd, cleanup stays below its `mkdtemp` root, and the caller's ref/config remain invariant            |
| `scripts/update-readme-coverage-badge.mjs:44-62`                                                                                                                                               | Read coverage output and optionally update the README badge                                                                          | Accepted explicit maintainer script; `--check` is read-only and CI uses the checked contract                                                                    |
| `tools/show-message-states.mjs:41-43,171-205`; `tools/gen-message-state-svgs.mjs:160-195`; `tools/compare-demo-gifs.mjs`                                                                       | Build disposable scenario repos, generate fixed gallery assets, and inspect named demo files                                         | Accepted repository-only tools with either private temporary roots or fixed maintainer-owned output directories                                                 |
| `scripts/lib/coverage-badge.mjs:38-55`; `tools/check-dco-range.mjs`; `tools/release-preflight.mjs`                                                                                             | Read coverage/history/release metadata                                                                                               | Accepted read-only policy evidence                                                                                                                              |

Existence checks, path joins, and reads inherit the same dispositions as their
owning row. No runtime path is opened through a shell, and no runtime operation
uses repository filenames to select an arbitrary cleanup root.

## Secret-scanner contract

The scanner is deliberately high precision. It examines only lines added by
`git diff --cached -U0` plus staged dotenv filenames. The patch parser validates
file boundaries and hunk old/new counts, decodes Git's C-style pathname quoting,
and handles binary changes, renames, deletions, missing final newlines, and
large patches without confusing metadata for content.

The policy outcomes are distinct:

- advisory mode warns and allows the commit if Git cannot produce a valid
  staged patch;
- `blockOnSecrets: true` blocks when a likely secret is found;
- `blockOnSecrets: true` also blocks when Git fails to launch, exits nonzero,
  or returns malformed patch structure;
- terminal and JSON output identify an unavailable scan separately from a
  detected secret and show `git commit --no-verify` as the explicit one-time
  bypass.

The scanner is not a general-purpose data-loss-prevention engine. It does not
perform entropy scoring, decode base64, or combine multiline values. Teams that
need broader enforcement should add a dedicated server-side scanner and rotate
any credential that reached Git history.

## Adversarial evidence

| Case                                                                                                           | Evidence                                                                                                | Result                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Git diff spawn error, nonzero exit, and successful-but-malformed patch                                         | `test/secret-scan.test.mjs`, `test/secret-scan-integration.test.mjs`, `test/json-output.test.mjs`       | Advisory warning remains nonblocking; explicit enforcement fails closed with distinct human/JSON state                   |
| Real Git-quoted path containing spaces, tab, newline, quote, backtick, dollar sign, semicolon, and Unicode     | `test/secret-scan-integration.test.mjs`                                                                 | Decoded as one pathname and the added credential is reported                                                             |
| Binary, rename-only, deletion, missing-final-newline, source lines resembling metadata, and a 5,000-line patch | `test/secret-scan.test.mjs`                                                                             | Valid patch shapes remain accepted; only added matching content is reported; malformed counts are rejected               |
| Leading-hyphen Node test path at commit and push time                                                          | `test/precommit.test.mjs`, `test/prepush.test.mjs`, `test/process.test.mjs`                             | The path is treated as a test file, never as a Node option; existing configured `--` is normalized                       |
| Custom non-Node test command                                                                                   | `test/process.test.mjs`, existing precommit/prepush command tests                                       | Existing executable and configured argv contract remains verbatim; discovered paths are appended as data                 |
| Hook file symlink, dangling symlink, and hook-directory symlink                                                | `test/hooks.test.mjs`, `test/doctor.test.mjs`                                                           | Classified uninspectable, preserved, and never followed by repair/write                                                  |
| Pre-created legacy predictable TAP path                                                                        | `test/prepush.test.mjs`                                                                                 | Pre-push uses a different randomized directory and neither reuses nor deletes the colliding path                         |
| Real pre-push test selection with hook-local Git dir, work tree, index, and config variables                   | `test/process.test.mjs`, `test/repository-shapes.test.mjs`, 257-test pre-push reproduction              | All selected tests pass; nested repositories stay isolated; caller HEAD, shared config, and remote main remain unchanged |
| Spaces, quotes, semicolons, Unicode, backslashes, globs, tabs, and newlines in other Git-path flows            | `test/process.test.mjs`, `test/lib-files.test.mjs`, `test/fix-staged.test.mjs`, `test/prepush.test.mjs` | Preserved through argv or NUL-delimited parsing without shell interpretation                                             |

## Dependency and workflow review

`npm ci` resolved the lockfile to 268 dependencies (26 production and 243
development entries in npm's summary) and reported zero install-time
vulnerabilities. `npm audit --json` reported zero vulnerabilities at every
severity. Optional commitlint remains consumer-owned and is not added to this
dependency graph.

All normal third-party workflow actions are pinned to complete commit SHAs.
The SLSA reusable workflow reference in `publish.yml` uses `@v2.1.0`; this is
the intentional reusable-workflow reference required by that upstream SLSA
integration rather than an unnoticed pin exception. Workflows declare explicit
permissions. Security, release, and rendering checkouts set
`persist-credentials: false`; ordinary CI has read-only repository permission.
The demo renderer downloads version-pinned binaries and verifies their SHA-256
digests before execution.

Pull-request workflows do not receive npm release authority. Publication uses
npm OIDC trusted publishing, packs and hashes one exact tarball, generates SLSA
provenance for that artifact, and makes the GitHub Release immutable after its
assets are attached. The remaining tag-to-`main` authorization gap is #94 and
belongs to #136. The scheduled `npm audit --audit-level=high` health job is
reporting-only (`continue-on-error`); locked installation, lint, tests,
coverage, and lifecycle checks remain enforced elsewhere in CI.

## Verification record

The completion branch must produce the following results from a clean
lockfile-defined dependency tree before the final signed commit:

| Command                                      | Result                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Hook-environment pre-push reproduction       | 257 selected tests passed; caller ref/config and remote `main` remained unchanged                  |
| Focused security regression suite            | 260 passed, 0 failed                                                                               |
| `npm run lint`                               | passed                                                                                             |
| `npm run format:check`                       | passed                                                                                             |
| `npm test`                                   | 665 passed, 0 failed                                                                               |
| `npm run test:coverage`                      | 665 passed; 100% line, branch, and function coverage                                               |
| `npm run coverage:check`                     | passed; README branch-coverage badge remains 100.0%                                                |
| `npm run test:lifecycle:npm`                 | packed npm workspace, hook, clone, worktree, repair, push, preview, and uninstall lifecycle passed |
| `npm pack --dry-run --json --ignore-scripts` | passed; 56 files, 131,120-byte compressed and 475,182-byte unpacked package                        |
| `npm audit --audit-level=high`               | passed; 0 known vulnerabilities                                                                    |
| `git diff --check`                           | passed                                                                                             |

## Residual risks and follow-up ownership

- Repository-configured local tools run with the developer's permissions and
  can intentionally consume CPU, memory, files, or the network. That code is
  inside the repository trust boundary, not a sandboxed plugin boundary.
- Async process output is captured in memory until completion or timeout. A
  malicious configured executable can create memory pressure; the same
  executable already has arbitrary local-code authority. A future streaming or
  output-cap design may reduce accidental resource usage.
- `PATH` and the inherited environment are trusted local execution context.
  Built-in peer tools are resolved by absolute local package path. Git plumbing
  intentionally uses the caller's full environment; configured test commands
  inherit ordinary values but not repository-local Git routing.
- The high-precision secrets rules trade recall for low false-positive rates.
  Server-side secret scanning and credential rotation remain necessary defense
  in depth.
- Release tag reachability (#94) remains High/open for #136. The historical
  assurance refresh (#99) remains open until the release audit and its findings
  are complete.

## Conclusion

Audit 2 is complete when the verification table is filled with passing results
and the signed pull request containing this report is linked from #131. Every
subprocess and file-operation group has an explicit boundary and disposition,
the five confirmed implementation weaknesses are fixed with adversarial
regressions, and unresolved release/assurance work remains visible under its
own issue and downstream audit owner.
