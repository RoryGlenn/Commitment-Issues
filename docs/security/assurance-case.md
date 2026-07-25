# Security Assurance Case

This assurance case explains why the security requirements for `commitment-issues` are expected to be met.

## Scope

`commitment-issues` is local Git-hook tooling for JavaScript and TypeScript projects. It reads local Git state and project files, runs local tools such as ESLint, Prettier, optional consumer-provided commitlint, and test runners, and prints advisory or blocking terminal output depending on configuration.

The project does not provide a network service, add telemetry, store user
credentials, transmit repository contents, or manage cryptographic keys for
users. Explicit repository-configured commands execute within that repository's
trust boundary and may have behavior of their own.

## Assets

The assets the project is intended to protect include:

- user working trees and staged changes;
- Git history and commit integrity;
- local repository contents;
- developer trust in advisory and blocking output;
- release integrity for the published npm package;
- private vulnerability reports.

## Threat model

Relevant attackers or failure modes include:

- a malicious or compromised dependency;
- a malicious repository configuration value in `package.json` or
  `.commitmentrc.json`;
- file paths containing spaces, tabs, newlines, quotes, shell metacharacters,
  leading hyphens, or unusual Unicode;
- generated, quoted, truncated, or malformed Git output;
- symbolic links or non-file entries at mutable project or native hook paths;
- collisions or link attacks in a shared temporary directory;
- Git hook repository variables redirecting nested fixture operations into the
  caller's repository;
- a compromised GitHub Action or release workflow dependency;
- accidental maintainer mistakes during releases;
- accidental mutation of staged or unstaged work;
- public disclosure of vulnerability details before a fix is ready.

Out of scope:

- compromise of the user's local machine;
- compromise of Git itself, Node.js itself, npm itself, or GitHub itself;
- malicious project-local tools intentionally configured by the repository owner and executed by the developer;
- enforcing organization-specific policy outside the local Git hooks.

## Trust boundaries

Important trust boundaries are:

1. **User repository boundary** — project files, staged content, filenames,
   branch state, and test files are controlled by the repository and may be
   untrusted when running in an unfamiliar project.
2. **Configuration boundary** — `package.json` and `.commitmentrc.json` values
   are user-controlled input and must be parsed and validated before use.
3. **Git boundary** — Git commands can be unavailable or fail, and their
   pathname lists, patches, remote refs, and other output must be parsed
   defensively without treating malformed output as an empty result.
4. **Process and environment boundary** — ESLint, Prettier, optional
   project-local commitlint, repository-configured test runners, Git, and
   package-manager commands are external tools. Built-in peers resolve locally;
   explicit commands and Git intentionally inherit the developer's `PATH` and
   environment, while hook-launched tests exclude Git's repository-local
   routing variables.
5. **Shell and option boundary** — file paths and command arguments must not be
   interpolated into a shell command or allowed to become unintended command
   options.
6. **Filesystem and hook boundary** — existing hooks, configured hook roots,
   symbolic links, permissions, temporary paths, and user-authored files must
   be classified before writing or removal.
7. **CI/CD boundary** — GitHub Actions workflows process untrusted pull-request
   contents and metadata without exposing publication authority.
8. **Release boundary** — tags, npm trusted-publishing credentials, tarballs,
   provenance, and GitHub Releases must preserve package integrity and
   authorization.
9. **Vulnerability-report boundary** — vulnerability reports may contain
   sensitive details and must be handled privately until disclosure is
   appropriate.

## Security requirements

The project security requirements are:

- do not transmit repository contents or telemetry;
- do not expose a network service;
- do not collect, persist, or transmit authentication credentials; inspect
  staged additions only locally for likely secret patterns;
- avoid shell injection when spawning tools;
- validate user-controlled configuration;
- preserve user working-tree safety;
- fail safely when inspecting Git state is not possible;
- keep dependency and release-chain risk visible and manageable;
- handle vulnerability reports privately and responsibly.

## Secure design argument

### Least privilege

