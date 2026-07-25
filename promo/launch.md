# Launch kit

Maintainer material for putting `commitment-issues` in front of people. It is
not shipped in the npm package because `promo/` is outside the `package.json`
`files` allowlist.

Current technical baseline: v3.4.0 is live on npm, its immutable GitHub Release
contains the exact npm tarball and matching SLSA provenance, issue #39 is
closed, and the demo GIF, repository topics, and social preview are complete.
Recheck those signals on launch day rather than relying on this snapshot.

---

## Message and media kit

Lead with the developer's feedback loop before listing features. Keep this
three-part sequence intact across the repository README, next-release npm
metadata, Product Hunt description, LinkedIn, Reddit, and X:

> **Catch mistakes while they're still cheap to fix.**
>
> Commit normally. When a fixable problem appears, Commitment Issues gives you
> an immediate suggestion and the exact safe command to fix it before the first
> push. CI stays authoritative.
>
> Watch the 26-second workflow: commit → suggestion → `npm run commit:fix` →
> successful push.

Use the first sentence as the general short lead. Use all three paragraphs when
the surface allows more context; follow them with feature or compatibility
detail only after the value is clear. Product Hunt's compact combined tagline
is “Catch mistakes early with advisory-first Git hooks”; begin its description
with the canonical promise above. For a shorter X post, use:

> Catch mistakes while they're still cheap to fix. Get immediate, advisory Git
> feedback and the exact safe command before your first push. CI stays
> authoritative.

| Asset                          | Best use                               | Notes                                                                 |
| ------------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| `assets/before-after.svg`      | GitHub/npm and long-form documentation | Crisp, accessible source with a jargon-free before/after story        |
| `assets/before-after.png`      | Product Hunt, LinkedIn, Reddit, and X  | 1200×675 upload-ready export; understandable without software context |
| `assets/demo.gif`              | README/npm and posts that accept GIFs  | 26-second real workflow: advisory warning, exact fix, successful push |
| `assets/commitment-issues.png` | Brand-led posts and social preview     | Existing 16:9 wordmark and Commit Owl artwork                         |

Recommended alt text for the comparison asset: “Without Commitment Issues: send
work, wait, find a mistake, and do it again. With Commitment Issues: spot and
fix the mistake first, then send once.”

---

## Blog post

The blog is a deliberate secondary angle: it opens with the blocking-hook and
habitual `--no-verify` problem, then connects that problem to the same
value-first promise. Product listings and short social posts should use the
feedback-loop lead above.

**Title:** Why I stopped letting pre-commit hooks block my commits

Many teams add Git hooks and develop the same reflex:

`git commit --no-verify`.

Blocking-by-default setups teach it. You're mid-thought, you commit a WIP, and a
hook rejects it because Prettier wanted different quotes — or worse, it
reformats and re-stages files you didn't mean to touch, or fails a test suite
you were about to fix in the next commit. The hook was trying to help. It just
picked the worst possible moment.

Once `--no-verify` becomes muscle memory, the hooks may as well not exist.

I wanted the opposite default: **catch mistakes while they're still cheap to
fix, then get out of the way.**

### Advisory-first

`commitment-issues` runs the checks you'd expect — ESLint, Prettier, missing-test
detection, and pushed-file tests — but by default it **reports** and lets your
commit through. You get a compact box: what it found, what's safe to do next, and
the command to fix it when you're ready. By default, your commit is not held
hostage.

When you _do_ want a hard gate, you opt in. Set `blockPushOnTestFailure: true` and
failing tests block a push. Strictness is a deliberate choice — not the default
that trains you to bypass it.

### Safe by construction

The fix commands refuse to do anything risky:

- `fix:staged` only touches staged files, and refuses to run when a file has both
  staged and unstaged changes.
- `commit:fix` refuses dirty tracked worktrees, detached or signed commits, and
  commits found in local tags or known remote refs, protecting unstaged work
  and the history visible in the offline ref snapshot.

Nothing mutates your work behind your back.

### One command, and it heals itself

```bash
npm install -D commitment-issues eslint@^9 prettier@^3
npx --no-install commitment-issues init
```

