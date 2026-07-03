---
name: oss-contribution
description: Guides an open-source contribution end to end — picking an uncontested issue, verifying the bug still exists on the current dev branch, writing a surgical fix with a network-free regression test, and opening an honest PR. Use when finding an issue to work on, preparing or reviewing an OSS pull request, or contributing to libraries like yfinance, pandas, numpy, scikit-learn, or matplotlib.
---

# OSS contribution playbook

```
Contribution Progress:
- [ ] 1. Pick a viable issue
- [ ] 2. Verify the bug exists on the current default/dev branch (read the code)
- [ ] 3. Fix: red → green with a network-free regression test
- [ ] 4. Match project conventions (branch, test framework, style)
- [ ] 5. Open an honest, small PR
```

**Step 1 — Pick.** Prefer fresh, uncontested issues: `good first issue` label,
low comment count, created recently, no linked PR, in a library the owner
actually uses. Skip issues where someone already said "working on this".

**Step 2 — Verify before writing any code.** Check out or read the project's
current default/dev branch and confirm the buggy code path is still there.
Issues are frequently already fixed (this saved a wasted PR on yfinance #2865).
If fixed, comment on the issue instead of opening a PR.

**Step 3 — Fix.** Follow the tdd-cycle skill: failing regression test first
(network-free — mock HTTP with recorded fixtures), then the smallest surgical
diff that turns it green. Keep the diff free of drive-by refactors.

**Step 4 — Conventions.** Read CONTRIBUTING.md and recent merged PRs for:
target branch (yfinance targets `dev`), test framework (yfinance uses
`unittest`), commit/PR title style, lint/format commands. Run the project's own
test command before pushing.

**Step 5 — PR.** Title states the fix, body contains: the issue link
(`Fixes #NNN`), what was broken, the root cause, the red→green test evidence,
and the diff's scope. No overstated claims — say exactly what is and isn't
covered. Small PRs merge; large ones stall.

After opening, watch for maintainer review and respond promptly and concretely;
a merged PR is the goal, not an opened one.
