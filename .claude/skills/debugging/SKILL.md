---
name: debugging
description: Debugs failures systematically — minimal reproduction, isolation, root cause, then fix with a regression test — instead of guessing at patches. Use when investigating a bug, error, traceback, flaky test, unexpected output, or when the user says "why is this failing" or "it doesn't work".
---

# Systematic debugging

Never patch a symptom you cannot explain. Follow this order:

```
Debug Progress:
- [ ] 1. Check it isn't already fixed upstream/on the dev branch
- [ ] 2. Build a minimal reproduction
- [ ] 3. Isolate: bisect code paths / inputs / versions
- [ ] 4. State the root cause in one sentence
- [ ] 5. Fix the cause, then add a regression test (see tdd-cycle skill)
```

**Step 1 — Already fixed?** Before investing time, read the current code on the
project's default/dev branch (and changelog/recent commits touching the area).
Bugs reported in issues are often already fixed — verifying first avoids wasted work.

**Step 2 — Minimal reproduction.** Reduce to the smallest script/test that shows the
failure deterministically. If you cannot reproduce it, gather more facts (exact
versions, inputs, environment) before theorizing.

**Step 3 — Isolate.** Change one variable at a time: comment out halves, pin
versions, swap inputs, add targeted prints/logging at boundaries. Prefer reading
the failing code path over speculating about it.

**Step 4 — Root cause.** Write one sentence: "X fails because Y does Z when W."
If you cannot fill that sentence, you are not done isolating. The fix must address
Y/Z, not mask X.

**Step 5 — Fix + regression test.** Apply the smallest fix at the root cause and
lock it in with a failing-then-passing test so it cannot silently return.

Anti-patterns to refuse: retry loops around undiagnosed failures, broad
`try/except` that swallows the error, "it works now" without knowing why.
