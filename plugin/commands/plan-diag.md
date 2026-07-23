---
description: dump in-memory build-model memory + current session state for debugging the plan→build transition
---

# /plan-diag

Inspect what the plan-review plugin currently knows about models and the
active session. Useful when build exited on the wrong model and you need
to find out why the priority chain resolved that target.

Usage: `/plan-diag` — prints current state
       `/plan-diag reset` — clears in-memory build-event memory (forces
                            re-detection on next session.updated)

Output sections:

1. **/set-build-model overrides (in-memory)** — Map<sessionID, ModelRef> built from
   `session.updated` events where `info.agent === "build"` and from `/set-build-model`
   slash commands. The plugin picks the last-remembered build-agent model as priority #2
   in its resolution chain. Empty if no build agent activity or explicit override.

2. **chat.message memory** — per-session, per-agent model map built from
   `chat.message` hook calls (fires on every user prompt). Priority #1 for build
   and fallback #3 for plan.

3. **Current session info** — session ID, last resolved target and source.

If you ran Ctrl-X M in the TUI and `/plan-diag` still shows the old
model, opencode did not emit a `session.updated` event for your picker
action. Workarounds:

- `/set-build-model <provider>/<model>` before approving the plan
- Switch to build agent, pick a model, switch back to plan, then approve

Diagnostic log lines `plan-review: ...` and `plan-review-TUI: ...` are emitted to
the opencode log on every metadata write — grep for those in
`~/.local/share/opencode/log/opencode.log` to verify the fork's native
selection is tracking correctly.