The tool runs locally with the developer's existing user permissions and does not require elevated privileges. GitHub Actions workflows use explicit least-privilege permissions where practical.

### Economy of mechanism

The package is pure ESM JavaScript with no build step, no native binaries, no network service, and no telemetry. This reduces the number of security-sensitive moving parts.

### Complete mediation

Git state and configuration are checked at the point of hook execution.
Configuration is parsed only as JSON, shallowly merged using documented
precedence, and allowlisted by key and value before hooks or process helpers use
it. Project JavaScript is never imported to discover configuration. Before
`init` mutates a consumer repository, it also requires the
`package.json` root, `scripts`, and `precommitChecks` containers to be JSON
objects. Existing mutable project paths must be regular files rather than
symbolic links or directories. Their device and inode identities are checked
again against an open descriptor immediately before truncation or writing;
missing paths use exclusive creation, and removal rechecks the inspected
identity. Hook activation uses the same shared classifier in `init` and
`doctor`: only executable command lines count, and POSIX hooks must have an
effective executable-access check; mode bits alone are not treated as proof.

### Fail-safe defaults

Default commit-time behavior is advisory rather than destructive. Push-time,
secret, protected-branch, and commit-message blocking are separate opt-ins. An
advisory secret scan warns and continues when the staged patch is unavailable.
With `blockOnSecrets: true`, a Git spawn failure, nonzero result, or malformed
patch blocks because the absence of a secret has not been established.
Blocking pre-push mode similarly fails closed when pushed files cannot be
inspected; blocking commit-message mode fails closed when its explicitly
configured local tool or rules cannot run. File mutation remains separately
guarded by ownership and working-tree checks.

### Least astonishment

The tool prints explicit messages about what it checked, what it refused to do, and how users can proceed safely. Blocking behavior is only enabled through explicit configuration.

### Defense in depth

The project combines local validation, tests, linting, formatting, CI on multiple platforms, CodeQL, OpenSSF Scorecard, Dependabot, pinned GitHub Actions, and npm provenance.

## Security hardening and dynamic analysis

### Runtime hardening

- Built-in and configured commands use argument vectors instead of shell
  interpolation for file paths.
- Discovered paths for Node's built-in test runner follow `--`; a relative path
  beginning with `-` is made absolute so it remains positional.
- ESLint, Prettier, and optional commitlint resolve only project-local binaries;
  missing tools do not trigger an implicit `npx`, global lookup, registry
  request, or installation.
- Process results distinguish spawn failure, timeout, signal termination,
  ordinary nonzero exit, and success.
- Timed commands terminate their attached POSIX process group or Windows process
  tree, with the documented limitation that deliberately detached descendants
  are outside the portable cleanup boundary.
- `fix:staged` refuses partially staged files, and `commit:fix` refuses dirty
  tracked worktrees, detached or signed commits, and commits retained by local
  tags or known remote refs.
- Mutable project files and fixer targets bind device, inode, link count, and
  timestamps. Existing hardlinked repository paths are replaced rather than
  overwritten, preserving external aliases; mid-run link changes fail closed.
- Path normalization and Git parsing cover POSIX and Windows-style separators,
  spaces, tabs, newlines, quotes, shell metacharacters, leading hyphens,
  Unicode, and diff content that resembles metadata.
- The staged-secret parser validates patch file/hunk structure and Git C-style
  pathname quoting before an enforced scan can succeed.
- Native hook ownership uses `lstat`; hook-file and hook-directory symbolic
  links are preserved as uninspectable instead of followed during repair.
- Pre-push reporter output is written beneath a randomized private temporary
  directory and cleanup is scoped to that owned directory.
- Hook-launched tests and disposable Git-fixture helpers strip repository-local
  Git environment variables before spawning. Tests rediscover the caller by
  cwd, while nested repositories retain their own refs, config, index, and
  remotes.

### Security automation and release evidence

