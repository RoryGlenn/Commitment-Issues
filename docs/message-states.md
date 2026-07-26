# Message States

> **Audience:** users who need a complete output catalog and maintainers who
> review presentation changes. This repository-only gallery is excluded from
> the npm package. Metadata tests require every terminal box title to appear
> here or in a referenced SVG, and `tools/gen-message-state-svgs.mjs` regenerates
> the visual fixtures.

`commitment-issues` uses compact terminal boxes to keep Git hook output readable. Each command invocation renders at most one box; when several findings coexist, they are consolidated under the strongest severity. On an eligible first run, the one-time onboarding box documented below replaces an otherwise clean or informational result. A warning or error takes priority and leaves the welcome unconsumed for a later clean run. The README shows the main user journey; this page catalogs the states a user may see, grouped by the command that produces them. Hook and fixer examples include rendered SVGs of real box output; setup and removal states also describe their ownership behavior.

Routine hooks default to `hookOutput: "problems-only"`, so their success and
informational states are normally silent. This gallery intentionally documents
those states under an explicit `hookOutput: "normal"` override; warnings and
errors are visible in either mode.

### Untrusted values and terminal controls

Repository filenames, refs, configuration values, Git diagnostics, argv, and
captured tool diagnostics are untrusted inside product-owned human messages.
Carriage returns, embedded newlines, and tabs appear visibly as `\\r`, `\\n`,
and `\\t`; other C0/C1 controls use `\\xNN`, and ANSI CSI/OSC sequences are
removed. Separate message-model entries still create the intended box line
breaks, while Unicode, spaces, and normal punctuation are preserved. Raw
project-tool output intentionally remains outside the box renderer.
Product-owned bold, dim, border, and severity colors are retained around the
escaped text. JSON mode keeps the original semantic strings and uses JSON's own
escaping.

The renderer unit coverage and the real-Git partially staged filename scenario
exercise this boundary with carriage-return, newline, tab, backspace, ANSI,
Unicode, and JSON round-trip cases.

To watch representative states render live in your own terminal (real hooks running in throwaway repos), clone this repo and run. The static gallery below is the exhaustive catalog; the runner intentionally keeps a smaller, maintainable set of executable examples.

```bash
npm run states              # every runnable representative state
npm run states -- secrets   # only states matching "secrets"
npm run states -- --list    # list state names
```

## Init

### Setup complete

<p>
  <img src="../assets/init-success.svg" alt="Green output with the split-heart logo showing that Commitment Issues is set up" width="737">
</p>

Shown only when `init` finishes wiring every configured hook along with the scripts, configuration, and gitignore defaults. The optional commit-msg hook is included only when enabled. Lists exactly what was added.

### Dry-run preview

<p>
  <img src="../assets/init-dry-run.svg" alt="Info output previewing the changes init would make without writing files" width="716">
</p>

Shown for `init --dry-run`: when changes are pending, it shows the same change
list without writing anything and explains how to apply it. When setup is
already complete, it reports that nothing would change and does not instruct
the user to apply nonexistent changes.

### Already configured

<p>
  <img src="../assets/init-already-configured.svg" alt="Green output showing that everything is already configured and nothing changed" width="737">
</p>

Shown when `init` is re-run, finds nothing to change, and verifies that every configured hook invokes `commitment-issues`. Init is safe to re-run at any time.

### No package.json

<p>
  <img src="../assets/no-package-json.svg" alt="Error output showing that no package.json was found" width="438">
</p>

Shown when `init` (or interactive `doctor`) runs outside a project root.

### Project root required

`Project root required.` is shown when `init`, interactive `doctor`, or
`uninstall` is launched from below the owning worktree root. The command names
that root and exits before changing or repairing anything.

### Invalid package.json

<p>
  <img src="../assets/init-invalid-package-json.svg" alt="Error output showing that package.json is not valid JSON" width="768">
</p>

Shown when package.json cannot be parsed; fix the JSON and run `init` again.

### Invalid package.json structure

`Invalid package.json structure.` is shown when the JSON parses but its root,
`scripts`, or `precommitChecks` value is not an object. The message names the
invalid container, exits before any write, and tells the user to fix
`package.json` before rerunning `init`.

### Invalid .commitmentrc.json

`Invalid .commitmentrc.json.` is shown by `init` or `uninstall` when the
standalone file contains invalid JSON or its top-level value is not an object.
The command exits before changing package scripts, configuration, hooks, or
gitignore state.

### Invalid command arguments

`Unknown init option: <option>`, `Unknown uninstall option: <option>`, and
`Unknown doctor option: <option>` are shown when an argument is outside the
documented command contract. The command exits before changing project files or
hooks. Other CLI commands report the same invalid-argument decision as a plain
stderr line or, when `--json` was requested, a structured JSON diagnostic.
`The --integration option may be supplied only once.` is the corresponding
owner-selection cardinality error.

### Prepare composition refusal

`Unsafe package.json prepare composition.` means the project-owned command has
incomplete shell syntax or heredoc-style redirection, so `init` cannot add
repair without guessing.
`Ambiguous package.json prepare repair.` means a recognized generated repair
was moved into shell control flow, otherwise moved away from its terminal
position, or duplicated. Init and uninstall both stop before changing any file
or hook; the latter never prints a setup-removed claim. The box asks the user
to retain every project command, remove only a displaced repair when
applicable, and rerun the command.

### Hook-manager owner selection

