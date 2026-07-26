# Migration Guide

This guide covers upgrading from `commitment-issues` 2.x and choosing between
migration from, or coexistence with, Husky, Lefthook, and the Python
`pre-commit` framework.

The short version: install `commitment-issues`, remove the old hook wiring, and run `npx --no-install commitment-issues init` in the repository root. The `init` command writes plain `.git/hooks` files, adds helper scripts and advisory push-test wiring, and migrates husky-era leftovers — without discarding unrelated project settings.

## Before you migrate

- Commit or stash any work you do not want to mix with the migration.
- Keep a copy of your current hook config so you can compare before and after.
- Make sure your repo already has a valid `package.json` and a Node version that satisfies `commitment-issues`.

## Keep an existing hook manager

Migration transfers ownership to generated `.git/hooks`; coexistence keeps the
current manager as sole owner and adds Commitment Issues as its command.

Preview and apply package-owned setup with an explicit owner:

```bash
npx --no-install commitment-issues init --dry-run --integration=husky
npx --no-install commitment-issues init --integration=husky
npx --no-install commitment-issues doctor --integration=husky
```

Use `lefthook` or `pre-commit` as appropriate. Bare `--integration` requires
exactly one evident owner; otherwise select explicitly. Selection never
overrides duplicate, unsupported, linked, non-regular, or unreadable selected
config: init stops before writes.

