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

## Known opencode bugs

- **"dummy" sessionID**: opencode uses `sessionID: "dummy"` in route on `--continue` startup. Components fire API calls with it → `Expected a string starting with "ses"` validation error. Not caused by our plugin — it's opencode's internal race between route placeholder and session list loading.

## Fork TUI internals

- **Variant (effort) storage**: `packages/tui/src/context/local.tsx` → `modelStore.variant` map. Per-agent key `${agent}/${providerID}/${modelID}`; legacy per-model `${providerID}/${modelID}` read as fallback. `selectionSnapshot` variant callback receives `(agentName, model)`.
- **TUI tests**: `bun test test/context/local.test.ts` from `packages/tui/` — covers `selectionSnapshot`, model pinning, variant resolution. Run after any `local.tsx` change.
- **Restore tests**: `bun test test/util/model-restore.test.ts` — covers `applyModelRestore` against real fixture files (round-trips through `readJson`). Run after any `local.tsx` restore-path change.

## Fork binary build

- `opencode-fork` → symlink to `~/projects/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
- Build: `OPENCODE_VERSION="1.18.15+moonug.selection.N" bun run script/build.ts --single --skip-install` (in `packages/opencode/`)
- **Always** pass `OPENCODE_VERSION` — without it the version becomes `0.0.0-<branch>-<timestamp>` (preview junk)
- Increment the `.N` build metadata suffix on each rebuild
- `--single` builds only current platform; `--skip-install` skips native dep reinstall (fine for TUI-only changes)
- **model.json `agents` field** (per-agent home-draft overrides): `~/.local/state/opencode/model.json` now carries an `agents: {plan?…, build?…}` map alongside the existing `recent`/`favorite`/`variant`. The TUI plugin's live-read flush reads these at session transition; the fork TUI itself restores them at startup so new sessions carry the user's last per-agent picks across restarts. Do not read global `model.json` from the plugin.
- **Scope isolation invariants (local.tsx)**: (1) the async model.json restore must never write into a bound session scope — if `modelStore.sessionID` is already set (`--continue`), persisted agents merge into the frozen `homeAgents` draft only, never the store; (2) `unbindSession` clears every known agent override and seeds the frozen draft back — session history-restored models must never become the home draft (one session would poison `save()`/model.json and every future session).
- **Synthetic-prompt guard (plugin)**: the server fires `chat.message` for EVERY prompt, including exitPlanMode's own noReply switch prompt. A plugin-instance-scoped `{active, sessionID}` window guard makes the hook skip recording during that call. With write-time precedence on the single record, the sticky-model bug is structurally gone (the switch prompt would write the same value back), but the guard is kept as defense-in-depth so diagnostics stay clean. Smoke test 36f.
- **Single record, write-time precedence (plugin)**: `plugin/model-store.ts` is the single writer for per-session model picks. Resolution is a trivial read of the record (no timestamp tournament across mixed clocks). `/set-build-model` sets `pinned:true`; implicit captures (`captureImplicit`) skip pinned records. Home flush (`mergeHomeFlush`) fills only agents absent from the current record.

## Bun caching

Bun caches dynamic imports. To verify new plugin code loaded, bump `BUILD_TAG` (derived from version) and check startup log: `plan-review: plugin init v${VERSION}` and `plan-review-TUI: plugin loaded v${VERSION} build=v${VERSION}`.