`Could not choose a hook-manager owner safely.` is shown by doctor when bare
`--integration` finds no owner or more than one. Init uses `No hook manager
could be identified.` or `Multiple hook managers were detected.` for the same
fail-before-write decision. An explicit `--integration=<manager>` resolves the
owner ambiguity without editing any owner. It does not override an unsafe,
duplicate, or unsupported selected configuration; those states still exit
before package, ignore, config, or hook changes.

### Project files unavailable

`Could not inspect .gitignore.` is shown when setup cannot safely read the
existing ignore path. The write-failure titles are:

- `Could not update package.json.`
- `Could not update the project files.`

These cover permission/preflight and unexpected write failures. The states stop
before hook installation or removal begins. Replacement bytes are completed,
permissioned, synced, and closed under a reserved same-directory transaction
name, then revalidated byte-for-byte through a no-follow descriptor before the
inspected destination is replaced. A failure therefore leaves each project file
as either its complete old version or its complete intended version, never
empty or partial. In a multi-file setup, an earlier complete replacement may
already have committed before a later file fails, but hook state is still
untouched.

Rerun the same command after fixing storage or permissions. The retry completes
remaining work and removes regular transaction files left by a writer process
that is no longer running. Active writers are not disturbed, and a linked,
non-regular, or differently owned entry in that reserved namespace is refused
instead of deleted.

### Unsafe project file

`Unsafe project file: <path>.` is shown when a mutable project path is a
symbolic link, a non-regular entry, or cannot be inspected safely. `init` and
`init --dry-run` check `package.json`, `.gitignore`, and `.commitmentrc.json`;
`uninstall` and `uninstall --dry-run` check the two JSON files they can modify.
The command names the reason and exits before changing project files or hooks.
Replace the path with a regular file inside the project before rerunning the
command.

### Hook wiring needs attention

<p>
  <img src="../assets/init-hook-wiring-warning.svg" alt="Warning output printed after the init summary when hook wiring needs manual attention" width="675">
</p>

Included in the same warning summary when `init` cannot fully wire the hooks by itself: an existing native hook does not invoke `commitment-issues`, a foreign `core.hooksPath` is configured, user-authored `.husky` hooks are stranded by the husky-era migration, or the directory is not a git repository yet. Existing hooks are preserved, and missing integration lists the exact command to add. When the active hooks themselves cannot be verified, setup-complete commit/push claims are also withheld.

## Uninstall

### Uninstall preview

`Commitment Issues uninstall preview.` is shown for `uninstall --dry-run`. It
lists the exact generated scripts, configuration, and hook files that would be
removed without writing anything.

### Setup removed

`Commitment Issues setup was removed.` confirms the cleanup and prints the
detected package-manager command that removes the remaining dependency and
updates its lockfile.

### Manual cleanup still needed

<p>
  <img src="../assets/uninstall-manual-cleanup.svg" alt="Warning output combining completed managed uninstall work with manual cleanup for a customized hook" width="706">
</p>

`Manual cleanup still needed:` is included in the same removal summary when a
hook or script invokes `commitment-issues` but has been customized, or when the
command cannot inspect local Git hooks. User-owned content is reported and
preserved instead of being edited heuristically.

## Pre-commit

### First-commit welcome

```text
╭───────────────────────── info ─────────────────────────╮
│                                                        │
│                          ,_,                           │
│                         (O,O)  <3                      │
│                         (   )                          │
│                         -"-"-                          │
│                                                        │
│   Commitment Issues is active here.                    │
│                                                        │
│   Commitment Issues checks changes before each         │
│   commit. Keep the hooks enabled, and tell us if       │
│   any guidance feels confusing.                        │
│                                                        │
│   Verify or repair the hooks anytime: npm run doctor   │
│                                                        │
╰────────────────────────────────────────────────────────╯
```

Shown once per clone as the final presentation for the first eligible clean or
informational human-readable pre-commit run. It is visible under the default
`hookOutput: "problems-only"` policy because it is onboarding, not a normal
check result. Warnings and errors take priority without consuming the welcome,
so one invocation never renders two boxes. The command follows the consuming
project's package manager. Its versioned Git-common-directory marker is shared
by linked worktrees; JSON mode and hook bypasses do not consume it. Set
`showWelcomeOnFirstCommit: false` to suppress both the message and marker.

### All checks passed

<p>
  <img src="../assets/precommit-all-passed.svg" alt="Success output showing that all pre-commit checks passed" width="511">
</p>

Shown when the pre-commit hook finds no advisory issues.

### Suggestions found

<p>
  <img src="../assets/precommit-suggestions-warning.svg" alt="Warning output showing formatting suggestions and the commit fix command" width="479">
</p>

Shown when commit-time checks find advisory issues such as formatting drift, lint issues, or missing tests. The commit still continues, and `npm run commit:fix` is offered when amending the latest commit is safe.

When `scanDebugArtifacts` is enabled, every non-exempt added-line match joins
this same suggestions box as one “temporary debug artifacts staged” finding.
Its detail lines name each file, line, and curated rule. A failed or malformed
staged-diff inspection instead contributes one “Debug artifact scan
unavailable” advisory. Both states allow the commit and never create a second
box or prompt.

### Missing tests

<p>
  <img src="../assets/missing-tests-warning.svg" alt="Warning output showing that a staged source file is missing unit tests" width="554">
</p>

Shown when a staged source file has no nearby matching test and is not exempt.

### Manual lint issue

