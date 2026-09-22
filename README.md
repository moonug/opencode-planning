# opencode-plan-review

[![npm version](https://img.shields.io/npm/v/opencode-plan-review.svg)](https://www.npmjs.com/package/opencode-plan-review)

Plan review plugin for [opencode](https://opencode.ai). Opens plans in `$EDITOR`, returns a unified diff of the user's edits as feedback for the model.

> **Branch note:** this is the `v2` branch (version `0.4.0-alpha.2`), targeting **opencode2** — the Effect-based host checkout at `~/projects/opencode-v2`. The published `0.3.x` line for opencode V1 lives on `main`; the V1 sections below are retained for reference.

## V2 (opencode2) quick start

Add the plugin **directory** to `~/.config/opencode-v2/opencode.jsonc`:

```jsonc
{
  "plugins": ["/Users/moonug/projects/opencode-planning-v2/plugin"]
}
```

Restart opencode2. After rebuilding the host binary, kill stale `opencode2 serve --service` daemons first — a daemon keeps the config and code from its start.

What differs from V1:

- per-session model picks are stored as durable session instruction entries (`planReviewModels`), not session metadata round-trips;
- model picks are captured from the `model.request` hook (primary requests only), not `chat.message`;
- `plan_review`, `set_build_model`, `plan_diag` are tools; opencode2 has no plugin command registration, so declare `/plan-diag`-style shortcuts in `config.commands` if you want them;
- explicit picker picks arrive as `session.model.selected` events and are attributed to the session's current agent (the event carries no agent);
- agent permissions are patched through `agent.transform` rules (plan may call `plan_review`, build may not);
- the TUI sidebar (`./tui` → `plugin/tui-v2.tsx`) reads only public session data.

### Slash commands

Copy [`plugin/commands-v2.jsonc`](plugin/commands-v2.jsonc) into `~/.config/opencode-v2/opencode.jsonc` (merge the `commands` key) to get `/plan-diag`, `/set-build-model` and `/plan-review`. The host substitutes `$ARGUMENTS` with whatever follows the command name. Equivalent markdown files under `~/.config/opencode-v2/commands/*.md` are scanned too.

Requirements: Python 3.x (stdlib only) and an opencode2 build containing the plugin hook commit — see `AGENTS.md` for the rebuild recipe.

## Origin

Adapted from the Claude Code `planning` plugin in [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz) (MIT). The original targets Claude Code via `PreToolUse` hooks; this project targets opencode via a custom tool + system-prompt injection.

**Scope note**: this port is intentionally limited to interactive plan review. The upstream plugin includes an autonomous execution pipeline (`/planning:exec`), a plan generator (`/planning:make`), a quality-review agent, an external codex review loop, and a custom-rules override mechanism — all of which rely on Claude Code-specific hooks (`PreToolUse`, `Task` tool, plugin-data-dir) that opencode does not expose. No feature parity is implied. See upstream [`usage.md`](https://github.com/umputun/cc-thingz/blob/master/plugins/planning/references/usage.md) for the full upstream documentation.

## What it does

- Registers a `plan_review` tool the model calls when the plan is ready
- Rewrites `plan_exit` / `ExitPlanMode` references in system prompts → `plan_review` so the model always calls the right tool
- Opens the plan in `$EDITOR` (cascade: agterm → tmux → zellij → kitty → wezterm → ghostty → `code -w` / `cursor -w` → blocking spawn)
- Computes a unified diff (Python `difflib`); the diff becomes the model's next user message
- When the user closes the editor without changes: auto-switches from plan agent to build agent on a per-session build model
- Slash commands: `/plan-review <file>`, `/set-build-model [provider/model | N]`, `/plan-diag [reset]`

## Requirements

- **Python 3.x** — stdlib only
- **Terminal overlay** (optional): `agtermctl`, `tmux`, `zellij`, `kitty`, `wezterm`, or `ghostty`. Falls back to plain `$EDITOR` on bare ssh.

## Install

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-plan-review"]
}
```

Restart opencode. The plugin self-installs on first load:
- **`commands/*.md`** — symlinked into `~/.config/opencode/commands/`
- **TUI plugin** — auto-registered into `~/.config/opencode/tui.jsonc` (tracks the fork's native per-session selection state and adds an `Agent models` sidebar block)
- **`bin/plan-review.py`** — Python helper, resolved from the package directory. `chmod +x` applied if needed.

## Build-model resolution

When a plan is approved, the session switches to the build agent. The build model is resolved per-session in this order (first match wins):

1. **`planReviewModels.build` record** — single per-session metadata key written by every pick path through `plugin/model-store.ts`. Legacy `planReviewDeferredPicks` key read as a one-shot fallback; the next write migrates.
2. **Session history** — last build-agent user message model.
3. **`agent.build.model`** — from opencode config.
4. **`config.model`** — global default.

If none resolve, the plugin refuses the auto-switch and prints instructions. Use `/plan-diag` to inspect.

### How model tracking works

The [opencode fork](https://github.com/moonug/opencode/tree/tui-selection-events) exposes `api.state.selection()` for the sidebar, advertises `api.state.modelSelectionEvents`, and emits `tui.model.selected` with the session, agent, and selected model. Each model event updates only that agent through a serialized per-session metadata read-modify-write; startup snapshots are never persisted. The TUI plugin also shows a compact `Agent models` sidebar block with status-dot highlighting.

Published plugin types do not yet include this additive API, so the plugin uses feature detection. On stock opencode it logs a safe fallback and relies on the server-side `chat.message` hook; it never reads global `model.json` or guesses from Tab presses. This prevents cross-session contamination.

## Editor cascade

| Priority | Condition | How |
|---|---|---|
| 1 | `$AGTERM_SESSION_ID` set, `agtermctl` on PATH | `agtermctl session overlay open` (blocks natively) |
| 2 | `$TMUX` set, `tmux` on PATH | `tmux display-popup -E -w 90% -h 90%` |
| 3 | `$ZELLIJ` set, `zellij` on PATH | `zellij run --floating` + sentinel file |
| 4 | `$KITTY_LISTEN_ON` set, `kitty` on PATH | `kitty @ launch --type=overlay` + sentinel file |
| 5 | `$WEZTERM_PANE` set, `wezterm` on PATH | `wezterm cli split-pane` + sentinel file |
| 6 | `ghostty` on PATH | blocking spawn with `--command` |
| 7 | `$EDITOR` is `code` / `cursor` / `subl` | spawn with `-w` (blocks until GUI closes) |
| 8 | otherwise | `subprocess.run([$EDITOR, file])` (blocks, works on ssh) |

If `$EDITOR` is unset: `$VISUAL` → `micro` → `nano` → `vi`.

For kitty: enable `allow_remote_control yes` and `listen_on unix:/tmp/kitty-$KITTY_PID` in `kitty.conf`.

## Color behavior

| Condition | Colored output |
|---|---|
| stdout is a TTY | yes (unless `--no-color` or `NO_COLOR` set) |
| stdout is a pipe / redirect | no (auto-detected via `isatty()`) |
| `--no-color` flag | no |
| `NO_COLOR` env var (any non-empty) | no ([no-color.org](https://no-color.org)) |

## Development setup

```sh
cd plugin
npm install
python3 bin/plan-review.py --test
cd ..
EDITOR=true bun test ./tests/plugin-smoke.test.ts
```

Override the helper path with `PLAN_REVIEW_SCRIPT=<absolute>` if not running from a clone.

## Layout

```
opencode-planning/
├── plugin/                        # npm package root
│   ├── index.ts                   # server plugin (tool + hooks, thin wiring)
│   ├── tui-plugin.tsx             # Native selection tracking + sidebar block
│   ├── model-store.ts             # shared RMW + per-session record (single source of truth)
│   ├── resolution.ts              # exitPlanMode + resolveBuildModel
│   ├── system-prompt.ts           # system.transform + messages.transform
│   ├── commands.ts                # slash-command handlers
│   ├── install.ts                 # self-install + tui.jsonc registration
│   ├── helpers.ts                 # logged / visibleErr / withTimeoutSafe
│   ├── package.json
│   ├── bin/plan-review.py         # Python helper (stdlib only)
│   └── commands/                  # slash commands (auto-symlinked)
├── tests/model-store.test.ts      # v1, legacy v2, and V2 instruction wire contracts
├── tests/plugin-smoke.test.ts     # legacy server and V2 plugin smoke tests
└── .github/workflows/publish.yml  # npm Trusted Publishing (OIDC)
```

## License

MIT.
