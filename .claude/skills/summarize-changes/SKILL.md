---
name: summarize-changes
description: Summarizes the uncommitted working-tree changes and flags risks such as missing error handling, hardcoded values, debug leftovers, or missing tests. Use when the user asks what changed, wants a self-review before committing or opening a PR, or asks for a diff summary.
---

## Current working tree

Status:

!`git status --short`

Diff (tracked files):

!`git diff HEAD --stat && git diff HEAD`

## Instructions

Using the injected status and diff above (do not re-run git unless the output
was truncated or empty):

1. Summarize the changes in 2–4 bullets, grouped by intent (fix / feature /
   refactor / docs / tests), not by file.
2. Flag risks, each with `file:line` where possible:
   - missing or weakened error handling;
   - hardcoded paths, credentials, magic numbers;
   - leftover debug prints, commented-out code, TODOs;
   - behavior changes with no corresponding test change;
   - accidental changes (files unrelated to the stated task, lockfile churn).
3. Note untracked files that look like they should be added or gitignored.
4. If the diff is empty, say there are no uncommitted changes and stop.

End with a one-line verdict: **ready to commit** or **fix the flagged items first**.
