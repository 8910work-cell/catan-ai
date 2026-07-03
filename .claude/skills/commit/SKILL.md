---
name: commit
description: Stages and commits the current changes following this repository's conventions, splitting unrelated work into separate logical commits.
disable-model-invocation: true
allowed-tools: Bash(git status *), Bash(git diff *), Bash(git log *), Bash(git add *), Bash(git commit *)
---

## Current state

!`git status --short && git log --oneline -5`

## Commit procedure

1. Review the status above. Group the changes into logical units — one concern
   per commit. Never `git add -A` blindly; stage files (or hunks) per unit.
2. Author every commit as the repo owner so it counts toward their GitHub profile:

   ```bash
   git -c user.name=8910work-cell -c user.email=8910work@gmail.com commit -m "..."
   ```

3. Message format:
   - subject: imperative mood, ≤ 50 chars, no trailing period
     (e.g. `Fix metadata loss on failed tradingPeriods fetch`);
   - blank line, then a body explaining **why** the change was needed and any
     evidence (failing test now passing, issue number);
   - reference issues as `Fixes #NNN` when applicable.
4. Do not commit: secrets, regenerated training artifacts (`*.bin` weights,
   `auto_train_status.json`) unless the retrain is the point of the change,
   debug leftovers. If the diff contains any, stop and clean up first.
5. After committing, show `git log --oneline -3` to confirm. Do **not** push
   unless the user asked for a push.

$ARGUMENTS