<p>
  <img src="../assets/manual-lint-warning.svg" alt="Warning output showing an ESLint issue that needs manual fixes" width="554">
</p>

Shown when ESLint reports issues that cannot be fixed automatically.

### Auto-fixable lint issues

<p>
  <img src="../assets/precommit-autofixable-lint.svg" alt="Warning output showing auto-fixable ESLint issues and the commit fix command" width="479">
</p>

Shown when ESLint finds issues it can fix itself (such as `prefer-const`); `npm run commit:fix` applies them.

### Failing staged tests

<p>
  <img src="../assets/precommit-staged-test-failure.svg" alt="Warning output showing that a staged test file is failing" width="541">
</p>

Shown when `runStagedTests` is enabled and a staged test file fails. The commit still continues.

### Tool timeout

<p>
  <img src="../assets/tool-limit-warning.svg" alt="Warning output showing that a tool exceeded the configured time limit" width="469">
</p>

Shown when a spawned tool exceeds the configured timeout. Its attached process
group/tree is terminated before the hook continues; unreclaimable inherited
pipes are released after a bounded cleanup grace.

### Tool crash

<p>
  <img src="../assets/precommit-tool-crash.svg" alt="Warning output showing that ESLint failed to complete" width="541">
</p>

Shown when ESLint or Prettier exits with a crash (broken config, parse error) instead of reporting issues. A crash is never presented as auto-fixable.

### Tool unavailable

<p>
  <img src="../assets/precommit-tool-unavailable.svg" alt="Warning output showing that ESLint could not be run" width="541">
</p>

Shown when a project-local ESLint or Prettier install is missing, or a tool
cannot be spawned. The commit still continues. Missing peers include the
detected package manager's install command and never trigger an implicit `npx`
fallback.

### Amend blocked by other tracked changes

<p>
  <img src="../assets/precommit-amend-blocked.svg" alt="Warning output explaining that other tracked changes suppress the automatic amend command" width="786">
</p>

Shown when fixable issues exist but other tracked files have unstaged changes, so `npm run commit:fix` is withheld: an amend would not leave a clean worktree.

### Amend withheld: worktree not inspectable

<p>
  <img src="../assets/precommit-amend-uninspectable.svg" alt="Warning output explaining that the working tree could not be inspected for a safe post-commit amend" width="786">
</p>

Shown when Git cannot report whether the worktree is clean; the amend recommendation is withheld rather than offered unverified.

### Fun tone

<p>
  <img src="../assets/precommit-fun-tone.svg" alt="Warning output showing the fun tone wording for pre-commit suggestions" width="582">
</p>

Shown when `precommitChecks.tone` is `"fun"`: every advisory state above keeps its structure but swaps in relationship-themed wording.

### Unknown config key warning

<p>
  <img src="../assets/config-unknown-key-warning.svg" alt="A single yellow console warning saying an unknown precommitChecks key is being ignored" width="646">
</p>

Shown as a diagnostic by hooks, `init`, and `doctor` when either configuration source contains an effective key the tool does not recognize — including typos like `requireTest` and nested paths such as `commitMessage.enable` that would otherwise silently fall back to default behavior. The diagnostic names the contributing source.

### Invalid config value warning

<p>
  <img src="../assets/config-invalid-value-warning.svg" alt="A single yellow console warning saying an invalid precommitChecks value is being ignored" width="646">
</p>

Shown as a diagnostic by hooks, `init`, and `doctor` when a recognized key in either configuration source has an invalid value — for example a string where a boolean is expected, a non-positive `timeoutMs`, or a non-boolean `commitMessage.enabled`. The invalid value is ignored in favor of the default; hooks remain advisory and continue.

### Malformed standalone config warning

`Ignoring .commitmentrc.json …` is printed as a one-line advisory when the
standalone file cannot be parsed or has a non-object root. The hooks continue
with `package.json` `precommitChecks` or built-in defaults instead.

### Unable to inspect staged files

<p>
  <img src="../assets/precommit-cannot-inspect-staged.svg" alt="Warning output showing that staged files could not be inspected and the commit continues" width="665">
</p>

Shown when Git cannot list the staged files at all. True to the advisory philosophy, the commit still continues.

### No staged files

<p>
  <img src="../assets/no-staged-files.svg" alt="Info output showing that no staged files were found" width="585">
</p>

Shown when the pre-commit hook runs with no staged files.

### Deletion-only commit

<p>
  <img src="../assets/deletion-only-commit.svg" alt="Info output showing that only deleted files are staged" width="734">
</p>

Shown when only deleted files are staged.

### No lintable or formattable files

<p>
  <img src="../assets/no-lintable-files.svg" alt="Info output showing that no lintable or formattable files are staged" width="617">
</p>

Shown when staged files are outside the JavaScript, TypeScript, and formatted-file patterns.

### No project files

<p>
  <img src="../assets/no-project-files.svg" alt="Info output showing that only dependency files are staged" width="543">
</p>

Shown when accidentally staged dependency files are ignored and no project files remain to check.

### Commit guard suggestions

<p>
  <img src="../assets/precommit-commit-guards.svg" alt="Warning output showing protected-branch, behind-upstream, and large-commit advisories" width="603">
</p>

Shown when the advisory commit guards notice something about the commit itself. All guards join the same consolidated suggestions box as lint and test advisories, and the commit still continues. The individual guard states follow.

### Protected-branch commit

<p>
  <img src="../assets/precommit-protected-branch.svg" alt="Warning output advising against committing directly to a protected branch" width="603">