That wires the hooks and npm scripts — no hook manager needed. Hooks are notorious for
silently breaking — a `git clean`, a stale checkout, a teammate who never ran
the install lifecycle. `commitment-issues` ships a `doctor` that repairs the
wiring through `prepare`, composing it after a project-owned command when
needed, so it self-heals without overwriting project setup and works with Yarn
Classic too.

It supports local npm, pnpm 10, Yarn Classic 1.22.22, and Bun 1.3.14 installs.
The [compatibility matrix](../docs/compatibility.md) records the exact required
Linux, macOS, Windows, and Node.js evidence for each manager.

### The point

Catch mistakes while they're still cheap to fix. Hooks should be a helpful
teammate, not a bouncer: advisory by default, strict when you ask, with the
exact safe command when a fix is available.

It's MIT-licensed and on npm as `commitment-issues`. If the philosophy resonates —
or if you think I'm wrong — I'd love the feedback.

Repo: https://github.com/RoryGlenn/commitment-issues

---

## Product Hunt preparation

Follow the official Product Hunt launch, posting, and featuring guidance linked
from issue #240. Use a personal account, complete any required onboarding, and
create a draft before selecting a launch date. The primary product URL should
point directly to the GitHub repository rather than to the supporting blog post.

The listing should:

- use `commitment-issues` as the product name;
- use “Catch mistakes early with advisory-first Git hooks” as the concise,
  value-first tagline and open the description with “Catch mistakes while
  they're still cheap to fix”;
- explain what the product does within Product Hunt's description limit;
- identify the maintainer as the maker;
- use relevant Developer Tools, Open Source, and GitHub topics when available;
- include the existing logo, social-preview artwork, and a legible product-flow
  gallery led by `assets/before-after.png` and supported by the demo GIF; and
- avoid superlatives, coordinated voting, or an upvote request.

### Ready-to-enter listing fields

