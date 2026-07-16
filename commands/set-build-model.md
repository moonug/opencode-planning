---
description: override the model used when the session auto-switches to the build agent after plan approval
---

# /set-build-model

Override which model the session switches to when `/plan-review` (or the
`plan_review` tool) approves a plan and the session auto-exits to the
build agent.

The override is stored in **this plugin's in-memory session memory** —
it is lost when opencode restarts. For a persistent override, configure
`agent.build.model` in `opencode.jsonc`.

Usage:

- `/set-build-model` — show a numbered list of available models pulled
  from `client.config.providers()`. Reply with `/set-build-model N` to
  pick the Nth entry, or `/set-build-model <provider>/<model-id>` to set
  directly.
- `/set-build-model 5` — pick the 5th model from the last shown list.
- `/set-build-model <provider>/<model-id>` — set directly, e.g.
  `/set-build-model ya-glm/glm`.

Resolution priority on plan approval (first match wins):

1. `chat.message` memory (build agent) — last picker choice per session
2. `chat.message` memory (plan agent) — fallback when build agent never picked
3. `/set-build-model` override (this command, in-memory, session-scoped)
4. `agent.build.model` from `opencode.jsonc`
5. `config.model` global default
6. picker history (`model.json` recent[0])
7. fallback to plan agent's model

This command sits at priority #3 — it overrides the config but is itself
overridden by any TUI picker choice (chat.message memory). It only takes
effect when the TUI picker has not been used in this session; any Ctrl-X M
pick (before or after running this command) wins.

Note: the opencode TUI model picker (Ctrl-X M) changes are captured by the
TUI-side plugin via model.json watcher and forwarded into chat.message
memory via session metadata, so they take priority over this command
(see priority #1-2 above). Use this command only when you need to set a
model without using the TUI picker.