</p>

Shown when the current branch matches `protectedBranches` (default `["main", "master"]`, globs supported) and `blockProtectedBranches` is off. Set `protectedBranches: []` to disable for trunk-based repos.

### Behind upstream

<p>
  <img src="../assets/precommit-behind-upstream.svg" alt="Warning output saying the branch is behind its upstream and suggesting a pull or rebase" width="582">
</p>

Shown when the branch is behind its upstream as of the last fetch. Disable with `adviseBehindUpstream: false`.

### Large commit

<p>
  <img src="../assets/precommit-large-commit.svg" alt="Warning output saying the commit exceeds the file-count and changed-line limits" width="593">
</p>

Shown when a commit stages more than `maxCommitFiles` files or changes more than `maxCommitLines` lines. Each exceeded limit prints its own suggestion; `0` disables either limit.

### Large staged file

<p>
  <img src="../assets/precommit-large-file.svg" alt="Warning output listing a staged file over the size threshold with a Git LFS pointer" width="541">
</p>

Shown when staged files exceed `maxFileSizeMb` (default 5). Each oversized file is listed with its size. `0` disables.

### Generated files staged

<p>
  <img src="../assets/precommit-generated-files.svg" alt="Warning output flagging staged build artifacts that are usually ignored" width="551">
</p>

Shown when staged paths match `generatedPaths` (default: `dist`, `build`, `coverage`, `node_modules`, `.DS_Store`, `__pycache__` anywhere in the tree). Setting `generatedPaths` replaces the default list.

### Possible secrets staged

<p>
  <img src="../assets/precommit-secrets-advisory.svg" alt="Warning output listing a staged .env file and an AWS key finding with rotation guidance" width="788">
</p>

Shown when the staged diff adds a line matching a curated credential pattern (AWS keys, private-key headers, GitHub/Slack/npm/Stripe/Google tokens, URLs with embedded passwords) or a real dotenv file is staged (`.env.example`-style templates are ignored). Only added lines are scanned, so pre-existing strings and deletions never fire. Exempt fixture paths with `secretExempt`; disable with `scanSecrets: false`.

### Commit blocked: possible secret staged

<p>
  <img src="../assets/precommit-blocked-secrets.svg" alt="Error output showing a commit refused because a possible secret is staged" width="665">
</p>

Shown only when `blockOnSecrets` is enabled and the scan found something. The commit is refused; `git commit --no-verify` bypasses it once. Rotate anything already exposed — a secret that reached a commit should be treated as leaked.

### Commit blocked: staged secret scan unavailable

`Commit blocked: staged secret scan unavailable.` is shown only when
`blockOnSecrets` is enabled and Git cannot launch, exits nonzero, or returns a
malformed staged patch. The commit is refused because possible secrets could
not be ruled out. This state is distinct from a detected secret in both human
and JSON output; retry after restoring Git/index access, or use
`git commit --no-verify` as an explicit one-time bypass. Without
`blockOnSecrets`, the same inspection failure is an advisory and the commit
continues.

### Commit blocked: protected branch

<p>
  <img src="../assets/precommit-blocked-protected-branch.svg" alt="Error output showing a commit refused on a protected branch" width="706">
</p>

Shown only when `blockProtectedBranches` is enabled and the current branch matches `protectedBranches`. The commit is refused; `git commit --no-verify` bypasses it once.

## Commit message

These states appear only after `precommitChecks.commitMessage.enabled` is set
to `true`. A successful project-local commitlint run is silent.

### Commit message needs attention

`Commit message needs attention` reports commitlint output in advisory mode.
The commit continues and the consumer's rule name/detail remains visible.

### Commit blocked: commit message needs attention

`Commit blocked: commit message needs attention` is the same reported problem
with `commitMessage.blockOnFailure: true`. It exits non-zero and names
`git commit --no-verify` as the explicit one-time bypass.

### Commit-message check unavailable

`Commit-message check unavailable` covers a missing project-local commitlint
CLI or a local executable that could not start. The message states that no
`npx`, network, or global fallback was attempted and gives a package-manager
specific install command.

### Commitlint configuration not found

`Commitlint configuration not found` is shown for commitlint's missing-config
result or its strict-mode `empty-rules` diagnostic.
It asks the consumer to add its own rules and explicitly says no built-in
Conventional Commits policy was substituted.

### Unable to read the commit message

`Unable to read the commit message` means the hook received no readable regular
file. Message paths are passed as one quoted argument rather than interpreted
as shell fragments.

### Commitlint timed out

`Commitlint timed out` uses the shared `timeoutMs` ceiling. Like every failure
above it warns in advisory mode and blocks only after explicit enforcement.

Fun tone provides corresponding relationship-themed titles and body copy
without changing the result: `Commit message sent mixed signals`,
`Commitlint stood this commit up`, `Commitlint needs relationship rules`,
`The commit message went missing`, `Commitlint needed space`, and
`Commitlint left this commit on read`.

## Commit fix and staged fixes

### Latest commit amended

<p>
  <img src="../assets/commit-fix-success.svg" alt="Success output showing the latest commit amended with automatic fixes" width="590">
</p>

Shown after `npm run commit:fix` safely applies automatic fixes and amends the
latest clean, attached, unsigned commit whose local ref snapshot permits the
rewrite.

### Latest commit amended with available fixes

<p>
  <img src="../assets/commit-fix-partial.svg" alt="Warning output showing the commit was amended but manual issues remain" width="581">
