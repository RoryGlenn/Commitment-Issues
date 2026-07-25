# Hook performance and scaling

This repository keeps hook performance measurable without turning wall-clock
timings into flaky pull-request checks. The ordinary test suite runs the
`smoke` tier for behavior only. Maintainers run the larger tiers explicitly
when hook discovery, Git queries, tool invocation, or path transport changes.

## Reproduce the benchmark

Install the locked dependencies, then run:

```bash
npm ci
npm run benchmark:hooks -- --tier smoke
npm run benchmark:hooks -- --tier large --enforce-budgets
npm run benchmark:hooks -- --tier argv-pressure --enforce-budgets
```

Use `--json` for machine-readable stdout or `--output <path>` to retain a JSON
report. `--keep` preserves the disposable repository and prints its path for
manual inspection. Without `--keep`, the fixture is removed and its temporary
path is not exposed in the report.

The tiers are deliberately bounded:

| Tier            | Source/test pairs | Staged paths | What runs                                                                  |
| --------------- | ----------------- | ------------ | -------------------------------------------------------------------------- |
| `smoke`         | 4                 | 9            | Test discovery plus real pre-commit and pre-push hooks                     |
| `large`         | 250               | 501          | Test discovery plus real ESLint, Prettier, Node tests, and both hook paths |
| `argv-pressure` | 1,000             | 2,001        | Discovery and conservative Windows command-line accounting only            |

Every generated path contains spaces, non-ASCII text, shell metacharacters,
and a long segment. The full-hook tiers use a real Git index and pushed diff;
the source/test pairs make every staged source discover one test.

## Budgets

These budgets catch order-of-magnitude regressions on a comparable maintainer
machine. They are not end-user latency guarantees and are not enforced by
normal pull-request CI.

| Tier            | Discovery | Pre-commit | Pre-push | Peak process-tree RSS | Fixture disk |
| --------------- | --------- | ---------- | -------- | --------------------- | ------------ |
| `smoke`         | 250 ms    | 15 s       | 15 s     | 512 MiB               | 32 MiB       |
| `large`         | 1 s       | 60 s       | 60 s     | 1,024 MiB             | 128 MiB      |
| `argv-pressure` | 5 s       | not run    | not run  | not measured          | 512 MiB      |

Run `--enforce-budgets` only on a controlled host. The report always records
the machine, individual discovery samples, elapsed hook time, sampled process
tree RSS where the platform exposes it, output byte counts, fixture size, and
whether each applicable budget passed.

## Measured baseline

The initial baseline was recorded on 2026-07-15 using Node 26.4.0, Git 2.55.0,
and a 10-logical-core Apple M1 Pro with 16 GiB RAM on macOS arm64.

| Tier            | Discovery median | Pre-commit | Pre-push | Peak RSS     | Fixture disk | Result |
| --------------- | ---------------- | ---------- | -------- | ------------ | ------------ | ------ |
| `large`         | 12.037 ms        | 2.599 s    | 1.929 s  | 711.625 MiB  | 0.789 MiB    | passed |
| `argv-pressure` | 55.755 ms        | not run    | not run  | not measured | 0.886 MiB    | passed |

The large pre-commit result was 361,309 bytes and the pre-push result was
145,430 bytes. That run exposed and now regression-tests a short-write defect:
a pipe could accept only the first part of a JSON result before the hook's
immediate exit. JSON output now retries partial and temporarily blocked writes
until the complete UTF-8 payload is delivered.

Treat these numbers as a reproducible reference point, not a comparison across
unlike machines. Refresh the dated table when a deliberate scaling change is
accepted; preserve the command, tier, host details, and before/after reports in
the pull request.

## Bounded argument transport

There is no universal safe file count because the limit depends on every
path's length, encoding, quoting, executable path, configured test command,
operating system, and launcher. The hooks therefore use one greedy,
argument-aware policy rather than a maximum number of files:

| Runtime             | Per-launch budget | Accounting and safety margin                                                                  |
| ------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Windows             | 6,000 units       | Conservative UTF-16 estimate including doubled quoting/escaping allowance; below `cmd.exe`    |
| macOS, Linux, POSIX | 24,000 bytes      | UTF-8 command and argv bytes including NUL terminators; well below supported-host exec limits |

