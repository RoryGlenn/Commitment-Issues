# Core CLI and Git Behavior Audit

This is the completion report for
[audit workstream #130](https://github.com/RoryGlenn/commitment-issues/issues/130).
It covers the public CLI, Git-state handling, configuration sources, setup and
removal, native hook ownership, lifecycle repair, protected-branch guards, and
the Git control flow used by commit and push checks.

## Executive summary

The audit found no unresolved Critical or High issue. Two Medium correctness
findings and the Git-state findings repaired by
[PR #139](https://github.com/RoryGlenn/commitment-issues/pull/139) are fixed
with regression coverage:

1. Setup commands accepted misspelled or unsupported options. In particular, a
   misspelled `--dry-run` could perform the real `init` or `uninstall` action.
   `init`, `uninstall`, `doctor`, and the remaining command contracts now reject
   unsupported arguments before mutation.
2. `init` could update package and hook state before discovering that
   `.gitignore` was uninspectable, and project-file permission failures could
   escape as raw filesystem exceptions. Project files are now inspected and
   preflighted before hook mutation, write failures receive bounded guidance,
   and a rerun repairs a partial setup.
3. Earlier Git discovery collapsed bare repositories, failed Git probes,
   configured hook paths, and uninspectable hooks into states that could produce
   false health claims or unsafe writes. PR #139 separated those states and
   made setup, repair, and removal fail safely.

The remaining platform, performance, and migration work is explicitly tracked
outside this workstream under #83, #95, #96, and #97. The later hook-manager
coexistence work extends this audited CLI with the `--integration` options
recorded below; it does not weaken the original fail-before-write boundary.

## Public CLI contract

| Invocation                          | Accepted arguments                                                                      | Success behavior                                                                                                        | Nonzero behavior and evidence                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commitment-issues --help`, `-h`    | none                                                                                    | Prints public commands; exit 0                                                                                          | A missing command prints usage to stderr and exits 1. `test/cli.test.mjs`                                                                                                                                                                                                               |
| `commitment-issues --version`, `-v` | none                                                                                    | Prints the package version; exit 0                                                                                      | Not applicable. `test/cli.test.mjs`                                                                                                                                                                                                                                                     |
| `init`                              | `--dry-run`/`-n`; `--integration[=husky\|lefthook\|pre-commit]`                         | Idempotently configures project files and native hooks, or emits read-only coexistence snippets; preview writes nothing | Invalid input or unsafe project/config/selected-manager state exits 1 before mutation. Hook ownership conflicts remain non-destructive warnings. `test/init*.test.mjs`, `test/repository-shapes.test.mjs`                                                                               |
| `uninstall`                         | `--dry-run` or `-n`                                                                     | Removes only exact owned setup; preview writes nothing                                                                  | Invalid input or an unsafe package/config state exits 1 before cleanup. Customized/uninspectable hooks are preserved and reported. `test/uninstall.test.mjs`                                                                                                                            |
| `doctor`                            | `--quiet`; `--integration[=husky\|lefthook\|pre-commit]`                                | Repairs exact owned native wiring, or verifies selected manager wiring read-only; quiet install mode stays exit 0       | Interactive invalid arguments, unsafe selected-manager config, or unrecoverable wiring exit 1; quiet failures warn without breaking installation. `test/doctor.test.mjs`                                                                                                                |
| `commit-msg`                        | zero or one message-file positional, or exact `--git-path`; generated hooks provide one | Disabled mode is silent; enabled advisory mode reports project commitlint results                                       | Enabled blocking mode exits 1 for findings/setup failures. More than one argument and unknown options are rejected by the bin. `test/commit-msg.test.mjs`, `test/cli.test.mjs`                                                                                                          |
| `precommit`                         | optional `--json`                                                                       | Advisory findings exit 0; JSON emits one schema-versioned payload                                                       | Invalid arguments and opted-in enforcement failures exit 1. `test/precommit*.test.mjs`, `test/json-output.test.mjs`                                                                                                                                                                     |
| `prepush`                           | up to Git's two positionals (`remote-name`, `remote-url`) plus optional `--json`        | Disabled/advisory modes allow the push; JSON preserves the same decision                                                | Invalid arguments or an opted-in blocking failure exit 1. `test/prepush.test.mjs`, `test/json-output.test.mjs`                                                                                                                                                                          |
| `commit-fix`                        | none                                                                                    | Safely fixes and amends an attached, unsigned commit absent from local protected refs                                   | Binds exact `HEAD`, branch attachment, index, target bytes, signature metadata, local tags, and known remote refs; refuses dirty, concurrent, retained, detached, signed, emptying, or manual-only cases. Extra arguments are rejected. `test/commit-fix.test.mjs`, `test/cli.test.mjs` |
| `fix-staged`                        | none                                                                                    | Fixes and stages only attributable output from the proven-safe staged set                                               | Captured stdin inputs and index-lock staging refuse inspection, partial-staging, concurrent, missing-tool, parse, staging, and remaining-manual failures. Extra arguments are rejected. `test/fix-staged.test.mjs`, `test/cli.test.mjs`                                                 |
| `fix-staged-js`                     | zero or more explicit file paths                                                        | Runs the internal ESLint/Prettier fixer for the exact argv paths; zero files exits 0                                    | Tool, parse, or remaining-lint failures exit 1. `test/fix-staged-js.test.mjs`                                                                                                                                                                                                           |

The hidden `vows` easter egg is separately tested as deterministic, read-only,
color-aware, and absent from the public command list.

## Repository and lifecycle evidence

| Required state                                      | Disposition and evidence                                                                                                                                                                                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty and unborn repositories                       | First-commit protected-branch enforcement is covered by `test/commit-guards-integration.test.mjs`; missing-commit fix behavior is covered by `test/commit-fix.test.mjs`.                                                                            |
| Detached HEAD                                       | Intentionally does not match a protected branch because no branch is named; every non-branch guard continues. Integration coverage: `test/commit-guards-integration.test.mjs`.                                                                      |
| Bare repositories                                   | Setup and doctor never claim local commit/push hooks are active; uninstall avoids hook inspection. `test/init.test.mjs`, `test/doctor.test.mjs`, `test/uninstall.test.mjs`.                                                                         |
| Linked worktrees                                    | Hooks resolve through Git's common directory and packed lifecycle repair works from the linked checkout. `test/hooks.test.mjs`, `test/doctor.test.mjs`, `test/integration/helpers/lifecycle-fixture.mjs`.                                           |
| Submodules                                          | Setup resolves and writes only the submodule's own Git common hook directory. `test/repository-shapes.test.mjs`.                                                                                                                                    |
| Shallow clones                                      | Setup installs native hooks without requiring deep history. `test/repository-shapes.test.mjs`.                                                                                                                                                      |
| Missing or multiple remotes                         | First-push base inference accepts only an unambiguous remote and falls back safely otherwise. `test/push-base.test.mjs`, `test/prepush.test.mjs`.                                                                                                   |
| Missing current branch                              | Branch-specific guards fail open intentionally while unrelated guards continue; unborn protected branches remain enforceable. `test/commit-guards*.test.mjs`.                                                                                       |
| Failed Git commands                                 | Hook path, branch, diff, file-list, worktree, upstream, and push-base failures have explicit fail-safe/advisory decisions. `test/hooks.test.mjs`, `test/init.test.mjs`, `test/doctor.test.mjs`, `test/precommit.test.mjs`, `test/prepush.test.mjs`. |
| Existing/custom hooks and hook paths                | Exact generated hooks are owned; custom bodies, foreign directories, non-executable files, and uninspectable paths are preserved with instructions. `test/hooks.test.mjs`, `test/init.test.mjs`, `test/doctor.test.mjs`, `test/uninstall.test.mjs`. |
| Existing lifecycle scripts                          | `prepare` and `postprepare` composition/removal preserve project commands. Fresh installs repair native hooks. `test/init.test.mjs`, `test/uninstall.test.mjs`, lifecycle matrix.                                                                   |
| Repeated or interrupted setup                       | `init` is idempotent and repairs a deliberately removed hook without disturbing configured state. `test/init.test.mjs`.                                                                                                                             |
| Read-only/uninspectable project files               | `.gitignore` inspection and package write access fail before hooks are touched; errors omit raw stacks. `test/init-gitignore.test.mjs`, `test/init.test.mjs`, `test/uninstall.test.mjs`.                                                            |
| Missing executables/non-interactive execution       | Missing local tools never fall back to global lookup or implicit `npx`; quiet doctor cannot break installation. `test/process.test.mjs`, `test/local-tool.test.mjs`, `test/doctor.test.mjs`.                                                        |
| Spaces, shell metacharacters, newlines, and Unicode | Git pathname flows are NUL-delimited and process arguments are passed without a shell. `test/process.test.mjs`, `test/lib-files.test.mjs`, staged/commit/push integration tests.                                                                    |

## File inventory and ownership

Every tracked file is assigned to one of these audit groups:

- **Public entrypoints:** `scripts/cli.mjs`, `init.mjs`, `uninstall.mjs`,
  `doctor.mjs`, `commit-msg.mjs`, `precommit.mjs`, `prepush.mjs`,
  `commit-fix.mjs`, `fix-staged.mjs`, and `fix-staged-js.mjs`.
- **Core Git/config/runtime helpers:** `scripts/lib/config.mjs`, `hooks.mjs`,
  `commit-guards.mjs`, `push-base.mjs`, `files.mjs`, `process.mjs`,
  `local-tool.mjs`, `checks.mjs`, `secret-scan.mjs`, `package-manager.mjs`, and
  `lifecycle-managers.mjs`.
- **Behavior presentation consumed by entrypoints:** `scripts/lib/message.mjs`,
  `ui.mjs`, `json-output.mjs`, and `logo.mjs`. Styling-specific review belongs
  to #133; this audit verifies their exit/severity integration only.
- **Lifecycle integration:** `test/integration/helpers/lifecycle-fixture.mjs`,
  `scripts/run-lifecycle-test.mjs`, and `test/integration/`.
- **Regression evidence:** every `test/*.test.mjs`, `test/*.test.js`, and
  `test/helpers/` or `test/integration/helpers/` file is mapped in
  `docs/scenario-coverage.md`; security-depth review continues in #131 and
  test-quality review continues in #132.
- **User-visible behavior documentation:** README, CHANGELOG, configuration,
  external-interface, how-it-works, message-state, migration, monorepo,
  security, troubleshooting/FAQ, and scenario-coverage documents.
- **Out-of-scope tracked groups with downstream owners:** workflows (#135),
  release tools and release documentation (#136), visual assets and promo
  material (#133/#137), governance/root policy files (#137), and independent
  final verification (#138).

## Findings and dispositions

| Severity     | Finding                                                                                                                 | Impact                                                            | Disposition                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Medium       | Unsupported setup arguments were ignored                                                                                | A misspelled preview option could run a real setup/removal action | Fixed with pre-mutation validation and regression tests                                |
| Medium       | Project-file inspection/write failures were late or raw                                                                 | Setup could be partial and diagnostics could expose a Node stack  | Fixed with early inspection/write preflight, bounded errors, and rerun repair coverage |
| Medium       | Git/hook discovery states were conflated                                                                                | False healthy claims or writes to an ineffective path             | Fixed by PR #139 with tests and documentation                                          |
| Low/accepted | Detached HEAD has no protected branch name                                                                              | The branch-name guard cannot apply                                | Intentional, documented, and tested; all unrelated checks continue                     |
| Deferred     | Broader shell/GUI clients, large-repository performance, published-version migration, and secret-inspection enforcement | Requires separate matrices or product contracts                   | Tracked by #83, #95, #96, and #97                                                      |

## Verification record

The completion branch produced these results from a clean lockfile-defined
dependency tree:

| Command                                      | Result                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run lint`                               | passed                                                                                     |
| `npm run format:check`                       | passed                                                                                     |
| `npm test`                                   | 642 passed, 0 failed                                                                       |
| `npm run test:coverage`                      | 642 passed; 100% line, branch, and function coverage                                       |
| `npm run coverage:check`                     | passed; README badge remains 100.0%                                                        |
| `npm run test:lifecycle:npm`                 | packed npm lifecycle, workspace, worktree, commit, push, repair, and uninstall flow passed |
| `npm pack --dry-run --json --ignore-scripts` | passed; 149 files, 186,461-byte compressed package                                         |
| `git diff --check`                           | passed                                                                                     |

The final issue comment should link the reviewed commit/PR containing this
report.

## Conclusion

The workstream is complete when the verification record above is attached to
#130. All confirmed defects are fixed with regression tests, every required
repository state is covered or intentionally dispositioned, observable
behavior is documented, and downstream ownership is explicit.
