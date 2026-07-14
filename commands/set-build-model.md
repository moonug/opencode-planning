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

Resolution priority on plan approval:

1. `/set-build-model` override (this command, in-memory, session-scoped)
2. `agent.build.model` from `opencode.jsonc`
3. `config.model` global default
4. opencode default

Note: the opencode TUI model picker (Ctrl-X M) is a separate runtime
mechanism that does not emit a persistent event; this command is the
text-based counterpart for plugin-internal state.