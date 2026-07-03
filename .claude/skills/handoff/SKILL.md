---
name: handoff
description: Writes a handoff document capturing goal, completed work, remaining tasks, next action, verification commands, and pitfalls, so another session or model can resume the work without the current context.
disable-model-invocation: true
argument-hint: [optional topic or file name]
---

## Current state

!`git branch --show-current && git status --short && git log --oneline -5`

## Instructions

Write a handoff document to `docs/handoff/<YYYY-MM-DD>-<topic>.md` (create the
directory if needed; derive the date from `date +%F`, topic from $ARGUMENTS or
the session's main task). The reader is a fresh session with **zero context** —
possibly a different model — so spell everything out; no session-local shorthand.

Required structure:

```markdown
# Handoff: <topic>

## Goal
What we are ultimately trying to achieve, and why (1–3 sentences).

## Done
Completed work with evidence: commits (hash + subject), files created/changed,
test results, decisions made and their reasons.

## Not done
Remaining tasks as a checklist, most-important first.

## Next action
The single concrete step to take first, with the exact command or file to open.

## How to verify
Commands that prove the current state is good (e.g. `node test_mcts.js`)
and what "good" looks like.

## Pitfalls
Constraints and traps: branch to push to, commit author convention, things
tried that failed, easily-broken assumptions.
```

Keep it factual and complete but under ~120 lines. After writing, print the
file path and the "Next action" section so the user can confirm it.
