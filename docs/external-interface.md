# External Interface Reference

This page is the compatibility contract for public commands, generated scripts,
Git hook entrypoints, output modes, and exit behavior. Configuration keys,
types, defaults, and validation rules are maintained once in
[Configuration and behavior](configuration.md).

For installation and quick usage, see the [README](../README.md).

## CLI commands

The callable public compatibility surface includes these commands and version
flags:

- `init`
- `uninstall`
- `doctor`
- `precommit`
- `prepush`
- `panic`
- `commit-msg <message-file>` or `commit-msg --git-path` (normally invoked by
  Git or a hook manager)
- `commit-fix`
- `fix-staged`
- `fix-staged-js`
- `--version` and `-v`

Primary `--help` output is organized around the developer actions normally run
by hand. A separate group identifies the Git integration normally invoked
automatically:

- Setup: `init`, `doctor`, and `uninstall`
- Checks: `precommit`, `prepush`, and the read-only `panic` guide
- Fixes: `fix-staged` and `commit-fix`
- Integration: `commit-msg <message-file> | --git-path` (normally invoked
  automatically by Git or a hook manager)

`fix-staged-js [files...]` remains a callable public compatibility interface
for package wiring, but it is omitted from primary help so low-level mutation
plumbing does not compete with the safer `fix-staged` developer action.
Every documented command supports both `commitment-issues help <command>` and
`commitment-issues <command> --help`; these help paths exit 0 without invoking
the target command or inspecting or changing a repository.

Examples:

```bash
npx --no-install commitment-issues --help
npx --no-install commitment-issues help init
npx --no-install commitment-issues init
npx --no-install commitment-issues init --dry-run --integration=husky
npx --no-install commitment-issues uninstall --dry-run
npx --no-install commitment-issues doctor
npx --no-install commitment-issues doctor --integration=husky
npx --no-install commitment-issues precommit --json
npx --no-install commitment-issues prepush --json
npx --no-install commitment-issues panic
npx --no-install commitment-issues commit-msg .git/COMMIT_EDITMSG
npx --no-install commitment-issues commit-msg --git-path
npx --no-install commitment-issues --version
```

### Arguments and options

The public argument contract is deliberately small:

| Command                    | Accepted arguments                                                          |
| -------------------------- | --------------------------------------------------------------------------- |
| global                     | `--help`/`-h`, `--version`/`-v`                                             |
| `init`                     | optional `--dry-run`/`-n`; optional `--integration[=<manager>]`             |
| `uninstall`                | optional `--dry-run` or `-n`                                                |
| `doctor`                   | optional `--quiet`; optional `--integration[=<manager>]`                    |
| `precommit`                | optional `--json`                                                           |
| `prepush`                  | up to the remote name and URL supplied by Git, plus optional `--json`       |
| `panic`                    | no arguments                                                                |
| `commit-msg`               | one message-file path, or `--git-path` to resolve Git's active message file |
| `commit-fix`, `fix-staged` | no arguments                                                                |
| `fix-staged-js`            | zero or more explicit file paths                                            |

The global `--help`/`-h` output shows the installed package version. A command's
`--help` flag and the equivalent `help <command>` form take the safe help path
before command dispatch.

Unknown options and excess positional arguments exit nonzero. Setup, removal,
and doctor validate their arguments before changing project files or hooks, so
a misspelled `--dry-run` or `--quiet` cannot silently perform another action.
Supported integration values are exactly `husky`, `lefthook`, and
`pre-commit`. A value is required when automatic detection finds zero or more
than one owner. Repeating the integration option is an error.

Setup and hook-health commands expect the project root of a non-bare Git
working tree. Bare repositories do not run this package's local commit or push
workflow and are not reported as having active hooks.

Detached HEAD intentionally has no protected branch identity, so the
protected-branch guard does not fire in that state. File, secret, size,
generated-file, lint, format, and related-test checks continue normally.

`panic` is a local, deterministic, non-interactive inspection guide. It starts
with the current repository state and `git status`, then conditionally explains
read-only commands for the observed state. It can label a content-preserving
unstage command or a verified previous-branch switch as a reversible option,
but suppresses those options while a merge, rebase, or cherry-pick is active,
while conflicts remain, or when any required state probe is unavailable. It
never executes a displayed command. Examples never interpolate repository
paths, so shell-sensitive filenames cannot become command text. Commands that
discard files or force ref/history changes are outside this interface.

## Scripts added by `init`

`init` wires these common scripts in the consuming `package.json`:

- `doctor` verifies and repairs hook wiring.
- `fix:staged` runs staged-file fixes against an exact repository snapshot.
- `commit:fix` applies safe automatic fixes and amends the latest clean,
  unpushed commit only while that snapshot remains current.
- `test:precommit` runs pre-commit checks directly.

