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

## Build-model resolution (server plugin)

`exitPlanMode` resolves the build model by source **absence** from a single per-session record — there is no timestamp tournament:

1. `planReviewModels.build` record (single per-session metadata key, written by every pick path through `plugin/model-store.ts`). The legacy `planReviewDeferredPicks` key is read as a one-shot fallback; the next write migrates.
2. Session history (last build-agent user message model).
3. `agent.build.model`.
4. `config.model`.
5. Nothing resolved → the tool tells the user to pick manually. It NEVER falls back to plan's model — plan and build are different agents; leaking one into the other is contamination.

Precedence is decided at **write time** in `plugin/model-store.ts`:

- `chat.message` capture (`captureImplicit`) writes the agent's most-recently-used model; skips records with `pinned: true`.
- `tui.model.selected` (`writePicker`) and `/set-build-model` (`writeCommand`) overwrite freely; `writeCommand` sets `pinned: true` so future implicit captures leave the record alone.
- Home→session flush (`mergeHomeFlush`) merges only into absent per-agent records — never overwrites an existing session's own picks.

**Synthetic-prompt guard** (defense-in-depth): with write-time precedence the sticky-model bug is structurally gone — the switch prompt would write the same value back. A plugin-instance-scoped `{active, sessionID}` window guard is kept so the diagnostics stay clean; smoke test 36f asserts both directions.

## TUI agent tracking (tui-plugin.tsx)

The fork exposes the TUI's local selection through `api.state.selection()`, advertises `api.state.modelSelectionEvents`, and emits `tui.model.selected` after a user picks a model. Published `@opencode-ai/plugin` types do not yet include this additive contract, so `plugin/tui-plugin.tsx` defines a small local type and checks both capabilities at runtime.

- Only **explicit** picker choices (`tui.model.selected`) become pending home picks. Transient selection snapshots (`tui.selection.changed`) only refresh a display cache (`lastHomeModels`) — never persisted as picks.
- On the home → session transition the draft is flushed once into `planReviewModels` via `mergeHomeFlush`. Primary fill is the **live** selection state read at transition time (the exact source the sidebar renders from); `mergeHomeFlush` only fills agents absent from the current record so explicit picks and in-session captures are never clobbered.
- In-session, `tui.model.selected` writes only its own agent (`writePicker`). Re-flushing the home cache would clobber the other agent's in-session pick with a stale home value — `mergeHomeFlush` exists precisely to prevent this.
- Metadata reads and writes share one promise chain in `updateRecord` (single GET → mutate → PUT with optional `aborted` predicate for disposal safety), preventing overlapping read-modify-write races while preserving session isolation.
- A compact `Agent models` sidebar block displays current plan and build models with status-dot active-agent highlighting (display-only, never model resolution).

On stock opencode, feature detection logs a safe fallback and the server plugin relies on `chat.message`. The TUI plugin never intercepts Tab, reads `model.json`, or restores a model-pick heuristic.

## Fork patches (~/projects/opencode)

The opencode fork carries TUI-side patches the plugin depends on. Key invariants in `packages/tui/src/context/local.tsx`:

- **Per-agent home draft**: `model.json` carries an `agents: {plan?, build?}` map alongside `recent`/`favorite`/`variant`. `homeAgents` mirrors the store's per-agent overrides only while no session is bound and **freezes** on `attachNewSession` — in-session model changes never leak into the persisted draft.
- **Late restore never contaminates a bound scope (RC1a)**: the async `model.json` read can resolve after `--continue` already bound an existing session (bind + history restore done). The restore then merges persisted agents into the frozen `homeAgents` draft only, never into the live session scope — otherwise the TUI displays the home draft while the session actually runs its own history model.
- **Unbind restores the draft (RC1b)**: `unbindSession` (session → home) clears every known agent override and seeds the frozen draft back. Session history-restored models must never become the home draft — one session would poison `save()`/`model.json` and every future session.
- **No home pinning**: the old effect that pinned the resolved fallback into the store on every home visit was removed (it poisoned fresh starts with the first provider's default). Agents with no explicit pick resolve through the fallback chain at display time instead of being pinned; `recent` is intentionally NOT part of the fallback chain (it is agent-agnostic and would leak one agent's pick into another).
- Tests: `packages/tui/test/context/local.test.ts` (19 tests) — run `bun test test/context/local.test.ts` from `packages/tui/` after any `local.tsx` change.

## Release cycles

Two independent cycles:

- **Plugin** → npm via Trusted Publishing (OIDC, `.github/workflows/publish.yml`, no tokens). First publish is manual; afterwards tag pushes (`vX.Y.Z`) trigger the workflow. Version lives only in `plugin/package.json`; both plugin entry points read it at runtime.
- **Fork binary** → local builds: `OPENCODE_VERSION="1.18.15+moonug.selection.N" bun run script/build.ts --single --skip-install` in `packages/opencode/`. `opencode-fork` symlink points at the dist binary. `.N` increments per rebuild; without `OPENCODE_VERSION` the version becomes preview junk.

Key files: `plugin/tui-plugin.tsx` (native model events, serialized metadata writes, sidebar UI), `plugin/index.ts` (`chat.message` hook, `exitPlanMode` build-only resolution by source absence), `plugin/model-store.ts` (single record, single writer, write-time precedence), `plugin/resolution.ts` (`exitPlanMode` implementation), `plugin/commands.ts` (slash-command handlers).

## Files

- `bin/plan-review.py` — Python helper. All editor-overlay logic, difflib, sentinel pattern, fallback cascade. Pure stdlib.
- `plugin/index.ts` — opencode server plugin. Thin wiring of tool registration, slash commands, system prompt injection, `chat.message` hook (with synthetic-prompt guard), `exitPlanMode` build-model resolution. Bun runtime.
- `plugin/tui-plugin.tsx` — TUI-side plugin. Explicit picker-event tracking, home-draft flush via `mergeHomeFlush`, sidebar model block, serialized metadata writes.
- `plugin/model-store.ts` — `updateRecord` (single GET → mutate → PUT), `captureImplicit`, `writePicker`, `writeCommand`, `mergeHomeFlush`, `readRecord`. Legacy `planReviewDeferredPicks` read as one-shot fallback; next write migrates.
- `plugin/resolution.ts` — `exitPlanMode`, `resolveBuildModel`, `getBuildAgentModel`, `getGlobalModel`, `getSessionHistoryBuildMessage`, `listAvailableModels`, `formatProviderList`, `parseModelString`.
- `plugin/system-prompt.ts` — `systemTransform`, `messagesTransform`.
- `plugin/commands.ts` — `handleSetBuildModel`, `handlePlanDiag`, `handlePlanReview` (`/set-build-model` writes `pinned: true`).
- `plugin/install.ts` — `installSelf`, `ensureCommandLinks`, `ensureManagedLink`, `ensureExecutable`, `ensureCommandSymlink`, `SCRIPT_PATH`, `TUI_PLUGIN_PATH`.
- `plugin/helpers.ts` — `logged`, `visibleErr`, `withTimeoutSafe`, `log`.
- `commands/plan-review.md`, `commands/set-build-model.md`, `commands/plan-diag.md` — slash-command bodies. Tell the model what to do when invoked.
- `tests/plugin-smoke.ts` — 73 end-to-end smoke checks (helper diffs, resolution chain, synthetic-prompt guard 36f, TUI flush semantics, P1–P4 named regressions).
- Fork: `packages/tui/src/context/local.tsx` — per-agent model store, scope isolation (RC1a/RC1b), `model.json` `agents` persistence; `packages/tui/test/context/local.test.ts` — 19 mirror tests for the store invariants.
