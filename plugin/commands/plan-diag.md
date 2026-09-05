---
description: inspect durable plan-review model state for the current session
---

# /plan-diag

Inspect what the plan-review plugin currently knows about models and the
active session. Useful when build exited on the wrong model and you need
to find out why the priority chain resolved that target.

Usage: `/plan-diag` — prints current state
       `/plan-diag reset` — clears the durable planReviewModels record for
                            the current session only. Other sessions keep
                            their records.

Output sections:

1. **planReviewModels record** — durable, per-session plan/build selections.
   `/set-build-model` records are pinned; implicit prompt captures do not
   overwrite them.
2. **Current session** — the session ID and resolution chain.

If a V2 picker choice does not appear, submit a prompt or command so the
selection is committed to the session. You can also use:

- `/set-build-model <provider>/<model>` before approving the plan
- Switch to build, pick a model, submit once, then switch back to plan

Diagnostic log lines `plan-review: ...` are emitted to the opencode log.