The executable and every fixed configured option count against the same
budget. Variable arguments are added in order while the estimate remains at or
below the boundary; a path is never split. This intentionally defines no file
count. If even the fixed command or one legal item cannot fit, the hook reports
the same structured unavailable-command advisory or blocking result it uses
for a launch failure.

ESLint, Prettier, staged tests, and pre-push tests run their batches
sequentially under one overall configured timeout. A normal non-zero exit does
not skip later batches, so findings and failures from every path are retained.
A timeout, signal, or spawn failure stops later launches; the existing
process-tree cleanup applies to the interrupted child. A parent `SIGINT`,
`SIGTERM`, or `SIGHUP` terminates every active attached tree and waits for pipe
closure within a bounded cleanup grace; a timeout racing that signal reuses the
same idempotent cleanup. Node's configured options remain before `--`,
configured positional tests run once, discovered leading-hyphen paths remain
unambiguous, and Git-local environment variables remain stripped.

The pre-commit large-file guard no longer sends staged paths back to
`git ls-files`. It reads the whole index once with `--stage -z`, parses the
NUL-delimited records, and filters the exact staged-path set locally. This is
semantically equivalent for stage-zero blobs and also preserves conflicted and
hostile path parsing without a pathspec argv.

The fixed-argv index probe uses an explicit 16 MiB output ceiling rather than
Node's roughly 1 MiB synchronous-process default. That bound supports large
indexes without allowing unbounded hook memory use. If Git cannot complete the
probe or an exceptional index exceeds the ceiling, the commit remains advisory
but reports that staged file sizes could not be inspected; it never silently
turns an unavailable size guard into a clean result.

### Issue #212 before/after validation

The change was measured on 2026-07-20 using Node 24.14.0, Git 2.51.1, Linux
x64, and an Intel Xeon Platinum 8573C host. These same-host timings verify that
bounded transport stays inside the existing budgets; they are not performance
guarantees.

| Tier            | Measurement      | Before    | After     | Result |
| --------------- | ---------------- | --------- | --------- | ------ |
| `large`         | Discovery median | 10.611 ms | 13.440 ms | passed |
| `large`         | Pre-commit       | 7.864 s   | 4.501 s   | passed |
| `large`         | Pre-push         | 3.142 s   | 3.556 s   | passed |
| `large`         | Fixture disk     | 0.713 MiB | 0.713 MiB | passed |
| `argv-pressure` | Discovery median | 75.036 ms | 74.152 ms | passed |
| `argv-pressure` | Fixture disk     | 0.885 MiB | 0.885 MiB | passed |

On the after-change POSIX `large` run, pre-commit completed all three ESLint
batches, all three Prettier batches, and both staged-test batches. Pre-push
completed both test batches and aggregated the expected `250 passed, 0 failed`
summary.

The report retains the legacy unbounded Windows estimate for comparison and
also plans the actual bounded transport. Every planned batch stays within the
6,000-unit runtime budget:

| Invocation             | `large` legacy | `large` transport (max units) | `argv-pressure` legacy | `argv-pressure` transport (max units) |
| ---------------------- | -------------- | ----------------------------- | ---------------------- | ------------------------------------- |
| `git ls-files --stage` | 139,143        | 1 whole-index probe (109)     | 684,143                | 1 whole-index probe (109)             |
| ESLint                 | 139,413        | 25 batches (5,973)            | 684,413                | 125 batches (5,885)                   |
| Prettier               | 139,556        | 27 batches (5,833)            | 684,556                | 134 batches (5,681)                   |
| Configured Node tests  | 70,910         | 13 batches (5,820)            | 347,160                | 63 batches (5,712)                    |

Boundary tests cover just-under, exact-boundary, and multi-batch inputs for
both POSIX-byte and Windows-unit accounting. The ordinary sharded Windows CI
runs those tests and the real multi-batch hook regressions on Node 22.11.0 and
Node 24, providing hosted Windows evidence without adding wall-clock
assertions.

## Regression policy

- Keep ordinary CI deterministic: assert fixture shape, hook success, cleanup,
  and report structure, but never elapsed milliseconds.
- Run `large` before merging a change that affects hook traversal, discovery,
  process execution, JSON volume, or tool argv construction.
- Run `argv-pressure` when changing path quoting, Windows launch behavior, or
  batching logic.
- Investigate a budget failure before raising a threshold. Record whether the
  cause is product code, dependency behavior, or a materially different host.
- Do not infer cross-platform support from a POSIX timing run; use the command
  pressure report and dedicated platform evidence together.
