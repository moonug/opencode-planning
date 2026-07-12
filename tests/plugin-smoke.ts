// smoke test: load plugin, verify tool registered, exercise python helper end-to-end.
// run with: bun tests/plugin-smoke.ts
import { $ } from "bun"
import { writeFileSync, chmodSync, readlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"

const pluginPath = new URL("../plugin/index.ts", import.meta.url).pathname
const scriptPath = new URL("../bin/plan-review.py", import.meta.url).pathname

// 1. plugin loads and registers plan_review tool
const mod = await import(pluginPath)
const ctx = {
  client: { app: { log: async () => {} }, session: { prompt: async () => {} } } as any,
  project: {} as any,
  directory: "/tmp",
  worktree: "/tmp",
  serverUrl: new URL("http://x"),
  $,
}
const hooks = await mod.default(ctx)
const t = hooks.tool.plan_review
console.log("[1] tool registered:", Object.keys(t.args).join(","))
if (!t.args.plan) throw new Error("plan arg missing")

// 1b. self-install: symlink at ~/.config/opencode/commands/plan-review.md exists
const linkPath = `${homedir()}/.config/opencode/commands/plan-review.md`
try {
  const target = readlinkSync(linkPath)
  if (!target.includes("opencode-planning")) throw new Error(`symlink target wrong: ${target}`)
  console.log("[1b] command symlink:", target)
} catch (e) {
  throw new Error(`command symlink missing: ${(e as Error).message}`)
}

// 2. python helper produces correct diff when invoked via shebang
const editorPath = "/tmp/pr-smoke-editor.sh"
writeFileSync(editorPath, "#!/bin/sh\nsed -i.bak 's/old/NEW/g' \"$1\"\n")
chmodSync(editorPath, 0o755)

const result = spawnSync(scriptPath, ["--plan-text", "old content\nsecond line"], {
  env: { ...process.env, EDITOR: editorPath },
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
})
console.log("[2] exit:", result.status, "stdout:")
console.log(result.stdout)
if (!result.stdout.includes("-old content")) throw new Error("diff missing removed line")
if (!result.stdout.includes("+NEW content")) throw new Error("diff missing added line")

// 3. python helper returns empty on no-op (editor that doesn't touch file)
const noopEditor = "/tmp/pr-smoke-noop.sh"
writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
chmodSync(noopEditor, 0o755)

const empty = spawnSync(scriptPath, ["--plan-text", "no change"], {
  env: { ...process.env, EDITOR: noopEditor },
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
})
console.log("[3] no-op stdout length:", empty.stdout.length)
if (empty.stdout.length !== 0) throw new Error("expected empty diff for no-op editor")

console.log("[OK] all smoke checks passed")