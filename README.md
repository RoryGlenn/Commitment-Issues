<p align="center">
  <img src="https://raw.githubusercontent.com/RoryGlenn/commitment-issues/main/assets/commitment-issues.png" alt="commitment-issues — for developers who overthink every commit" width="100%" />
</p>

# Commitment Issues

[![npm version](https://img.shields.io/npm/v/commitment-issues.svg)](https://www.npmjs.com/package/commitment-issues)
[![npm weekly downloads](https://img.shields.io/npm/dw/commitment-issues.svg)](https://www.npmjs.com/package/commitment-issues)
[![CI](https://github.com/RoryGlenn/commitment-issues/actions/workflows/ci.yml/badge.svg)](https://github.com/RoryGlenn/commitment-issues/actions/workflows/ci.yml)
[![Branch coverage: 100.0%](https://img.shields.io/badge/branch%20coverage-100.0%25-brightgreen.svg)](docs/branch-coverage.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Local Git hooks for developers who overthink every commit.**

**Catch mistakes while they're still cheap to fix.**

Commit normally. When a fixable problem appears, Commitment Issues gives you an
immediate suggestion and the exact safe command to fix it before the first
push. CI stays authoritative.

## One small mistake. Two very different outcomes.

<p align="center">
  <img src="https://raw.githubusercontent.com/RoryGlenn/commitment-issues/main/assets/before-after.svg" alt="Without Commitment Issues: send work, wait, find a mistake, and do it again. With Commitment Issues: spot and fix the mistake first, then send once." width="900" />
</p>

**Without:** commit → push → wait → CI fails → read logs → fix → commit again →
push → wait again.

**With:** commit → immediate suggestion → run the exact fix command → push
once.

[Why earlier feedback matters](docs/why-before-ci.md).

### Watch the shorter path in 26 seconds

<p align="center">
  <img src="https://raw.githubusercontent.com/RoryGlenn/commitment-issues/main/assets/demo.gif" alt="commitment-issues setup followed by a non-blocking commit warning, a safe automatic amend, and passing related push-time tests" width="800" />
</p>

Checks start advisory. Fixes run only when requested and when the repository
state proves the operation safe. Teams can opt into individual blocking gates
after they trust the signal.

No telemetry · npm, pnpm 10, Yarn Classic 1.22.22, Yarn Berry 4.17.0, and Bun 1.3.14 · Node.js >=22.11.0

[Quickstart](#quickstart) · [Why it is different](#why-it-is-different) ·
[Configuration](docs/configuration.md) · [Migration](docs/migration.md) ·
[FAQ](docs/faq.md)

<details>
<summary>See the main safety states</summary>

### Pre-commit suggestions

<p>
  <img src="assets/precommit-suggestions-warning.svg" alt="Pre-commit warning output showing formatting suggestions and the commit fix command" width="479">
</p>

### Safety refusal

<p>
  <img src="assets/partially-staged-error.svg" alt="Error output showing that partially staged files cannot be fixed safely" width="568">
</p>

### Safe automatic amend

<p>
  <img src="assets/commit-fix-success.svg" alt="Success output showing the latest commit amended with automatic fixes" width="590">
</p>

### Advisory push failure

<p>
  <img src="assets/advisory-push-failure.svg" alt="Warning output showing failing push-time tests in advisory mode" width="713">
</p>

The repository keeps an exhaustive, mechanically checked
[message-state gallery](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/message-states.md).

</details>

## Why before CI?

CI remains the authoritative shared gate. Local checks catch problems while the
developer still has the relevant code in mind, avoiding a queue wait, context
switch, log investigation, correction push, and second CI run for issues that
could have been identified immediately.

[See the feedback-latency and measurement model](docs/why-before-ci.md).

## Quickstart

You need Git, Node.js >=22.11.0, ESLint 9 with a flat config, and Prettier 3.

```bash
npm install -D commitment-issues eslint@^9 prettier@^3
npx --no-install commitment-issues init --dry-run
npx --no-install commitment-issues init
```

Want to see the advisory workflow without touching an existing project? Follow
the [five-minute disposable-repository tutorial](docs/try-it-safely.md).

Already using Husky, Lefthook, or the Python `pre-commit` framework? Keep it:

```bash
npx --no-install commitment-issues init --dry-run --integration=husky
npx --no-install commitment-issues init --integration=husky
npx --no-install commitment-issues doctor --integration=husky
```

Replace `husky` with `lefthook` or `pre-commit`. This mode prints exact
project-local snippets and verifies the manager config plus its installed
dispatcher without editing manager-owned files. Bare `--integration` works
only when one owner is evident; ambiguous or unsupported layouts require
manual review. See the
[coexistence contracts](docs/migration.md#keep-an-existing-hook-manager).

Then commit and push normally:

```bash
git add -A
git commit -m "your message"
git push
```

### Think you made a Git mistake?

Run the read-only recovery guide from inside the project:

```bash
npx --no-install commitment-issues panic
```

It starts with the repository's current state and `git status`, then explains
only the inspection steps relevant to what Git reports. When Git can prove a
content-preserving option is applicable, it may also show how to unstage work
or return to the previously checked-out branch. The guide never runs a
recovery operation, never guesses at missing state, and never includes commands
that discard files or force history changes.

When the tool reports a safe fix path:

```bash
npm run fix:staged   # fix the current staged files before committing
npm run commit:fix   # fix and amend a safe, attached latest commit
```

Hooks resolve ESLint and Prettier only from the project's installed
`node_modules`. A missing tool stays advisory and prints the detected package
manager's install command; the hook does not ask `npx` to download it.

## Why it is different

- **Advisory adoption:** warnings first; enforcement is per-check opt-in.
- **Safe explicit fixes:** ambiguous partial staging, dirty tracked worktrees,
  detached or signed commits, and history retained by a local tag or known
  remote-tracking ref are refused. Hardlinked targets are replaced only at the
  repository path, preserving every other alias to the original inode.
- **Related push tests:** runs tests associated with the files being pushed.
- **Debug-junk advisory:** optionally catches common temporary instrumentation
  only on newly staged lines.
- **Native by default, composable by choice:** use owned native hooks or keep
  Husky, Lefthook, or pre-commit through read-only coexistence mode.
- **Self-repair:** `doctor` restores missing generated hooks after install or
  clone without overwriting custom hooks.
- **Local and reversible:** no account or telemetry; preview setup and removal
  with `--dry-run`.

## What it catches

| Check                                    | Default                             | Optional enforcement           |
| ---------------------------------------- | ----------------------------------- | ------------------------------ |
| Lint and formatting drift                | Reports findings and safe fix paths | Fix commands remain explicit   |
| Missing nearby tests                     | Warns with path exemptions          | —                              |
| Related staged tests                     | Off until enabled                   | —                              |
| Related pushed-file tests                | Advisory after `init`               | `blockPushOnTestFailure`       |
| Protected branches                       | Warns on direct commit/push         | `blockProtectedBranches`       |
| Likely staged secrets and dotenv files   | Warns with file/line detail         | `blockOnSecrets`               |
| Temporary staged debug artifacts         | Off until explicitly enabled        | Advisory only                  |
| Branch behind upstream                   | Suggests pulling or rebasing        | —                              |
| Oversized commits, large/generated files | Suggests a safer next step          | —                              |
| Commit messages through commitlint       | Off until enabled, then advisory    | `commitMessage.blockOnFailure` |
| Broken generated hook wiring             | `doctor` reports and repairs        | —                              |

See [Configuration and behavior](docs/configuration.md) for matching rules,
validation, exemptions, and every option.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/project-flowchart-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="assets/project-flowchart-light.svg">
  <img alt="commitment-issues project flowchart showing setup, Git hook wiring, code and guard checks before commit, safe fix paths, and pre-push tests" src="assets/project-flowchart-light.svg">
</picture>

By default, `init` writes native `.git/hooks/pre-commit` and
`.git/hooks/pre-push` files.
When commit-message linting is enabled, it also owns `.git/hooks/commit-msg`.
The hooks invoke the installed binary; package source is not copied into the
repository. Existing custom hooks and foreign `core.hooksPath` values are
preserved and reported for manual composition.

With `--integration=<manager>`, it writes no native or manager-owned hook
files. It prints project-local snippets and configures install-time doctor to
verify the selected manager while preserving its unrelated behavior.

[Read the complete lifecycle and safety model](docs/how-it-works.md).

## Does it fit your project?

| Requirement or boundary | Support                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Primary ecosystem       | JavaScript and TypeScript                                                                                   |
| Runtime                 | Node.js >=22.11.0                                                                                           |
| Linting and formatting  | ESLint 9 or 10 flat config and Prettier 3                                                                   |
| Package managers        | Local npm, pnpm 10, Yarn Classic 1.22.22, Yarn Berry 4.17.0 with `nodeLinker: node-modules`, and Bun 1.3.14 |
| Yarn Plug'n'Play        | Unsupported because the hooks require the project-local `node_modules/.bin` tree                            |
| Monorepos               | Root-owned workspaces and linked Git worktrees                                                              |
| Existing hooks          | Preserved; explicit Husky, Lefthook, and pre-commit coexistence is verified read-only                       |
| Commit messages         | Optional project-local commitlint and rules                                                                 |
| CI                      | Keep CI authoritative; hooks may be skipped with `COMMITMENT_ISSUES=0`                                      |

Setup details: [compatibility](docs/compatibility.md) ·
[frameworks](docs/framework-recipes.md) ·
[monorepos](docs/monorepo.md) · [Yarn Berry](docs/yarn-berry.md) ·
[CI providers](docs/ci-recipes.md)

## How it compares

| Capability               | commitment-issues     | Husky + lint-staged                    | Lefthook / pre-commit          |
| ------------------------ | --------------------- | -------------------------------------- | ------------------------------ |
| Default posture          | Advisory              | Script-defined                         | Commands normally control exit |
| Hook manager             | Native hooks          | Husky                                  | Separate runtime/binary        |
| Staged fixes             | Built in and explicit | lint-staged tasks                      | Command-dependent              |
| Partially staged files   | Refuses the fix       | Temporarily hides/reapplies by default | Command-dependent              |
| Related push tests       | Built in              | Custom wiring                          | Custom wiring                  |
| Safe latest-commit amend | Built in              | Custom wiring                          | Custom wiring                  |
| Hook repair              | `doctor`              | Reinstall/custom repair                | Reinstall                      |
| Primary audience         | JS/TS guardrails      | JS/TS task runner                      | General hook orchestration     |

Already using another system? Follow the [migration guide](docs/migration.md).

## From advisory to enforced

| Action            | Default after `init`                                                                                                 | Stricter option                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `git commit`      | Reports lint, formatting, missing-test, secret, branch, and commit-shape findings; debug-artifact scanning is opt-in | Enable the relevant secret or branch blocker |
| `git push`        | Runs related pushed-file tests in advisory mode                                                                      | Enable `blockPushOnTestFailure`              |
| Commit message    | Off until enabled, then advisory                                                                                     | Enable `commitMessage.blockOnFailure`        |
| Automatic changes | Only explicit fix commands                                                                                           | No implicit mutation mode                    |

When `blockPushOnTestFailure` and `advisePushTests` are both set, blocking takes
precedence. Roll out one enforcement choice at a time after the team has
observed its false-positive and failure behavior.

## Privacy and trust

- Commit/push checks do not mutate tracked files.
- Fix commands stop when Git cannot prove the operation safe.
- Configuration is validated JSON; project JavaScript is not imported.
- Built-in tools use local executables and argument arrays without shell
  interpolation.
- Test commands inherit the normal developer environment but not Git's
  hook-local repository routing, so nested Git fixtures resolve from their own
  working directory.
- The package adds no telemetry, repository upload, account, or hosted service.
- A configured `testCommand` remains repository-owned executable code and may
  have behavior of its own.

See the [security policy](https://github.com/RoryGlenn/commitment-issues/blob/main/.github/SECURITY.md),
[assurance case](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/security/assurance-case.md),
and [release verification](docs/release-verification.md).

## Removal

```bash
npx --no-install commitment-issues uninstall --dry-run
npx --no-install commitment-issues uninstall
npm remove commitment-issues
```

Removal deletes only exact generated setup. Customized scripts/hooks and shared
dependencies, ignores, and lockfiles are preserved.
Husky, Lefthook, and pre-commit files are always user-owned; uninstall reports
matching entries for manual removal and leaves their bytes unchanged.

## Documentation

- [Configuration and behavior](docs/configuration.md)
- [Compatibility and installation support](docs/compatibility.md)
- [FAQ and troubleshooting](docs/faq.md)
- [Git terms in plain language](docs/faq.md#git-terms-used-in-this-project)
- [Migration guide](docs/migration.md)
- [External interface](docs/external-interface.md)
- [JSON output](docs/json-output.md)
- [Complete repository documentation index](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/index.md)

Maintainer direction and contribution policy live in the
[roadmap](https://github.com/RoryGlenn/commitment-issues/blob/main/ROADMAP.md),
[governance](https://github.com/RoryGlenn/commitment-issues/blob/main/GOVERNANCE.md),
and the
[contribution guide](https://github.com/RoryGlenn/commitment-issues/blob/main/.github/CONTRIBUTING.md).

## Project status and support

- **Status:** actively maintained.
- **Questions and bugs:** [GitHub Issues](https://github.com/RoryGlenn/commitment-issues/issues)
- **License:** MIT — see [LICENSE](LICENSE).
