# Maintainer operations

This repository-only guide covers routine maintenance, dependency policy,
package contents, and release housekeeping. User installation and configuration
belong in the [README](../README.md) and
[configuration reference](configuration.md).

## Dependencies

### Sources and selection

Dependencies come from the npm ecosystem and are declared in `package.json` and
locked in `package-lock.json`. The project does not vendor convenience copies of
third-party source code.

Add a dependency only when it provides clear value beyond a small project-local
implementation. Review:

- maintenance activity and license compatibility;
- transitive footprint and supported Node.js versions;
- runtime network or execution behavior;
- whether built-in Node.js APIs can provide the same result; and
- whether the dependency materially improves safety, portability, or
  maintainability.

GitHub Actions are dependencies too. Keep third-party actions pinned to immutable
commits and let Dependabot propose reviewed updates.

### Installation and tracking

Developers use `npm install` when intentionally changing dependencies. CI uses
`npm ci` so resolution matches the committed lockfile. Review `package.json`,
`package-lock.json`, and `.github/dependabot.yml` like source code.

Dependency update pull requests should identify the change, preserve the
lockfile, pass CI, review unexpected transitive changes, and update documentation
when installation, runtime behavior, or platform support changes.

For a reported vulnerability, determine whether the dependency and vulnerable
path are reachable, update or remove it when practical, document material
residual risk, and release a fix when users may be affected.

## Automated repository health

Automated repository health and a
[Repository Health Review](repository-health-reviews.md) are complementary.
This section covers continuous and weekly drift detection. An RHR is the
versioned, evidence-recording human assessment used quarterly, semiannually, or
after a material event. A green workflow run is input to the applicable RHR
domain; it is not a complete RHR by itself.

Dependabot checks npm dependencies and GitHub Actions each Monday in the
`America/New_York` time zone. Low-risk minor and patch updates are grouped to
reduce pull request noise; grouped updates still require normal review. Routine
version releases must be at least seven days old before Dependabot proposes
them. Security updates bypass that cooldown.

The required CI `quality` job runs lint, formatting, actionlint 1.7.12, and
`npm audit --audit-level=high` once on Ubuntu/Node 24. The actionlint archive is
version-pinned and checksum-verified; it checks workflow syntax, expressions,
action inputs, inline shell, and common injection hazards before `CI Success`
can pass. Dependabot updates action references, but not this downloaded binary;
update the actionlint version and its official Linux AMD64 checksum together
during a deliberate automation-maintenance change. The exact `concurrency.queue`
diagnostic is temporarily ignored because GitHub supports the property while
actionlint 1.7.12's bundled schema does not; remove that suppression once the
pinned validator understands `queue`.

The weekly and manually dispatchable `Repository Health` workflow runs:

```sh
npm ci
npm test
npm run test:lifecycle:npm
npm audit --audit-level=high
```

The weekly run retains tests and the packed npm lifecycle to catch Node, runner,
registry, and other time-dependent drift while avoiding duplicate static checks
and package inspection. A high-severity advisory fails both required CI and the
weekly workflow visibly. Review production reachability, whether the finding
affects runtime or development tooling, and whether a safe update exists; do not
silence the gate without a documented disposition.

The workflow reports branches that have not changed in 90 days but does not
delete them. Before deleting a branch, confirm that it has no open pull request
and is merged or no longer needed. Prefer GitHub's **Automatically delete head
branches** setting for merged pull requests.

Preview or create an immutable parent plus one issue per control-catalog domain
with `node tools/rhr.mjs ...`. Preview is the default; the explicit `--create`
mode takes repeated historical-issue snapshots and refuses a partial run.
`--resume` fills a confirmed interrupted run without duplicating a parent or
domain. The complete start, evidence, finding, closure, health-rating, and
revisit procedure is in the RHR guide.

## Demo asset verification

The `Render demo` workflow regenerates `assets/demo.gif` and preserves the
unmodified artifact for review. Its metadata gate allows at most two frames or
0.10 seconds of timing drift. Its visual gate uses a `0.997` SSIM minimum and
masks only the four documented volatile runtime regions.

The gate is intended to reject changed messages, layout or color shifts,
clipping, and missing scenes. Update the committed GIF only after reviewing the
artifact; do not lower the threshold to accept an unexplained mismatch.

## Before/after asset verification

`assets/before-after.svg` is the editable, accessible source for the comparison
story. Regenerate the social upload after every source change:

```sh
ffmpeg -nostdin -hide_banner -loglevel error \
  -f svg_pipe -i assets/before-after.svg \
  -frames:v 1 -y assets/before-after.png
```

