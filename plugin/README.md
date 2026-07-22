# opencode-plan-review

[![npm version](https://img.shields.io/npm/v/opencode-plan-review.svg)](https://www.npmjs.com/package/opencode-plan-review)

Plan review plugin for [opencode](https://opencode.ai). Opens plans in `$EDITOR`, returns a unified diff of the user's edits as feedback for the model.

## Origin

Adapted from the Claude Code `planning` plugin in [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz) (MIT). The original targets Claude Code via `PreToolUse` hooks; this project targets opencode via a custom tool + system-prompt injection.

## What it does

- Registers a `plan_review` tool the model calls when the plan is ready
- Rewrites `plan_exit` / `ExitPlanMode` references in system prompts → `plan_review` so the model always calls the right tool
- Opens the plan in `$EDITOR` (cascade: tmux popup → kitty overlay → wezterm split → `code -w` / `cursor -w` → blocking spawn)
- Computes a unified diff (Python `difflib`); the diff becomes the model's next user message
- When the user closes the editor without changes: auto-switches from plan agent to build agent on a per-session build model
- Slash commands: `/plan-review <file>`, `/set-build-model [provider/model | N]`, `/plan-diag [reset]`

## Requirements

- **Python 3.x** — stdlib only
- **Terminal overlay** (optional): `tmux`, `kitty`, or `wezterm`. Falls back to plain `$EDITOR` (e.g. `vim`) on bare ssh.

## Install

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": ["opencode-plan-review"]
}
```

Restart opencode. The plugin self-installs on first load:
- **`commands/*.md`** — symlinked into `~/.config/opencode/commands/`
- **TUI plugin** — auto-registered into `~/.config/opencode/tui.jsonc` (tracks Tab agent switches + model snapshots)
- **`bin/plan-review.py`** — Python helper, resolved from the package directory. `chmod +x` applied if needed.

## Build-model resolution

When a plan is approved, the session switches to the build agent. The build model is resolved per-session in this order (first match wins):

1. **chat.message memory (build)** — model promoted from TUI metadata snapshots (Tab or startup)
2. **build model memory** — `rememberBuildModel` from `session.updated` events (agent-filtered: only `agent === "build"`)
3. **chat.message memory (plan)** — fallback when no build-specific model is known
4. **`agent.build.model`** — from opencode config
5. **`config.model`** — global default
6. **`agent.plan.model`** — last resort

If none resolve, the plugin refuses the auto-switch and prints instructions. Use `/plan-diag` to inspect.

### How model tracking works

The TUI's per-agent model store (`modelStore.model[agentName]`) is in-memory and not exposed to plugins. The plugin bridges this with two mechanisms — both per-instance, no cross-session contamination:

- **Startup snapshot** — reads `model.json` once at TUI init, records it for the default agent (build). This is the model the user sees on screen when opencode opens.
- **Tab snapshot** — on Tab, reads `model.json` with change detection: only records if the model changed since the last Tab. Attributed to `prevAgent` (the agent being tabbed away from).

Snapshots are written to session metadata via `session.update`. The server plugin's `exitPlanMode` reads them back at plan-approval time.

No `model.json` watcher — a global watcher fired in all opencode instances simultaneously, causing cross-session model contamination. Removed in v0.2.0.

## Editor cascade

| Priority | Condition | How |
|---|---|---|
| 1 | `$TMUX` set, `tmux` on PATH | `tmux display-popup -E -w 90% -h 90%` |
| 2 | `$KITTY_LISTEN_ON` set, `kitty` on PATH | `kitty @ launch --type=overlay` + sentinel file |
| 3 | `$WEZTERM_PANE` set, `wezterm` on PATH | `wezterm cli split-pane` + sentinel file |
| 4 | `$EDITOR` is `code` / `cursor` / `subl` | spawn with `-w` (blocks until GUI closes) |
| 5 | otherwise | `subprocess.run([$EDITOR, file])` (works on ssh with vim) |

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
EDITOR=/dev/null bun tests/plugin-smoke.ts
```

Override the helper path with `PLAN_REVIEW_SCRIPT=<absolute>` if not running from a clone.

## Layout

```
opencode-planning/
├── plugin/                        # npm package root
│   ├── index.ts                   # server plugin (tool + hooks)
│   ├── tui-plugin.ts              # TUI plugin (Tab snapshot + model tracking)
│   ├── model-memory.ts            # rememberBuildModel (agent-filtered)
│   ├── package.json
│   ├── bin/plan-review.py         # Python helper (stdlib only)
│   └── commands/                  # slash commands (auto-symlinked)
├── tests/plugin-smoke.ts          # end-to-end smoke
└── .github/workflows/publish.yml  # npm Trusted Publishing (OIDC)
```

## License

MIT.
