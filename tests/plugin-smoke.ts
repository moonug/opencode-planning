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

// 1b. self-install: symlinks for all commands
for (const name of ["plan-review.md", "set-build-model.md", "plan-diag.md"]) {
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

// 7. exitPlanMode refuses when no target resolved — exercise via plan_review.execute
//    with a no-op editor (empty diff triggers exitPlanMode). Map and client are
//    the real plugin context; we mock client.session.prompt to capture the build
//    prompt instead of letting python helper run.
{
  const noopEditor = "/tmp/pr-smoke-exitnoop.sh"
  writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor, 0o755)

  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  const out = await testHooks.tool.plan_review.execute(
    { plan: "no change" },
    { sessionID: "ses_target_undef", messageID: "m", agent: "build", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  if (!out.includes("Switched to build agent")) throw new Error("plan_review did not report success")
  if (prompts.length !== 1) throw new Error(`expected 1 prompt, got ${prompts.length}`)
  const text = prompts[0].body.parts[0].text
  if (!text.includes("No build model resolved")) throw new Error("missing refusal warning: " + text)
  if (!text.includes("/set-build-model")) throw new Error("missing /set-build-model hint")
  if (text.includes("(opencode default)")) throw new Error("still contains fallback to opencode default")
  console.log("[7] exitPlanMode refuses when target undefined: ok")
}

// 7b. exitPlanMode happy path with resolved target — sends inline model+agent
//     override in client.session.prompt body (v1 SDK shorthand, no v2 needed).
{
  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  // populate build event memory by sending a build event through event hook
  await testHooks.event({
    event: {
      type: "session.updated.1",
      data: {
        sessionID: "ses_happy",
        info: { id: "ses_happy", agent: "build", model: { providerID: "ya-glm", id: "glm" } },
      },
    },
  } as any)
  prompts.length = 0  // clear session.created prompt that might fire
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "plan-review", arguments: "/tmp/nonexistent.md", sessionID: "ses_happy" },
    },
  } as any).catch(() => {})
  // drive exitPlanMode via plan_review tool execute with a no-op editor
  const noopEditor2 = "/tmp/pr-smoke-happy-noop.sh"
  writeFileSync(noopEditor2, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor2, 0o755)
  const out = await testHooks.tool.plan_review.execute(
    { plan: "x" },
    { sessionID: "ses_happy", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  if (!out.includes("Switched to build agent")) throw new Error("happy path did not report success")
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("build prompt not sent with agent=build")
  if (buildPrompt.body?.model?.providerID !== "ya-glm") throw new Error(`inline model.providerID wrong: ${JSON.stringify(buildPrompt.body?.model)}`)
  if (buildPrompt.body?.model?.modelID !== "glm") throw new Error(`inline model.modelID wrong: ${JSON.stringify(buildPrompt.body?.model)}`)
  if (buildPrompt.body?.noReply !== true) throw new Error("build prompt must have noReply=true")
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: /set-build-model")) {
    throw new Error("build prompt text missing source label: " + buildPrompt.body?.parts?.[0]?.text)
  }
  console.log("[7b] exitPlanMode happy path with inline model+agent: ok")
}

