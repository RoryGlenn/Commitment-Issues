# How commitment-issues works

`commitment-issues` owns the Git hook workflow directly by default, or composes
into an explicitly selected existing manager without taking ownership of its
files. Commit checks stay advisory by default, push checks can warn or block
depending on configuration, and fix commands mutate work only when the safety
checks pass.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/project-flowchart-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../assets/project-flowchart-light.svg">
    <img src="../assets/project-flowchart-light.svg" alt="commitment-issues project flowchart showing setup, Git hook wiring, code and guard checks before commit, safe fix paths, and pre-push tests" width="100%">
  </picture>
</p>

## Setup

Install the package with the peer tools it runs:

```bash
npm install -D commitment-issues eslint@^9 prettier@^3
```

Then initialize the project:

```bash
npx --no-install commitment-issues init
```

Run this from the project root of a non-bare Git working tree. Bare repositories
cannot run the local commit and push workflow and are reported as unsupported
instead of being marked healthy. The init command is idempotent. It wires plain
Git hooks, adds helper npm scripts, enables advisory push tests, and adds safe
ignore defaults for local tool output.

## Core hook wiring

`commitment-issues` does not require a hook manager.

| Git action              | Native hook path        | Command invoked                     |
| ----------------------- | ----------------------- | ----------------------------------- |
| `git commit`            | `.git/hooks/pre-commit` | `commitment-issues precommit`       |
| `git push`              | `.git/hooks/pre-push`   | `commitment-issues prepush "$@"`    |
| commit message (opt-in) | `.git/hooks/commit-msg` | `commitment-issues commit-msg "$1"` |

The hook files call the package binary from `node_modules/.bin`, so the behavior stays local to the project.

### Existing-manager path

With `init --integration=<manager>`, those entrypoints run inside Husky,
Lefthook, or pre-commit. Init prints project-local snippets; it never edits the
manager's files. Doctor then checks the exact config entry and executable
dispatcher in Git's effective hooks directory. Ambiguous, linked,
duplicate/cross-stage, conditional, unsupported, or customized layouts are
preserved for explicit remediation instead of guessed healthy.