This payload stays inside the stricter limits in Product Hunt's current
[posting guide](https://help.producthunt.com/en/articles/479557-how-to-post-a-product)
and
[launch preparation guide](https://www.producthunt.com/launch/preparing-for-launch).
The maintainer must still preview and approve every field in Product Hunt before
scheduling.

- **Primary URL:** `https://github.com/RoryGlenn/commitment-issues`
- **Name:** `commitment-issues`
- **Tagline (50/60 characters):** `Catch mistakes early with advisory-first Git hooks`
- **Description (254/260 characters):** `Catch mistakes while they're still cheap to fix. Commitment Issues spots Git workflow problems before your first push, suggests the exact safe command, and stays advisory by default. Local-only, telemetry-free, open source, for JavaScript and TypeScript.`
- **Pricing:** Free
- **Status:** Available now
- **Topics:** Developer Tools, Open Source, GitHub
- **Hunter and maker:** use Rory's eligible personal Product Hunt account and
  confirm the maker badge in the preview; do not use a company account.

### Upload-ready media pack

Use these files in this order. The thumbnail is Product Hunt's recommended
240×240 square and is under 3 MB. All four static gallery cards use the
recommended 1270×760 canvas and are under 130 KB. The gallery therefore remains
complete even if the optional GIF is not accepted or displayed.

| Order | Upload file                               | Purpose                                                              | Alt text                                                                                                                       |
| ----: | ----------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
|     — | `assets/product-hunt-thumbnail.png`       | Required square thumbnail                                            | Split-heart Commitment Issues logo on a dark background.                                                                       |
|     1 | `assets/product-hunt-01-before-after.png` | Jargon-free value story                                              | Without Commitment Issues: send, wait, find a mistake, and redo. With Commitment Issues: spot it, fix it, and send once.       |
|     2 | `assets/product-hunt-02-setup.png`        | The two installation and setup commands                              | Two commands install and set up Commitment Issues; the next commit then receives helpful checks.                               |
|     3 | `assets/product-hunt-03-advisory.png`     | A real advisory-style warning and its exact fix command              | By default, a commit continues while Commitment Issues identifies two fixable ESLint problems and suggests npm run commit:fix. |
|     4 | `assets/product-hunt-04-safe-fix.png`     | The safe fix followed by the shorter send-once outcome               | The suggested command safely amends the latest commit, producing a simple fix, send, done path.                                |
|     5 | `assets/demo.gif`                         | Optional 26-second motion proof after the four self-contained stills | Commitment Issues setup, a non-blocking warning, the exact safe fix command, and a successful push.                            |

The editable source mapping is explicit:

- `assets/product-hunt-thumbnail.svg` →
  `assets/product-hunt-thumbnail.png`;
- `assets/before-after.svg` →
  `assets/product-hunt-01-before-after.png`;
- `assets/product-hunt-02-setup.svg` →
  `assets/product-hunt-02-setup.png`;
- `assets/product-hunt-03-advisory.svg` →
  `assets/product-hunt-03-advisory.png`; and
- `assets/product-hunt-04-safe-fix.svg` →
  `assets/product-hunt-04-safe-fix.png`.

The render workflow regenerates every PNG and rejects a stale export.

### Human-only first maker comment worksheet

Product Hunt's current
[commenting guidelines](https://help.producthunt.com/en/articles/10030102-commenting-guidelines)
reject LLM-generated comments. Rory must write and approve the final first
maker comment in his own voice. Use these prompts as a factual checklist, not
as copy to paste:

- what the project does and who it is for;
- the blocking-hook and habitual `--no-verify` problem;
- why advisory-first is the default;
- the safe-fix, local-only, and native-hook design choices;
- current JS/TS, Node, Yarn Plug'n'Play, shell, and GUI-client boundaries; and
- the specific tradeoffs on which feedback would be useful.

Add one personal detail that only the maintainer can supply: the real moment a
blocking hook made `--no-verify` feel easier than fixing the problem, what that
experience cost, and why this different default was worth building. End with a
specific request for feedback rather than a request for votes.

Prepare personal answers for likely questions about Husky/lint-staged and CI,
bypasses, partial staging, telemetry and configured-command trust, monorepos,
platform compatibility, the proposed v4 direction, release verification, and
the v3.3.0/v3.3.1 fix-forward history. The durable product answers live in the
FAQ; the maintainer should review the final listing and every reply for accuracy
and tone.

---

## Posting checklist

- [x] Generate and embed the demo GIF (`vhs promo/demo.tape` → `assets/demo.gif`).
- [x] Add the reusable before/after SVG and 1200×675 social PNG.
- [x] Prepare the Product Hunt-native 240×240 thumbnail and four-card
      1270×760 static gallery, with deterministic source/export checks.
- [x] Align the README, next-release npm metadata, rationale, Product Hunt, and
      cross-platform post copy around the same value-first message; the blog
      reinforces it from the documented blocking-hook angle.
- [ ] Confirm the live npm page carries the new description and README after
      the next release.
- [x] Add GitHub repo topics: `git-hooks`, `husky`, `lint-staged`, `pre-commit`, `eslint`, `prettier`, `developer-tools`.
- [x] Add a social preview image (Settings → General → Social preview).
- [x] Publish and independently verify v3.4.0, including matching npm/GitHub
      tarballs and signed SLSA provenance.
- [ ] Re-run the clean-install launch path: `init`, advisory commit warning,
      `commit:fix`, and related push-time tests.
- [ ] Recheck npm, the immutable GitHub Release assets, CI, CodeQL, DCO,
      Scorecard, README media, and repository availability on launch day.
- [ ] Publish the blog on your site; cross-post to DEV with a canonical link back.
- [ ] Confirm the personal Product Hunt account can post and has completed any
      required onboarding.
- [ ] Create and review the Product Hunt draft, direct repository URL, tagline,
      description, topics, maker attribution, gallery, and first maker comment.
- [ ] Schedule the launch for a day when the maintainer can stay available after
      Product Hunt's 12:01 a.m. PT launch boundary.
- [ ] Post the first maker comment promptly and reserve launch-day time for
      technical replies and feedback triage.
- [ ] Start milestone #2's 14-day validation window after the launch.
