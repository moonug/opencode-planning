# opencode-plan-review

[![npm version](https://img.shields.io/npm/v/opencode-plan-review.svg)](https://www.npmjs.com/package/opencode-plan-review)

Plan review plugin for [opencode](https://opencode.ai). Opens plans in `$EDITOR`, returns a unified diff of the user's edits as feedback for the model.

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

1. **chat.message memory (build)** — model captured directly or promoted from native TUI selection metadata
2. **build model memory** — `rememberBuildModel` from `session.updated` events (agent-filtered: only `agent === "build"`)
3. **chat.message memory (plan)** — fallback when no build-specific model is known
4. **`agent.build.model`** — from opencode config
5. **`config.model`** — global default
6. **`agent.plan.model`** — last resort

If none resolve, the plugin refuses the auto-switch and prints instructions. Use `/plan-diag` to inspect.

### How model tracking works

The [opencode fork](https://github.com/moonug/opencode/tree/tui-selection-events) exposes `api.state.selection()` and `tui.selection.changed`. At startup and on each event, the TUI plugin serializes a per-session metadata read-modify-write for the current plan/build models. It also shows a compact `Agent models` sidebar block with status-dot highlighting.

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
EDITOR=true bun tests/plugin-smoke.ts
```

Override the helper path with `PLAN_REVIEW_SCRIPT=<absolute>` if not running from a clone.

## Layout

```
opencode-planning/
├── plugin/                        # npm package root
│   ├── index.ts                   # server plugin (tool + hooks)
│   ├── tui-plugin.tsx             # Native selection tracking + sidebar block
│   ├── model-memory.ts            # rememberBuildModel (agent-filtered)
│   ├── package.json
│   ├── bin/plan-review.py         # Python helper (stdlib only)
│   └── commands/                  # slash commands (auto-symlinked)
├── tests/plugin-smoke.ts          # end-to-end smoke
└── .github/workflows/publish.yml  # npm Trusted Publishing (OIDC)
```

## License

MIT.
