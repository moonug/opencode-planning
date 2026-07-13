// smoke test: load plugin, verify tool registered, exercise python helper end-to-end.
// run with: bun tests/plugin-smoke.ts
import { $ } from "bun"
import { writeFileSync, chmodSync, readlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"

const pluginPath = new URL("../plugin/index.ts", import.meta.url).pathname
const scriptPath = new URL("../bin/plan-review.py", import.meta.url).pathname
const { rememberBuildModel, sessionUpdateInfo } = await import("../plugin/model-memory.ts")

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

// 1b. self-install: symlinks for both commands
for (const name of ["plan-review.md", "set-build-model.md"]) {
  const linkPath = `${homedir()}/.config/opencode/commands/${name}`
  const target = readlinkSync(linkPath)
  if (!target.includes("opencode-planning")) throw new Error(`symlink target wrong: ${target}`)
  console.log(`[1b] ${name} →`, target)
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

// 4. parseModelString edge cases (mirrors plugin/index.ts)
function parseModelString(s: string): { providerID: string; modelID: string } | undefined {
  const m = s.match(/^([^/\s]+)\/(.+)$/)
  if (!m) return undefined
  return { providerID: m[1], modelID: m[2] }
}
{
  const cases: Array<[string, { providerID: string; modelID: string } | undefined]> = [
    ["anthropic/claude-sonnet-4", { providerID: "anthropic", modelID: "claude-sonnet-4" }],
    ["ya-deepseek/deepseek-v4-flash", { providerID: "ya-deepseek", modelID: "deepseek-v4-flash" }],
    ["no-slash", undefined],
    ["/missing-provider", undefined],
    ["missing-model/", undefined],
    ["", undefined],
    ["   ", undefined],
  ]
  for (const [input, expected] of cases) {
    const got = parseModelString(input)
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      throw new Error(`parseModelString("${input}"): expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`)
    }
  }
  console.log("[4] parseModelString: 7/7 cases ok")
}

// 5. rememberBuildModel correctly tracks last build-agent model per session
{
  const models = new Map<string, { providerID: string; modelID: string }>()

  // ignore plan-agent events
  rememberBuildModel({
    type: "session.updated",
    properties: { info: { id: "s1", agent: "plan", model: { providerID: "ya-glm", id: "glm" } } },
  }, models)
  if (models.has("s1")) throw new Error("plan-agent event should be ignored")

  // remember build-agent model
  rememberBuildModel({
    type: "session.updated",
    properties: { info: { id: "s1", agent: "build", model: { providerID: "omlx", id: "Ornith" } } },
  }, models)
  if (JSON.stringify(models.get("s1")) !== JSON.stringify({ providerID: "omlx", modelID: "Ornith" })) {
    throw new Error("first build-agent model not remembered")
  }

  // overwrite with later build-agent model
  rememberBuildModel({
    type: "session.updated.1",
    data: { info: { id: "s1", agent: "build", model: { providerID: "ya-deepseek", id: "deepseek-v4-flash" } } },
  }, models)
  if (JSON.stringify(models.get("s1")) !== JSON.stringify({ providerID: "ya-deepseek", modelID: "deepseek-v4-flash" })) {
    throw new Error("second build-agent model did not overwrite")
  }

  // sync wrapper
  rememberBuildModel({
    type: "sync",
    syncEvent: {
      type: "session.updated.1",
      data: { info: { id: "s2", agent: "build", model: { providerID: "minimax", id: "M3" } } },
    },
  }, models)
  if (JSON.stringify(models.get("s2")) !== JSON.stringify({ providerID: "minimax", modelID: "M3" })) {
    throw new Error("sync wrapper not handled")
  }

  // ignore malformed events
  rememberBuildModel({ type: "session.updated", properties: { info: { id: "s3" } } }, models)
  if (models.has("s3")) throw new Error("malformed event should be ignored")

  // sessionUpdateInfo returns info from any wrapper
  if (!sessionUpdateInfo({ type: "session.updated", properties: { info: { id: "x" } } })) throw new Error("info extractor broken")

  console.log("[5] build event memory: 6/6 cases ok")
}

// 6. real-world event format from opencode SQLite (data.sessionID + data.info.{agent,model})
{
  const models = new Map<string, { providerID: string; modelID: string }>()
  rememberBuildModel({
    type: "session.updated.1",
    data: {
      sessionID: "ses_real",
      info: {
        id: "ses_real",
        agent: "build",
        model: { id: "MiniMax-M3", providerID: "minimax-coding-plan", variant: "thinking" },
      },
    },
  }, models)
  if (JSON.stringify(models.get("ses_real")) !== JSON.stringify({ providerID: "minimax-coding-plan", modelID: "MiniMax-M3" })) {
    throw new Error(`real-world event not captured: ${JSON.stringify(models.get("ses_real"))}`)
  }
  console.log("[6] real-world event format (SQLite-style): ok")
}

// 7. exitPlanMode refuses when no target resolved (no silent default-to-plan-model)
{
  const { exitPlanMode } = await import("../plugin/index.ts")
  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async (opts: any) => { prompts.push(opts) } },
  }
  await exitPlanMode(
    fakeClient,
    null,  // v2 unavailable
    new Map(),  // no build event memory
    "ses_target_undef",
    "test summary",
  )
  if (prompts.length !== 1) throw new Error(`expected 1 prompt, got ${prompts.length}`)
  const text = prompts[0].body.parts[0].text
  if (!text.includes("No build model resolved")) throw new Error("missing refusal warning")
  if (!text.includes("/set-build-model")) throw new Error("missing /set-build-model hint")
  if (text.includes("(opencode default)")) throw new Error("still contains fallback to opencode default")
  if (!logs.some((l: any) => l.body?.level === "warn" && l.body?.message?.includes("no build model resolved"))) {
    throw new Error("missing warn log")
  }
  console.log("[7] exitPlanMode refuses when target undefined: ok")
}

console.log("[OK] all smoke checks passed")