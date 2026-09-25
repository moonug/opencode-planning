# AGENTS.md

## Errors

- `catch {}` — forbidden. Empty catch swallows errors and turns debugging into hell. At minimum: log it, rethrow, or add a comment explaining why it's intentionally ignored.
- The fork TUI's `local.tsx` had a `.catch(() => {})` on the `model.json` restore — it bit us because the restore silently never applied. The TUI cannot import opencode's log API; use `console.error` (terminal stderr is visible in the TUI) and add a unit test against a fixture file.

## Plugin SDK contract (v1 vs v2)

The two plugin hosts hand out DIFFERENT SDK clients:
- Server plugin host → `@opencode-ai/sdk` (v1, hey-api runtime). `client.session.update` body type is `{ title?: string }`; the runtime only serializes `options.body`. **Anything at the top level is silently dropped on the wire** — no schema rejection, just an empty body that the server then silently ignores. Metadata MUST be passed under `body: { metadata: ... }`.
- TUI plugin host → `@opencode-ai/sdk/v2` (v2, flat params). `client.session.update({ sessionID, metadata })` packs `metadata` into body server-side. **Metadata MUST be at the top level here**, NOT under `body`.

Use `plugin/model-store.ts::v1SdkAdapter(client)` / `v2SdkAdapter(client)` and pass the adapter to `updateRecord` / `readRecord` / `clearRecord`. Don't call `client.session.update/get` directly in the plugin code — the SDK shapes are different and a typo silently drops the write.

**Fake-client smoke tests don't prove server compatibility** — they accept whatever shape the plugin passes and can't tell if a real hey-api runtime would drop keys. v0.3.0 shipped with two wrong call shapes (top-level `metadata` for v1, `{path:{id}}` for v2) and every smoke check passed. The new `[contract:update-body]` check fixes that by using a v1-shaped fake that mirrors hey-api's `body`-only serialization. Add a new contract test for every new SDK call shape.

## plan_review abort contract (v0.3.3)

- `ToolContext.abort` fires on session interrupt; `review-helper.ts::runReviewHelper` kills the helper on abort (SIGTERM → SIGKILL after 2s) and **throws** — it must NEVER resolve with empty stdout on abort, because empty tool output means "plan approved" and switches the session to the build agent.
- In-flight guard: a second `plan_review` while an editor is open **throws** (`already in progress`) — any non-empty return value would be misread as a diff feedback. Consequence: BOTH the abort path and the guard path must throw, never return text.
- The python helper tracks its long-running editor child (`_track_proc`) and kills it on SIGTERM/SIGINT/SIGHUP (exit 128+signo) — killing the helper alone used to orphan vim on the tty and freeze the TUI keyboard (25.09 incident: 7 leaked pairs on ttys048).
- `PLAN_REVIEW_SCRIPT` is read lazily per call (`install.ts::scriptPath`), so tests can override it after module load.

## opencode plugin architecture

- **Server plugins**: `opencode.jsonc` → `"plugin": ["package-or-path"]`. Hook: `export default async (ctx) => { return { tool, config, event, ... } }`
- **TUI plugins**: MUST be registered in `~/.config/opencode/tui.jsonc` → `"plugin": ["path"]`. NOT in `~/.config/opencode/plugins/` — that path loads as server plugin and fails.
- **TUI plugin shape**: `export default { id, tui: async (api) => {} }`
- **`tool.definition` hook**: can rewrite built-in tool descriptions (e.g., suppress `plan_exit` → redirect to `plan_review`)
- **`system.transform` hook**: can modify existing `output.system[]` blocks (string replacement). Also appends new blocks.
- **`chat.message` hook**: the only reliable server-side hook for per-session tracking. The `event` hook drops `session.*` events (filtered at `packages/opencode/src/plugin/index.ts:252`).
- **`config` hook**: can inject into `experimental.primary_tools` and set per-agent `permission` (e.g., `plan_review: "allow"` for plan, `"deny"` for build).

## Native TUI selection

The fork adds `api.state.selection()`, `api.state.modelSelectionEvents`, and the local `tui.model.selected` event. Use a small additive local type plus feature detection until published `@opencode-ai/plugin` types catch up.

Persist plan/build selections only for `ses_` IDs through serialized session metadata read-modify-writes. **The metadata key is `planReviewModels`** (was `planReviewDeferredPicks` before v0.3.0; legacy key still read as fallback). The shared `plugin/model-store.ts::updateRecord` is the single writer — both server plugin and TUI plugin go through it. Never read global `model.json`, intercept Tab, or infer pending model picks. When the native API is absent, log the fallback and rely on `chat.message`.