Both fix commands capture the initial `HEAD`, exact index-file identity and
bytes, complete index tree, target entry mode and blob, and regular-file
identity. ESLint and Prettier receive captured content through stdin with the
original path used only for configuration and parser selection; they never
receive a live target to rewrite. Complete attributable outputs are then
written with the crash-resistant project-file transaction and rechecked
byte-for-byte.

Immediately before staging, the commands verify the same `HEAD`, index, and
expected worktree bytes. Fixed content is hashed explicitly and a prepared
index containing only those blobs is installed while holding Git's cooperative
`index.lock`; `git add` never reads a concurrent worktree edit. `commit:fix`
additionally verifies that no tracked worktree change appeared and that the
original commit is still absent from remote-tracking branches both before
staging and immediately before `git commit --amend`.

A detected edit, deletion, path-type replacement, index update, `HEAD` move,
publication, lock conflict, or failed revalidation stops the command. It does
not stage ambiguous bytes or amend a different commit. Concurrent user state
remains available for review with `git status`.

## Setup removed by `uninstall`

`uninstall` removes only setup it can identify safely:

- exact generated package scripts;
- the `precommitChecks` configuration block;
- a valid `.commitmentrc.json` standalone configuration file; and
- exact generated pre-commit, pre-push, and optional commit-msg hook bodies.

Customized hooks and scripts are preserved and reported. Shared `.gitignore`
entries, ESLint/Prettier dependencies, the package dependency, and lockfiles
remain owned by the consuming project.

Hook-manager configuration is always project-owned. Even when an exact
coexistence entry is recognized, uninstall reports its manager/hook names for
manual cleanup and does not delete or edit `.husky/*`, Lefthook YAML,
`.pre-commit-config.yaml`, `.pre-commit-config.yml`, or lint-staged
configuration. For cleanup reporting only, it inventories exact current and
pre-dispatch manager entries wherever they appear in executable hook content;
their position does not make them healthy, and `init` and `doctor` still
require the dispatcher form first. It removes an exact
`doctor --quiet --integration=<manager>` prepare command or suffix because that
package script is generated package state.

Hook ownership checks do not follow symbolic links. A hook-file symlink,
dangling symlink, or symlink used as the hooks directory is preserved as
uninspectable; `init` and `doctor` report it instead of repairing through it.

Mutable project files follow the same repository boundary. Existing paths that
a command can modify must be regular files: `init` checks `package.json`,
`.gitignore`, and `.commitmentrc.json`, while `uninstall` checks `package.json`
and `.commitmentrc.json`. Both commands refuse symbolic links, directories, and
paths that cannot be inspected safely, including during `--dry-run`. Before a
write, the destination and its containing directory must be writable. The
complete replacement is written under a randomized, reserved name in that same
directory; short writes are completed, the original POSIX permission bits are
applied, and the staged file is size-checked, synced, closed, and matched back
to its opened identity. The destination identity is then revalidated at the
commit boundary. Existing files are replaced by same-filesystem rename so
concurrent readers see complete old or new bytes, while a missing destination
uses an atomic hard-link commit that refuses a concurrently inserted path.

An ordinary failure cleans up only the exact transaction file opened by that
invocation. A forced termination can leave the reserved stage behind; a later
write removes it only after its encoded process ID is no longer active and its
regular-file ownership is verified. The retry never treats that stage as a
project file. Standalone-config removal continues to recheck the inspected
destination identity immediately before deletion.

## Git hook interface

`init` writes plain native hooks that call only the project-local binary:

- pre-commit → `node_modules/.bin/commitment-issues precommit`
- pre-push → `node_modules/.bin/commitment-issues prepush "$@"`
- commit-msg, when enabled →
  `node_modules/.bin/commitment-issues commit-msg "$1"`

The hooks honor `COMMITMENT_ISSUES=0` and the pre-3.0 `HUSKY=0` compatibility
skip. When the local binary is no longer installed, they print one bounded
skip notice to stderr and exit 0. The pre-push hook forwards Git's remote name
and URL for remote-specific first-push base selection. Package source is not
copied into the consumer repository.

### Hook-manager coexistence interface

`init --integration=<manager>` emits deterministic snippets only for inactive
or missing entries and never writes manager files; fully wired entries are not
reprinted. `doctor --integration=<manager>` follows the same missing-only
remediation rule and recognizes only active exact entries in the manager's real
hook section plus executable manager dispatchers in Git's effective hooks
directory. Comments, printed examples, nested example blocks, duplicate
Lefthook hook/command keys, duplicate pre-commit IDs, partial entries, wrong
stages, pre-commit `args`, a missing fixed Lefthook `files:` producer or
`use_stdin: true`, dynamic command templates, wrappers that omit `"$@"`,
pre-commit wrappers without an executable dispatch, duplicate candidate config
files, and linked, non-regular, or non-executable paths are not healthy.
Selecting a manager explicitly resolves owner ambiguity only; it never
overrides an unsafe, duplicate, or unsupported selected configuration.
An older direct call is reported for replacement. When a guarded current entry
and an older direct call coexist, doctor asks for removal of only the older
duplicate and does not print another snippet. Repeated current entries likewise
require removal until one exact entry remains. A Commitment Issues call under
the wrong hook stage is reported for relocation to its matching stage; older
direct calls also need the `hook` subcommand inserted during that move.