// 10. /set-build-model <provider>/<model> writes to in-memory Map, exitPlanMode uses it
{
  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  // call /set-build-model with explicit string
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "ya-glm/glm", sessionID: "ses_set" },
    },
  } as any)
  const confirm = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("Build model for this session set to"))
  if (!confirm) throw new Error("set-build-model did not produce confirmation")
  if (!confirm.body.parts[0].text.includes("ya-glm/glm")) throw new Error("confirmation missing model id")

  // drive exitPlanMode via plan_review tool execute with no-op editor
  prompts.length = 0
  const noopEditor3 = "/tmp/pr-smoke-set-noop.sh"
  writeFileSync(noopEditor3, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor3, 0o755)
  await testHooks.tool.plan_review.execute(
    { plan: "x" },
    { sessionID: "ses_set", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("build prompt not sent after set-build-model")
  if (buildPrompt.body?.model?.providerID !== "ya-glm" || buildPrompt.body?.model?.modelID !== "glm") {
    throw new Error(`build prompt wrong model: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: /set-build-model")) {
    throw new Error("build prompt text missing /set-build-model source label")
  }
  console.log("[10] /set-build-model writes Map, exitPlanMode uses it: ok")
}

// 11. /set-build-model without args lists providers via client.config.providers()
{
  const prompts: any[] = []
  const logs: any[] = []
  const fakeProviders = {
    data: {
      providers: [
        { id: "ya-glm", name: "Yandex GLM", models: { glm: { name: "GLM" } } },
        { id: "anthropic", name: "Anthropic", models: { "claude-sonnet-4": { name: "Claude Sonnet 4" } } },
        { id: "minimax-coding-plan", name: "Coding Plan", models: { "MiniMax-M3": { status: "active" } } },
      ],
    },
  }
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: {
      get: async () => ({ data: {} }),
      providers: async () => fakeProviders,
    },
    session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  prompts.length = 0
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "", sessionID: "ses_pick" },
    },
  } as any)
  const picker = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("set-build-model picker"))
  if (!picker) throw new Error("picker output missing")
  const text = picker.body.parts[0].text
  if (!text.includes("ya-glm") || !text.includes("anthropic") || !text.includes("minimax-coding-plan")) {
    throw new Error("picker list missing providers: " + text)
  }
  if (!text.includes("/set-build-model <number>")) {
    throw new Error("picker missing usage hint for number selection")
  }
  // pick via number — must use last shown list
  prompts.length = 0
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "2", sessionID: "ses_pick" },
    },
  } as any)
  const pick2 = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("Build model for this session set to"))
  if (!pick2) throw new Error("numeric pick did not produce confirmation")
  if (!pick2.body.parts[0].text.includes("anthropic/claude-sonnet-4")) {
    throw new Error(`numeric pick wrong: expected anthropic/claude-sonnet-4, got ${pick2.body.parts[0].text}`)
  }
  console.log("[11] /set-build-model picker (list + numeric pick): ok")
}

// 12. chat.message hook captures inline model from TUI picker
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async () => {} },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  await testHooks["chat.message"](
    {
      sessionID: "ses_chat",
      agent: "build",
      model: { providerID: "ya-glm", modelID: "glm" },
    } as any,
    { message: {} as any, parts: [] },
  )
  if (!logs.some((l: any) => l.body?.level === "debug" && l.body?.message?.includes("chat.message captured") && l.body?.message?.includes("ya-glm/glm"))) {
    throw new Error("chat.message hook did not emit capture log")
  }
  console.log("[12] chat.message captures TUI picker inline model: ok")
}

// 13. exitPlanMode priority chain: chat.message wins over build event memory
{
  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: { model: "anthropic/claude-sonnet-4" } }) },
    session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  // populate BOTH: build event memory with MiniMax-M3 AND chat.message with ya-glm
  await testHooks.event({
    event: {
      type: "session.updated.1",
      data: {
        sessionID: "ses_prio",
        info: { id: "ses_prio", agent: "build", model: { providerID: "minimax-coding-plan", id: "MiniMax-M3" } },
      },
    },
  } as any)
  await testHooks["chat.message"](
    {
      sessionID: "ses_prio",
      agent: "build",
      model: { providerID: "ya-glm", modelID: "glm" },
    } as any,
    { message: {} as any, parts: [] },
  )
  prompts.length = 0
  const noopEditor4 = "/tmp/pr-smoke-prio-noop.sh"
  writeFileSync(noopEditor4, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor4, 0o755)
  await testHooks.tool.plan_review.execute(
    { plan: "x" },
    { sessionID: "ses_prio", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("build prompt missing")
  if (buildPrompt.body?.model?.providerID !== "ya-glm" || buildPrompt.body?.model?.modelID !== "glm") {
    throw new Error(`chat.message should win over session.updated, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: chat.message")) {
    throw new Error(`build prompt should have 'source: chat.message' label, got: ${buildPrompt.body?.parts?.[0]?.text}`)
  }
  console.log("[13] chat.message wins over session.updated: ok")
}

// 14. priority chain order: chat.message > /set-build-model (per user choice)
//     We verify by NOT touching /set-build-model and confirming chat.message wins.
{
  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
  }
  const ctx = {
    client: fakeClient,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  }
  const testHooks = await mod.default(ctx)
  // set both: chat.message with minimax + /set-build-model with ya-glm
  // priority #1 is chat.message per user's choice — must win
  await testHooks["chat.message"](
    {
      sessionID: "ses_over",
      agent: "build",
      model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" },
    } as any,
    { message: {} as any, parts: [] },
  )
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "ya-glm/glm", sessionID: "ses_over" },
    },
  } as any)
  prompts.length = 0
  const noopEditor5 = "/tmp/pr-smoke-over-noop.sh"
  writeFileSync(noopEditor5, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor5, 0o755)
  await testHooks.tool.plan_review.execute(
    { plan: "x" },
    { sessionID: "ses_over", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("build prompt missing")
  // chat.message should win (per user's priority choice: "chat.message wins")
  if (buildPrompt.body?.model?.providerID !== "minimax-coding-plan") {
    throw new Error(`chat.message should win per user priority, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: chat.message")) {
    throw new Error(`expected source: chat.message, got: ${buildPrompt.body?.parts?.[0]?.text}`)
  }
  console.log("[14] priority order: chat.message wins over /set-build-model: ok")
}

// 15. plugin init logs: "plugin init v0.2.0" + "tool 'plan_review' created, args: ..."
{
  const logs: any[] = []
  const testHooks = await mod.default({
    client: { app: { log: async (opts: any) => { logs.push(opts) } }, session: { prompt: async () => {} } } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const initLog = logs.find((l: any) => l.body?.level === "info" && l.body?.message?.includes("plugin init v0.2.0"))
  if (!initLog) throw new Error("init log 'plan-review: plugin init v0.2.0' missing")
  const toolLog = logs.find((l: any) => l.body?.level === "info" && l.body?.message?.includes("tool 'plan_review' created"))
  if (!toolLog) throw new Error("tool registration log missing")
  if (!toolLog.body.message.includes("plan")) throw new Error("tool log missing arg name")
  if (!testHooks.tool.plan_review) throw new Error("plan_review not in returned hooks")
  console.log("[15] init + tool registration logs emitted: ok")
}

// 8. experimental.chat.system.transform appends ENFORCEMENT block
{
  const logs: any[] = []
  const testHooks = await mod.default({
    client: { app: { log: async (opts: any) => { logs.push(opts) } }, session: { prompt: async () => {} } } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const out: any = { system: ["base prompt about file editing"] }
  await testHooks["experimental.chat.system.transform"]({ model: { providerID: "x", modelID: "y" } }, out)
  const joined = out.system.join("\n")
  if (!joined.includes("ENFORCEMENT")) throw new Error("ENFORCEMENT block missing")
  if (!joined.includes("plan_review")) throw new Error("plan_review mention missing")
  if (!joined.includes("bash tool")) throw new Error("bash fallback hint missing")
  if (!logs.some((l: any) => l.body?.level === "debug" && l.body?.message?.includes("system prompt injected"))) {
    throw new Error("diagnostic log missing")
  }
  // must skip subagent agents
  const subOut: any = { system: ["subagent system prompt"] }
  await testHooks["experimental.chat.system.transform"]({ model: { providerID: "x", modelID: "y" } }, subOut)
  if (subOut.system.join("\n").includes("ENFORCEMENT")) throw new Error("ENFORCEMENT should not be added for subagent")
  console.log("[8] system prompt transform with ENFORCEMENT: ok")
}

// 9. event hook emits diagnostic log for session.updated + plan-diag handler
{
  const logs: any[] = []
  const prompts: any[] = []
  const testHooks = await mod.default({
    client: {
      app: { log: async (opts: any) => { logs.push(opts) } },
      session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
    } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  // simulate a session.updated event with build agent and a model
  await testHooks.event({
    event: {
      type: "session.updated.1",
      data: {
        sessionID: "ses_diag_test",
        info: { id: "ses_diag_test", agent: "build", model: { providerID: "ya-glm", id: "glm" } },
      },
    },
  } as any)

  // diagnostic log line for session.updated must be present
  if (!logs.some((l: any) => l.body?.level === "debug" && l.body?.message?.includes("session.updated:") && l.body?.message?.includes("ya-glm/glm"))) {
    throw new Error("diagnostic log for session.updated missing")
  }

  // rememberBuildModel should have populated the Map
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "plan-diag", arguments: "", sessionID: "ses_diag_test" },
    },
  } as any)
  if (!prompts.some((p: any) => p.body?.parts?.[0]?.text?.includes("# plan-diag"))) {
    throw new Error("/plan-diag handler did not produce diag output")
  }
  const diagText = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("# plan-diag"))?.body.parts[0].text
  if (!diagText.includes("ya-glm/glm")) throw new Error("plan-diag output missing remembered build model")

  // /plan-diag reset clears the map
  prompts.length = 0
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "plan-diag", arguments: "reset", sessionID: "ses_diag_test" },
    },
  } as any)
  if (!prompts.some((p: any) => p.body?.parts?.[0]?.text?.includes("build-event memory cleared"))) {
    throw new Error("/plan-diag reset did not produce confirmation")
  }

  console.log("[9] diagnostic log + /plan-diag handler: ok")
}

console.log("[OK] all smoke checks passed")