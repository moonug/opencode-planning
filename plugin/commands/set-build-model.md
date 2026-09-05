---
description: override the model used when the session auto-switches to the build agent after plan approval
---

# /set-build-model

Override which model the session switches to when `/plan-review` (or the
`plan_review` tool) approves a plan and the session auto-exits to the
build agent.

The override is stored in durable plugin storage for this session and
survives opencode restarts. For a default shared by new sessions, configure
the build agent model in `opencode.jsonc`.

Usage:

- `/set-build-model` — show a numbered list of available models pulled
  from `client.config.providers()`. Reply with `/set-build-model N` to
  pick the Nth entry, or `/set-build-model <provider>/<model-id>` to set
  directly.
- `/set-build-model 5` — pick the 5th model from the last shown list.
- `/set-build-model <provider>/<model-id>` — set directly, e.g.
  `/set-build-model ya-glm/glm`.

Resolution priority on plan approval (first match wins):

1. Durable `planReviewModels.build` record captured for this session
2. Last build-agent model reconstructed from session history
3. Build-agent model from `opencode.jsonc`
4. Global default model

This command pins the durable record. Later implicit prompt captures leave
the pin alone. An explicit committed picker choice or another
`/set-build-model` replaces it; `/plan-diag reset` clears it.

OpenCode V2 publishes durable `session.model.selected` events when a model
selection is committed. The server plugin attributes those events to the
active agent; it never reads global `model.json`.