</p>

Shown when `commit:fix` amends what it can but some issues still need manual attention; it exits non-zero so the remaining work is not missed.

### Latest commit already clean

<p>
  <img src="../assets/commit-fix-already-clean.svg" alt="Success output showing the latest commit needed no automatic fixes" width="510">
</p>

Shown when `commit:fix` checks the latest commit's files and finds nothing to change.

### Active Git operation refusal

<p>
  <img src="../assets/commit-fix-active-operation.svg" alt="Error output refusing to amend while a Git revert is active" width="788">
</p>

Shown before fixer tools run when Git reports an active merge, cherry-pick,
revert, rebase, `git am`, or sequencer state. The refusal also applies when the
index and worktree match `HEAD`, so an empty or conflict-resolved operation
cannot be silently replaced by an amend. Operation files, `HEAD`, the index,
and worktree remain available to continue, skip, or abort with Git.

The fun-tone title is `Git is already in a complicated relationship`; it leaves
the same operation state exactly where it was.

### Git operation state uninspectable

<p>
  <img src="../assets/commit-fix-operation-uninspectable.svg" alt="Error output refusing to amend because active Git operations could not be inspected" width="788">
</p>

Shown when Git cannot locate a worktree-specific operation marker or the
filesystem cannot inspect one. The command fails closed before fixer tools or
repository mutation. The fun-tone title is
`Git would not explain its relationship status`.

### No automatic fixes landed

<p>
  <img src="../assets/commit-fix-manual-only.svg" alt="Warning output showing that no automatic changes were added to the latest commit" width="786">
</p>

Shown when the fixers ran but produced no changes while issues remain (for example, a file Prettier cannot parse); fix manually, then amend.

### Fixes emptied the commit

<p>
  <img src="../assets/commit-fix-emptied-commit.svg" alt="Warning output explaining that the fixes reverted the commit's only changes" width="716">
</p>

Shown when the automatic fixes reverted the only changes in the latest commit, so amending would create an empty commit; drop it with `git reset --soft HEAD^`.

### Protected-reference refusal

<p>
  <img src="../assets/commit-fix-protected-reference.svg" alt="Error output refusing to amend a commit retained by a local tag or known remote ref" width="757">
</p>

Shown when a local tag or remote-tracking ref contains the latest commit. The
command lists the locally known ref and asks for a new fix commit instead. Its
offline proof does not contact remotes or claim knowledge of remote-only refs.

The fun-tone title is
`The latest commit is already seeing another Git ref`; it keeps the same
protected-history refusal.

### Detached-commit refusal

<p>
  <img src="../assets/commit-fix-detached.svg" alt="Error output refusing to amend a detached commit" width="788">
</p>

Shown when `HEAD` is detached or points outside `refs/heads/`. The command asks
the user to switch to or create the branch that should retain the replacement,
preventing an amended commit from becoming reachable only through the reflog.

The fun-tone title is `This commit has no branch to come home to`; it does not
change the refusal.

### Signed-commit refusal

<p>
  <img src="../assets/commit-fix-signed.svg" alt="Error output refusing to replace a signed commit without an explicit signing workflow" width="778">
</p>

Shown when the raw commit carries a Git `gpgsig` or `gpgsig-sha256` header,
including OpenPGP and SSH signatures. Automatic amend stops before staging so
it cannot silently replace the signed commit with an unsigned one.

The fun-tone title is
`This signed commit deserves a proper second ceremony`; manual signed amend
remains the required recovery.

### Dirty worktree refusal

<p>
  <img src="../assets/commit-fix-dirty-worktree.svg" alt="Error output refusing to amend while tracked changes exist in the worktree" width="603">
</p>

Shown when tracked files have uncommitted changes; commit, stash, or discard them before amending.

### Commit history safety unverifiable

<p>
  <img src="../assets/commit-fix-unverified.svg" alt="Error output refusing to amend because Git could not inspect branch attachment, commit metadata, tags, or known remote refs" width="716">
</p>

Shown when Git cannot inspect branch attachment, commit metadata, local tags, or
remote-tracking refs. The command fails closed rather than assume the commit is
safe to rewrite.

### No commit to inspect

<p>
  <img src="../assets/commit-fix-no-commit.svg" alt="Error output showing that the latest commit could not be inspected" width="786">
</p>

Shown when the repository has no commit yet (or HEAD cannot be resolved).

### No fixable files in the latest commit

<p>
  <img src="../assets/commit-fix-no-fixable-files.svg" alt="Info output showing that the latest commit has no staged-fixer targets" width="685">
</p>

Shown when the latest commit contains no files the staged fixers handle.

### Fixer interrupted before amend

Shown when ESLint or Prettier times out, stops on a signal, cannot start, or is
missing locally. `commit:fix` discards incomplete output and stops before later
tool phases, staging, or amend. The box confirms that the index and `HEAD`
remain unchanged. If the interrupted process changed or invalidated a captured
target, every affected path is listed and left untouched for manual review.

The fun-tone title is `A fixer left the makeover halfway through`; the same
index, history, affected-path, and retry details remain visible.

### Repository changed during commit fix

<p>
  <img src="../assets/commit-fix-concurrent.svg" alt="Error output refusing to amend after repository state changed while fixers ran" width="778">
</p>

Shown when revalidation detects that a target was edited, deleted, or replaced,
the index changed, `HEAD` moved, or a local tag or known remote-tracking ref
began retaining the original commit while tools ran. The command preserves the
concurrent state and does not amend.

