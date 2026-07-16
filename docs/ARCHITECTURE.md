# Architecture

## Origin

Direct adaptation of the Claude Code `planning` plugin in [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz) (MIT). Original targets Claude Code via a `PreToolUse` hook on `ExitPlanMode`; this targets opencode via a custom tool because opencode has no such hook.

See README "Origin" section for the full credit + delta list.

## Why two layers (TS plugin + Python helper)?

The Claude Code `planning` plugin is a 370-line Python script that owns the editor-overlay logic. That logic — tmux popup command, sentinel-file pattern for kitty/wezterm, unified diff via `difflib`, temp-file lifecycle — is non-trivial and has nothing to do with opencode's plugin API.

Wrapping that logic in a TS plugin would mean reimplementing it in TS (or shelling out to Python anyway). Instead: the opencode plugin is a thin TS shell (~120 LOC) that:

1. registers the `plan_review` tool,
2. registers the `/plan-review` slash command via `event` hook,
3. injects the system prompt hint,
4. spawns the Python helper via `Bun.$`,
5. returns its stdout as tool output.

Python stays Python because:
- `difflib` is stdlib, mature, no install dance.
- The CC plugin's Python code was verified working — porting the same logic verbatim avoids rewriting bugs.
- The helper is testable in isolation (`--test`) without any opencode runtime.

## Why a custom tool instead of intercepting `ExitPlanMode`?

OpenCode has no `ExitPlanMode` tool. The "plan" flow is an *agent* named `plan`, not a model tool call. The mechanism Claude Code uses (PreToolUse hook on `ExitPlanMode`) does not exist in opencode.

The closest opencode equivalent is a custom tool the model calls voluntarily. We nudge the model to do so via `experimental.chat.system.transform`. The tool is also exposed as a slash command (`/plan-review`) for manual use, matching the CC plugin's `/make → Interactive review` flow.

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

The plugin reads stdout via `BunShell.text()`. Empty stdout means approved; non-empty means iterate. No JSON wrapping.

## TUI agent tracking

The TUI's current agent lives in a private SolidJS `createStore` (see `packages/tui/src/context/local.tsx:77-133`) that is **not** exposed through the plugin API. Tab/Shift+Tab only mutate that store — the server has no awareness of the change. Since build-model resolution needs to know which agent the user is actually in, we bridge this with a small **TUI-side plugin** alongside the server plugin:

- `plugin/tui-plugin.ts` registers a `keymap.intercept("key", ...)` handler that fires on Tab/Shift+Tab, before the default `agent.cycle` command runs.
- It computes the next agent from `api.client.app.agents()` and writes a deferred-pick map to session metadata via `api.client.session.update({body:{metadata:{planReviewDeferredPicks}}})`.
- On the user's first real prompt the `chat.message` hook reads that metadata and merges it into `chatMessageMemory` — but note the **promotion was moved out of `chat.message`** into `exitPlanMode`, because the user's first prompt fires `chat.message` *before* the TUI's `session.updated` handler flushes metadata. `exitPlanMode` runs much later (seconds-to-minutes, at plan approval) and is guaranteed to see the metadata, so it does the promotion there.
- The server plugin also watches `session.updated` / `session.updated.1` events and updates `lastSessionAgent` so subsequent picker changes in `model.json` (Ctrl-X M) are attributed to the agent the user is actually in.

The TUI plugin does **not** `preventDefault` — the default Tab handler still runs, and the TUI's local state changes as before. The plugin only **observes** and forwards.

Key files / symbols: `plugin/tui-plugin.ts` (keymap intercept, `promptAsync` flush), `plugin/index.ts` (`chat.message` hook, `exitPlanMode` deferred-picker promotion block, `lastSessionAgent`), `plugin/model-memory.ts` (`rememberBuildModel`, `sessionUpdateInfo`).

## Files

- `bin/plan-review.py` — Python helper. All editor-overlay logic, difflib, sentinel pattern, fallback cascade. Pure stdlib.
- `plugin/index.ts` — opencode server plugin. Tool registration, slash command via `event` hook, system prompt injection, `chat.message` hook, `exitPlanMode` build-model resolution. Bun runtime.
- `plugin/tui-plugin.ts` — TUI-side plugin. Tab/Shift+Tab observer, deferred-picker flush into session metadata.
- `plugin/model-memory.ts` — `rememberBuildModel` + `sessionUpdateInfo`: parses `session.updated` events into a per-session build-model `Map`.
- `commands/plan-review.md`, `commands/set-build-model.md`, `commands/plan-diag.md` — slash-command bodies. Tell the model what to do when invoked.
- `tests/plugin-smoke.ts` — end-to-end smoke (plugin loads, python helper diffs, model-resolution priority chain).