# Terminal UX and Output Architecture Audit

This is the completion report for
[audit workstream #133](https://github.com/RoryGlenn/commitment-issues/issues/133).
It covers every published human and JSON output boundary, the one-box
invariant, message composition, Boxen ownership, color and width behavior,
redirected output, Unicode, accessibility evidence, the live message-state
runner, and generated terminal assets.

## Executive summary

The audit found no unresolved Critical or High issue. It reproduced and fixed
three Medium runtime defects, one Low gallery-evidence defect, and two
assertion gaps:

1. The once-per-clone welcome rendered before pre-commit checks, so a first-run
   warning, error, or normal-mode result could produce two boxes. Findings now
   take priority, leave the welcome marker unconsumed, and allow onboarding on
   the next clean or informational invocation.
2. Boxen could throw a `RangeError` before any user guidance appeared when a
   launcher supplied `COLUMNS=0`, `1`, `2`, malformed text, or an unsafe large
   integer. The shared renderer now retries with the smallest valid rounded
   box while preserving all semantic content.
3. Picocolors treated the string value in `FORCE_COLOR=0` as truthy, so the
   severity body remained colored even though Boxen removed its border color.
   The shared renderer now strips preformatted escapes and omits border color
   whenever color is explicitly disabled.
4. The live message-state runner changed `package.json` only to expose normally
   quiet states but left that change dirty. Its auto-fixable example therefore
   hid the safe `commit:fix` recommendation and claimed unrelated worktree
   changes existed. Presentation-only fixture configuration is now committed
   before each scenario.

The audit also replaced two assertion gaps with executable evidence: every
exercised JSON payload is recursively checked against the published schema,
and every committed SVG must expose an accessible title and description.

The existing configurable-style issue
[#86](https://github.com/RoryGlenn/commitment-issues/issues/86) remains the
explicit owner for a borderless ASCII `plain` mode and a quieter `minimal`
mode. This workstream verifies deterministic, color-free redirected output but
does not implement the full style feature. Cross-shell and GUI Git-client
execution remains owned by
[#83](https://github.com/RoryGlenn/commitment-issues/issues/83) and the
cross-platform audit workstream; this report does not turn a local macOS run
into a Windows Terminal, PowerShell, Command Prompt, VS Code, or JetBrains
claim.

## Scope inventory

| Group                    | Current inventory and evidence                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository               | 238 tracked files at audit start; this report is the workstream's only new file.                                                                                          |
| Published runtime        | 27 measured modules. Every module has a named test owner and remains in the 100% runtime coverage denominator.                                                            |
| Public human entrypoints | CLI help/version/errors; `init`; `uninstall`; `doctor`; `precommit`; `commit-msg`; `prepush`; `commit-fix`; `fix-staged`; the compatibility fixer entrypoint; and `vows`. |
| Shared presentation      | `scripts/lib/ui.mjs` is the only Boxen importer. Severity models use `{ severity, lines }`; commands do not construct borders directly.                                   |
| Machine output           | `precommit --json` and `prepush --json`, versioned by `docs/json-output.schema.json`; tool output is kept off JSON stdout.                                                |
| Live gallery             | 42 real-command scenarios in disposable repositories. Each scenario fails the runner if it exits unexpectedly or renders more than one box.                               |
| Static gallery           | 66 generated message-state SVGs documented in `docs/message-states.md`; exact regeneration is tested.                                                                     |
| Visual assets            | All 85 committed SVGs require `role="img"`, `aria-labelledby`, a non-empty `<title>`, and a non-empty `<desc>`.                                                           |
| Top-level tests          | 44 files covering units, subprocesses, real Git repositories, JSON, message states, assets, packaging, and repository policy.                                             |

Repository-only maintenance commands were inspected for accidental overlap,
but their progress output is not part of the installed CLI compatibility
contract.

## Output architecture

The presentation boundary is centralized:

1. Check and command logic produces semantic findings or line models.
2. `scripts/lib/message.mjs`, `welcome.mjs`, `vows.mjs`, or the operational
   command composes user-facing content.
3. `scripts/lib/ui.mjs` owns Boxen, severity-to-color mapping, border styling,
   width recovery, and the hook-output visibility policy.
4. Hook entrypoints render at most one final model. Raw formatter/test-runner
   output may appear outside that model, as documented by the one-box contract.

No business module imports Boxen. The existing model seam is sufficient for
future style work without adding #86's CLI/configuration surface during this
audit.

Human box output is written to stdout. Configuration diagnostics and bounded
plain operational warnings use stderr. In JSON mode, stdout contains exactly
one JSON document plus a newline; pre-push child output is redirected to stderr
and summarized structurally. Quiet install repair intentionally uses plain
lines and never a box.

## Public-state coverage map

| Boundary        | States and policy                                                                                  | Primary evidence                                                                |
| --------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| CLI dispatcher  | help, version, missing/unknown commands, suggestions, invalid argument contracts                   | `test/cli.test.mjs`, `docs/audits/core-cli-git.md`                              |
| Init            | setup, preview, idempotence, project/config errors, ownership conflicts, combined warnings         | `test/init*.test.mjs`, message-state gallery                                    |
| Uninstall       | preview, successful removal, preserved custom state, unsafe project/config errors                  | `test/uninstall.test.mjs`, message-state gallery                                |
| Doctor          | healthy, repaired, unrepairable, foreign/custom hooks, config/tool advisories, quiet lines         | `test/doctor.test.mjs`, message-state gallery                                   |
| Pre-commit      | clean/no-op, advisory checks, blocking guards, first-run welcome, problems-only/normal, JSON       | `test/precommit.test.mjs`, `test/welcome.test.mjs`, `test/json-output.test.mjs` |
| Commit message  | disabled/success silence, advisory and blocking findings, missing tool/config, timeout/unreadable  | `test/commit-msg.test.mjs`, `test/message.test.mjs`                             |
| Pre-push        | disabled/manual, selected tests, passed/failed/unavailable, branch policy, combined findings, JSON | `test/prepush.test.mjs`, `test/json-output.test.mjs`                            |
| Explicit fixers | no-op, complete/partial fix, safety refusals, tool/Git failures, recovery instructions             | `test/fix-staged*.test.mjs`, `test/commit-fix.test.mjs`                         |
| Hidden vows     | deterministic content, narrow wrapping, disabled color, no mutation                                | `test/cli.test.mjs`, `test/vows.test.mjs`                                       |
| Shared renderer | severity dispatch, hook suppression, colored border, non-color output, width and Unicode           | `test/ui.test.mjs`                                                              |

`docs/message-states.md` remains the exhaustive human-output catalog. The live
runner is deliberately representative rather than duplicating all static
states; metadata tests require every production box title to appear in the
catalog or one of its referenced SVGs.

## Terminal, color, width, and redirection evidence

| Environment or behavior         | Result                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive/styled presentation | Rounded Boxen output remains the default; forced-color subprocess evidence proves both body and border use the severity color.                                       |
| `NO_COLOR`                      | Captured CI output contains no ANSI escapes while retaining the textual severity, body, Unicode, and border structure.                                               |
| Explicit color disable          | `FORCE_COLOR=0` removes body and border ANSI styling.                                                                                                                |
| Redirected/non-TTY output       | Captured stdout is deterministic, contains one complete presentation, and does not require a TTY to preserve content.                                                |
| Narrow terminal                 | Long paths and prose wrap within `COLUMNS=20`; existing welcome and vows fixtures cover `COLUMNS=24`.                                                                |
| Invalid width                   | `0`, `1`, `2`, malformed text, and an unsafe large integer no longer crash the renderer.                                                                             |
| Long and Unicode content        | Long unbroken paths, `猫`, and `café` survive wrapping and capture. Real-Git path suites cover whitespace, newlines, Unicode, and leading hyphens.                   |
| CI / limited terminal hint      | `CI=1`, `TERM=dumb`, and `NO_COLOR=1` are exercised together. The result is color-free but intentionally retains rounded Unicode borders until #86 provides `plain`. |
| Pipes and JSON                  | Human output remains readable when captured; JSON stdout remains box/progress-free and schema-valid, with child output on stderr.                                    |

## Accessibility review

- Every severity has a textual title (`info`, `success`, `warning`, or
  `error`), so color is not the only signal.
- Messages retain the outcome, consequence, and next action when color is
  disabled. Blocking paths name the one-time Git bypass where policy permits
  it; repairable paths name the retry or recovery action.
- Long content wraps rather than being clipped, including narrow and Unicode
  cases.
- Every committed SVG has an accessible name and description, and gallery
  Markdown supplies contextual alt text.
- The terminal does not yet offer a borderless ASCII mode for screen readers,
  limited fonts, or users who prefer minimal decoration. That is a confirmed
  accessibility/compatibility limitation, dispositioned to #86 rather than
  partially implementing its configuration and precedence contract here.

## Findings and dispositions

| Severity                 | Finding and evidence                                                                                                    | Impact                                                                                       | Disposition                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Medium                   | Welcome rendered before final pre-commit outcome; red regression observed two boxes in `test/welcome.test.mjs`          | Violated the defining one-box invariant and made onboarding compete with actionable findings | Fixed: findings win, marker remains absent, welcome appears on a later eligible run             |
| Medium                   | Boxen threw `RangeError: Invalid count value` for invalid or sub-border `COLUMNS`; red regression in `test/ui.test.mjs` | Any boxed command could crash before explaining its outcome                                  | Fixed in the shared renderer with a bounded three-column retry                                  |
| Medium                   | `FORCE_COLOR=0` disabled Boxen's border but Picocolors still emitted body escapes; red regression in `test/ui.test.mjs` | Explicit color disable was incomplete and could undermine accessibility or captured output   | Fixed centrally by removing preformatted escapes and border color                               |
| Low                      | Live gallery's presentation config remained dirty; red regression hid `npm run commit:fix`                              | Review evidence misrepresented the real safe-amend UX                                        | Fixed by committing fixture-only config; representative regression added                        |
| Low evidence gap         | Payload tests parsed JSON and checked version/top-level fields but did not apply the published schema                   | Schema drift could remain unnoticed inside nested checks/findings                            | Fixed with recursive schema assertions applied to every exercised payload                       |
| Low evidence gap         | Accessibility metadata was asserted only for selected visual assets                                                     | A new SVG could omit an accessible name/description                                          | Fixed with an all-SVG invariant across 85 assets                                                |
| Deferred                 | Rounded Unicode borders/arrows and decorative glyphs remain in color-free output                                        | Not optimized for ASCII-only terminals or every screen-reader preference                     | Existing issue #86 owns `plain` and `minimal` styles, CLI override, persistence, and precedence |
| Deferred external matrix | Native Windows shells and GUI Git clients were not available in the local audit                                         | Local evidence cannot prove those launch and rendering paths                                 | Existing issue #83 and workstream #134 own hosted/manual cross-platform evidence                |

The first four regressions were run red against the defective implementation
before their smallest fixes were applied.

## Verification record

The final checkout was verified on macOS 26.5.2 with Node 26.4.0 and npm
11.17.0. Terminal subprocesses set their own TTY, color, width, CI, and limited
terminal hints rather than inheriting an interactive claim from the host.

| Command                                                            | Result                                                          |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Targeted UI, welcome, message-state, JSON, and visual-asset suites | 57/57 passed                                                    |
| `npm run lint`                                                     | Passed                                                          |
| `npm run format:check`                                             | Passed                                                          |
| `npm test`                                                         | 693/693 passed                                                  |
| `npm run test:coverage`                                            | 693/693 passed; 100% lines, branches, and functions             |
| `npm run coverage:check`                                           | Passed; README branch-coverage badge current at 100.0%          |
| `npm run states`                                                   | 42/42 live scenarios completed with expected exits and ≤ 1 box  |
| `npm run test:lifecycle:npm`                                       | All named packed npm lifecycle/workspace/worktree phases passed |
| `npm pack --dry-run --json --ignore-scripts`                       | 57 files; 137,584-byte tarball, 498,524 bytes unpacked          |
| `git diff --check`                                                 | Passed                                                          |

Hosted Windows and non-npm package-manager results must come from the relevant
CI/audit workstreams; they are not inferred from this local record.

## Conclusion

The workstream is ready to close after the reviewed pull request and final
verification results are linked to #133. The published runtime has one Boxen
owner, user-visible states are cataloged and test-mapped, the one-box invariant
now includes onboarding, hostile width metadata cannot crash presentation,
structured output is schema-checked, and accessibility/platform limitations
have explicit downstream owners rather than unsupported completion claims.