The fun-tone title is
`The repository changed the relationship status mid-fix`; it says the latest
commit was left out of the drama without changing the refusal.

### Fixes could not be applied safely or amended

<p>
  <img src="../assets/commit-fix-stage-failed.svg" alt="Error output showing exact fixes could not be applied or staged safely" width="665">
</p>

<p>
  <img src="../assets/commit-fix-amend-failed.svg" alt="Error output showing the staged fixes could not be amended into the commit" width="786">
</p>

The first box covers an unavailable snapshot, blob, index lock, or other
revalidation failure before amend; it never asks `git add` to reread live
worktree bytes. The second appears after exact fixes were safely staged but
`git commit --amend` itself failed and explains the manual recovery step.

### Git state could not be inspected

<p>
  <img src="../assets/commit-fix-cannot-inspect.svg" alt="Error output showing the current working tree could not be inspected" width="786">
</p>

<p>
  <img src="../assets/commit-fix-cannot-list-files.svg" alt="Error output showing the files from the latest commit could not be listed" width="706">
</p>

<p>
  <img src="../assets/commit-fix-cannot-inspect-fixes.svg" alt="Error output showing the staged fixes could not be inspected" width="691">
</p>

Shown when a Git probe fails partway through `commit:fix` (worktree, commit file list, or staged-fix inspection); the command stops instead of guessing.

### Staged fixes applied

<p>
  <img src="../assets/fix-staged-success.svg" alt="Success output showing staged fixes were applied and the index refreshed" width="522">
</p>

Shown when `npm run fix:staged` applies automatic fixes and refreshes the staged index.

### Staged files already clean

<p>
  <img src="../assets/fix-staged-already-clean.svg" alt="Success output showing the staged files needed no automatic changes" width="696">
</p>

Shown when `fix:staged` runs but the staged files needed no automatic changes.

### Staged fixes need manual attention

<p>
  <img src="../assets/fix-staged-manual.svg" alt="Warning output showing fixes were applied but lint issues remain" width="786">
</p>

Shown when the available fixes were applied but non-fixable lint issues remain; it exits non-zero.

### No staged files to fix

<p>
  <img src="../assets/fix-staged-none.svg" alt="Info output showing there are no staged fixable files" width="786">
</p>

Shown when nothing fixable is staged.

### Partially staged safety refusal

<p>
  <img src="../assets/partially-staged-error.svg" alt="Error output showing that partially staged files cannot be fixed safely" width="568">
</p>

Shown when `npm run fix:staged` finds a file that has both staged and unstaged changes; resolve them before retrying.

### Staged file missing from the working tree

<p>
  <img src="../assets/fix-staged-missing-file.svg" alt="Error output refusing to fix staged files that are missing from the working tree" width="779">
</p>

Shown when a staged file no longer exists on disk (for example, a broken symlink); restore or unstage it first.

### Staged or unstaged files could not be inspected

<p>
  <img src="../assets/fix-staged-cannot-inspect.svg" alt="Error output showing staged files could not be inspected" width="786">
</p>

<p>
  <img src="../assets/fix-staged-cannot-inspect-unstaged.svg" alt="Error output showing unstaged files could not be inspected" width="786">
</p>

Shown when a Git probe fails before fixing starts; `fix:staged` stops rather than risk an unsafe index refresh.

### Repository changed during staged fixes

<p>
  <img src="../assets/fix-staged-concurrent.svg" alt="Error output refusing to stage after repository state changed while fixers ran" width="778">
</p>

Shown when revalidation detects that a target was edited, deleted, or replaced,
the index changed, or `HEAD` moved while staged fixes were computed. No
ambiguous bytes are staged; the concurrent state remains available in
`git status`.

The fun-tone title is
`The repository changed the relationship status mid-fix`; it says no surprise
changes were invited into the commit without changing the refusal.

### Fixer interrupted before staging

Shown when a fixer times out, stops on a signal, cannot start, or is missing
locally. `fix:staged` discards incomplete output, skips later tool phases, and
does not stage anything from the interrupted run. The exact index and `HEAD`
remain unchanged. Any captured target changed or made unverifiable by the tool
is listed exactly and left untouched so concurrent user work is never guessed
away. The fun-tone title matches the commit-fix interruption state without
changing its safety details.

### Fixed output could not be applied safely

<p>
  <img src="../assets/fix-staged-restage-failed.svg" alt="Error output showing exact fixes could not be applied or staged safely" width="665">
</p>

Shown when the exact snapshot, crash-safe file replacement, prepared index, or
Git lock cannot be completed. The command reports that exact staging could not
be verified and directs the user to review `git status` and tool output.

## Pre-push

### Tests passed

<p>
  <img src="../assets/prepush-success.svg" alt="Success output showing all pushed-file tests passed and push was allowed" width="310">
</p>

Shown when push-time tests are enabled and the associated pushed-file tests pass.
When the same push targets a protected branch, both facts are consolidated:

<p>
  <img src="../assets/prepush-protected-tests-passed.svg" alt="Warning output combining passing pre-push tests with a protected-branch advisory" width="520">
</p>

### No tests to run

<p>
  <img src="../assets/prepush-no-tests.svg" alt="Info output showing that no pushed files have associated tests" width="755">
</p>

Shown when a push mode is enabled but none of the pushed files have associated tests.

### Checks disabled

<p>
  <img src="../assets/prepush-disabled.svg" alt="Info output showing that no pre-push test mode is enabled" width="786">