The PNG must remain 1200×675. Review both files at full size, 600 pixels wide,
and a mobile-width preview. Within two seconds, a viewer without software
experience should be able to read the picture as “send, wait, find a mistake,
and redo” versus “spot it, fix it, and send once.” Keep visible copy to at most
35 words and out of software jargon; the accessible title retains the
canonical “Catch mistakes while they're still cheap to fix” promise. The
`Render demo` workflow regenerates the PNG, uploads the rendered artifact for
inspection, and requires it to byte-match the committed export.
`test/visual-assets.test.mjs` checks that workflow contract plus the
dimensions, plain-language story, cross-surface references, and demo's
absolute 20–30 second duration.

## Product Hunt asset verification

The Product Hunt pack reuses the comparison story and keeps the remaining
cards as editable SVGs. Regenerate the complete upload set with the same
commands used by the `Render demo` workflow:

```sh
ffmpeg -nostdin -hide_banner -loglevel error \
  -f svg_pipe -i assets/product-hunt-thumbnail.svg \
  -frames:v 1 -y assets/product-hunt-thumbnail.png
ffmpeg -nostdin -hide_banner -loglevel error \
  -f svg_pipe -i assets/before-after.svg \
  -vf pad=1270:760:35:42:color=0x060a18 \
  -frames:v 1 -y assets/product-hunt-01-before-after.png
ffmpeg -nostdin -hide_banner -loglevel error \
  -f svg_pipe -i assets/product-hunt-02-setup.svg \
  -frames:v 1 -y assets/product-hunt-02-setup.png
ffmpeg -nostdin -hide_banner -loglevel error \
  -f svg_pipe -i assets/product-hunt-03-advisory.svg \
  -frames:v 1 -y assets/product-hunt-03-advisory.png
ffmpeg -nostdin -hide_banner -loglevel error \
  -f svg_pipe -i assets/product-hunt-04-safe-fix.svg \
  -frames:v 1 -y assets/product-hunt-04-safe-fix.png
```

The thumbnail must remain 240×240 and below 3 MB. Each numbered gallery card
must remain 1270×760 and below 130 KB. Review the cards in their documented
order at full size and at 600 pixels wide. Card 1 must explain the value without
software knowledge; cards 2–4 may then show the real commands and advisory-first
flow. The listing fields, order, and alt text are canonical in
`promo/launch.md`. The render workflow uploads the regenerated pack and
byte-compares it with the committed exports.

## npm package contents

Use this command to inspect the exact release manifest:

```sh
npm pack --dry-run --json --ignore-scripts
```

The package boundary is explicit:

| Class                          | Included in npm? | Contents                                                                                                      |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Runtime                        | Yes              | Explicit CLI, command, and transitive helper paths in `package.json`                                          |
| User documentation             | Yes              | Explicit guides in `package.json`, `README.md`, `CHANGELOG.md`, and `LICENSE`                                 |
| Relative README assets         | Yes              | Only SVGs referenced by relative path in the installed README                                                 |
| Lifecycle and coverage tooling | No               | The six repository-only modules classified in `branch-coverage.md`                                            |
| Maintainer and audit evidence  | No               | Repository-only planning, galleries, reviews, and operational records                                         |
| Promotional media              | No               | `assets/commitment-issues.png`, the before/after and Product Hunt source/export assets, and `assets/demo.gif` |

