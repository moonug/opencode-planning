# Architecture

## Origin

Direct adaptation of the Claude Code `planning` plugin in [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz) (MIT). Original targets Claude Code via a `PreToolUse` hook on `ExitPlanMode`; this targets opencode via a custom tool because opencode has no such hook.

See README "Origin" section for the full credit + delta list.

## Why two layers (TS plugin + Python helper)?

The Claude Code `planning` plugin is a 370-line Python script that owns the editor-overlay logic. That logic — tmux popup command, sentinel-file pattern for kitty/wezterm, unified diff via `difflib`, temp-file lifecycle — is non-trivial and has nothing to do with opencode's plugin API.

Wrapping that logic in a TS plugin would mean reimplementing it in TS (or shelling out to Python anyway). Instead, the OpenCode V2 plugin keeps the editor workflow behind a thin TypeScript boundary that:

1. registers the `plan_review` tool,
2. registers slash commands through `command.transform`,
3. injects the system prompt hint through the session `context` hook,
4. spawns the Python helper with `execFile`,
5. returns its stdout as tool output.

Python stays Python because:
- `difflib` is stdlib, mature, no install dance.
- The CC plugin's Python code was verified working — porting the same logic verbatim avoids rewriting bugs.
- The helper is testable in isolation (`--test`) without any opencode runtime.

## Why a custom tool instead of intercepting `ExitPlanMode`?

OpenCode has no `ExitPlanMode` tool. The "plan" flow is an *agent* named `plan`, not a model tool call. The mechanism Claude Code uses (PreToolUse hook on `ExitPlanMode`) does not exist in opencode.

The closest OpenCode equivalent is a custom tool the model calls voluntarily. The V2 session `context` hook rewrites stale `plan_exit` references and appends a short directive. The plugin also registers `/plan-review` directly through `command.transform`.

## Why a manual edit loop instead of plannotator's browser UI?

The user explicitly asked for the $EDITOR-based flow (mirroring CC planning). Plannotator uses a Bun HTTP server + React SPA — different tradeoff: web UI is more visual, $EDITOR is universal and zero-dep.

We chose to reuse the editor cascade verbatim from the CC plugin. Pluggability: if a future request wants browser-based review, the tool's `execute` body is the only place that needs to change.

## Sentinel-file pattern (kitty / wezterm)

Tmux's `display-popup -E` blocks natively until the spawned command exits. Kitty and WezTerm launch overlays asynchronously, so we need a wait mechanism.

The pattern:

1. Parent reserves a path: `tempfile.mkstemp(prefix="plan-done-")` then immediately `os.unlink()`s the file. The path is reserved; the inode is free.
2. Parent polls `sentinel.exists()` every 300ms.
3. Parent launches the editor inside a shell wrapper that runs the editor then `touch <reserved-path>`, creating a new file at that path.
4. Parent's poll loop sees the file appear, cleans up, returns.

This works because the OS doesn't reserve unlinked paths — a subsequent `touch` simply creates a fresh file there.

## stdout contract

| Condition | stdout | exit | meaning to plugin |
|---|---|---|---|
| Plan unchanged | empty | 0 | "Plan reviewed, no changes. Approved by user." |
| Plan changed | unified diff | 0 | feedback text with header + diff + revision prompt |
| Internal error | stderr message | nonzero | error message returned to model |

The plugin reads stdout from `execFile`. Empty stdout means approved; non-empty means iterate. No JSON wrapping.

## Build-model resolution (server plugin)

`exitPlanMode` resolves the build model by source **absence** from a single per-session record — there is no timestamp tournament:

1. `planReviewModels.build` record in V2 plugin storage, keyed by session. V1 session metadata is read as a migration fallback and copied into plugin storage on the next write.
2. Session history (last build-agent message model).
3. `agent.build.model`.
4. `config.model`.
5. Nothing resolved → the tool tells the user to pick manually. It NEVER falls back to plan's model — plan and build are different agents; leaking one into the other is contamination.

Precedence is decided at **write time** in `plugin/model-store.ts`:

- The prompt-admission hook writes the active agent's most-recently-used model through `captureImplicit`.
- Durable `session.model.selected` events provide the explicit picker/command capture path, overwrite freely, and are attributed using the session's current agent. Events caused by the plugin's own plan→build transition are identified and ignored.
- `/set-build-model` uses `writeCommand`, which sets `pinned: true`; later implicit captures leave the pin alone.

V2 persists agent and model switches as separate operations. Approval switches the agent first and the model second, matching the TUI submit path, so `session.model.selected` is attributed to `build` rather than contaminating the `plan` record.

## V2 TUI (`tui.tsx` / `tui-v2.tsx`)

The package exports `./tui`, so OpenCode discovers the TUI entrypoint from the same configured plugin directory. It contributes one `sidebar.content` slot.

The sidebar is intentionally display-only. It derives the latest plan/build models from assistant messages, agent/model switch messages, and the current durable session state. The server plugin owns resolution storage and listens to public V2 events, so the TUI does not need a private selection API, direct server-plugin storage access, or `model.json` heuristics.

## Release cycle

The V2 branch targets the OpenCode V2 beta plugin contracts. `plugin/package.json` exports `server.ts` as the server entrypoint and `tui.tsx` as `./tui`. Validate both against the intended V2 build before publishing because the API is still beta.

## Files

- `bin/plan-review.py` — Python helper. All editor-overlay logic, difflib, sentinel pattern, fallback cascade. Pure stdlib.
- `plugin/server.ts`, `plugin/v2.ts` — V2 server entrypoint and implementation: transforms, hooks, durable event tracking, commands, and tool registration.
- `plugin/tui.tsx`, `plugin/tui-v2.tsx` — V2 TUI entrypoint and display-only sidebar contribution.
- `plugin/index.ts`, `plugin/tui-plugin.tsx` — legacy V1 implementations retained as migration references on this branch; the V1 branch remains unchanged.
- `plugin/model-store.ts` — `updateRecord` (single GET → mutate → PUT), `captureImplicit`, `writePicker`, `writeCommand`, `mergeHomeFlush`, `readRecord`. Legacy `planReviewDeferredPicks` read as one-shot fallback; next write migrates.
- `plugin/resolution.ts` — `exitPlanMode`, `resolveBuildModel`, `getBuildAgentModel`, `getGlobalModel`, `getSessionHistoryBuildMessage`, `listAvailableModels`, `formatProviderList`, `parseModelString`.
- `plugin/system-prompt.ts` — `systemTransform`, `messagesTransform`.
- `plugin/commands.ts` — `handleSetBuildModel`, `handlePlanDiag`, `handlePlanReview` (`/set-build-model` writes `pinned: true`).
- `plugin/install.ts` — legacy V1 self-install implementation; V2 does not invoke it.
- `plugin/helpers.ts` — `logged`, `visibleErr`, `withTimeoutSafe`, `log`.
- `commands/plan-review.md`, `commands/set-build-model.md`, `commands/plan-diag.md` — slash-command bodies. Tell the model what to do when invoked.
- `tests/plugin-smoke.ts` — legacy V1 smoke coverage.
- `tests/v2-plugin-smoke.ts` — V2 transforms, durable storage, command acknowledgements, context rewriting, and plan→build switch ordering.
- `plugin/tests/v2-tui-smoke.tsx` — V2 TUI registration and sidebar rendering.
