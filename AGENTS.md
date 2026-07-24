# AGENTS.md

## Errors

- `catch {}` — forbidden. Empty catch swallows errors and turns debugging into hell. At minimum: log it, rethrow, or add a comment explaining why it's intentionally ignored.

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

Persist plan/build selections only for `ses_` IDs through serialized session metadata read-modify-writes. Never read global `model.json`, intercept Tab, or infer pending model picks. When the native API is absent, log the fallback and rely on `chat.message`.

## Version centralization

`require("./package.json").version` works in Bun ESM modules. Version lives only in `plugin/package.json`. Both `index.ts` and `tui-plugin.tsx` read it at runtime. Tests read `EXPECTED_VERSION` from the same file.

## npm publishing

- **Trusted Publishing** (OIDC) via GitHub Actions — no tokens. Workflow: `.github/workflows/publish.yml` with `actions/setup-node@v6`, `node-version: "24"`, `id-token: write`.
- First publish must be manual (`npm publish` with 2FA). Trusted Publisher can only be configured after the package exists on npmjs.com.
- Tag push (`git tag vX.Y.Z && git push origin vX.Y.Z`) triggers the workflow automatically.
- Configure at npmjs.com → package → Settings → Trusted Publisher: org, repo, workflow filename (`publish.yml`).

## Known opencode bugs

- **"dummy" sessionID**: opencode uses `sessionID: "dummy"` in route on `--continue` startup. Components fire API calls with it → `Expected a string starting with "ses"` validation error. Not caused by our plugin — it's opencode's internal race between route placeholder and session list loading.

## Bun caching

Bun caches dynamic imports. To verify new plugin code loaded, bump `BUILD_TAG` (derived from version) and check startup log: `plan-review: plugin init v${VERSION}` and `plan-review-TUI: plugin loaded v${VERSION} build=v${VERSION}`.