</p>

Shown when the pre-push hook is run by hand and no push-test mode is configured.

### Advisory push failure

<p>
  <img src="../assets/advisory-push-failure.svg" alt="Warning output showing failing push-time tests in advisory mode" width="713">
</p>

Shown when `advisePushTests` is enabled and pushed-file tests fail; the push is still allowed.
When the same push targets a protected branch, the final warning summarizes
both findings after the test-runner output:

<p>
  <img src="../assets/prepush-protected-tests-failed.svg" alt="Warning output combining an advisory test failure with a protected-branch advisory" width="819">
</p>

### Blocking push failure

<p>
  <img src="../assets/blocking-push-failure.svg" alt="Error output showing failing push-time tests in blocking mode" width="596">
</p>

Shown when `blockPushOnTestFailure` is enabled and pushed-file tests fail; the push is blocked.

### Could not run tests (advisory)

<p>
  <img src="../assets/prepush-advisory-could-not-run.svg" alt="Warning output showing the test command could not run and the push was allowed" width="623">
</p>

Shown when `advisePushTests` is enabled but the test command itself fails to run (or times out); the push is allowed.

### Push blocked: could not run tests

<p>
  <img src="../assets/prepush-blocked-could-not-run.svg" alt="Error output showing the push was blocked because the test command could not run" width="623">
</p>

Shown when `blockPushOnTestFailure` is enabled and the test command itself fails to run; the gate fails closed.

### Config conflict warning

<p>
  <img src="../assets/prepush-config-conflict.svg" alt="A single yellow console warning saying both push-test modes are set and blocking wins" width="718">
</p>

Shown (as a one-line stderr warning, not a box) when both `blockPushOnTestFailure` and `advisePushTests` are set; blocking wins.

### Could not inspect pushed files (advisory)

<p>
  <img src="../assets/prepush-advisory-uninspectable.svg" alt="Warning output showing that the pushed-file diff could not be computed in advisory mode" width="776">
</p>

Shown when Git cannot list the pushed files in advisory mode; a warning prints and the push is allowed.

### Push blocked: could not inspect pushed files

<p>
  <img src="../assets/prepush-blocked-uninspectable.svg" alt="Error output showing that the pushed-file diff could not be computed in blocking mode" width="776">
</p>

Shown when Git cannot list the pushed files in blocking mode; the gate fails closed rather than skipping the check.

### Pushing to a protected branch

<p>
  <img src="../assets/prepush-protected-branch-advisory.svg" alt="Warning output showing an advisory that the push updates a protected branch directly" width="459">
</p>

Shown when the push updates a branch matching `protectedBranches` and
`blockProtectedBranches` is off. The push continues. If tests run, their result
is folded into this same final box instead of producing a second box.

### Push blocked: protected branch

<p>
  <img src="../assets/prepush-blocked-protected-branch.svg" alt="Error output showing a push refused to a protected branch" width="675">
</p>

Shown when `blockProtectedBranches` is enabled and the push targets a protected branch. The push is refused; `git push --no-verify` bypasses it once.

### Silent by design