The runtime script allowlist is intentionally file-by-file. The
[coverage policy](branch-coverage.md#source-scope) records the complementary
maintenance-only set. Package tests compare those classifications with the
actual `npm pack` manifest, require the public bin target, and follow every
relative runtime import so a helper cannot be omitted accidentally. New scripts
remain out of npm until a maintainer deliberately classifies them.

The README loads the hero PNG, before/after SVG, and demo GIF from stable GitHub
URLs so npm can render them without adding promotional media to every package.

Relative links in shipped Markdown must resolve within the exact `npm pack`
manifest, not merely within the source checkout. Package tests validate that
boundary directly, and the package-manager lifecycle validates it again from a
clean installed copy. When shipped documentation needs repository-only policy,
planning, or audit evidence, use its canonical GitHub URL rather than expanding
the npm package solely to make the link resolve.

The tarball must remain at or below **350 KiB compressed** and **812 KiB
unpacked**. Tests fail when the budget is exceeded, required runtime or
user-documentation files are missing, maintenance tooling or internal evidence
enters the tarball, or promotional media is included. Do not raise the limits
merely to accommodate documentation or media growth; a change must identify
the reviewed runtime requirement and measured package delta that needs the
additional space.

The unpacked ceiling includes the roughly 26 KiB measured increase from the
reviewed concurrent-fix transaction runtime added for issue #303. It increased
from 800 to 806 KiB for issue #307's worktree-root resolution, whose runtime and
user documentation add 5,804 measured unpacked bytes. It increased from 806 to
812 KiB for issue #308's active-operation guard, whose runtime, changelog, and
user documentation add 6,009 measured unpacked bytes. The compressed ceiling
did not need to change.

## Release candidate identity

The normal release's authoritative byte-level candidate is the tarball created
once by the hosted tag workflow and accepted by its recovery and publication
gates. Retain its run-summary filename, SHA-256, release tag, source commit,
runner OS/image, and exact Node/npm versions with the release evidence. Local
pre-tag packs remain useful for manifest, lifecycle, and compatibility review,
but their digests are scoped to their recorded environments; an equal extracted
tree does not establish equal compressed bytes.

Use the separate archive-byte and extracted-tree procedure in
[Release Verification](release-verification.md#authoritative-candidate-identity)
when comparing candidates. Do not turn a clean tree comparison into a claim
that the archive hashes match.

## Partial release incidents

Do not rerun a failed tag workflow until the release state is known. Record the
exact version, tag, peeled tag commit, workflow run ID/attempt and head SHA, job
conclusions, npm public version/provenance/dist-tags, durable npm stage
record/ID, and GitHub Release draft, immutability, and asset state. A failed or
malformed lookup is unknown state, not evidence that an artifact or stage is
absent.

Use the state table and byte-verification procedure in the
[release-verification guide](release-verification.md#partial-publication-and-recovery):

- Before stage, a failed-job retry is allowed only when the public npm version,
  stage record, and every GitHub draft/release are absent, the failure is
  transient, and neither source nor workflow needs an edit.
- Once staged, never fully rerun the tag workflow or stage the same version
  again. Resume only failed downstream jobs that retain the original stage
  record and provenance. If that durable identity is unavailable, resolve the
  npm stage explicitly and fix forward with a new patch.
- After maintainer 2FA approval, the explicit finalizer may resume only when the
  exact tag, successful source run/attempt, stage ID, npm provenance, source
  commit, retained tarball bytes, complete draft, and `dist-tags.latest` all
  name the same candidate.
- Immediately after approval, the release verifier tolerates only
  exact-version or exact-attestation HTTP 404 propagation. Six bounded backoffs
  run inside a hard 60-second deadline; every other failure or mismatch remains
  immediately terminal.
- The tag run cryptographically verifies its local SLSA bundle and requires one
  complete exact draft before it shows approval instructions. The finalizer
  downloads the tarball, provenance, and stage record from that successful
  source run and cannot stage or publish npm.
- An empty or partial published release cannot be repaired because published
  releases and assets are immutable. Preserve it and release a new patch.
- A complete matching npm version and immutable GitHub Release require no
  action.

Never move or reuse a consumed tag, republish an existing npm version, delete
or replace a published release asset, or use `npm unpublish`. If an incomplete
version points `latest`, first verify a known-complete exact version. Moving the
dist-tag and deprecating the incomplete version are explicit npm-owner actions,
never automated recovery steps. Record the authorization, commands, results,
and replacement version in the incident issue.

## Release and housekeeping checklist

- Review open Dependabot pull requests and unexpected lockfile changes.
- Confirm CI, DCO, CodeQL, and OpenSSF Scorecard are passing.
- Review the weekly repository-health output.
- Delete stale branches only after confirming they are safe to remove.
- Run `npm pack --dry-run --json --ignore-scripts` and review the exact files
  and sizes.
- Run the release collision preflight before versioning.
- Retain the hosted candidate summary containing its digest, source, tag,
  runner OS/image, and exact Node/npm pack toolchain.
- Confirm the npm trusted publisher remains stage-only and traditional tokens
  remain disallowed; retain the stage ID, stage record, and successful source
  run ID with the release evidence.
- Classify any failed tag workflow before authorizing a retry or registry
  metadata change.
- Follow the [release-verification guide](release-verification.md) after
  publishing.
- Complete and retain the exact-artifact
  [GUI Git-client checklist](git-client-release-checklist.md) before claiming
  verified GUI-client support. Otherwise mark unavailable lanes unverified,
  narrow the support claim, and link a follow-up issue; shell-matrix success
  does not substitute for client-started Git operations.
- Complete the recurring
  [sensitive-access checklist](project-roles.md#recurring-access-review), record
  dated evidence, and resolve expired contributor grants before each release.