The generated forms forward Git arguments, stdin, and blocking exits to the
same Node entrypoints while preserving unrelated manager behavior.
Install-time verification uses `doctor --quiet --integration=<manager>` and
warns without modifying manager files or failing an install. Runtime lookup
remains project-local; hook/GUI environments must provide `node` and any
manager runtime. See the
[coexistence guide](migration.md#keep-an-existing-hook-manager) for exact
snippets, supported config/wrapper versions, structural checks, path rules,
bypasses, and uninstall behavior.

ESLint and Prettier are also resolved directly from the project's
`node_modules`; a missing peer is reported with an install hint and never
delegated to an implicit `npx` fallback. The configured `testCommand` is user
owned and runs verbatim.

## Pre-commit flow

On the first eligible clean or informational human-readable pre-commit run in a
clone, a compact Commit Owl welcome becomes the final box and records a
versioned marker below Git's common directory. Warnings and errors take
priority without consuming it. Linked worktrees share the marker. JSON runs do
not display or consume it, and projects can opt out with
`showWelcomeOnFirstCommit: false`.

The pre-commit hook then inspects staged files.

- Git pathname lists are requested with NUL delimiters. Leading/trailing
  whitespace, tabs, newlines, and Unicode are preserved exactly when paths are
  passed to checks or fixers.
- If there are no relevant project files, the commit continues.
- If relevant files are staged, the hook runs configured checks.
- Code checks can report lint issues, formatting drift, missing tests, and optional staged-related test failures.
- Guard checks cover the branch and its upstream, commit shape and size, generated files, and likely staged secrets.
- In default advisory mode, issues are shown as warnings and the commit still continues.

Blocking commit behavior is only used when explicitly configured.

## Optional commit-message flow

When `precommitChecks.commitMessage.enabled` is `true`, `init` and `doctor`
also own the native commit-msg hook. Git supplies the pending message file as
`$1`; the generated hook quotes it and the Node entrypoint forwards its absolute
path as one argv value to project-local `node_modules/.bin/commitlint`.
Lefthook instead uses the explicit static `commit-msg --git-path` mode, which
selects `MERGE_MSG` only for a direct `git merge` invocation (identified by
Git's `GITHEAD_<object-id>` environment plus a regular `MERGE_HEAD`) and uses
`COMMIT_EDITMSG` for ordinary commits and a later `git commit` that completes a
pending merge. It resolves the selected file with `git rev-parse --git-path`
before invoking the same local commitlint command.

No commitlint package or ruleset is bundled. The consumer installs the CLI and
defines its own commitlint configuration. Findings and setup failures warn by
default; `commitMessage.blockOnFailure` is the explicit enforcement switch.
Successful runs are silent, and `git commit --no-verify` retains Git's normal
bypass behavior.

## Safe fix paths

`commitment-issues` separates safe fix paths from normal advisory checks.

| Command              | Safety rule                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `npm run fix:staged` | Fixes captured staged bytes and refuses partial or concurrent changes.                        |
| `npm run commit:fix` | Amends only the same clean, attached, unsigned commit after final state and local-ref checks. |

The fixers receive captured content through stdin instead of rewriting live
project paths. Before staging, the command rechecks `HEAD`, the exact index
file and tree, and target bytes, then places only known tool output into a
prepared index under Git's lock. Existing hardlinked targets are atomically
replaced at the repository path, so other links to the original inode keep
their original bytes. Two selected paths that already share an inode are
refused before tools run, because replacing one would change the other's link
count inside the transaction. Link count is part of the captured identity; a
link added or removed while tools run makes revalidation fail. `commit:fix`
also requires `HEAD` to remain on the same local branch, refuses commit
signature headers, and repeats repository, worktree, tag, and
remote-tracking-ref checks immediately before amending. If revalidation detects
that another process edited, deleted, replaced, linked, staged, committed,
attached a protected ref, or changed the active branch during the run, the
command refuses and leaves that work out of its mutation.

Publication proof is deliberately offline: local tags and remote-tracking refs
are authoritative inputs, but a ref that exists only on a remote cannot be
discovered without network access. The command does not contact remotes and
does not claim that a commit absent from the local ref snapshot was never
published elsewhere.

The tool prefers refusing a risky mutation over hiding or rewriting work unexpectedly.

## Pre-push flow

After `init`, push-time tests run in advisory mode by default.

The pre-push hook reads pushed refs, detects changed files, collects related
tests, and runs the configured test command. Native, Husky, and Lefthook wiring
read Git's stdin directly. The pre-commit framework consumes that stream first,
so the entrypoint reconstructs the same range only from a complete documented
`PRE_COMMIT_*` environment. A partial environment is ignored rather than
guessed. The default runner is `node --test`.

For an existing remote branch, its advertised SHA is the diff base. On the
first push of a new branch, the hook chooses the closest unambiguous merge base
from its upstream or remote-tracking branches, so files inherited from `main`
do not trigger a whole-repository test snapshot. If the history is orphaned,
unrelated, or no safe base can be identified, it conservatively diffs from the
repository's empty tree. That fallback may run more tests, but cannot omit a
test because base discovery failed.

Related-test lookup is package-aware. Colocated tests win first, followed by
paths mirrored below the nearest package's `test/` or `tests/` directory. A
nested package never falls through to the root package's basename-only test.
See [Monorepo & Workspaces Guide](monorepo.md#related-test-selection) for the
full deterministic lookup order.

| Result                     | Default advisory mode     | Blocking mode |
| -------------------------- | ------------------------- | ------------- |
| Tests pass                 | Push allowed              | Push allowed  |
| Tests fail                 | Push allowed with warning | Push blocked  |
| No related tests are found | Push allowed              | Push allowed  |

If `blockPushOnTestFailure` and `advisePushTests` are both set, blocking takes precedence.

Spawned tools return structured outcomes for success, normal nonzero exit,
external signal, timeout, and spawn failure. Missing built-in peer tools are a
separate outcome. Timeout cleanup terminates the attached process group on
Ubuntu/macOS and process tree on Windows; see the documented
[timeout cleanup boundary](configuration.md#timeout-cleanup-boundary).

## Configuration defaults

The default behavior is intentionally advisory-first:

```json
{
  "precommitChecks": {
    "advisePushTests": true,
    "blockPushOnTestFailure": false,
    "testCommand": ["node", "--test"]
  }
}
```

These keys may instead be top-level entries in `.commitmentrc.json`.
Standalone keys override matching `package.json` values.

See [Configuration and Behavior](configuration.md) for the full configuration reference.
