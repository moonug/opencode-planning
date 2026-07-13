---
description: set the model used when the session auto-switches to the build agent after plan approval
---

# /set-build-model

Set a per-session override for the model used after `/plan-review` (or the `plan_review` tool) approves a plan and the session auto-switches to the build agent.

Usage: `/set-build-model <provider>/<model-id>`

Example: `/set-build-model ya-deepseek/deepseek-v4-flash`

The override is persisted in `session.metadata` and survives until the session ends. Resolution priority on plan approval:

1. `/set-build-model` override (this command)
2. last model selected while the build agent was active (in-memory session memory)
3. `agent.build.model` from `opencode.jsonc`
4. `config.model` global default
5. opencode default