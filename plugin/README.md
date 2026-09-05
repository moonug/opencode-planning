# opencode-plan-review

[![npm version](https://img.shields.io/npm/v/opencode-plan-review.svg)](https://www.npmjs.com/package/opencode-plan-review)

Plan review plugin for [OpenCode V2](https://opencode.ai/v2/docs/). Opens plans in `$EDITOR`, returns a unified diff of the user's edits as feedback for the model.

## Origin

Adapted from the Claude Code `planning` plugin in [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz) (MIT). The original targets Claude Code via `PreToolUse` hooks; this project targets opencode via a custom tool + system-prompt injection.

## What it does

- Registers a `plan_review` tool the model calls when the plan is ready
- Rewrites `plan_exit` / `ExitPlanMode` references in system prompts → `plan_review` so the model always calls the right tool
- Opens the plan in `$EDITOR` (cascade: agterm → tmux → zellij → kitty → wezterm → ghostty → `code -w` / `cursor -w` → blocking spawn)
- Computes a unified diff (Python `difflib`); the diff becomes the model's next user message
- When the user closes the editor without changes: auto-switches from plan agent to build agent on a per-session build model
- Slash commands: `/plan-review <file>`, `/set-build-model [provider/model | N]`, `/plan-diag [reset]`

## Requirements

- **OpenCode V2**
- **Python 3.x** — stdlib only
- **Terminal overlay** (optional): `agtermctl`, `tmux`, `zellij`, `kitty`, `wezterm`, or `ghostty`. Falls back to plain `$EDITOR` on bare ssh.

## Install

Add to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-plan-review"]
}
```

For a local checkout, put the absolute `plugin/` directory in the same array. V2 loads the server entrypoint and its exported `./tui` entrypoint together; no command symlinks or separate TUI configuration are required.

## Build-model resolution

When a plan is approved, the session switches to the build agent. The build model is resolved from **per-session sources only** (never global `model.json`, never plan's model):

1. **`planReviewModels.build` record** — durable plugin storage keyed by session. Existing V1 session metadata is read as a migration fallback and copied on the next write. `/set-build-model` pins its choice so implicit captures leave it alone.
2. **Session history** — model of the last build-agent user message
3. **`agent.build.model`** — from opencode config
4. **`config.model`** — global default

If none resolve, the plugin refuses the auto-switch and prints manual instructions — it never falls back to the plan agent's model. With write-time precedence on the single per-session record (`planReviewModels`), the sticky-model bug is structurally gone; a synthetic-prompt guard is kept as defense-in-depth so diagnostics stay clean. Use `/plan-diag` to inspect.

### How model tracking works

The V2 server emits `session.model.selected` when a model choice is committed. The server plugin reads the session's active agent and records only that agent's model. The prompt-admission hook provides a second capture path.

The exported V2 TUI plugin is display-only. Its `Agent models` sidebar block derives plan/build models from durable session state and message history, so it does not need a private fork API or access to server-plugin storage.

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
npm run typecheck
npm run test:v2
```

Override the helper path with `PLAN_REVIEW_SCRIPT=<absolute>` if not running from a clone.

## Layout

```
opencode-planning/
├── plugin/                        # npm package root
│   ├── index.ts                   # legacy V1 server implementation
│   ├── server.ts / v2.ts          # V2 server entrypoint and implementation
│   ├── tui.tsx / tui-v2.tsx       # V2 sidebar entrypoint and implementation
│   ├── tui-plugin.tsx             # legacy V1 TUI implementation
│   ├── model-store.ts             # shared RMW + per-session record (single source of truth)
│   ├── resolution.ts              # exitPlanMode + resolveBuildModel
│   ├── system-prompt.ts           # system.transform + messages.transform
│   ├── commands.ts                # slash-command handlers
│   ├── install.ts                 # legacy V1 self-installer
│   ├── helpers.ts                 # logged / visibleErr / withTimeoutSafe
│   ├── package.json
│   ├── bin/plan-review.py         # Python helper (stdlib only)
│   ├── commands/                  # command documentation
│   └── tests/v2-tui-smoke.tsx     # V2 sidebar render smoke
├── tests/plugin-smoke.ts          # end-to-end smoke (~60 checks incl. P1–P4 regressions)
├── tests/v2-plugin-smoke.ts       # V2 transforms, commands, storage, and switch ordering
└── .github/workflows/publish.yml  # npm Trusted Publishing (OIDC)
```

## License

MIT.
