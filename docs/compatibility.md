# Compatibility and installation support

This page is the canonical environment support boundary for
`commitment-issues`. “CI-verified” means a required pull-request job installs
the packed package and exercises its real CLI, native Git hooks, workspaces,
clone repair, linked worktrees, and removal. “Locally verified” records useful
additional evidence but is not a required cross-platform gate. “Manual release
check” means a human must execute and record the named client workflow against
the exact candidate. “Unverified” is not an affirmative compatibility claim.

## Package managers

| Manager or mode                                   | Support     | Required evidence                                                               |
| ------------------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| npm                                               | Supported   | Packed lifecycle on Ubuntu, macOS, and Windows with Node 22.11.0 and 24         |
| pnpm 10                                           | Supported   | Packed lifecycle on all three OSes with Node 24 and on Ubuntu with Node 22.11.0 |
| Yarn Classic 1.22.22                              | Supported   | Packed lifecycle on all three OSes with Node 24 and on Ubuntu with Node 22.11.0 |
| Bun 1.3.14                                        | Supported   | Packed lifecycle on all three OSes with Node 24 and on Ubuntu with Node 22.11.0 |
| Yarn Berry 4.17.0 with `nodeLinker: node-modules` | Supported   | Packed lifecycle on all three OSes with Node 24 and on Ubuntu with Node 22.11.0 |
| Yarn Plug'n'Play                                  | Unsupported | The hook and peer-tool design requires a root `node_modules/.bin` tree          |
| Other package managers                            | Unsupported | No install, lockfile, runner, hint, or lifecycle contract                       |

Install the package and its peer tools locally. The baseline peer versions work
at the exact minimum Node release:

```bash
# npm
npm install -D commitment-issues eslint@^9 prettier@^3
npx --no-install commitment-issues init

# pnpm
pnpm add -D commitment-issues eslint@^9 prettier@^3
pnpm exec commitment-issues init

# Yarn Classic
yarn add -D commitment-issues eslint@^9 prettier@^3
yarn run commitment-issues init

# Yarn Berry 4.17.0 after setting nodeLinker: node-modules
yarn add -D commitment-issues eslint@^9 prettier@^3
yarn run commitment-issues init

# Bun
bun add --dev commitment-issues eslint@^9 prettier@^3
bunx --no-install commitment-issues init
```

At a workspace root, pnpm additionally needs `--workspace-root` and Yarn
Classic needs `--ignore-workspace-root-check`; Yarn Berry does not accept the
Classic-only flag. The
[monorepo guide](monorepo.md) shows those exact commands.

Global installation and a registry-downloading one-shot runner are not
supported. Generated hooks deliberately invoke
`node_modules/.bin/commitment-issues` and self-neutralize when that project-local
entry is gone; they never fall through to a global binary.
Coexistence snippets apply the same local-only rule, including Bun's Windows
launcher.

## Install and lifecycle modes

| Mode                                      | Boundary and evidence                                                                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean local install                       | Supported from the packed tarball with each manager above                                                                                                                                                                            |
| Manager-native CLI                        | Verified through `npx --no-install`, `pnpm exec`, `yarn run`, or `bunx --no-install`                                                                                                                                                 |
| Normal fresh-clone reinstall              | npm, pnpm, Yarn Classic, and Bun run the consumer-owned `prepare` repair added by `init`; Yarn Berry requires explicit local `doctor` repair because it does not support `prepare` and disables `postinstall` by default             |
| Production/dev-omitted install            | npm `ci`/`install --omit=dev`, pnpm `--prod`, Yarn Classic `--production`, Yarn Berry production focus, and Bun `--production` keep installation successful when the project-local development package is absent                     |
| Install with lifecycle scripts disabled   | Installs the CLI but intentionally does not repair clone-local hooks; run the local `doctor` command or reinstall with scripts enabled                                                                                               |
| Re-initialization and same-version repair | Supported and idempotent                                                                                                                                                                                                             |
| Existing hook-manager coexistence         | Husky, Lefthook, and pre-commit configs plus effective executable dispatchers are inspected read-only through explicit `--integration=<manager>`; Lefthook commands remain static; lint-staged remains a separate project-owned task |
| Forward cross-version upgrade             | Supported from pinned immutable v2.5.1, v3.2.0, and v3.3.2 fixtures when the new version's `init` is run                                                                                                                             |
| In-place downgrade                        | Unsupported; older versions do not perform reverse migrations                                                                                                                                                                        |
| Manual rollback                           | Documented cleanup-and-reinstall path using current `uninstall`, a pinned target manifest/lockfile and peers, then target `init`/`doctor`                                                                                            |
| Uninstall                                 | The CLI removes exact owned setup, then the selected manager removes the package while preserving the lockfile                                                                                                                       |
| Root-owned workspaces                     | Supported for the default npm, pnpm, Yarn Classic, Yarn Berry `node-modules`, and Bun layouts in the [monorepo guide](monorepo.md)                                                                                                   |
| Global install                            | Unsupported; the product contract is project-local                                                                                                                                                                                   |

The package itself declares no dependency install lifecycle script. `init`
adds or composes a Node-only guard in the consuming project's `prepare` script.
When `node_modules/commitment-issues/package.json` exists, the guard imports
that exact package's CLI and runs `doctor --quiet`; when a production install
or direct removal leaves the development package absent, it exits successfully
without trying a global binary, package runner, network resolution, or another
project. A present package with a missing CLI still fails visibly as a corrupt
installation. Projects that disable scripts retain an explicit, local recovery
path without executing package code during dependency installation.