The inspectable configuration and dispatcher set is deliberately bounded:

- Lefthook accepts exactly one of `lefthook.yml`, `lefthook.yaml`,
  `.lefthook.yml`, `.lefthook.yaml`, `.config/lefthook.yml`, or
  `.config/lefthook.yaml`. JSON, JSONC, TOML, local configs,
  `extends`/`remotes`, advanced YAML constructs, all top-level global options,
  and a non-empty `LEFTHOOK_CONFIG` override require manual review. The
  installed dispatcher must match the canonical Lefthook 2.1.10 wrapper or the
  narrow documented direct form, and every selected runtime candidate must
  have a reviewed Lefthook executable identity.
- pre-commit accepts exactly one `.pre-commit-config.yaml` or
  `.pre-commit-config.yml`. Each Commitment Issues local hook must match the
  generated snippet exactly, `always_run` must be `true`, and `args` is
  rejected; every unrelated local/meta/remote hook and supported top-level
  option is schema-checked before health is reported. That check uses the
  pre-commit 3.2 language set, the minimum `identify` 1.0 type-tag set, and
  PyYAML SafeLoader-compatible implicit scalar typing. The installed dispatcher
  must match the supported pre-commit 3.2+ canonical template
  and be bound to the selected config and hook type. Its primary executable
  must exist, be executable, and have a reviewed Python identity; when it is
  absent or non-executable, the literal `pre-commit` PATH fallback must resolve
  instead. Remediation for the `.yml` destination includes
  `--config .pre-commit-config.yml`.
- Husky validates an exact guarded command as the first substantive user
  command (after the exact v8 runtime source only for direct `.husky` v8
  hooks), an active exact `.husky`/`.husky/_` hook path, and a Husky
  8.0.1–8.0.3 or 9.0.2–9.1.7 dispatcher/runtime shape. Husky 8.0.0/9.0.1 and
  customized, partial, or newer templates require manual review.

Conditions, ordering, and skip behavior on unrelated manager entries remain
project-owned. The selected Commitment Issues hook and command must be
unconditional so a configuration cannot be reported healthy while silently
skipping the CI entry. The static project-local command still requires `node`
in a restricted hook or GUI `PATH`; Lefthook and pre-commit must additionally
resolve their reviewed manager runtimes, while Husky uses its inspected
repository-local dispatcher.

lint-staged remains composition evidence rather than a hook owner. Detection
covers its package/dependency keys, the supported `.lintstagedrc*` and
`lint-staged.config.*` names, and a top-level `lint-staged` key in
`package.yaml` or `package.yml`; the configuration is never executed or
interpreted.

`core.hooksPath` is byte-preserving and presence-aware: an empty configured
value is not treated as unset, and whitespace or POSIX backslashes are never
trimmed or rewritten into a recognized Husky path. Windows backslashes retain
their Git-native separator meaning.

The manager entrypoints preserve these inputs:

| Manager    | pre-push input                                       | commit-msg input                                            |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| Husky      | quoted `"$@"`                                        | quoted `"$1"`                                               |
| Lefthook   | ref stream through `use_stdin: true`                 | static `--git-path` resolution of Git's active message file |
| pre-commit | complete documented `PRE_COMMIT_*` range environment | filename supplied by the framework                          |

Manager-native skip and bypass behavior stays authoritative. The entry scripts
use the package's hidden `hook` dispatcher so `COMMITMENT_ISSUES=0` and legacy
`HUSKY=0` apply to automatic manager calls without suppressing an explicit
human invocation of `precommit`, `prepush`, or `commit-msg`. Advisory outcomes
exit 0; configured blocking outcomes retain their normal nonzero status.
Every emitted manager entry examines only the ordered project-local launcher
candidates `node_modules/.bin/commitment-issues`, `.exe`, `.cmd`, and `.bat`,
then invokes the same first regular executable path it inspected. If no
candidate is usable, the entry exits successfully and silently; it never
consults `PATH`, a global install, `npx`, or the network. Husky preserves the
selected launcher's nonzero result before later custom commands. Lefthook keeps
its fixed file-sentinel assignment attached to the selected invocation, and
pre-commit's fixed `sh -c` entry forwards framework filenames as literal
`"$@"` argv.

