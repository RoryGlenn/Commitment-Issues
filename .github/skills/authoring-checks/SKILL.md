---
name: authoring-checks
description: "How to add or modify commitment-issues commands, hook checks, and shared helpers (pure ESM .mjs, no build step, Node >=22.11.0). USE WHEN: adding a new pre-commit/pre-push/commit-msg check; editing an entry script (cli/init/doctor/precommit/prepush/commit-msg/commit-fix/fix-staged); adding a scripts/lib helper; spawning a tool or git; printing terminal boxes; reading precommitChecks config; wiring the standard/fun tone message system. Covers the advisory-first philosophy, the process/ui/message/config/files/package-manager libs, and where each pattern belongs."
---

# Authoring Commands, Checks & Helpers

`commitment-issues` is **pure ESM `.mjs` with no build step and no transpile** (Node `>=22.11.0`). Entry-point commands live in `scripts/`; shared, unit-tested helpers live in `scripts/lib/`. Match the surrounding code: small composable functions, clear names, comments only where intent is non-obvious.

## The guiding philosophy: advisory-first

The whole tool is **advisory by default, enforcement opt-in**. A check should:

- Report problems without discarding unstaged work, rewriting pushed history, or blocking by default.
- Refuse to mutate when staged and unstaged changes overlap (never silently lose work).
- Suggest a safe follow-up command (`npm run fix:staged`, `npm run commit:fix`) instead of auto-mutating.
- Gate stricter/blocking behavior behind an explicit `precommitChecks` opt-in (e.g. `blockPushOnTestFailure`, `runStagedTests`).

When in doubt, warn and continue — do not fail the hook.

## Where things go

| Layer                      | Location                                               | Tested by                 |
| -------------------------- | ------------------------------------------------------ | ------------------------- |
| Command / hook entry point | `scripts/<name>.mjs` (top-level code + `process.exit`) | subprocess in a temp repo |
| Reusable logic             | `scripts/lib/<name>.mjs` (pure, exported functions)    | in-process unit test      |

Push pure logic **down into `scripts/lib/`** so it can be unit-tested directly; keep the entry script a thin orchestrator. See the `testing-and-coverage` skill for the exact test mechanics.

## The `scripts/lib/` toolkit — use these, don't reinvent

### `process.mjs` — spawning tools & git

- `run(command, args, options?)` — `cross-spawn` sync wrapper (utf8). Use `cross-spawn` (not `node:child_process` directly) so bare names resolve on Windows without a shell and avoid DEP0190.
- `toolInvocation(name, extraArgs)` — resolves a tool's CLI entry from the nearest `node_modules` `bin` and returns `{ command, args }` to run it with the current Node, skipping npx startup cost. Prefer this for eslint/prettier/etc.
- `local-tool.mjs`: `localToolInvocation(name, extraArgs, cwd)` resolves only a project
  `node_modules/.bin` executable and returns `null` when absent. Use for optional
  integrations such as commitlint that must never fall back to npx/global/network.
- `spawnAsync(command, args, options?)` — async spawn with the shared timeout
  and invocation-wide `SIGHUP`/`SIGINT`/`SIGTERM` process-tree cancellation.
  Keep long-running commands on this boundary so attached descendants are
  reclaimed and unreclaimable inherited pipes cannot outlive a bounded cleanup
  grace before signal-appropriate exit.
- `TOOL_TIMEOUT_MS` — default 120s ceiling so a hung tool can't wedge a commit; overridden by `precommitChecks.timeoutMs` (positive number).
- `isPackageInstalled(name, cwd)` — **fs-based** walk up `node_modules/<name>/package.json`. Must stay fs-based: a package whose `exports` map hides `package.json` makes `require.resolve('<name>/package.json')` throw (false negative). Do not "simplify" it to `require.resolve`.

### `ui.mjs` — terminal output

- `printBox(message, color?, options?)` — rounded padded `boxen` box.
- Severity boxes (each takes an array of pre-formatted lines): `infoBox` (cyan), `successBox` (green), `warningBox` (yellow), `errorBox` (red). Colors come from `picocolors`.
- Keep output compact and advisory — explain what happened, what's safe next, and when the tool refused to act.

### `message.mjs` — advisory text & tone

- `buildAdvisoryMessage(...)` composes the user-facing lines.
- `buildCommitMessageCheckMessage(...)` composes optional commitlint outcomes.
- Two tones: `standard` (default) and `fun`, selected by `precommitChecks.tone`. The `fun` tone rewrites the **standard** wording via regex matches on the canonical message, so when you add a new standard message string, add the matching fun variant and cover it in `test/fun-tone.test.mjs`. Standard wording is the source of truth (tests assert on it).