- CodeQL, OpenSSF Scorecard, Dependabot, pinned GitHub Actions, DCO, and the
  aggregate `CI Success` gate keep security-sensitive changes visible.
- The live `main` ruleset separately blocks CodeQL tool-severity Errors and
  High/Critical security alerts after the required analysis completes.
- Stage-only trusted publishing uploads the exact tarball packed, tested, and
  hashed by the candidate job without making it public.
- Maintainer 2FA approval makes that staged npm candidate public only after the
  workflow has prepared a complete draft containing the same tarball and signed
  SLSA provenance.
- A separate finalizer with no npm authority revalidates npm, provenance, the
  source run, stage ID, draft, and assets before making the GitHub Release
  immutable.
- Pull requests that modify the publish workflow exercise its reusable-workflow
  permission contract without publishing.

Before release, automated tests execute hook entrypoints, subprocess behavior,
property-based path/parser cases, working-tree refusal paths, coverage, and the
npm lifecycle in disposable repositories. The suite uses `node:assert/strict`
for runtime invariants. These checks support review but do not replace the
manual threat-model and workflow inspection recorded in dated security reviews.

## Common implementation weakness mitigations

### Command injection

The project avoids shell interpolation for tool execution. Commands are
spawned with argument vectors through Node.js process APIs and `cross-spawn`,
so file paths are passed as arguments rather than shell code. An option
separator protects discovered Node test paths, including repository filenames
that begin with `-`. The generated commit-msg hook quotes Git's `$1`, and the
entrypoint resolves it to one absolute argv value before invoking commitlint.
Lefthook configuration contains no Git-provided argument template: pre-push
uses stdin, while the explicit commit-msg `--git-path` mode asks Git for
the active `MERGE_MSG` or `COMMIT_EDITMSG` path inside the Node process. The
merge-only selection requires Git's `GITHEAD_<object-id>` environment signal
and a regular, non-linked `MERGE_HEAD`; probe, non-regular entries, and unsafe
filesystem failures fail closed into the configured advisory/blocking policy.

Hook-path discovery also treats Git output as a protocol record rather than
free-form text. `core.hooksPath` must be exactly one terminal-NUL-delimited
record; missing or additional delimiters fail closed. Valid values retain
whitespace and distinguish present-empty from unset, while resolved Git paths
lose at most one LF or CRLF terminator. POSIX backslashes are literal path
bytes, not alternate separators, so hostile near-matches cannot acquire Husky
ownership semantics.

### Terminal output injection

Product-owned human presentation treats repository filenames, refs,
configuration, Git/process diagnostics, and command-line arguments as
untrusted. A dependency-free boundary helper strips complete ANSI CSI/OSC
sequences and renders C0/C1 controls as visible `\\r`, `\\n`, `\\t`, or
`\\xNN` text before product styling is applied. The styled box boundary retains
only product-owned SGR sequences and removes other terminal sequences; raw
repository values are escaped before they can reach those styles. Intentional
layout is represented by separate message-model entries, so an embedded newline
in a repository value cannot create a new product line. Unicode, spaces, normal
punctuation, and established bold/dim/severity presentation are preserved.

Captured data that enters a product summary uses array-backed detail fields so
filenames containing newlines remain one semantic value. JSON serialization is
separate from human rendering and preserves those exact values through JSON's
own escaping. Raw child-process output remains a deliberate passthrough outside
the product renderer; users should treat output from explicitly configured
project tools according to that tool's own trust boundary.

### Path handling and path traversal

The project treats Git file lists as data, uses NUL delimiters for pathname
queries, normalizes paths where needed, and includes cross-platform tests for
control characters, shell metacharacters, leading hyphens, Windows-style
separators, and Unicode. The staged-secret parser tracks validated diff hunks
separately from file headers, decodes Git C-style quoted paths, and rejects
malformed structure in blocking mode, so content that resembles metadata does
not bypass inspection.

### Unsafe working-tree mutation

Automatic fixes are guarded. The tool refuses risky mutation when staged and unstaged changes overlap, and `commit:fix` only amends when the working tree is safe enough to do so.