## Version centralization

`require("./package.json").version` works in Bun ESM modules. Version lives only in `plugin/package.json`. Both `index.ts` and `tui-plugin.tsx` read it at runtime. Tests read `EXPECTED_VERSION` from the same file.

## npm publishing

- **Trusted Publishing** (OIDC) via GitHub Actions — no tokens. Workflow: `.github/workflows/publish.yml` with `actions/setup-node@v6`, `node-version: "24"`, `id-token: write`.
- First publish must be manual (`npm publish` with 2FA). Trusted Publisher can only be configured after the package exists on npmjs.com.
- Tag push (`git tag vX.Y.Z && git push origin vX.Y.Z`) triggers the workflow automatically.
- Configure at npmjs.com → package → Settings → Trusted Publisher: org, repo, workflow filename (`publish.yml`).

## Release QA checklist (manual — TUI can't be fully smoke-tested)

Before every plugin release or fork rebuild, run on a real terminal:

1. **Startup**: launch fresh `opencode` — startup log shows `plan-review: plugin init v0.3.x` and `plan-review-TUI: plugin loaded v0.3.x` for the EXPECTED version. Recent block in model picker shows your last 10 used models. Per-agent current model = `~/.local/state/opencode/model.json` `agents.{plan,build}` (no nanobanana default fallback).
2. **Persistence**: pick a model for `build` via `/model` in the picker, exit, reopen. Per-agent model restored.
3. **Build resolution**: in a fresh session, run `/plan-diag` — should print the per-agent record. Approve a plan → exitPlanMode must resolve and switch agent + model without "No build model resolved" unless the user truly never picked anything.
4. **DB check**: after picking build, `sqlite3 ~/.local/share/opencode/opencode.db "SELECT metadata FROM session WHERE id='<id>'"` must contain a non-empty `planReviewModels` object (no planReviewDeferredPicks only).
5. **FORK binary version**: `opencode-fork --version` reports `1.18.15+moonug.selection.N` for the CURRENT build (rebuild if stale).
6. **No stale instances**: kill any long-running `opencode` from before the version bump — they hold pre-refactor plugin code in memory and produce confusing logs.

## Diagnostics (log/DB locations + evidence patterns)

- **Server log**: `~/.local/share/opencode/log/opencode.log`. Key greps:
  - `plan-review: plugin init|plugin loaded` — which plugin version EACH running instance actually holds (run-id in `run=` field; long-running instances keep pre-refactor code in memory — check this FIRST when logs look wrong)
  - `schema rejection kind=Payload` — server rejected an SDK call; correlate its timestamp with `HOOK FIRED` lines 1–3ms earlier to identify the caller
  - `stream providerID=... session.id=` — ground truth for the model the server ACTUALLY streamed (TUI display can differ)
  - `created id=... version=...` — reveals which binary created a session (binary-provenance forensics)
- **Session DB**: `sqlite3 ~/.local/share/opencode/opencode.db "SELECT id, directory, substr(metadata,1,300) FROM session ORDER BY time_updated DESC"` — `time_*` are ms epochs; `metadata` holds `planReviewModels`.
- **TUI state**: `~/.local/state/opencode/model.json` (recent/favorite/variant/agents). `~/.local/state/opencode/prompt-history.jsonl` contains verbatim user complaints — useful to correlate bug reports with timestamps.
- **`ENXIO` on lstat/realpath for `~/arcadia-wt/**`**: a stalled macfuse `arc` mount, not a plugin bug. Symptoms: server `ENXIO: no such device or address, lstat '<wt path>'`, TUI retries `failed ref=err_*`, `glob`/tool failures in the same window, `plan_review` `status:"error"`. Check `ls` on the directory, wait for the mount to recover, retry. From plugin v0.3.2 the tool always reports non-empty text (errno + FUSE hint) instead of a bare error.

## Environment gotchas

- Fork pre-push hook runs repo-wide `bun typecheck`, which FAILS on pre-existing `@opencode-ai/app#typecheck` errors (desktop/drizzle-orm missing) — pushing with `--no-verify` is the established norm there.
- `gh run watch` requires an explicit run ID when non-interactive (`gh run list --workflow=Publish --limit=1 --json databaseId -q '.[0].databaseId'`).

## Known opencode bugs

- **"dummy" sessionID**: opencode uses `sessionID: "dummy"` in route on `--continue` startup. Components fire API calls with it → `Expected a string starting with "ses"` validation error. Not caused by our plugin — it's opencode's internal race between route placeholder and session list loading.

