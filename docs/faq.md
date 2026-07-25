# FAQ and troubleshooting

This page answers common adoption and recovery questions. The complete option
table lives in [Configuration and behavior](configuration.md), and public
command/output compatibility lives in the
[external interface](external-interface.md).

New to Git? The [plain-language Git glossary](#git-terms-used-in-this-project)
explains the words used on this page.

## Is this a replacement for Husky or lint-staged?

It can be, but does not have to be. Native setup lets `commitment-issues` own
Git hook wiring and staged ESLint/Prettier fixes without a separate manager. It adds
advisory-first checks, safe fix helpers, related push-time tests, and `doctor`
repair. Versions before 3.0 used Husky and lint-staged; `init` recognizes and
migrates the exact legacy wiring it owns.

If Husky, Lefthook, or the Python pre-commit framework still runs other project
logic, keep it with `init --integration=<manager>`. That mode prints exact
snippets and verifies them read-only without editing manager files. lint-staged
can remain a separate command; its config is never executed or interpreted. See
[Keep an existing hook manager](migration.md#keep-an-existing-hook-manager).

## What happens by default, and when can it block?

After `init`, commits inspect staged files for lint, formatting, missing-test,
secret, branch, and commit-shape findings. Pushes run related tests in advisory
mode when matching files exist. Findings warn without blocking by default, and
routine success/no-op hook output stays quiet.

Temporary debug-artifact scanning is additionally opt-in with
`scanDebugArtifacts: true` and remains advisory even when enabled.

Blocking is separate and explicit for protected branches, secrets, push-time
tests, and optional commit-message linting. Local hooks remain bypassable with
Git's standard `--no-verify`; policy that must be universal belongs in CI or
server-side protection. See the [configuration reference](configuration.md)
for every enforcement switch.

## Why is advisory-first the default?

A new local hook should not unexpectedly stop an established workflow. Teams
can observe findings, tune exemptions, and enable only the gates they trust.
Automatic changes remain separate commands, so a warning does not rewrite a
working tree or commit.

## How do I catch temporary debug statements without flagging examples?

Set `scanDebugArtifacts: true`. The check examines only lines added to the
staged patch and recognizes a small, language-scoped list: stand-alone
`console.log`, `debugger`, Python `print`/`pdb.set_trace`, Ruby `binding.pry`,
and comment-only `TODO remove`/`FIXME temporary` markers. Removed, unchanged,
same-line quoted, comment-prefixed, inline-comment, prose, and unsupported-file
examples do not match. Because the zero-context diff does not reconstruct a
language parser's lexical state, a stand-alone-looking line inside a multiline
block comment, template string, or triple-quoted string can still warn.

Documentation, fixtures, snapshots, and the effective `generatedPaths` are
exempt by default. Set `debugArtifactExempt` to replace that list with the
repository's intentional paths—for example, a CLI whose `print(...)` output is
product behavior or a source fixture containing a multiline example. An empty
list explicitly scans supported files in normally exempt locations. The setting
accepts path globs only, never custom regular expressions or commands.
The finding cannot block a commit, and an unavailable Git patch becomes a
visible advisory instead of a silent success. See
[Optional temporary debug-artifact advisory](configuration.md#optional-temporary-debug-artifact-advisory).

## What does `init` change?

`init` can add package scripts, advisory push configuration, a self-repairing
`prepare` command, native Git hooks, and common cache/dependency ignores. It
preserves project-owned scripts, custom hooks, foreign `core.hooksPath`
configurations, dependencies, source files, and lockfiles. Use
`npx --no-install commitment-issues init --dry-run` for the exact proposed diff.

The full ownership and precedence rules are documented under
[What `init` changes](configuration.md#what-init-changes).

## Is it safe to run `init` more than once?

Yes. It is idempotent: known generated setup is refreshed, healthy setup is
left alone, and unrecognized project-owned content is preserved.

## How do I repair or coexist with custom hooks?

Run `npm run doctor` for native wiring. It repairs generated files it owns and
reports custom or foreign hooks that require manual integration.

For a supported manager, use an explicit read-only contract instead:

```bash
npx --no-install commitment-issues init --dry-run --integration=lefthook
npx --no-install commitment-issues init --integration=lefthook
npx --no-install commitment-issues doctor --integration=lefthook
```

Replace the value with `husky` or `pre-commit`. Do not omit the value when more
than one manager is present; automatic mode refuses to guess, and explicit
selection cannot bypass unsafe or unsupported config. Use the exact printed
entry as the first substantive manager command, leaving unrelated behavior
after it. Doctor requires that entry plus an executable installed dispatcher;
custom/newer layouts need manual review. Uninstall identifies recognized
entries but leaves all manager files unchanged. The
[coexistence contract](migration.md#keep-an-existing-hook-manager) lists the
supported forms and remediation rules.

## Will it change code or commits automatically?

Hook checks are read-only. Changes happen only after an explicit fix command:

```bash
npm run fix:staged
npm run commit:fix
```

`fix:staged` refuses files with overlapping staged and unstaged changes.
`commit:fix` refuses dirty tracked worktrees, detached or signed commits,
commits retained by local tags or known remote refs, and repository states it
cannot inspect safely. Resolve the condition named in the refusal and retry; do
not bypass a safety check merely to force an amend.

## I think I made a Git mistake. Where should I start?

Run the local, read-only guide from inside the project:

```bash
npx --no-install commitment-issues panic
```

It presents the observed state first, explains `git status`, and adds only
context-supported inspection steps for detached HEAD, active
merge/rebase/cherry-pick conflicts, staged or deleted changes, untracked files,
and recent branch switches. Any suggested state-changing option preserves
working-tree content and is labeled separately. The command itself is
deterministic and non-interactive: it never performs recovery, and it withholds
state-changing guidance whenever inspection is incomplete or a conflict is in
progress. Back up important files and ask for help if the explanation does not
match what you intended; the guide cannot promise that Git still contains
missing data.

## How are related tests selected?

The tool looks next to a changed source file, in an adjacent `__tests__`
directory, and in top-level `test` or `tests` directories. For example,
`src/foo.ts` can match `test/foo.test.ts`.

Use `testExempt` for intentional exceptions, `requireTests: false` to disable
the presence check, and `runStagedTests: true` to execute related tests during
commit. `init` enables advisory related tests for pushes. Test-runner examples
and exact matching behavior live in
[Configuration and behavior](configuration.md#unit-test-heuristics).

## How do I use Jest, Vitest, or another runner?

Set `testCommand` to an argument array that accepts test paths. It is explicit
repository-owned configuration and executes without a shell. An array beginning
with `npx` opts into that executable's own package-resolution and possible
network behavior. Install the runner locally or select its offline/no-install
mode when the hook must remain network-isolated.

## Will missing tools be downloaded automatically?

No. Built-in ESLint, Prettier, and optional commitlint integrations resolve only
project-local binaries. Hooks report a missing tool and the detected package
manager's install command; fix commands fail because they cannot claim the
requested fix succeeded. There is no implicit `npx`, global lookup, registry
request, or install fallback.

## How do I enable commit-message linting?

Install project-local commitlint and its rules, set
`commitMessage.enabled: true`, then run `init` or `doctor` to wire the hook.
`blockOnFailure` is a second opt-in. The tool does not bundle commitlint or
invent a Conventional Commits policy. See
[Optional commit-message linting](configuration.md#optional-commit-message-linting).

## Where can configuration live?

Use `package.json` → `precommitChecks`, a repository-root
`.commitmentrc.json`, or both. Standalone keys override matching package keys;
unmatched package keys remain active. Both sources are JSON and are validated
without importing project code. See
[Configuration files and precedence](configuration.md#configuration-files-and-precedence).

## Does it collect telemetry or upload repository data?

No. The package has no telemetry, hosted service, repository upload, or runtime
phone-home request. It reads local Git/project state and runs local tools.
Installing dependencies, performing `git push`, or selecting a network-capable
`testCommand` can use the network independently. The
[security assurance case](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/security/assurance-case.md)
defines the complete trust boundary.

## What projects and package managers are supported?

The supported v3 product targets JavaScript and TypeScript projects running
Node.js >=22.11.0. Local installs through npm, pnpm 10, Yarn Classic 1.22.22,
Yarn Berry 4.17.0 with `nodeLinker: node-modules`, and Bun 1.3.14 are supported.
TypeScript file discovery is built in, while parsing and lint rules remain
owned by the project's ESLint setup.

Yarn Plug'n'Play is unsupported. Global installs are unsupported because
hooks intentionally invoke the project-local bin. Install once at a monorepo
root and use root-owned configuration/tools. See the
[compatibility](compatibility.md), [Yarn Berry](yarn-berry.md),
[monorepo](monorepo.md), and [framework](framework-recipes.md) guides for the
tested boundaries.

## Which shells and GUI Git clients are supported?

The main matrix runs on Ubuntu, macOS, and Windows. Generated hooks are POSIX
`sh`; Git for Windows uses its bundled shell. Node.js and the local binary must
still be reachable in the environment inherited by Git.

Required CI launches the packed artifact through Linux `/bin/sh`, Bash, and
Fish; macOS `/bin/sh` and Zsh; and Windows PowerShell and Command Prompt. Each
lane performs a real commit and push with a stripped `PATH`; the hooks
themselves continue to run under POSIX `sh` (Git's bundled `sh` on Windows).

VS Code Source Control, one current IntelliJ IDEA or PyCharm version, and
GitHub Desktop on macOS and Windows require separate UI validation. Those
v3.4.0 lanes are currently unverified and tracked in
[#231](https://github.com/RoryGlenn/commitment-issues/issues/231). An integrated
terminal proves its selected shell, not the GUI client's inherited environment.
See the [compatibility matrix](compatibility.md) and the
[GUI checklist](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/git-client-release-checklist.md).

## Should I use this in CI?

Keep CI authoritative. Local hooks improve feedback latency but can be bypassed
or absent. Run normal lint, formatting, and test commands directly in CI and set
`COMMITMENT_ISSUES=0` when installs should skip local hook behavior. See the
[CI recipes](ci-recipes.md).

## How do I show success messages or playful wording?

Set `hookOutput: "normal"` to show routine hook success/info boxes. Set
`tone: "fun"` for relationship-themed advisory text. Neither setting changes
checks, safety decisions, JSON, or exit codes. The complete public gallery is
maintained in the repository's
[message-state documentation](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/message-states.md).

## How can I verify a release?

Follow [Release verification](release-verification.md) to compare the npm and
GitHub tarballs, verify npm signatures/attestations, and validate the attached
SLSA provenance against the artifact digest and source tag.

## How do I remove it?

Run removal while the package is still installed:

```bash
npx --no-install commitment-issues uninstall --dry-run
npx --no-install commitment-issues uninstall
npm remove commitment-issues
```

The uninstaller removes exact generated scripts, configuration, and owned hook
bodies. It preserves customized hooks/scripts, shared ignores, ESLint, Prettier,
the lockfile, and anything whose ownership cannot be proven.

## Why is Node.js 22.11.0 the minimum?

Node.js 22.11.0 is the first Node 22 LTS release and the minimum exercised by
the CI matrix. Node 24 is tested as well. Older runtimes are outside the
supported release contract.

## Git terms used in this project

Git uses short names for different versions of the same files. This glossary
explains those names and why they matter to `commitment-issues`.

### Working tree

Your **working tree** is the checked-out copy of the project: the files as they
currently exist on your computer. A file there can match what is staged,
contain additional unstaged edits, or be unchanged. The safe-fix commands
inspect the working tree so they do not overwrite work you still need.

### Staged changes and the index

**Staged changes** are the exact file versions selected for the next commit.
Git keeps that selection in a hidden staging area, also called the **index**.

For example, imagine you select `app.js` and then edit it again. The commit
still gets the earlier, staged version unless you select the file again.
`commitment-issues` checks the staged version because that is what the commit
is about to save.

### Unstaged changes

**Unstaged changes** are edits to a tracked file that are not selected for the
next commit. They stay on your computer after that commit. The explicit fix
commands keep them separate and refuse a fix when they cannot do that safely.

### Untracked file

An **untracked file** exists in the project folder, but Git is not currently
tracking it. For example, a new `notes.txt` file stays out of a commit until you
choose to stage it. A commit check does not add an untracked file merely because
it exists.

### Partially staged file

A **partially staged file** has one version selected for the next commit and
more edits to that same file left unstaged. The next commit would contain the
selected version, while the extra edits would stay on your computer.

A formatter could accidentally mix those two versions. That is why
`npm run fix:staged` refuses a partially staged file instead of guessing what
you meant.

### Git hook

A **Git hook** is a small program that Git runs at a particular moment, such as
before a commit or push. `commitment-issues init` connects the package to local
hooks so it can check work at those moments. The hooks belong only to that
clone, and their warnings do not block by default.

### Upstream branch

An **upstream branch** is the branch or other Git reference that a local branch
is configured to follow. It is usually a remote-tracking branch such as
`origin/main`, but it can be another local reference. For a remote-tracking
upstream, fetching updates Git's last-seen version. Git can then tell whether
your local branch is behind it. `commitment-issues` uses this information for
its behind-upstream advice and can use it as a comparison point during a push.
It does not fetch from the network for you.

### Default branch and protected branch

The **default branch** is the repository's usual starting and merging branch,
often `main`. A **protected branch** is a branch name treated as needing extra
care. A branch can be both, but the two terms do not mean the same thing.

`commitment-issues` warns about direct commits and pushes to `main` and
`master` by default. It blocks only when the repository explicitly enables
that behavior. Rules enforced by a Git hosting service are separate.

### Amend

To **amend** is to replace the latest commit with a new version instead of
adding another commit. The commit's identifier changes. `npm run commit:fix`
amends only when the latest commit is attached, unsigned, absent from locally
known protected refs, and the tracked working tree is safe; otherwise it
refuses. The check stays offline, so fetch first if the local remote-tracking
snapshot needs to include newer remote refs.

### Detached HEAD

**HEAD** is Git's name for what you currently have checked out. A **detached
HEAD** means HEAD points directly to a commit instead of to a branch name. You
can inspect or test that commit, but a new commit is not automatically attached
to your normal branch.

Without a branch name, `commitment-issues` cannot apply its branch-name warning.
Its non-branch checks still run.

### Reflog

The **reflog** is a private, local list of places where HEAD and branch names
pointed recently. Git normally records the move caused by an amend, so the
reflog can help you find the older commit identifier.

The reflog is not shared when you push and is not a permanent backup.
`commitment-issues` never treats it as permission to rewrite pushed history.
