# opencode-plan-review

## Origin

Adapted from the Claude Code `planning` plugin in [`umputun/cc-thingz`](https://github.com/umputun/cc-thingz) (MIT, by [Umputun](https://github.com/umputun)). The original plugin targets Claude Code via a `PreToolUse` hook on `ExitPlanMode`; this project targets [opencode](https://opencode.ai) via a custom tool + slash command, since opencode has no equivalent "exit plan mode" hook.

Heavy reuse from the original:
- `editor-overlay cascade` (tmux → kitty → wezterm) and `sentinel-file pattern` ported to `bin/plan-review.py` with minor adjustments for ssh/vim fallback and code/cursor `-w` auto-append.
- `unified-diff-via-difflib` and the `tempfile.NamedTemporaryFile(delete=False) + finally unlink` lifecycle ported verbatim.
- `--test` self-check inline unit-test runner.

Differences from the original:
- No `PreToolUse` / `permissionDecision: "deny"` output. Opencode uses tool-result strings for feedback, not hook-protocol JSON.
- Adds self-install of `commands/plan-review.md` (opencode requires markdown files in its commands dir).
- Adds `session.prompt({ agent: "build" })` auto-exit on empty diff (plannotator trick), since opencode has no UI "approve plan" button for custom tools.
- Adds ANSI color (with `NO_COLOR` respect) and `--no-color` flag.

## What it does

After the model produces a structured plan, open it in `$EDITOR` via a terminal overlay (tmux / kitty / wezterm), compute a unified diff of the user's edits, and return the diff as feedback for the model to revise the plan.

Works on plain ssh / vim too — no overlay terminal required.

## What it does

- Registers a `plan_review` tool the model calls when ready to publish a plan.
- Registers a `/plan-review <file>` slash command for ad-hoc review of any markdown file.
- Injects system-prompt instructions so the model auto-calls the tool after producing a plan.
- Opens the plan in `$EDITOR` (cascade: tmux popup → kitty overlay → wezterm split-pane → `code -w` / `cursor -w` → blocking spawn).
- Computes a unified diff (Python `difflib`); the diff becomes the model's next user message.
- Loop terminates when the user closes the editor without changes.

## Install

One line. Add the plugin to `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/Users/you/projects/opencode-planning/plugin/index.ts"
  ]
}
```

Restart opencode. The plugin self-installs the rest on first load:

- **`bin/plan-review.py`** — Python 3 helper, found via `import.meta.url` (no `$PATH` copy needed). Spawned directly via shebang.
- **`commands/plan-review.md`** — symlinked into `~/.config/opencode/commands/` automatically.
- The plugin also `chmod +x`s the python helper if it isn't already.

Override paths via env vars if needed:

| Var | Default |
|---|---|
| `PLAN_REVIEW_SCRIPT` | `<plugin-dir>/../bin/plan-review.py` |
| `EDITOR` | `$VISUAL` → `micro` → `nano` → `vi` |

## Editor cascade

| Priority | Condition | How |
|---|---|---|
| 1 | `$TMUX` set, `tmux` on PATH | `tmux display-popup -E -w 90% -h 90%` (blocks natively, no sentinel) |
| 2 | `$KITTY_LISTEN_ON` set, `kitty` on PATH | `kitty @ launch --type=overlay` + sentinel file |
| 3 | `$WEZTERM_PANE` set, `wezterm` on PATH | `wezterm cli split-pane` + sentinel file |
| 4 | `$EDITOR` is `code` / `cursor` / `subl` / etc. | spawn with `-w` flag (blocks until GUI window closes) |
| 5 | otherwise | `subprocess.run([$EDITOR, file])` inheriting stdio (works on ssh with vim) |

If `$EDITOR` is unset, fallback order: `$VISUAL` → `micro` → `nano` → `vi`.

For kitty: enable `allow_remote_control yes` and `listen_on unix:/tmp/kitty-$KITTY_PID` in `kitty.conf`.

## Auto-exit plan mode

When `plan_review` returns no diff (user closed editor without changes), the plugin auto-injects a `session.prompt({ agent: "build", noReply: true })` — same trick plannotator uses — to switch the session out of the plan agent into the build agent. No UI approval click required.

## Verification

```sh
# python helper unit tests (25 cases, stdlib only)
python3 bin/plan-review.py --test

# end-to-end smoke (plugin loads, symlink created, python helper diffs)
bun tests/plugin-smoke.ts

# manual end-to-end (opens real editor, returns real diff)
echo "# Plan\n- task 1\n" | python3 bin/plan-review.py --file /dev/stdin
```

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
npm install        # or: bun install
cd ..
python3 bin/plan-review.py --test
bun tests/plugin-smoke.ts
```

The `plugin/node_modules/` directory is gitignored. Override the path to the helper with `PLAN_REVIEW_SCRIPT=<absolute>` if you're not running from a clone.

## Layout

```
opencode-planning/
├── bin/
│   └── plan-review.py            # Python helper, stdlib only
├── plugin/
│   ├── index.ts                  # opencode plugin entry
│   ├── package.json
│   └── tsconfig.json
├── commands/
│   └── plan-review.md            # slash-command template
├── tests/
│   └── plugin-smoke.ts           # end-to-end smoke
└── docs/
    └── ARCHITECTURE.md
```

## License

MIT.