### Crash-safe project-file mutation

Setup and removal do not truncate `package.json`, `.commitmentrc.json`, or
`.gitignore` in place. They stage complete replacement bytes under a randomized
same-directory name, preserve permission bits, sync and close the staged file,
revalidate both staged and destination identities, and then commit through
same-filesystem rename or an exclusive hard link for a previously missing
path. A failed or terminated writer therefore leaves complete old or new
destination bytes. Reserved transaction files are cleaned only when their
encoded writer is no longer active and the entry remains a regular file owned
by the current user; ambiguous entries fail closed.

### Malformed or untrusted configuration

The effective configuration from `.commitmentrc.json` and `package.json` is
allowlisted by key and value. Unknown keys are reported as likely typos.
Invalid values are rejected by omission so the rest of the tool receives only
validated configuration. Hook-time parse failures warn and use the package
fallback; mutating setup/removal commands stop before writing.

### Dependency vulnerabilities

Dependencies are declared in `package.json`, locked in `package-lock.json`, and monitored with Dependabot. Dependency changes are reviewed through pull requests and CI.

Optional commit-message linting does not add commitlint to this dependency
graph. It resolves only the consumer project's `node_modules/.bin/commitlint`
and has no npx, global, or network fallback; the consumer explicitly owns and
trusts both the tool and its executable configuration.

### CI/CD risks

Workflows use explicit permissions and full-SHA action pins, except for the
SLSA reusable-workflow version reference required by that upstream integration.
Security, release, and rendering checkouts disable persisted credentials. CI
runs DCO validation, linting, formatting, tests, coverage, npm package
lifecycle integration, and the pnpm/Yarn/bun lifecycle matrix. The single
strict `CI Success` context aggregates those required jobs.

### Release integrity risks

Releases use unique version identifiers, changelog entries, npm trusted
publishing, the exact packed npm tarball, signed SLSA provenance attached before
the GitHub Release becomes immutable, collision preflight, and documented
independent verification guidance. Release-workflow pull requests also force
GitHub to validate the reusable-workflow permission contract before a tag can
consume it.

The workflow fetches complete canonical history and refuses publication unless
the version-tag commit is reachable from `origin/main`. Live tag rules restrict
new `v*` tags to repository admins and prohibit version-tag updates or deletion.
[Issue #94](https://github.com/RoryGlenn/commitment-issues/issues/94) closed
through PR #188, with the final control and residual trust boundary recorded in
the [release audit](../audits/release-packaging-and-upgrades.md). Provenance
complements that authorization check; it does not replace it.

### Vulnerability disclosure risks

The security policy directs reporters to private vulnerability reporting. Public vulnerability history is maintained separately so disclosure can be coordinated.

## Evidence

Relevant evidence includes:

- [Security, secrets, paths, and subprocesses audit](../audits/security-secrets-paths-subprocesses.md)
- [Security review](../security-review-2026-07.md)
- [Configuration reference](../configuration.md)
- [Maintainer dependency and release operations](../maintainer-operations.md)
- [Release verification](../release-verification.md)
- [Vulnerability history](../vulnerability-history.md)
- [Governance and prospective DCO baseline](../../GOVERNANCE.md)
- [CI workflow](../../.github/workflows/ci.yml)
- [CodeQL workflow](../../.github/workflows/codeql.yml)
- [Dependabot configuration](../../.github/dependabot.yml)
- Guard integration evidence: `test/commit-guards-integration.test.mjs`
- Secret scanner evidence: `test/secret-scan.test.mjs` and
  `test/secret-scan-integration.test.mjs`
- Configuration allowlist evidence: `scripts/lib/config.mjs` and
  `test/config.test.mjs`

## Maintenance

This assurance case should be reviewed when:

- the project adds new runtime behavior;
- the project adds network communication;
- the project changes release tooling;
- the project changes how commands are spawned;
- the project changes configuration parsing;
- a vulnerability is reported or fixed.
