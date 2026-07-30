---
description: Build-critique-fix loop against the next unapproved system in PROGRESS.md
---

Read `PROGRESS.md` and pick the topmost system that is `in progress` or `built` but not
`critic-approved` (unless the user named a system, in which case use that one).

Then:

1. Invoke the `visual-critic` agent on it, passing any reference description the user has
   given in this conversation.
2. If it returns REWORK, apply the deltas it listed, rebuild, and go back to 1.
3. If it returns APPROVE, set that system to `critic-approved` in `PROGRESS.md`, commit,
   and report which system is next.

Stop after an APPROVE, or after three REWORK rounds on the same system — three rounds
without convergence means the target is unclear, so ask for reference rather than continuing
to iterate blind.
