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

1. **Build event memory** — Map<sessionID, ModelRef> built from
   `session.updated` events where `info.agent === "build"`. The plugin
   picks the last-remembered build-agent model as priority #2 in its
   resolution chain. Empty if you never switched to the build agent in
   this session, or if opencode did not emit `session.updated` for your
   ctrl-x m / agent-tab switch.

2. **Last resolved target** — the model that exitPlanMode picked last
   time (or "never called"). Format: `provider/model (source)`.

3. **Current session info** — what the plugin sees in the latest
   `session.updated` event for this session: agent, model, and (if
   opencode provides it) `next.agent` / `next.model`.

If you ran ctrl-x m in the TUI and `/plan-diag` still shows the old
model, opencode did not emit a `session.updated` event for your picker
action. In that case the plugin cannot know what you picked. Workarounds:

- `/set-build-model <provider>/<model>` before approving the plan
- `/agent build` → `/model <provider>/<model>` → `/agent plan`, then
  approve

Diagnostic log lines `plan-review: session.updated: ...` are emitted to
the opencode log on every session.updated event — grep for those in
`~/.local/share/opencode/log/opencode.log` to see exactly which fields
opencode populates after your picker action.