Composition preserves terminal semicolons, single `&` operators, trailing
whitespace, quoted operators, and multiline project logic across init and
uninstall. Incomplete shell endings and a displaced or duplicate generated
repair fail closed before project or hook mutation. The same analyzer runs on
every supported operating system; the package never invokes a shell to inspect
the command.

Coexistence instead composes
the same guard with `doctor --quiet --integration=<manager>`: installs warn
without editing manager files or failing. The same spaces, Unicode, worktree,
shell, and workspace boundaries apply; hooks still need `node` and the selected
manager runtime.
Supported config/wrapper versions and manual-review cases are in the
[coexistence contract](migration.md#keep-an-existing-hook-manager).

Cross-version evidence downloads only immutable release artifacts whose
SHA-256 values are pinned in the
[release audit](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/audits/release-packaging-and-upgrades.md#pinned-upgrade-fixtures).
The required pull-request boundary is npm on Ubuntu/Node 24. A read-only release
candidate job reruns that npm migration against the exact tarball, then hands
the artifact and its hash to the separate OIDC-enabled stage job. Weekly
repository health exercises pnpm 10, Yarn Classic 1.22.22, and Bun 1.3.14.
Every path preserves project-owned `prepare` logic and custom hooks, while
changing exact generated artifacts only.

The [migration guide](migration.md#downgrades-and-manual-rollback) defines the
manual rollback procedure. It is an explicit recovery path, not support for
installing an older package over a newer configured repository.

## Node.js and peer tools

`package.json` requires Node.js `>=22.11.0`. The exact minimum and Node 24 are
required CI lanes. A local macOS audit also exercises Node 26; versions not
named here are admitted by the minimum engine range but do not have a separate
evidence claim. A lenient package manager that launches the CLI below the
minimum receives a direct version diagnostic before command dispatch.

The cross-version migration lane uses Node 24 because the pinned v2.5.1 and
v3.2.0 starting releases declared a higher `>=22.22.1` floor. Their historical
floor does not narrow the current package's Node 22.11.0 support.

ESLint 9 and 10 are the supported peer majors, and Prettier 3 is the supported
formatter major. The baseline install commands select ESLint 9 because it works
at Node 22.11.0. ESLint 10 is exercised on Node 24 and newer lanes and remains
subject to ESLint's own Node engine. The package has no TypeScript build or
compiler target: TypeScript support means file discovery followed by the
consumer's TypeScript-aware ESLint configuration.

The production package is native ESM JavaScript with no transpilation. Its
four runtime dependencies (`boxen`, `cross-spawn`, `js-yaml`, and `picocolors`)
all have Node requirements below this package's declared floor.

## Operating systems, shells, and Git clients

| Environment                           | Evidence level       | Boundary                                                                                                                                           |
| ------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu, macOS, Windows                | CI-verified          | npm at Node 22.11.0/24; pnpm, Yarn Classic, Yarn Berry `node-modules`, and Bun at Node 24; all non-npm managers also run on Ubuntu at Node 22.11.0 |
| POSIX `/bin/sh`                       | CI-verified          | The packed artifact runs the full commit/push/doctor/uninstall scenario on Linux and a portability smoke on macOS                                  |
| Bash and Fish                         | CI-verified on Linux | Each launches the same offline packed-artifact scenario; the generated Git hooks still execute under POSIX `sh`                                    |
| Zsh                                   | CI-verified on macOS | Launches the same offline packed-artifact scenario; the generated Git hooks still execute under POSIX `sh`                                         |
| Windows PowerShell and Command Prompt | CI-verified          | Each launches the packed CLI and real Git lifecycle; Git for Windows executes generated hooks through its bundled `sh`                             |
| VS Code Source Control                | Unverified (manual)  | No v3.4.0 UI evidence; commit and push must pass with the GUI-inherited Node/local-bin environment before support is claimed                       |
| IntelliJ IDEA or PyCharm              | Unverified (manual)  | No v3.4.0 UI evidence; one current JetBrains client must pass the shared commit/push lane before support is claimed                                |
| GitHub Desktop on macOS and Windows   | Unverified (manual)  | No v3.4.0 UI evidence; both operating-system lanes must execute commit and push from the UI before support is claimed                              |

Every automated shell lane installs the exact `npm pack` artifact without
registry access, uses a path containing spaces, Unicode, `$`, and `&`, preserves
an existing hook, verifies LF hook bodies and Unix executable bits, and runs
Git with a deliberately stripped `PATH`. Shell support means that shell can
launch the CLI and Git scenario; it does not change the generated hook
interpreter.

GUI clients are not shells and do not run in required pull-request CI. Their
candidate-specific evidence is recorded using the
[GUI Git-client checklist](https://github.com/RoryGlenn/commitment-issues/blob/main/docs/git-client-release-checklist.md).
The v3.4.0 UI lanes are unverified and tracked for post-launch validation in
[#231](https://github.com/RoryGlenn/commitment-issues/issues/231); required
shell CI does not imply that they passed. Node.js and the project-local bin
must be reachable in the environment the client gives Git, and success from an
integrated terminal is not a substitute.

The current CLI does not ship shell-completion scripts. Bash, Zsh, Fish, and
PowerShell parser checks become required if completion files enter the package;
the launch matrix is not a substitute for validating completion syntax.