## Fork TUI internals

- **Variant (effort) storage**: `packages/tui/src/context/local.tsx` → `modelStore.variant` map. Per-agent key `${agent}/${providerID}/${modelID}`; legacy per-model `${providerID}/${modelID}` read as fallback. `selectionSnapshot` variant callback receives `(agentName, model)`.
- **Sticky model overrides (nanobanana flicker fix)**: `local.tsx::resolveAgentModel` — when the provider list flaps (auth refresh / sync re-batch) an agent's override fails `isModelValid`; the resolver then returns the agent's `lastValid` entry (last-known-GOOD; entries enter the map only after passing validation, so they are NOT re-validated against the flapping list) instead of the shared fallback. Never make `resolveModel`'s fallback reachable for an agent that ever had a valid pick — one submitted prompt in that window poisons the session history. Discards log rate-limited (1/10s) via `console.error`.
- **unbindSession keeps session overrides when the draft lacks the agent** — clearing would resolve to the shared fallback on home. The persisted draft (model.json `agents`) is still the frozen `homeAgents` only, so RC1b isolation is unchanged.
- **TUI tests**: `bun test test/context/local.test.ts` from `packages/tui/` — covers `selectionSnapshot`, model pinning, variant resolution, sticky flaps `[N1]–[N3]`. Run after any `local.tsx` change.
- **Restore tests**: `bun test test/util/model-restore.test.ts` — covers `applyModelRestore` against real fixture files (round-trips through `readJson`). Run after any `local.tsx` restore-path change.

## Fork binary build

- `opencode-fork` → symlink to `~/projects/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
- Build: `OPENCODE_VERSION="1.18.15+moonug.selection.N" bun run script/build.ts --single --skip-install` (in `packages/opencode/`)
- **Always** pass `OPENCODE_VERSION` — without it the version becomes `0.0.0-<branch>-<timestamp>` (preview junk)
- Increment the `.N` build metadata suffix on each rebuild
- **Binary provenance guard**: `opencode --version` must ALWAYS report `1.18.15+moonug.selection.N`. Any other suffix (e.g. `tui-selection-events.3`) means an autonomous loop rebuilt dist from its own tree — that binary's content is unverified. Stop, inspect `git status` in the fork, and rebuild with the proper `OPENCODE_VERSION`.
- **Autonomous loops must not leave uncommitted changes in the fork tree** — they silently end up inside the next binary build. Commit or stash before any `build.ts` run.
- **`--single` builds only current platform; `--skip-install` skips native dep reinstall (fine for TUI-only changes)**
- **model.json `agents` field** (per-agent home-draft overrides): `~/.local/state/opencode/model.json` now carries an `agents: {plan?…, build?…}` map alongside the existing `recent`/`favorite`/`variant`. The TUI plugin's live-read flush reads these at session transition; the fork TUI itself restores them at startup so new sessions carry the user's last per-agent picks across restarts. Do not read global `model.json` from the plugin.
- **Scope isolation invariants (local.tsx)**: (1) the async model.json restore must never write into a bound session scope — if `modelStore.sessionID` is already set (`--continue`), persisted agents merge into the frozen `homeAgents` draft only, never the store; (2) `unbindSession` clears every known agent override and seeds the frozen draft back — session history-restored models must never become the home draft (one session would poison `save()`/model.json and every future session).
- **Synthetic-prompt guard (plugin)**: the server fires `chat.message` for EVERY prompt, including exitPlanMode's own noReply switch prompt. A plugin-instance-scoped `{active, sessionID}` window guard makes the hook skip recording during that call. With write-time precedence on the single record, the sticky-model bug is structurally gone (the switch prompt would write the same value back), but the guard is kept as defense-in-depth so diagnostics stay clean. Smoke test 36f.
- **Single record, write-time precedence (plugin)**: `plugin/model-store.ts` is the single writer for per-session model picks. Resolution is a trivial read of the record (no timestamp tournament across mixed clocks). `/set-build-model` sets `pinned:true`; implicit captures (`captureImplicit`) skip pinned records. Home flush (`mergeHomeFlush`) fills only agents absent from the current record.

## Bun caching

Bun caches dynamic imports. To verify new plugin code loaded, bump `BUILD_TAG` (derived from version) and check startup log: `plan-review: plugin init v${VERSION}` and `plan-review-TUI: plugin loaded v${VERSION} build=v${VERSION}`.
