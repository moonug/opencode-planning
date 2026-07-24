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

1. `chat.message` memory (build agent) — last model used by the build
   agent in this session, captured directly or promoted from native TUI
   selection metadata
2. `/set-build-model` override (this command, in-memory, session-scoped)
3. `chat.message` memory (plan agent) — fallback when build agent never
   picked
4. `agent.build.model` from `opencode.jsonc`
5. `config.model` global default
6. `agent.plan.model` (last resort)

This command sits at priority #2 — it overrides the config but is itself
overridden by any TUI model picker choice recorded for the build agent,
or by a later build prompt.

Note: the fork's TUI plugin reads `api.state.selection()` for display and
persists explicit `tui.model.selected` events. Stock opencode falls back safely to
`chat.message`; neither path reads global `model.json`.