Init may update Commitment Issues' package scripts/config, ignore defaults,
and exact `prepare` suffix. It never writes native/manager hooks, changes
`core.hooksPath`, or runs the manager installer. Dry-run writes nothing;
re-running is idempotent. Use the normal local runner for your
[package manager](compatibility.md#package-managers).

Snippets use static `node_modules/.bin/commitment-issues`, so checkout spelling
is never shell-interpolated and no global package fallback exists. Yarn Berry
requires `nodeLinker: node-modules`; Plug'n'Play is unsupported. Hook/GUI
`PATH` must provide `node`; Lefthook/pre-commit also need their reviewed
runtime, while Husky uses its inspected local dispatcher.

### Husky contract

Generate each guarded line rather than hand-writing a platform-specific
launcher:

```sh
npx --no-install commitment-issues init --dry-run --integration=husky
```

Put it before unrelated substantive commands; only an exact Husky v8
`_/husky.sh` source may precede it. The line selects the first regular,
executable project-local extensionless/`.exe`/`.cmd`/`.bat` launcher, succeeds
when none is usable, and never consults `PATH`. Quoted Git arguments and `||
exit $?` preserve argv and blocking status; `--no-verify`, `HUSKY=0`, and
`COMMITMENT_ISSUES=0` remain bypasses.

Doctor also requires the active `.husky`/`.husky/_` hook path and exact Husky
8.0.1–8.0.3 or 9.0.2–9.1.7 wrapper/runtime. A direct v8 hook needs the runtime
only when it sources it. Husky 8.0.0/9.0.1 and customized, partial, linked, or
newer shapes remain user-owned and require manual review.

### Lefthook contract

Read-only inspection supports exactly one of these main YAML files:

- `lefthook.yml`
- `lefthook.yaml`
- `.lefthook.yml`
- `.lefthook.yaml`
- `.config/lefthook.yml`
- `.config/lefthook.yaml`

JSON/JSONC/TOML, `*-local`, multiple candidates, `extends`/`remotes`, advanced
YAML, global options, or `LEFTHOOK_CONFIG` require manual review. Merge the
printed command into its existing top-level hook/`commands` map without
duplicating either key:

Print the exact static YAML entries for the enabled hooks, then merge only
those blocks:

```sh
npx --no-install commitment-issues init --dry-run --integration=lefthook
```

The static `files` producer/`{files}` assignment supplies an installed sentinel
so empty commits/pushes still run policy; other producers/placeholders require
review. `use_stdin: true` forwards push refs. Commit-msg's `--git-path`
resolves the worktree message (`MERGE_MSG` for direct automatic merges,
otherwise `COMMIT_EDITMSG`). If another command needs pre-push stdin, use one
project wrapper to read and fan it out. Installed pre-push/commit-msg wrappers
must forward `"$@"`. Existing ordering, parallelism, skips, aggregation, and
advisory/blocking exits remain Lefthook's.

Unrelated conditions stay untouched, but the Commitment Issues hook/command
must be unconditional. Doctor separately checks the canonical Lefthook 2.1.10
wrapper or a direct `#!/bin/sh` plus one optional-`exec`/`command`
`[node_modules/.bin/]lefthook run <hook>` line; pre-push/commit-msg end in
`"$@"`. It schema-checks every hook and nested setup/command/script/job/group,
so malformed siblings are uninspectable. Runtime resolution honors literal
PATH order and execute access; packaged `test -f` candidates exclude
non-files. Verification requires a reviewed executable identity but never runs
repository-controlled code.

### pre-commit framework contract

Use pre-commit 3.2 or newer so `stages` names match Git hook names. Merge these
entries into a `repo: local` hook list in either `.pre-commit-config.yaml` or
`.pre-commit-config.yml`; keep every other repo and hook:

Print the exact guarded local entries, then merge them beneath the existing
`repo: local` hook list:

```sh
npx --no-install commitment-issues init --dry-run --integration=pre-commit
```

The fixed `sh -c` entry applies the same ordered local-launcher selection and
uses `exec "$commitment_issues_bin" ... "$@"`, so framework-supplied message
filenames remain literal argv and the selected launcher's status propagates.

The framework supplies commit-msg's filename normally. For pre-push it consumes
Git stdin and publishes the same range through `PRE_COMMIT_FROM_REF`,
`PRE_COMMIT_TO_REF`, branch, remote-name, and remote-URL variables; the
Commitment Issues entrypoint understands that documented environment. The
framework's `SKIP=<hook-id>` and Git's `--no-verify` continue to work.

Each Commitment Issues ID must occur exactly once. The `entry`, `language`,
`pass_filenames`, `always_run`, and `stages` fields must each match the snippet
exactly; an `args` field is rejected because it can change the validated argv.
Other hooks keep their own conditions, but these entries must stay
unconditional with `always_run: true`. Doctor conservatively recognizes the
supported pre-commit 3.2+ generated dispatcher; customized or newer wrapper
templates are preserved for manual review. When the selected file is the
`.yml` form, the wrapper remediation includes its destination explicitly:

```bash
pre-commit install --config .pre-commit-config.yml --hook-type pre-commit --hook-type pre-push
```

Add `--hook-type commit-msg` when commit-message linting is enabled.

Before reporting health, inspection validates root options and every
local/meta/remote hook against audited keys, stages, regexes, the shared
pre-commit 3.2+ language set, and minimum `identify` 1.0 tags.
`default_language_version` excludes renamed `system`/`script` aliases; YAML
scalars use PyYAML SafeLoader 1.1 typing, and
`minimum_pre_commit_version` cannot exceed 3.2. Version-specific languages,
newer tags, advanced regexes, higher requirements, and unknown fields require
manual review.

The canonical dispatcher parser supports an empty, missing, or non-executable
primary (which selects PATH) and a slash-qualified executable with a reviewed
Python identity, including free-threaded `python3.Nt` names. PATH is evaluated
literally—empty components mean the repository directory and quotes are not
stripped—and linked executable identities are checked at their resolved
target. The static verifier does not execute `pre-commit` or Python to infer
behavior.

### lint-staged composition

lint-staged is a staged-file task runner, not a Git-hook owner. Keep its current
Husky or Lefthook pre-commit command and add Commitment Issues as a separate
command. Coexistence detection reports lint-staged but never reads, merges,
reorders, executes, interprets, or deletes its configuration. Detection covers
the `lint-staged` package/dependency keys, `.lintstagedrc` and its supported
JSON/YAML/JS/MJS/CJS/TS/MTS/CTS names, `lint-staged.config.*` for
JS/MJS/CJS/TS/MTS/CTS, and a top-level `lint-staged` key in `package.yaml` or
`package.yml`. This avoids changing its stash, concurrency, task-order, and
failure semantics.

`doctor --integration=<manager>` is verification-only: it checks the exact
configuration entry and the executable manager wrapper in Git's effective
hooks directory. Interactive mode exits nonzero with exact missing snippets or
the manager install command (`lefthook install` or `pre-commit install` with
each enabled hook type), while `--quiet` warns and exits zero so a package
install cannot fail. `uninstall` removes only the exact package-owned repair
suffix and other generated package state. Manager entries and wrappers are
user-owned and therefore never claimed or deleted; uninstall names recognized
entries for manual cleanup.

## Upgrading from `commitment-issues` 2.x

Version 3.0 dropped the husky and lint-staged dependencies: hooks are now plain `.git/hooks` files and staged fixes run ESLint/Prettier directly. The upgrade is automated:

1. Update the package (husky and lint-staged are no longer peer dependencies):

   ```bash
   npm install -D commitment-issues@latest
   npm remove husky lint-staged   # unless you use them yourself
   ```

2. Run the initializer once:

   ```bash
   npx --no-install commitment-issues init
   ```

   This retires the husky-era `core.hooksPath`, removes the `.husky` files this tool generated (never your own), and writes the native `.git/hooks` wiring. The next `npm install` self-heals automatically through the generated or composed `prepare` script, so teammates only need to reinstall.

3. Commit the changes (`.husky/` removal) and try a normal commit / push.

Notes:

- **Custom `.husky` hooks** (e.g. `commit-msg`) no longer run once the husky wiring is retired. `init` and `doctor` list them; move the logic into `.git/hooks` or use the [explicit Husky coexistence contract](#husky-contract). If that hook ran commitlint, you can instead enable `precommitChecks.commitMessage` after keeping your project-local commitlint dependency and config.
- **Custom `lint-staged` configs** are left untouched — `fix:staged` no longer reads them. Keep running lint-staged yourself if you rely on custom tasks.
- **CI recipes**: `COMMITMENT_ISSUES=0` is the new hook-skip variable; the old `HUSKY=0` is still honored.

## Verified package upgrades

The cross-version lifecycle starts from exact immutable release artifacts, not
from a moving npm dist-tag:

| Starting release | Verified boundary                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2.5.1           | Last 2.x release: Husky `core.hooksPath`, exact generated `.husky` hooks, historical scripts/configuration, and the old peer-tool set migrate to native hooks. |
| v3.2.0           | Previous minor: exact older native hooks, including the pre-push body that did not forward Git's remote arguments, are refreshed.                              |
| v3.3.2           | Latest published baseline: exact PATH-fallback pre-commit, pre-push, and commit-msg bodies are refreshed to project-local-bin wiring.                          |

Each fixture is pinned by SHA-256 to an immutable GitHub Release asset; the
[release audit](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/audits/release-packaging-and-upgrades.md#pinned-upgrade-fixtures)
records the exact digests. The required pull-request lane exercises every
fixture with npm on Ubuntu and Node 24. The release workflow repeats the npm
migration with the exact candidate tarball in a read-only build job, then
hash-checks the artifact before the separate OIDC-enabled job publishes it.
Weekly health extends the same migration to pnpm, Yarn Classic, and Bun.

These are forward-upgrade guarantees. The lifecycle proves that exact generated
hooks and scripts are refreshed or removed only when ownership is established,
project-owned `prepare` logic is retained, custom hooks remain byte-for-byte
unchanged, and the migrated hooks run during a real commit and push. Other
historical starting versions are not a separate compatibility claim.

Run the new version's `init` explicitly after changing dependencies. Package
installation or peer removal does not guarantee that the consuming project's
root `prepare` runs during that same command. Once `init` has added or composed
the repair command, later normal installs can self-heal clone-local hooks. A
production install that omits the development package, or an accidental
package-first removal, leaves that guard silent and successful; it never falls
through to `npx`, a global binary, or the network. Reinstall the package before
running `uninstall` when the generated setup also needs removal.

## Downgrades and manual rollback

In-place downgrades are unsupported. An older release cannot safely reverse
newer native wiring into Husky, recognize every newer generated body, or infer
which newer configuration belongs to the project. It therefore must not rewrite
unknown state as an automatic reverse migration.

If you must return to an older release:

1. Commit or back up custom hook and configuration changes.
2. While the current version is still installed, run
   `npx --no-install commitment-issues uninstall`. This removes only state the
   current version can prove it owns and restores a composed project-owned
   `prepare` command.
3. Restore a package manifest and lockfile that pin the target version and its
   peer tools. Do not substitute a moving tag or an unbounded dependency range.
   Returning to 2.x also requires its compatible Husky and lint-staged peers and
   a Node version accepted by that release.
4. Install from the restored lockfile, then run the target version's
   `npx --no-install commitment-issues init` and
   `npx --no-install commitment-issues doctor`.
5. Review the resulting hooks and package changes, then try a normal commit and
   push before sharing the rollback.

Custom hooks are preserved throughout this process, but an older release may
not run logic written for a newer hook layout. Treat any manual-cleanup warning
as work to review, not as permission to delete the file.

## Migrate from raw `husky` + `lint-staged`

This is the most direct migration.

1. Install the package and its peer tools if needed:

   ```bash
   npm install -D commitment-issues eslint@^9 prettier@^3
   ```

2. Remove any custom hook bodies that call old scripts directly, and remove husky's `prepare` script (`init` replaces it).

3. Run the initializer:

   ```bash
   npx --no-install commitment-issues init
   ```

4. Review the `package.json` and `.gitignore` changes and the new `.git/hooks` files.

5. Uninstall the old wiring once you are happy:

   ```bash
   npm remove husky lint-staged
   ```

6. Commit the updated config and try a normal commit / push.

**Before** — a hand-wired `.husky/pre-commit` that runs lint-staged directly:

```bash
# .husky/pre-commit
npx lint-staged
```

**After** — `init` points plain `.git/hooks` files at the `commitment-issues` bin and adds an advisory pre-push test gate:

```bash
# .git/hooks/pre-commit (generated, not committed)
commitment-issues precommit

# .git/hooks/pre-push (generated, not committed)
commitment-issues prepush "$@"
```

Expect to review `package.json` (new helper scripts + `precommitChecks`) and `.gitignore` (cache and `node_modules/` ignores). `.git/hooks` is per-clone and self-heals on every install via the generated or composed `prepare` repair script.

## Migrate from `lefthook`

`lefthook` usually centralizes hooks in a single config file. Moving to `commitment-issues` means letting `init` write native `.git/hooks` entry points that call the `commitment-issues` bin.

1. Remove your `lefthook` hook installation (`lefthook uninstall` unsets its `core.hooksPath`; `doctor` will tell you if one is still configured).
2. Install `commitment-issues` and the peer tools it uses.
3. Run `npx --no-install commitment-issues init`.
4. Compare the resulting `.git/hooks/pre-commit` and `.git/hooks/pre-push` hooks with your old behavior.

The biggest behavior change is philosophical: `commitment-issues` is advisory-first by default. It reports problems without blocking unless you opt into stricter behavior in `precommitChecks`.

**Before** — hook logic centralized in `lefthook.yml`:

```yaml
# lefthook.yml
pre-commit:
  commands:
    lint:
      run: eslint {staged_files}
    format:
      run: prettier --write {staged_files}
```

**After** — remove `lefthook.yml`; the native hooks call the bin instead:

```bash
# .git/hooks/pre-commit (generated, not committed)
commitment-issues precommit

# .git/hooks/pre-push (generated, not committed)
commitment-issues prepush "$@"
```

Files to review: `package.json` and `.gitignore` — then delete the now-unused `lefthook.yml`.

## Migrate from `pre-commit`

If you are using the Python-based `pre-commit` framework, migrate the actual checks into your JavaScript package scripts and hook them through `commitment-issues`.

1. Map each check you care about to a package script or existing command.
2. Install `commitment-issues` alongside `eslint` and `prettier`.
3. Run `pre-commit uninstall` so its hook entry points are removed, then `npx --no-install commitment-issues init`.
4. Remove `.pre-commit-config.yaml`.

If you relied on `pre-commit` to block everything automatically, review your `precommitChecks` settings. `commitment-issues` warns by default and only blocks when you explicitly opt in.

**Before** — `.pre-commit-config.yaml` driving hooks through the Python framework:

```yaml
# .pre-commit-config.yaml
repos:
  - repo: local
    hooks:
      - id: eslint
        name: eslint
        entry: npx eslint
        language: system
        types: [javascript]
```

**After** — drop `.pre-commit-config.yaml` and let the native hooks run your JS tooling:

```bash
# .git/hooks/pre-commit (generated, not committed)
commitment-issues precommit

# .git/hooks/pre-push (generated, not committed)
commitment-issues prepush "$@"
```

Files to review: `package.json` and `.gitignore` — then remove `.pre-commit-config.yaml` and any `pre-commit` install hook.

## After the migration

- Run `npm test` and `npm run lint`.
- Run `npm run doctor` to confirm the hooks report healthy.
- Try `npm run fix:staged` on a staged-only change.
- Try `npm run commit:fix` on a clean, fixable commit.
- If you want to preview the setup without writing files, run `npx --no-install commitment-issues init --dry-run` first.

## Common follow-up adjustments

- If your repo is TypeScript-heavy, make sure ESLint is configured for TypeScript files.
- If you use custom test commands, set `precommitChecks.testCommand` in `package.json`.
- If you want blocking push-time failures, set `precommitChecks.blockPushOnTestFailure` to `true`.

If you run into a migration edge case, check the FAQ and configuration docs for the behavior details.