The first eligible clean or informational human-readable pre-commit invocation
shows a default-on contributor welcome, then records
`<git-common-dir>/commitment-issues/welcome-v1`. A warning or error takes
priority without consuming the welcome. The versioned marker is clone-local,
outside the working tree, and shared by linked worktrees.
`showWelcomeOnFirstCommit: false` disables both display and marker creation.
JSON mode and Git's standard hook bypasses do not consume it, and all marker
failures fail open.

Staged and pushed-file test commands inherit the developer's ordinary
environment, but Git's repository-local routing variables are removed first.
The command still discovers the current checkout from its working directory;
nested Git fixtures therefore cannot be redirected into the hook caller by an
inherited `GIT_DIR`, work tree, or index path.

## Configuration interface

Configuration is dependency-free JSON read from `.commitmentrc.json` and the
`precommitChecks` object in `package.json`. Standalone keys take precedence over
matching package keys; unmatched package values and built-in defaults remain
active. No JavaScript configuration file is discovered or executed.

The versioned configuration interface includes source precedence, allowlisted
keys, types, defaults, validation and fallback behavior, the test-command trust
boundary, and optional commitlint behavior. Adding or changing a key requires
updating the [configuration reference](configuration.md), runtime allowlist,
and tests together.

`scanDebugArtifacts` is an explicit opt-in for the local added-line advisory;
`debugArtifactExempt` is its allowlisted repository-path exemption list. The
check publishes the stable `debug-artifacts` check ID, a
`debug-artifacts.detected`/`debug-artifacts.unavailable` subtype in the check's
extensible JSON details, and per-rule identifiers. It accepts no user regular
expressions or shell commands and does not extend the strict top-level JSON v1
finding shape.

## Output interface

Human commands render at most one outcome box per invocation. The one-time
pre-commit onboarding box replaces an otherwise clean or informational result;
warnings and errors take priority and defer onboarding.
`precommit`, `prepush`, and `commit-msg` default to
`hookOutput: "problems-only"`, which suppresses final success and informational
boxes while retaining warnings and errors. `hookOutput: "normal"` restores
success and informational states without changing execution or exit behavior.
The once-per-clone welcome is intentionally independent of `hookOutput`; its
dedicated configuration opt-out is `showWelcomeOnFirstCommit: false`.

Operational commands (`init`, `uninstall`, `doctor`, `panic`, and explicit fix
commands) are outside the hook-output policy. Mixed findings use the strongest
final severity. A normal `panic` run emits exactly one box; help and argument
errors take the CLI's normal single text response path before repository
inspection.

Product-owned human output treats repository, Git, configuration, process, and
argument values as untrusted terminal text. Embedded carriage returns,
newlines, and tabs are shown as `\\r`, `\\n`, and `\\t`; other C0/C1 controls
use `\\xNN`, and ANSI CSI/OSC sequences are removed. Intentional layout still
comes from separate message-model lines, so normal Unicode, spaces, and
punctuation remain unchanged. Product-owned bold, dim, and severity styling is
applied only around already escaped values, so normal colored output remains
unchanged. Raw output from explicitly run project tools is relayed as that tool
produced it and stays outside the product-owned message model.

The public
[message-state gallery](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/message-states.md)
shows concrete human output. It is repository evidence rather than installed
package documentation.

`precommit --json` and `prepush --json` replace terminal boxes on stdout with a
single versioned payload. Field semantics, stderr behavior, and examples are in
[JSON output](json-output.md) and its
[versioned schema](json-output.schema.json). Other commands do not support
`--json`. JSON strings retain their exact semantic values and rely on standard
JSON escaping rather than the visible human-output notation above.

## Exit behavior

- Commit and push checks are advisory by default.
- Debug-artifact findings and inspection failures are always advisory; there is
  no blocking configuration for this check.
- Protected-branch, secret, push-test, and commit-message blocking require the
  corresponding explicit configuration.
- With `blockOnSecrets: true`, a detected secret and an unavailable staged-patch
  inspection both block. Git launch failures, nonzero results, and malformed
  patches have a distinct unavailable-scan terminal/JSON result; advisory mode
  warns and continues.
- Fix commands return nonzero when safety checks fail or manual work remains.
- `panic` exits 0 after a complete working-tree inspection and exits nonzero
  outside a working tree, when Git state is unavailable, or for invalid
  arguments. Its exit status never reflects a performed recovery operation,
  because it performs none.
- JSON mode reports the same exit code in `exitCode`; it does not change whether
  a result blocks.
- Missing built-in peer tools are advisory in hooks and never invoke an implicit
  `npx` fallback; an explicit fix request fails when its required tool is absent.
- Configured test executables and options remain argument arrays, including an
  explicitly selected `npx` executable. Discovered paths are appended as data;
  Node `--test` paths are placed after `--`, and leading-hyphen paths are made
  absolute to prevent option interpretation.