### `config.mjs`

- `loadPrecommitConfig()` — reads root `.commitmentrc.json` plus the
  `precommitChecks` object from `package.json`; standalone keys win. It returns
  only sanitized values and never throws. All config access goes through here.
- `resolveCommitMessageConfig()` — resolves the sanitized nested opt-in to
  explicit disabled/advisory defaults.
- `resolveShowWelcomeOnFirstCommit()` — preserves the default-on onboarding
  behavior unless a project explicitly opts out.

### `files.mjs`

- `codeFilePattern`, `formatFilePattern`, `findTestFile`, `isTestExemptFile`, `collectTestsForFiles`, `shortFileList`. Use `isTestExemptFile` to honor `precommitChecks.testExempt` globs (e.g. `scripts/lib/**`).

### `fix-safety.mjs`

- `captureFixSnapshot`, `runFixTools`, `applyFixOutputs`, and
  `stageFixOutputs` bind explicit fixer commands to exact `HEAD`, index
  identity/bytes/tree, and target bytes. Use this transaction for live
  worktree or index mutation; do not pass live target paths to writable
  formatter modes or replace exact blob staging with `git add`. Captured-input
  tool processes use bounded concurrency and share one `timeoutMs` deadline
  across the complete fix operation. Parent-signal cancellation and timeout
  cleanup must continue to share the same idempotent tracked-tree operation.

### `package-manager.mjs`

- `runScript(...)`, `devInstallCommand(pkgs, cwd)` — per-manager strings (npm/pnpm/yarn/bun) so output and smokes stay manager-agnostic.

### `checks.mjs`

- `summarizeEslintJson`, `eslintManualIssues`, `parsePrettierList` — parse tool output into issue summaries. Add new tool parsing here.

## Git invocation convention

Always force stable, unquoted paths when parsing git output:

```js
const GIT_PATH_ARGS = ["-c", "core.quotePath=false"];
run("git", [...GIT_PATH_ARGS, "diff", "--name-only", "--cached"], { cwd });
```

Never assume `/` separators when consuming git paths — normalize (`replace(/\\/g, "/")`) before matching, and keep everything cross-platform.

## `precommitChecks` config surface

Read via `loadPrecommitConfig()`. The supported keys are grouped by behavior:

- Test execution: `requireTests`, `runStagedTests`, `advisePushTests`,
  `blockPushOnTestFailure`, `testCommand`, and `testExempt`.
- Branch and commit guards: `protectedBranches`, `blockProtectedBranches`,
  `adviseBehindUpstream`, `maxCommitFiles`, `maxCommitLines`,
  `maxFileSizeMb`, and `generatedPaths`.
- Commit messages: nested `commitMessage` settings (enabled and
  blockOnFailure).
- Secret scanning: `scanSecrets`, `blockOnSecrets`, and `secretExempt`.
- Debug-artifact advisory: `scanDebugArtifacts` and `debugArtifactExempt`.
- Shared behavior: `timeoutMs`, `tone`, `hookOutput`, and
  `showWelcomeOnFirstCommit`.

`KNOWN_PRECOMMIT_CONFIG_KEYS` in `scripts/lib/config.mjs` is the source of
truth. If you add a key, update [`docs/configuration.md`](../../../docs/configuration.md),
[`docs/external-interface.md`](../../../docs/external-interface.md), this list,
and the default-behavior tests. `test/metadata.test.mjs` prevents those three
documentation surfaces from drifting away from the source allowlist.

## Checklist for a new/changed check

1. Put pure logic in a `scripts/lib/*.mjs` export; keep the entry script thin.
2. Default to **advisory** output via `warningBox`/`infoBox`; gate any blocking behavior behind an explicit `precommitChecks` flag.
3. Use `toolInvocation`/`spawnAsync` (not raw npx) and honor `TOOL_TIMEOUT_MS`.
4. Read config only through `loadPrecommitConfig()`.
5. Add standard-tone message strings, then the matching `fun`-tone variant.
6. Unit-test the lib function in-process; subprocess-test the entry behavior in a temp repo.
7. Run `npm test && npm run lint && npm run format:check`.
8. Update `docs/` (configuration/message-states) and the `## [Unreleased]` block in `CHANGELOG.md` for any user-visible change.
