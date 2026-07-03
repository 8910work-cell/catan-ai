---
name: tdd-cycle
description: Fixes a bug or adds behavior via a red-green regression test cycle, writing a failing test before any fix and keeping evidence of both runs. Use when fixing a bug, patching a regression, adding a testable behavior, or when the user mentions TDD, red-green, regression test, or "write a test first".
---

# Red → Green regression cycle

Copy this checklist into your response and check items off as you go:

```
TDD Progress:
- [ ] 1. Reproduce: write a failing test that captures the bug/behavior
- [ ] 2. Red: run it and record the failure output
- [ ] 3. Fix: smallest change that makes the test pass
- [ ] 4. Green: run the test again and record the pass
- [ ] 5. Full suite: run the whole test suite, confirm no regressions
```

**Step 1 — Reproduce.** Write the test before touching production code. The test must:
- fail for the same reason the bug happens (not for a setup error);
- be network-free — mock or stub external HTTP/API calls with recorded fixtures;
- live next to the existing tests and follow the project's framework (this
  repo uses headless Node scripts — see `test_mcts.js` — not a test runner).

**Step 2 — Red.** Run only the new test. If it passes, the test does not capture the
bug — rewrite it. Save the failure output; it goes in the commit/PR description as evidence.

**Step 3 — Fix.** Make the smallest surgical change that turns the test green.
Do not refactor unrelated code in the same change.

**Step 4 — Green.** Re-run the new test, then Step 5 the full suite
(e.g. `node test_mcts.js`). If anything else broke, the fix is wrong or incomplete — return to Step 3.

**Evidence.** Quote the red output and the green output when reporting or writing
the PR description. A claim of "fixed" without both runs is not done.