A real `git push` with no push-test mode configured prints nothing at all — the hook stays out of the way. The [Checks disabled](#checks-disabled) box only appears when the hook is run by hand in a terminal.

## Doctor

### Configuration needs attention

`Configuration needs attention.` reports malformed standalone JSON, unknown
keys (including nested commit-message paths), or invalid values without
preventing hook diagnosis and repair. Interactive doctor output consolidates
these diagnostics, missing-tool notices, stranded-hook findings, and the final
hook-health result into one box.
`doctor --quiet` prints the same diagnostics as plain one-line warnings and
still exits successfully so an install is never broken.

### Hook-manager integration health

`<manager> integration is healthy.` confirms that every enabled manager entry
and its executable Git dispatcher are active; manager files were inspected but
not changed. `<manager> integration needs attention.` lists exact missing
snippets or the manager wrapper-install command and exits nonzero interactively.
Quiet mode emits one line and exits zero.

An older direct Commitment Issues entry is labelled for replacement with the
guarded dispatcher as the first substantive command. If the current
hook-dispatch entry is also present, the output instead asks the user to remove
only the older duplicate, retain and correctly position the current entry, and
does not print another snippet. Repeated current entries must likewise be
reduced to one. A Commitment Issues command under the wrong hook stage is
labelled for relocation to its matching stage rather than being hidden by a
healthy entry or duplicated under a new key. Older direct calls also need the
`hook` subcommand inserted during that move. When no current or older command
exists for the hook's own stage, the missing guarded snippet is printed as a
separate required step.

The health state requires an exact unconditional Commitment Issues entry:
duplicate Lefthook hook/command keys, duplicate pre-commit IDs, wrong or
repeated required fields, and any pre-commit `args` property on a Commitment
Issues entry are rejected. The complete selected document is schema-checked,
so an unsupported nested Lefthook job or unrelated pre-commit hook/root option
also requires manual review. Conditions and skip rules on supported unrelated
manager entries remain untouched.

`Multiple hook-manager owners were detected.` reports additional evidence when
the caller made an explicit choice. `lint-staged composition was detected.`
confirms that its separate task flow remains untouched.

### Some manager paths need manual review.

This advisory names linked, duplicate, non-regular, or otherwise uninspectable
candidates without treating them as healthy. Lefthook's JSON, JSONC, TOML,
local, extended/remote, advanced-YAML, and `LEFTHOOK_CONFIG`-overridden forms
also require manual review. A customized or newer Husky, Lefthook, or
pre-commit generated wrapper is preserved and reported rather than matched
approximately.

### Already healthy

<p>
  <img src="../assets/doctor-healthy.svg" alt="Success output showing that doctor found Git hook wiring already healthy" width="603">
</p>

Shown when `doctor` finds the hook wiring already correct.

### Install-time repair composition

`The install-time repair is not healthy.` reports an exact historical
composition that `init` can rewrite safely. `The install-time repair is
ambiguous.` reports a displaced or duplicate generated repair that needs
manual cleanup. Both interactive states exit nonzero before hook repair and
never print the healthy claim. Quiet mode instead emits one bounded warning
line and exits zero so package installation remains usable.

### Repaired hooks

<p>
  <img src="../assets/doctor-repaired-hooks.svg" alt="Warning output showing that doctor repaired Git hook wiring" width="675">
</p>

Shown when `doctor` recreates missing `.git/hooks` files or retires dead husky-era wiring (a pre-3.0 `core.hooksPath` left behind after the husky package was removed).

### Hook not wired

<p>
  <img src="../assets/doctor-hook-not-wired.svg" alt="Warning output showing that a custom Git hook does not invoke commitment-issues" width="757">
</p>

Shown when a custom hook exists but never invokes `commitment-issues`; `doctor` reports it and leaves the hook untouched.

### Hook inactive

`A git hook is inactive.` is shown on POSIX when a custom hook contains the
expected command but the file is not executable. `doctor` leaves the file and
its mode untouched and prints the exact `chmod +x` command to run.

### Missing peer tools

<p>
  <img src="../assets/doctor-missing-tools.svg" alt="Warning output listing required tools that are not installed" width="726">
</p>

Shown when eslint or prettier cannot be resolved from the project's
`node_modules`. Advisory only: missing tools never fail an otherwise-healthy
repo, and `doctor` states that hooks do not download them through `npx`.

### Commit-message linting is not ready

`Commit-message linting is not ready.` appears when the integration is enabled
but `node_modules/.bin/commitlint` is absent. It suggests installing
`@commitlint/cli` locally and adding a consumer-owned config; it never downloads
anything or makes `doctor --quiet` fail an install.

### Foreign core.hooksPath

<p>
  <img src="../assets/doctor-hookspath-foreign.svg" alt="Warning output showing core.hooksPath points at a directory the tool does not manage" width="696">
</p>

Shown when `core.hooksPath` points at a directory this tool does not manage (another hook manager or a custom hooks dir) whose hooks never invoke `commitment-issues`. The configuration is never changed; the box lists the commands to add there (or how to unset it). When those hooks already invoke the tool, doctor reports healthy instead. Husky-era wiring gets the same respect while the husky package is still installed — doctor nudges toward `init` for the migration instead of rewiring automatically.

### Leftover .husky hooks

<p>
  <img src="../assets/doctor-leftover-husky-hooks.svg" alt="Warning output listing user-authored .husky hooks that no longer run" width="716">
</p>

Shown when user-authored hooks are stranded in `.husky/` after the husky-era wiring is retired. Advisory only — the files are never deleted.

### Legacy Husky path needs manual review

`The legacy .husky path needs manual review.` is included in interactive
`doctor` output when `.husky` is a symbolic link, a non-directory entry, or
cannot be read safely. `init` and `uninstall` report the same preservation
decision in their existing summaries. No command follows or removes the path;
the user must inspect it manually. Quiet doctor prints the decision as a plain
warning and still exits successfully so dependency installation is not broken.

### Not a git working tree

<p>
  <img src="../assets/doctor-not-git-repo.svg" alt="Error output showing the current directory is not a git repository" width="500">
</p>

Shown when interactive `doctor` runs outside a Git worktree or inside a bare
repository. Bare repositories are called out explicitly because local commit
and push hooks do not run there. (`doctor --quiet` exits silently instead, so
installs never break.) Running without a package.json shows the same
[No package.json](#no-packagejson) box as `init`.

### Repair failed

<p>
  <img src="../assets/doctor-repair-failed.svg" alt="Error output showing the git hook wiring could not be repaired" width="634">
</p>

<p>
  <img src="../assets/doctor-still-broken.svg" alt="Error output showing the hook wiring still looks broken after repair" width="768">
</p>

Shown when a repair step fails (for example, the husky-era `core.hooksPath` cannot be unset or a hook file cannot be written) or the wiring still looks broken afterward; interactive mode exits non-zero, `--quiet` warns in one line and still exits 0. `Could not determine core.hooksPath.` identifies a failed Git configuration probe specifically. `Could not locate the configured git hooks directory.` means Git returned a configured value but could not resolve its effective directory. In both cases, no hook is written or reported healthy while the active hook location is unknown.

### Quiet mode one-liners

<p>
  <img src="../assets/doctor-quiet-lines.svg" alt="Plain console lines from doctor --quiet: a missing-tool warning and a repaired notice" width="786">
</p>

`doctor --quiet` (the generated or composed `prepare` repair command) never prints boxes: it stays silent when healthy and prints a single line for each configuration warning or when it repairs something, finds missing tools, spots an unwired hook, or cannot complete a repair. It always exits 0 so an install can never break.

## Adding more examples

Add an SVG for each documented message state so the gallery stays visually consistent. Keep the README focused on the core user journey and use this page for the complete state catalog.
