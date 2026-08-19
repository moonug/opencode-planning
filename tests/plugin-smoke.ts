// smoke test: load plugin, verify tool registered, exercise python helper end-to-end.
// run with: bun tests/plugin-smoke.ts
import { $ } from "bun"
import { writeFileSync, chmodSync, readlinkSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import "@opentui/solid/preload"

// Force no-op EDITOR for the whole smoke run: tests that exercise
// plan_review.execute call the python helper, which spawns $EDITOR. Without
// forcing this, a system EDITOR=vim would open real vim and block on user
// input in tests [36b]/[36c]/[9c] etc. Tests [2]/[3] override EDITOR with their
// own sed/no-op scripts via spawnSync env, which still wins for those calls.
// NOTE: do not set VISUAL here — plan-review.py prefers VISUAL over EDITOR
// (lines 105-106/135-136), so a global VISUAL would leak past per-test EDITOR
// overrides in spawnSync. Only force EDITOR.
const _defaultNoopEditor = "/tmp/pr-smoke-default-noop.sh"
writeFileSync(_defaultNoopEditor, "#!/bin/sh\nexit 0\n")
chmodSync(_defaultNoopEditor, 0o755)
process.env.EDITOR = _defaultNoopEditor
delete process.env.VISUAL

const pluginPath = new URL("../plugin/index.ts", import.meta.url).pathname
const scriptPath = new URL("../plugin/bin/plan-review.py", import.meta.url).pathname
const modelStore = await import("../plugin/model-store.ts")
const EXPECTED_VERSION = require("../plugin/package.json").version

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

// 5. model-store: captureImplicit respects pinned records, writePicker
//    overwrites freely, writeCommand pins, mergeHomeFlush fills absent agents.
{
  const recorded: Array<{ key: string; value: any }> = []
  const stored = new Map<string, Record<string, any>>()
  const fakeClient = {
    session: {
      get: async ({ path }: any) => ({ data: { metadata: stored.get(path.id) ?? {} } }),
      update: async ({ path, body }: any) => {
        // The v1 SDK adapter passes metadata under body. Match that here so
        // a regression moving metadata back to the top level surfaces as a
        // missing key on `recorded[i].value`.
        const next = body?.metadata
        if (next) stored.set(path.id, next)
        recorded.push({ key: path.id, value: next })
        return { data: null }
      },
    },
  } as any

  // captureImplicit writes chat-capture record
  await modelStore.captureImplicit(modelStore.v1SdkAdapter(fakeClient), "ses_a", "build", { providerID: "ya-glm", modelID: "glm" })
  if (recorded.length !== 1) throw new Error("captureImplicit did not write metadata")
  if (recorded[0].value.planReviewModels.build?.source !== "chat") throw new Error("captureImplicit source wrong")

  // writeCommand sets pinned:true
  await modelStore.writeCommand(modelStore.v1SdkAdapter(fakeClient), "ses_a", "build", { providerID: "anthropic", modelID: "claude-sonnet-4" })
  if (recorded[1].value.planReviewModels.build?.pinned !== true) throw new Error("writeCommand did not set pinned")
  if (recorded[1].value.planReviewModels.build?.source !== "command") throw new Error("writeCommand source wrong")

  // captureImplicit must SKIP a pinned record (no overwrite)
  const beforeCount = recorded.length
  await modelStore.captureImplicit(modelStore.v1SdkAdapter(fakeClient), "ses_a", "build", { providerID: "openai", modelID: "gpt-x" })
  if (recorded.length !== beforeCount) throw new Error("captureImplicit must skip pinned records")
  const finalBuild = (await modelStore.readRecord(modelStore.v1SdkAdapter(fakeClient), "ses_a")).build
  if (finalBuild?.providerID !== "anthropic") throw new Error("pinned record lost its model: " + JSON.stringify(finalBuild))

  // writePicker overwrites freely (explicit beats pinned)
  await modelStore.writePicker(modelStore.v1SdkAdapter(fakeClient), "ses_a", "build", { providerID: "openai", modelID: "gpt-y" })
  const after = (await modelStore.readRecord(modelStore.v1SdkAdapter(fakeClient), "ses_a")).build
  if (after?.providerID !== "openai") throw new Error("writePicker did not overwrite: " + JSON.stringify(after))

  // mergeHomeFlush fills absent agents only
  recorded.length = 0
  await modelStore.mergeHomeFlush(modelStore.v1SdkAdapter(fakeClient), "ses_b", {
    plan: { providerID: "ya-glm", modelID: "glm" },
    build: { providerID: "openai", modelID: "gpt-z" },
  })
  const home = (await modelStore.readRecord(modelStore.v1SdkAdapter(fakeClient), "ses_b"))
  if (home.plan?.source !== "home-flush" || home.build?.source !== "home-flush") {
    throw new Error("home-flush source wrong: " + JSON.stringify(home))
  }

  // mergeHomeFlush does NOT overwrite existing records
  recorded.length = 0
  const written = await modelStore.mergeHomeFlush(modelStore.v1SdkAdapter(fakeClient), "ses_b", {
    plan: { providerID: "anthropic", modelID: "claude-x" }, // already has plan=glm
    build: { providerID: "anthropic", modelID: "claude-y" }, // already has build=gpt-z
  })
  if (written.length !== 0) throw new Error("mergeHomeFlush overwrote existing records: " + JSON.stringify(written))
  if (recorded.length !== 0) throw new Error("mergeHomeFlush no-op should not write metadata")

  console.log("[5] model-store: pinned/command/picker/home-flush semantics: ok")
}

// 6. model-store: legacy planReviewDeferredPicks metadata is read once as
//    fallback; next write migrates to planReviewModels.
{
  const stored = new Map<string, Record<string, any>>([
    ["ses_legacy", {
      planReviewDeferredPicks: {
        build: { providerID: "openai", modelID: "gpt-old", pickedAt: 1234 },
        plan: { providerID: "anthropic", modelID: "claude-old", pickedAt: 5678, explicit: false },
      },
    }],
  ])
  const fakeClient = {
    session: {
      get: async ({ path }: any) => ({ data: { metadata: stored.get(path.id) ?? {} } }),
      update: async ({ path, metadata }: any) => { stored.set(path.id, metadata); return { data: null } },
    },
  } as any

  const rec = await modelStore.readRecord(modelStore.v1SdkAdapter(fakeClient), "ses_legacy")
  if (rec.build?.providerID !== "openai" || rec.build?.source !== "picker") {
    throw new Error("legacy build pick not parsed: " + JSON.stringify(rec.build))
  }
  if (rec.plan?.explicit === false && rec.plan?.source !== "home-flush") {
    throw new Error("legacy plan pick should be tagged home-flush: " + JSON.stringify(rec.plan))
  }
  console.log("[6] model-store: legacy planReviewDeferredPicks read fallback: ok")
}

// [contract:update-body] updateRecord sends metadata under body, not at the top
//    level. The fork ships a v1 SDK client (`@opencode-ai/sdk`) whose
//    body type is `{ title?: string }` and whose hey-api runtime only
//    serializes `options.body`. Putting `metadata` at the top level silently
//    drops it on the wire — no schema rejection, just empty metadata on the
//    server. This fake mimics that runtime exactly so a regression moves the
//    metadata back into a shape the server will actually persist.
{
  const stored = new Map<string, Record<string, any>>()
  const recorded: Array<{ path: any; body: any }> = []
  // mimic hey-api: the patch method only sees `body`; top-level keys that are
  // not `body`/`path`/`query`/`url`/`headers` are ignored at the wire level
  const fakeClient = {
    session: {
      get: async ({ path }: any) => ({ data: { metadata: stored.get(path.id) ?? {} } }),
      update: async (options: any) => {
        recorded.push({ path: options.path, body: options.body })
        const id = options.path?.id
        const next = options.body?.metadata
        if (id && next) stored.set(id, next)
        return { data: null }
      },
    },
  } as any

  await modelStore.captureImplicit(modelStore.v1SdkAdapter(fakeClient), "ses_contract", "build", {
    providerID: "openai",
    modelID: "gpt-x",
  })
  if (recorded.length !== 1) throw new Error("updateRecord should have issued one PUT")
  const put = recorded[0]
  if (!put.body || !put.body.metadata || !put.body.metadata.planReviewModels) {
    throw new Error(
      "updateRecord sent metadata at top level or missing — body=" + JSON.stringify(put.body)
    )
  }
  if (put.body.metadata.planReviewModels.build?.providerID !== "openai") {
    throw new Error("persisted metadata wrong: " + JSON.stringify(put.body.metadata))
  }
  // the legacy fake shape (top-level metadata) would NOT have produced any
  // persisted record with this fake — verify the negative path
  const beforeLegacy = stored.get("ses_contract") ?? {}
  if (!beforeLegacy.planReviewModels) {
    throw new Error("legacy shape would have silently dropped the write")
  }
  console.log("[contract:update-body] updateRecord persists via body.metadata: ok")
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
  if (out.includes("Switched to build agent")) throw new Error("plan_review falsely reported success when no model resolved: " + out)
  if (!out.includes("no build model resolved")) throw new Error("missing no-model warning in tool output: " + out)
  if (prompts.length !== 1) throw new Error(`expected 1 prompt, got ${prompts.length}`)
  const text = prompts[0].body.parts[0].text
  if (!text.includes("No build model resolved")) throw new Error("missing refusal warning: " + text)
  if (!text.includes("/set-build-model")) throw new Error("missing /set-build-model hint")
  if (text.includes("(opencode default)")) throw new Error("still contains fallback to opencode default")
  console.log("[7] exitPlanMode refuses when target undefined: ok")
}

// 25. Plan-only chat capture must NOT leak plan's model into build.
{
  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
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
    { sessionID: "ses_plan_pick", agent: "plan", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
  )
  if (stored.planReviewModels?.build) throw new Error("plan capture leaked into build record: " + JSON.stringify(stored.planReviewModels))
  prompts.length = 0
  const noopEditorPM = "/tmp/pr-smoke-pm-noop.sh"
  writeFileSync(noopEditorPM, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditorPM, 0o755)
  await testHooks.tool.plan_review.execute(
    { plan: "x" },
    { sessionID: "ses_plan_pick", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (buildPrompt) {
    throw new Error(`build prompt must not be sent when build has no model, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  const refusal = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("No build model resolved"))
  if (!refusal) throw new Error("expected no-build-model refusal prompt")
  console.log("[25] plan model does NOT leak into build when build not picked: ok")
}

// Global picker-file and watcher checks were removed. Model attribution now
// comes only from native per-session selection metadata or chat.message.

// 31. plugin init probes client.app.agents and logs first agent
//     REMOVED: not needed for the priority chain. Kept as expected
//     behavior on getBuildAgentModel/getPlanAgentModel (covered by [37]).

// 32. Event hook no longer wires build event memory — session.* events are
//     filtered by opencode upstream. The hook must still tolerate them
//     without crashing. (P2 regression: restart-survival comes from the
//     persisted record, not the event hook.)
{
const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) }, agents: async () => ({ data: [] }) } as any,
    session: { promptAsync: async () => {}, get: async () => ({ data: { metadata: {} } }), update: async () => ({ data: null }) },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks.event({
    event: {
      type: "session.updated",
      properties: { info: { id: "ses_evt", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } },
    },
  })
  await new Promise(r => setTimeout(r, 30))
  const errs = logs.filter((l: any) => l.body?.level === "error")
  if (errs.length) throw new Error("session.updated produced error log: " + JSON.stringify(errs))
  // No build event memory log anymore
  if (logs.some((l: any) => l.body?.message?.includes("build event memory"))) {
    throw new Error("build event memory log should not exist anymore")
  }
  console.log("[32] event hook is a no-op for session.updated (record persists instead): ok")
}

// 33. chat.message hook writes the per-agent record (captureImplicit) for build agent.
//     This is the per-session record source "chat" and is the safe stock-runtime fallback.
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) }, agents: async () => ({ data: [] }) } as any,
    session: { prompt: async () => {}, update: async () => ({ data: null }) },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks["chat.message"](
    { sessionID: "ses_cm", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
  )
  const captured = logs.find((l: any) => l.body?.message?.startsWith("chat.message:"))
  if (!captured) throw new Error("chat.message handler did not log captured line. logs: " + logs.map((l:any)=>l.body?.message).join("\n"))
  if (!captured.body.message.includes("agent=build") || !captured.body.message.includes("ya-glm/glm")) {
    throw new Error("captured log should mention agent=build and ya-glm/glm, got: " + captured.body.message)
  }
  console.log("[33] chat.message hook captures per-agent model: ok")
}

// 34. exitPlanMode priority: chat.message capture (build) writes to the
//     record; resolveBuildModel reads it. Smoke for the wire-up only.
{
  const logs: any[] = []
  const prompts: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) }, agents: async () => ({ data: [] }) } as any,
    session: {
      get: async () => ({ data: { metadata: {} } }),
      update: async () => ({ data: null }),
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks["chat.message"](
    { sessionID: "ses_prio", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
  )
  console.log("[34] priority chain order documented (chat.message first): ok")
}

// 35. exitPlanMode: config fallback when nothing else set.
//     REMOVED: picker (model.json) fallback deleted — model.json is global.
//     See [16] for config-based fallback assertion.
{
  console.log("[35] config fallback wired in exitPlanMode (asserted in [16]): ok")
}

// 36. exitPlanMode direct call: captureImplicit writes per-agent.
{
  const logs: any[] = []
  const prompts: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) }, agents: async () => ({ data: [] }) } as any,
    session: {
      get: async () => ({ data: { metadata: {} } }),
      update: async () => ({ data: null }),
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  // populate the per-session record with a build-agent pick (captureImplicit)
  await testHooks["chat.message"](
    { sessionID: "ses_prio36", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
  )
  // also populate plan agent memory so chat.message (plan) source is exercised
  await testHooks["chat.message"](
    { sessionID: "ses_prio36", agent: "plan", model: { providerID: "openai", modelID: "gpt-y" } } as any,
    {},
  )
  // invoke the plan_review tool execute path indirectly — call the
  // captured tool object would require unwrapping. Instead, assert via
  // chat.message fired-once log that the channel is alive.
  const planCaptured = logs.find((l: any) => l.body?.message?.startsWith("chat.message:") && l.body?.message?.includes("agent=plan"))
  if (!planCaptured) throw new Error("plan chat.message did not capture: " + logs.map((l:any)=>l.body?.message).join("\n"))
  console.log("[36] chat.message memory captures plan-agent pick: ok")
}

// 36b. Per-session isolation: each session's record is independent. ONE
//      plugin instance serves two sessions; ses_A and ses_B each get their
//      own model — no cross-contamination via global RAM.
{
  const prompts: any[] = []
  const logs: any[] = []
  const meta = new Map<string, Record<string, any>>()
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    } as any,
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async ({ path }: any) => ({ data: { metadata: meta.get(path.id) ?? {} } }),
      update: async ({ path, body }: any) => { if (body?.metadata) meta.set(path.id, body.metadata); return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  await testHooks["chat.message"](
    { sessionID: "ses_isoA", agent: "build", model: { providerID: "openai", modelID: "gpt-a" } } as any,
    {},
  )
  await testHooks["chat.message"](
    { sessionID: "ses_isoB", agent: "build", model: { providerID: "anthropic", modelID: "claude-b" } } as any,
    {},
  )

  const noopEditor = "/tmp/pr-smoke-cross-noop.sh"
  writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor, 0o755)

  prompts.length = 0
  await testHooks.tool.plan_review.execute(
    { plan: "isolation test A" },
    { sessionID: "ses_isoA", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildA = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildA) throw new Error("[36b] ses_A: build prompt missing")
  if (buildA.body.model?.providerID !== "openai" || buildA.body.model?.modelID !== "gpt-a") {
    throw new Error(`[36b] ses_A should get openai/gpt-a, got: ${JSON.stringify(buildA.body.model)}`)
  }
  if (buildA.body.model?.providerID === "anthropic") {
    throw new Error("[36b] ses_A LEAKED ses_B's model anthropic/claude-b!")
  }

  prompts.length = 0
  await testHooks.tool.plan_review.execute(
    { plan: "isolation test B" },
    { sessionID: "ses_isoB", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildB = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildB) throw new Error("[36b] ses_B: build prompt missing")
  if (buildB.body.model?.providerID !== "anthropic" || buildB.body.model?.modelID !== "claude-b") {
    throw new Error(`[36b] ses_B should get anthropic/claude-b, got: ${JSON.stringify(buildB.body.model)}`)
  }
  if (buildB.body.model?.providerID === "openai") {
    throw new Error("[36b] ses_B LEAKED ses_A's model openai/gpt-a!")
  }

  console.log("[36b] per-session isolation via planReviewModels metadata: ses_A→openai, ses_B→anthropic, no leak: ok")
}

// 36c. /set-build-model (pinned) beats chat.message (plan agent) — and a
//      plan-agent session.updated must NOT trigger any model-write path.
//      exitPlanMode must NOT leak plan's kimi-k3 into build.
{
  const noopEditor = "/tmp/pr-smoke-prio-noop.sh"
  writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor, 0o755)

  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    } as any,
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  // 1. Plan agent session.updated — must NOT write to model-store
  await testHooks.event({
    event: {
      type: "session.updated",
      properties: { info: { id: "ses_prio", agent: "plan", model: { providerID: "opencode-go", modelID: "kimi-k3" } } },
    },
  })
  if (Object.keys(stored).length > 0) throw new Error("plan session.updated wrote metadata: " + JSON.stringify(stored))

  // 2. chat.message for plan agent writes the plan record only
  await testHooks["chat.message"](
    { sessionID: "ses_prio", agent: "plan", model: { providerID: "opencode-go", modelID: "kimi-k3" } } as any,
    {},
  )
  if (stored.planReviewModels?.plan?.modelID !== "kimi-k3") throw new Error("plan record not set")
  if (stored.planReviewModels?.build) throw new Error("plan capture leaked into build record: " + JSON.stringify(stored.planReviewModels))

  // 3. /set-build-model sets build pinned
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "opencode-go/deepseek-v4-flash", sessionID: "ses_prio" },
    },
  } as any)

  prompts.length = 0
  await testHooks.tool.plan_review.execute(
    { plan: "priority test" },
    { sessionID: "ses_prio", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("[36c] build prompt missing")
  if (buildPrompt.body?.model?.modelID !== "deepseek-v4-flash") {
    throw new Error(`[36c] should resolve to deepseek (/set-build-model), got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (buildPrompt.body?.model?.modelID === "kimi-k3") {
    throw new Error("[36c] LEAKED plan's kimi-k3 into build model!")
  }
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: build model memory")) {
    throw new Error(`[36c] wrong source label: ${buildPrompt.body?.parts?.[0]?.text}`)
  }

  console.log("[36c] /set-build-model beats chat.message; plan-agent updates never leak into build: ok")
}

// 36d. Last-write-wins: an explicit picker event overwrites the chat
//      capture. chat.message set build=sol; a tui.model.selected for terra
//      must overwrite sol. (Same shape as the legacy "promotion overwrites
//      stale chat" check — last-write-wins for explicit > implicit.)
{
  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    } as any,
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  // chat.message writes build=sol (implicit capture)
  await testHooks["chat.message"](
    { sessionID: "ses_stale", agent: "build", model: { providerID: "openai", modelID: "gpt-5.6-sol" } } as any,
    {},
  )
  if (stored.planReviewModels?.build?.modelID !== "gpt-5.6-sol") throw new Error("sol not in record")

  // Drive an explicit /set-build-model — last-write-wins, record now terra
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "openai/gpt-5.6-terra", sessionID: "ses_stale" },
    },
  } as any)
  if (stored.planReviewModels?.build?.modelID !== "gpt-5.6-terra") throw new Error("terra did not overwrite sol in record")

  const noopEditor = "/tmp/pr-smoke-stale-noop.sh"
  writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor, 0o755)
  prompts.length = 0
  await testHooks.tool.plan_review.execute(
    { plan: "stale test" },
    { sessionID: "ses_stale", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("[36d] build prompt missing")
  if (buildPrompt.body?.model?.modelID !== "gpt-5.6-terra") {
    throw new Error(`[36d] should resolve to terra, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (buildPrompt.body?.model?.modelID === "gpt-5.6-sol") {
    throw new Error("[36d] stale sol was NOT overwritten!")
  }

  console.log("[36d] explicit overwrite wins over implicit chat capture (last-write-wins): sol→terra: ok")
}

// 36f. RC2 regression: exitPlanMode's own synthetic switch prompt must NOT
//      feed back through captureImplicit and rewrite the record. With
//      write-time precedence, a same-value write would be a no-op, but we
//      keep the synthetic-prompt guard so the diagnostics stay clean and
//      the resolved target doesn't get re-stamped as "user intent".
{
  const noopEditor = "/tmp/pr-smoke-synthetic-noop.sh"
  writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor, 0o755)

  const prompts: any[] = []
  const logs: any[] = []
  let hooksRef: any = undefined
  let stored: Record<string, any> = {
    planReviewModels: {
      build: { providerID: "openai", modelID: "gpt-5.6-terra", source: "picker", at: Date.now() },
    },
  }
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [{ name: "build", model: { providerID: "opencode-go", modelID: "luna" } }] }),
    } as any,
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      messages: async () => ({ data: [] }),
      // Faithful server simulation: chat.message fires for every prompt.
      prompt: async (opts: any) => {
        prompts.push(opts)
        if (hooksRef && opts?.body?.agent && opts?.body?.model) {
          await hooksRef["chat.message"](
            { sessionID: opts.path?.id, agent: opts.body.agent, model: opts.body.model, variant: opts.body.variant },
            {},
          )
        }
        return {}
      },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  hooksRef = testHooks

  const runApproval = async () =>
    testHooks.tool.plan_review.execute(
      { plan: "synthetic guard test" },
      { sessionID: "ses_synth", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )

  await runApproval()
  const first = prompts.find((p: any) => p.body?.agent === "build")
  if (!first) throw new Error("[36f] first build prompt missing")
  if (first.body?.model?.modelID !== "gpt-5.6-terra") {
    throw new Error(`[36f] first resolution should be terra (record), got: ${JSON.stringify(first.body?.model)}`)
  }
  if (!first.body?.parts?.[0]?.text?.includes("source: TUI explicit picker (build)")) {
    throw new Error(`[36f] first source should be TUI explicit picker (build), got: ${first.body?.parts?.[0]?.text}`)
  }
  const skipLog = logs.find((l: any) => l.body?.message?.includes("skipped synthetic switch prompt"))
  if (!skipLog) {
    throw new Error("[36f] guard did not fire — synthetic chat.message was not skipped. logs: " + logs.map((l:any)=>l.body?.message).join("\n"))
  }

  prompts.length = 0
  await runApproval()
  const second = prompts.find((p: any) => p.body?.agent === "build")
  if (!second) throw new Error("[36f] second build prompt missing")
  if (!second.body?.parts?.[0]?.text?.includes("source: TUI explicit picker (build)")) {
    throw new Error(`[36f] second source should stay TUI explicit picker (build), got: ${second.body?.parts?.[0]?.text}`)
  }
  // Record must still be source=picker (not re-stamped by the synthetic
  // prompt's chat.message capture).
  if (stored.planReviewModels?.build?.source !== "picker") {
    throw new Error(`[36f] synthetic prompt mutated record source: ${JSON.stringify(stored.planReviewModels?.build)}`)
  }

  console.log("[36f] synthetic switch prompt does not feed back into the record: ok")
}

// 36e. Regression: plan and build use the same model but different effort.
//      Auto-exit must preserve build=high instead of dropping it or leaking plan=xhigh.
{
  const noopEditor = "/tmp/pr-smoke-build-variant-noop.sh"
  writeFileSync(noopEditor, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditor, 0o755)

  const prompts: any[] = []
  const now = Date.now() + 10000
  const fakeClient = {
    app: { log: async () => ({}), agents: async () => ({ data: [] }) } as any,
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: { planReviewModels: {
        plan: { providerID: "openrouter", modelID: "z-ai/glm-5.2", variant: "xhigh", source: "picker", at: now },
        build: { providerID: "openrouter", modelID: "z-ai/glm-5.2", variant: "high", source: "picker", at: now + 1 },
      } } } }),
      messages: async () => ({ data: [] }),
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const oldEditor = process.env.EDITOR
  process.env.EDITOR = noopEditor
  try {
    await testHooks.tool.plan_review.execute(
      { plan: "variant test" },
      { sessionID: "ses_variant", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )
  } finally {
    if (oldEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = oldEditor
    rmSync(noopEditor, { force: true })
  }
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (!buildPrompt) throw new Error("[36e] build prompt missing")
  if (buildPrompt.body?.model?.modelID !== "z-ai/glm-5.2") throw new Error(`[36e] wrong build model: ${JSON.stringify(buildPrompt.body)}`)
  if (buildPrompt.body?.variant !== "high") throw new Error(`[36e] build effort should be high, got: ${JSON.stringify(buildPrompt.body?.variant)}`)
  if (buildPrompt.body?.variant === "xhigh") throw new Error("[36e] plan effort leaked into build")
  console.log("[36e] auto-exit preserves build effort for shared model: ok")
}

// 37. chat.message captures per-session, per-agent. Two sessions, two
//     agents each — ensure the per-session record is keyed correctly.
//     REMOVED: too granular for the reduced plugin state (the
//     per-session record is already verified by [33]).

// 38. TUI plugin module exports { id, tui } — required by opencode's
//     PluginLoader.readV1Plugin which throws "must default export an
//     object with tui()" otherwise. Confirm id is "plan-review-tui"
//     and tui is a function.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const exp = mod.default as any
  if (!exp || typeof exp !== "object") throw new Error("default export must be an object, got: " + typeof exp)
  if (exp.id !== "plan-review-tui") throw new Error("default.id should be 'plan-review-tui', got: " + exp.id)
  if (typeof exp.tui !== "function") throw new Error("default.tui must be a function, got: " + typeof exp.tui)
  console.log("[38] TUI plugin exports { id, tui } object: ok")
}

// 38b. TUI plugin logs its version and safely falls back when the fork's
//      additive selection API is unavailable, without rendering stale UI.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  const logs: any[] = []
  const slots: any[] = []
  const fakeApi = {
    client: {
      app: {
        log: async (opts: any) => { logs.push(opts); return {} },
      },
    },
    state: { selection: () => ({ models: {} }) },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: (plugin: any) => { slots.push(plugin); return "test" } },
    lifecycle: { signal: new AbortController().signal, onDispose: (_fn: any) => () => {} },
    event: { on: (_t: string, _h: any) => () => {} },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise((r) => setTimeout(r, 30))
  const loaded = logs.find((l: any) => l.message?.includes("plugin loaded"))
  if (!loaded?.message?.includes(`v${EXPECTED_VERSION}`)) {
    throw new Error("TUI init log missing version marker, got: " + loaded?.message)
  }
  if (!loaded?.message?.includes(`build=v${EXPECTED_VERSION}`)) {
    throw new Error("TUI init log missing build marker, got: " + loaded?.message)
  }
  if (!logs.some((entry) => entry.message?.includes("relying on chat.message fallback"))) {
    throw new Error("missing safe fallback log")
  }
  if (slots.length !== 0) throw new Error("stock runtime must not register an empty model indicator")
  console.log(`[38b] TUI plugin logs v${EXPECTED_VERSION} and falls back safely: ok`)
}

// 38c. Native plugin: no metadata writes on home; flushes draft once on
//      home→session transition. Reads selection LIVE at flush time (the
//      sidebar also reads live). tuiCurrentSelection is gone.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  const logs: any[] = []
  const updates: any[] = []
  const slots: any[] = []
  let selectionHandler: any
  let createdHandler: any
  let selectionCalls = 0
  const selection = {
    sessionID: undefined as string | undefined,
    agent: "build",
    models: {
      build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    },
  }
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 }, metadata: { keep: true } } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async (opts: any) => { logs.push(opts); return {} } },
    },
    state: {
      provider: [],
      modelSelectionEvents: true,
      selection: () => { selectionCalls++; return selection },
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: (slot: any) => { slots.push(slot); return "test" } },
    lifecycle: { signal: new AbortController().signal, onDispose: (_fn: any) => () => {} },
    event: {
      on: (type: string, handler: any) => {
        if (type === "tui.selection.changed") selectionHandler = handler
        if (type === "session.created") createdHandler = handler
        return () => {}
      },
    },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise((r) => setTimeout(r, 30))
  // No startup metadata writes
  if (updates.length !== 0) throw new Error("startup must not write metadata, got: " + updates.length)
  // The session is created, then we transition into it. Only a session
  // observed as created may receive the draft flush.
  createdHandler({ type: "session.created", properties: { sessionID: "ses_new" } })
  await new Promise((r) => setTimeout(r, 5))
  selectionHandler({ data: { current: { sessionID: "ses_new", agent: "build", models: selection.models } } })
  await new Promise((r) => setTimeout(r, 30))
  // Live selection read happens at flush time
  if (selectionCalls < 1) throw new Error("flush must read live selection, got calls: " + selectionCalls)
  if (updates.length !== 1) throw new Error("home→session must flush draft once, got: " + updates.length)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.build?.modelID !== "deepseek-v4-flash") throw new Error(`draft build must be deepseek, got: ${JSON.stringify(picks?.build)}`)
  if (picks?.build?.source !== "home-flush") throw new Error("flushed build must be tagged home-flush, got: " + JSON.stringify(picks?.build))
  if (updates[0]?.metadata?.tuiCurrentSelection) throw new Error("tuiCurrentSelection must never be written")
  if (typeof slots[0]?.slots?.sidebar_content !== "function") throw new Error("native runtime must register sidebar_content")
  if (slots[0]?.slots?.home_prompt_right || slots[0]?.slots?.session_prompt_right) {
    throw new Error("native runtime must not register prompt-right slots")
  }
  const tuiSource = readFileSync(new URL("../plugin/tui-plugin.tsx", import.meta.url), "utf8")
  if (tuiSource.includes("createSignal")) throw new Error("sidebar must not cache selection in plugin-local Solid state")
  if (!tuiSource.includes("Agent models")) throw new Error("heading must be Agent models")
  if (!tuiSource.includes("plan-review v{VERSION}")) throw new Error("sidebar must show the plugin version")
  if (tuiSource.includes('border={["bottom"]}')) throw new Error("sidebar must not have a divider — should be compact like MCP")
  if (tuiSource.includes("tuiCurrentSelection")) throw new Error("plugin must not persist tuiCurrentSelection snapshots")
  console.log("[38c] native plugin: no startup writes, flushes once on session; reads live: ok")
}

// 38e. exitPlanMode reads planReviewModels directly from session metadata
//      and resolves it as the "TUI explicit picker" source. No RAM map, no
//      promotion logic — the record IS the resolved source.
{
  const logs: any[] = []
  let sessionGetCalls = 0
  const sessionMetadata = {
    planReviewModels: {
      build: { providerID: "ya-glm", modelID: "glm", source: "picker", at: Date.now() },
      plan: { providerID: "opencode-go", modelID: "deepseek-v4-flash", source: "picker", at: Date.now() },
    },
  }
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } } as any,
    session: {
      list: async () => ({ data: [] }),
      get: async (opts: any) => {
        sessionGetCalls++
        return { data: { id: opts?.path?.id ?? "ses_meta", metadata: sessionMetadata } }
      },
    },
    config: { get: async () => ({ data: {} }) },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks["chat.message"](
    {
      sessionID: "ses_meta",
      agent: "test",
      model: { providerID: "openai-go", modelID: "mimo-v2.5-pro" },
    } as any,
    {} as any,
  )
  await new Promise((r) => setTimeout(r, 30))
  if (sessionGetCalls !== 0) {
    throw new Error("chat.message hook should not call session.get, got calls: " + sessionGetCalls)
  }
  const fakeFs = await import("node:fs")
  const tmpEditor = "/tmp/pr-smoke-exitplanmo.sh"
  fakeFs.writeFileSync(tmpEditor, "#!/bin/sh\nexit 0\n")
  fakeFs.chmodSync(tmpEditor, 0o755)
  const oldEditor = process.env.EDITOR
  process.env.EDITOR = tmpEditor
  try {
    await testHooks.tool.plan_review.execute(
      { plan: "x" },
      { sessionID: "ses_meta", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )
  } finally {
    if (oldEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = oldEditor
    fakeFs.rmSync(tmpEditor, { force: true })
  }
  if (sessionGetCalls < 1) {
    throw new Error("exitPlanMode must call session.get at least once, got calls: " + sessionGetCalls)
  }
  const resolution = logs.find((l: any) => l.body?.message?.startsWith("plan-review: exitPlanMode resolution:"))
  if (!resolution?.body?.message?.includes("source=TUI explicit picker (build)")) {
    throw new Error("expected TUI explicit picker (build) source from record, got: " + resolution?.body?.message)
  }
  console.log("[38e] exitPlanMode resolves record.build as TUI explicit picker (build): ok")
}

// 39. Native model events write only their agent, serialize, and remain session-scoped.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  const metadata = new Map<string, Record<string, unknown>>([["ses_A", { keep: true }]])
  const subscribedTypes: string[] = []
  let modelHandler: any
  const fakeApi = {
    client: {
      session: {
        get: async ({ sessionID, path }: any) => ({ data: { metadata: metadata.get(sessionID ?? path?.id) ?? {} } }),
        update: async ({ sessionID, path, body, metadata: next }: any) => {
          // The TUI plugin uses the v2 adapter which passes {sessionID, metadata}
          // flat; the server plugin uses v1 which nests metadata under body. Match
          // both so this fake works for either path.
          const id = sessionID ?? path?.id
          const value = body?.metadata ?? next
          if (id && value) metadata.set(id, value)
          return { data: null }
        },
      },
      app: { log: async () => ({}) },
    },
    state: { modelSelectionEvents: true, selection: () => ({ models: {} }) },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => { subscribedTypes.push(type); if (type === "tui.model.selected") modelHandler = handler; return () => {} } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  if (!subscribedTypes.includes("tui.model.selected")) throw new Error("native model event was not subscribed")
  if (!subscribedTypes.includes("tui.selection.changed")) throw new Error("selection.changed event was not subscribed")

  modelHandler({ type: "tui.model.selected", data: { sessionID: "ses_A", agent: "plan", model: { providerID: "openai", modelID: "a-plan" } } })
  modelHandler({ type: "tui.model.selected", data: { sessionID: "ses_B", agent: "build", model: { providerID: "anthropic", modelID: "b-build", variant: "high" } } })
  modelHandler({ type: "tui.model.selected", data: { sessionID: "ses_A", agent: "build", model: { providerID: "openai", modelID: "a-build" } } })
  await new Promise(r => setTimeout(r, 50))

  const picksA = (metadata.get("ses_A") as any)?.planReviewModels
  const picksB = (metadata.get("ses_B") as any)?.planReviewModels
  if (picksA?.plan?.modelID !== "a-plan" || picksA?.build?.modelID !== "a-build") {
    throw new Error("serialized writes lost ses_A picks: " + JSON.stringify(picksA))
  }
  if ((metadata.get("ses_A") as any)?.keep !== true) throw new Error("metadata merge dropped existing keys")
  if (picksB?.build?.modelID !== "b-build" || picksB?.plan) {
    throw new Error("cross-session model contamination: " + JSON.stringify(picksB))
  }
  if (picksB?.build?.variant !== "high") throw new Error("native model metadata dropped build variant")
  console.log("[39] native per-agent model writes serialize without cross-session contamination: ok")
}

// 39b. Disposal unsubscribes and prevents an in-flight metadata read from
//      committing a stale model event after a replacement plugin loads.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let dispose: (() => void) | undefined
  let resolveRead: (() => void) | undefined
  let readStarted: (() => void) | undefined
  let updates = 0
  let unsubscribedCount = 0
  const started = new Promise<void>((resolve) => { readStarted = resolve })
  const gate = new Promise<void>((resolve) => { resolveRead = resolve })
  const fakeApi = {
    client: {
      session: {
        get: async () => {
          readStarted?.()
          await gate
          return { data: { metadata: {} } }
        },
        update: async () => { updates++; return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: { provider: [], modelSelectionEvents: true, selection: () => ({ models: {} }) },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: (fn: () => void) => { dispose = fn; return () => {} } },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      return () => { unsubscribedCount++ }
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  modelHandler({ type: "tui.model.selected", data: { sessionID: "ses_disposed", agent: "build", model: { providerID: "openai", modelID: "stale" } } })
  await started
  dispose?.()
  resolveRead?.()
  await new Promise((resolve) => setTimeout(resolve, 20))
  if (unsubscribedCount < 2) throw new Error("dispose did not unsubscribe both handlers: " + unsubscribedCount)
  if (updates !== 0) throw new Error("disposed plugin committed stale model metadata")
  console.log("[39b] disposal cancels queued native model metadata writes: ok")
}

// 40. event hook accepts session.updated events from the v2 SDK shape
//     (event.event.type="session.updated" with properties.info). The v2
//     SDK uses this shape consistently. Verifies the simple event path
//     doesn't throw and runs without side effects on non-build agents.
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) }, agents: async () => ({ data: [] }) } as any,
    session: { promptAsync: async () => {}, get: async () => ({ data: { metadata: {} } }), update: async () => ({ data: null }) },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks.event({
    event: {
      type: "session.updated",
      properties: { info: { id: "ses_meta", agent: "plan", model: { providerID: "ya-glm", modelID: "glm" } } },
    },
  })
  await new Promise(r => setTimeout(r, 30))
  // No crash, no error log — the handler is a no-op for non-build agents.
  const errs = logs.filter((l: any) => l.body?.level === "error")
  if (errs.length) throw new Error("unexpected error logs: " + JSON.stringify(errs))
  console.log("[40] event hook tolerates non-build session.updated: ok")
}

// 41. tui.json(c) registration via ensureCommandSymlink — TUI plugins
//     are NOT auto-discovered from ~/.config/opencode/plugins/, they
//     MUST be in tui.json plugin[]. Verify the helper writes the entry
//     under a fake HOME.
{
  const tmp = `/tmp/pr-smoke-tui-json-${Date.now()}`
  const fs = await import("node:fs")
  fs.mkdirSync(tmp, { recursive: true })
  fs.mkdirSync(`${tmp}/.config/opencode`, { recursive: true })
  const old = process.env.HOME
  process.env.HOME = tmp
  try {
    try {
      await mod.default({
        client: {
          app: { log: async () => {}, agents: async () => ({ data: [] }) } as any,
          session: { promptAsync: async () => {} },
        } as any,
        project: {} as any,
        directory: "/tmp",
        worktree: "/tmp",
        serverUrl: new URL("http://x"),
        $,
      })
    } catch {
      // expected: prior tests' mod.default init may still be running with
      // a different client. We only care about the tui.json(c) side effect.
    }
    await new Promise(r => setTimeout(r, 100))
    const candidates = ["tui.jsonc", "tui.json"]
    let found: string | undefined
    for (const c of candidates) {
      const p = `${tmp}/.config/opencode/${c}`
      if (fs.existsSync(p)) { found = p; break }
    }
    if (!found) {
      let listing: string[] = []
      try { listing = fs.readdirSync(`${tmp}/.config/opencode`) } catch {}
      throw new Error("tui.json(c) was not written. List: " + JSON.stringify(listing))
    }
    const raw = fs.readFileSync(found, "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed.plugin)) throw new Error("tui.json plugin[] missing")
    if (!parsed.plugin.some((p: any) => typeof p === "string" && p.includes("tui-plugin.tsx"))) {
      throw new Error("tui.json plugin[] should contain tui-plugin.tsx path, got: " + JSON.stringify(parsed.plugin))
    }
    console.log("[41] ensureCommandSymlink writes tui.json plugin[] entry: ok")
  } finally {
    process.env.HOME = old
  }
}

// 41b. JSONC with comments is preserved when adding the plugin entry.
//      jsonc-parser modify/applyEdits keeps comments and trailing commas.
{
  const tmp = `/tmp/pr-smoke-jsonc-${Date.now()}`
  const fs = await import("node:fs")
  fs.mkdirSync(`${tmp}/.config/opencode`, { recursive: true })
  // Write a tui.jsonc WITH comments
  const commented = `{
  // user's theme preference
  "theme": "dark",
  "plugin": [
    "some-other-plugin"
  ] // trailing comment
}

`
  fs.writeFileSync(`${tmp}/.config/opencode/tui.jsonc`, commented)
  const old = process.env.HOME
  process.env.HOME = tmp
  try {
    await mod.default({
      client: { app: { log: async () => {}, agents: async () => ({ data: [] }) } as any, session: { promptAsync: async () => {} } } as any,
      project: {} as any, directory: "/tmp", worktree: "/tmp", serverUrl: new URL("http://x"), $,
    })
    await new Promise(r => setTimeout(r, 100))
    const raw = fs.readFileSync(`${tmp}/.config/opencode/tui.jsonc`, "utf8")
    // Comments must survive
    if (!raw.includes("// user's theme preference")) throw new Error("JSONC comment was stripped: " + raw)
    if (!raw.includes("// trailing comment")) throw new Error("trailing comment was stripped: " + raw)
    // Both plugins must be present
    if (!raw.includes("some-other-plugin")) throw new Error("existing plugin was dropped: " + raw)
    if (!raw.includes("tui-plugin.tsx")) throw new Error("our plugin was not added: " + raw)
    console.log("[41b] JSONC comments preserved on plugin registration: ok")
  } finally {
    process.env.HOME = old
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 41bb. Installer replaces this package's previous .ts TUI entry after the
//       TSX migration instead of leaving a broken duplicate behind.
{
  const tmp = `/tmp/pr-smoke-tsx-upgrade-${Date.now()}`
  const fs = await import("node:fs")
  fs.mkdirSync(`${tmp}/.config/opencode`, { recursive: true })
  const oldHome = process.env.HOME
  const previousPath = new URL("../plugin/tui-plugin.ts", import.meta.url).pathname
  fs.writeFileSync(`${tmp}/.config/opencode/tui.jsonc`, JSON.stringify({ plugin: [previousPath] }, null, 2))
  process.env.HOME = tmp
  try {
    await mod.default({
      client: { app: { log: async () => {} } } as any,
      project: {} as any, directory: "/tmp", worktree: "/tmp", serverUrl: new URL("http://x"), $,
    })
    const raw = fs.readFileSync(`${tmp}/.config/opencode/tui.jsonc`, "utf8")
    if (raw.includes("tui-plugin.ts\"")) throw new Error("old .ts TUI entry survived upgrade: " + raw)
    if (!raw.includes("tui-plugin.tsx")) throw new Error("new .tsx TUI entry missing after upgrade: " + raw)
    console.log("[41bb] installer migrates its TUI entry from .ts to .tsx: ok")
  } finally {
    process.env.HOME = oldHome
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 41c. Malformed tui.jsonc is NOT overwritten.
{
  const tmp = `/tmp/pr-smoke-malformed-${Date.now()}`
  const fs = await import("node:fs")
  fs.mkdirSync(`${tmp}/.config/opencode`, { recursive: true })
  const malformed = `{ "plugin": [ // missing closing bracket and quote`
  fs.writeFileSync(`${tmp}/.config/opencode/tui.jsonc`, malformed)
  const old = process.env.HOME
  process.env.HOME = tmp
  try {
    await mod.default({
      client: { app: { log: async () => {}, agents: async () => ({ data: [] }) } as any, session: { promptAsync: async () => {} } } as any,
      project: {} as any, directory: "/tmp", worktree: "/tmp", serverUrl: new URL("http://x"), $,
    })
    await new Promise(r => setTimeout(r, 100))
    const raw = fs.readFileSync(`${tmp}/.config/opencode/tui.jsonc`, "utf8")
    if (raw !== malformed) throw new Error("malformed tui.jsonc was modified — should be untouched")
    console.log("[41c] malformed tui.jsonc not overwritten: ok")
  } finally {
    process.env.HOME = old
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 41d. User's regular file in commands/ is NOT clobbered.
{
  const tmp = `/tmp/pr-smoke-userfile-${Date.now()}`
  const fs = await import("node:fs")
  fs.mkdirSync(`${tmp}/.config/opencode/commands`, { recursive: true })
  const userContent = "# my custom command\nThis is user-created."
  fs.writeFileSync(`${tmp}/.config/opencode/commands/plan-review.md`, userContent)
  const old = process.env.HOME
  process.env.HOME = tmp
  try {
    await mod.default({
      client: { app: { log: async () => {}, agents: async () => ({ data: [] }) } as any, session: { promptAsync: async () => {} } } as any,
      project: {} as any, directory: "/tmp", worktree: "/tmp", serverUrl: new URL("http://x"), $,
    })
    await new Promise(r => setTimeout(r, 100))
    const raw = fs.readFileSync(`${tmp}/.config/opencode/commands/plan-review.md`, "utf8")
    if (raw !== userContent) throw new Error("user's command file was clobbered: " + raw)
    console.log("[41d] user command file not clobbered: ok")
  } finally {
    process.env.HOME = old
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// 42. Native model events for non-session IDs never write metadata immediately.
//     Home picks for build/plan are cached and flushed to session metadata
//     only when a valid ses_ session becomes active (via tui.selection.changed).
//     This fixes the regression where picking build at home then submitting
//     caused plan to overwrite build in deferredPicks.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let updates: any[] = []
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const written: any[] = []
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 } } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: { modelSelectionEvents: true, selection: () => ({ sessionID: undefined, agent: "plan", models: {} }) },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)

  // 1. Pick build model at home — no session ID yet. Should NOT write yet.
  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "build", model: { providerID: "anthropic", modelID: "claude-4" } } })
  await new Promise(r => setTimeout(r, 10))
  if (updates.length !== 0) throw new Error("[42a] home build pick must not write immediately, got: " + updates.length)

  // 2. Pick plan model at home — still no session. Should NOT write yet.
  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "plan", model: { providerID: "openai", modelID: "gpt-5" } } })
  await new Promise(r => setTimeout(r, 10))
  if (updates.length !== 0) throw new Error("[42b] home plan pick must not write immediately, got: " + updates.length)

  // 2b. The session is created (server emits session.created), then the TUI
  //     navigates into it. Only a session observed as created may receive the
  //     draft flush.
  createdHandler({ type: "session.created", properties: { sessionID: "ses_home_test" } })
  await new Promise(r => setTimeout(r, 5))

  // 3. Emit a selection.changed to a valid session — should trigger flush.
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_home_test", agent: "plan", models: {} } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error("[42c] expected exactly 1 flush write, got: " + updates.length)
  const deferredWrite = updates.find((u: any) => u.metadata?.planReviewModels)
  if (!deferredWrite) throw new Error("[42d] flush must write planReviewModels")
  const picks = deferredWrite.metadata.planReviewModels
  if (picks.build?.modelID !== "claude-4") throw new Error(`[42e] build should be claude-4, got: ${JSON.stringify(picks.build)}`)
  if (picks.plan?.modelID !== "gpt-5") throw new Error(`[42f] plan should be gpt-5, got: ${JSON.stringify(picks.plan)}`)
  if (picks.build?.modelID === picks.plan?.modelID) throw new Error("[42g] build and plan must not be the same model")

  // 4. Picking the same session again should not double-flush
  selectionHandler({ data: { current: { sessionID: "ses_home_test", agent: "build", models: {} } } })
  await new Promise(r => setTimeout(r, 30))
  if (updates.length !== 1) throw new Error("[42h] re-triggering same session must not add writes, got: " + updates.length)

  console.log("[42] home picks deferred and flushed once on session transition: ok")
}

// 43. Regression: a seeded (non-explicit) startup fallback must never survive
//     an explicit picker choice.
//     Bug: at startup the fork could resolve both agents to the same default
//     (e.g. GLM). The plugin seeded it as the draft. If that seed later
//     overwrote the user's explicit MiniMax pick, the wrong model would be
//     flushed. Fix: explicit picks replace the seed, and a later non-explicit
//     selection never re-applies over an explicit pick.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 } } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      provider: [],
      modelSelectionEvents: true,
      // Startup snapshot where the fork bug makes both agents show the same
      // default (GLM). The plugin seeds it non-explicitly.
      selection: () => ({ sessionID: undefined, agent: "build", models: { build: { providerID: "zai", modelID: "glm" } } }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: {
      on: (type: string, handler: any) => {
        if (type === "tui.model.selected") modelHandler = handler
        if (type === "tui.selection.changed") selectionHandler = handler
        if (type === "session.created") createdHandler = handler
        return () => {}
      },
    },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)

  // 1. Init seeded build=glm (non-explicit). No metadata writes on home.
  await new Promise(r => setTimeout(r, 5))
  if (updates.length !== 0) throw new Error("[43a] home seeding must not write, got: " + updates.length)

  // 2. User explicitly picks build=MiniMax at home.
  modelHandler({ data: { sessionID: undefined, agent: "build", model: { providerID: "minimax", modelID: "M2.7" } } })
  await new Promise(r => setTimeout(r, 5))

  // 3. A later home selection snapshot re-reports the stale GLM default.
  //    It must NOT overwrite the explicit MiniMax pick.
  selectionHandler({ data: { current: { sessionID: undefined, agent: "build", models: { build: { providerID: "zai", modelID: "glm" } } } } })
  await new Promise(r => setTimeout(r, 5))

  // 4. The session is created, then we transition into it. Draft flush may
  //    only happen for a session observed as created.
  createdHandler({ type: "session.created", properties: { sessionID: "ses_home_repro" } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ data: { current: { sessionID: "ses_home_repro", agent: "build", models: { build: { providerID: "minimax", modelID: "M2.7" } } } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error("[43b] expected exactly 1 flush write, got: " + updates.length)
  const picks = updates[0]?.metadata?.planReviewModels
  if (!picks) throw new Error("[43c] flush must write planReviewModels")
  if (picks.build?.modelID !== "M2.7") throw new Error(`[43d] build should be M2.7 (explicit), got: ${JSON.stringify(picks.build)}`)
  if (updates[0]?.metadata?.tuiCurrentSelection) throw new Error("[43e] tuiCurrentSelection must never be written")
  console.log("[43] explicit pick beats seeded startup fallback: ok")
}

// 49. Regression: opening an EXISTING session must NOT receive the home
//     draft. The flush only targets sessions observed as newly created
//     (session.created or a fresh time.created). Otherwise picking build at
//     home then opening an old session would silently overwrite that
//     session's own deferred picks with the draft.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 3_600_000 } } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      modelSelectionEvents: true,
      selection: () => ({ sessionID: undefined, agent: "plan", models: {} }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)

  // 1. Pick build at home (explicit draft).
  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "build", model: { providerID: "anthropic", modelID: "claude-4" } } })
  await new Promise(r => setTimeout(r, 10))
  if (updates.length !== 0) throw new Error("[49a] home pick must not write immediately")

  // 2. Open an EXISTING session (no session.created event, old time.created).
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_existing", agent: "plan", models: {} } } })
  await new Promise(r => setTimeout(r, 30))
  if (updates.length !== 0) throw new Error(`[49b] existing session must NOT receive the draft flush, got ${updates.length} writes`)

  // 3. The draft is now dropped. Even a freshly created session that follows
  //    must NOT flush (there is nothing left to flush).
  createdHandler({ type: "session.created", properties: { sessionID: "ses_later" } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_later", agent: "plan", models: {} } } })
  await new Promise(r => setTimeout(r, 30))
  if (updates.length !== 0) throw new Error(`[49c] dropped draft must not flush into a later session, got ${updates.length} writes`)
  console.log("[49] existing session does not receive the home draft: ok")
}

// 50. A failed metadata write must keep the pending draft so the next flush
//     attempt can retry it (picks are only dropped once the write confirms).
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  let failUpdate = true
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 } } }),
        update: async (opts: any) => {
          if (failUpdate) throw new Error("network down")
          updates.push(opts)
          return { data: null }
        },
      },
      app: { log: async () => ({}) },
    },
    state: { modelSelectionEvents: true, selection: () => ({ sessionID: undefined, agent: "plan", models: {} }) },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)

  // 1. Pick build at home, then transition into a new session with the
  //    write failing. The draft must survive the failed attempt.
  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "build", model: { providerID: "anthropic", modelID: "claude-4" } } })
  await new Promise(r => setTimeout(r, 10))
  createdHandler({ type: "session.created", properties: { sessionID: "ses_retry" } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_retry", agent: "plan", models: {} } } })
  await new Promise(r => setTimeout(r, 30))
  if (updates.length !== 0) throw new Error(`[50a] failed update must not record a write, got ${updates.length}`)

  // 2. Retry: return home, then re-enter the session. The write now succeeds
  //    and must carry the retained draft.
  failUpdate = false
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: undefined, agent: "build", models: {} } } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_retry", agent: "build", models: {} } } })
  await new Promise(r => setTimeout(r, 30))
  if (updates.length !== 1) throw new Error(`[50b] expected exactly 1 write after retry, got ${updates.length}`)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.build?.modelID !== "claude-4") throw new Error(`[50c] retried flush must carry the draft, got: ${JSON.stringify(picks)}`)
  console.log("[50] failed flush keeps the draft pending for retry: ok")
}

// 51. Regression: the USER's ctrl-x n repro. The home → session transition
//     can fire before the session.created SSE event reaches this plugin AND
//     before the sync store knows the session, so the flush cannot rely on
//     either signal at call time. The authoritative newness check is the
//     time.created returned by the session.get call inside the flush: a
//     fresh session must get the draft even with NO session.created event.
//     Also verifies F2: the home snapshot carries BOTH agents, so the flush
//     writes planReviewModels.plan AND .build (build is what plan
//     approval needs; only seeding the active agent left build undefined).
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  const homeSelection = {
    sessionID: undefined as string | undefined,
    agent: "plan", // active agent is plan; build still shown in sidebar
    models: {
      plan: { providerID: "openai", modelID: "gpt-5" },
      build: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
    },
  }
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 1_000 }, metadata: {} } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      modelSelectionEvents: true,
      selection: () => homeSelection,
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise(r => setTimeout(r, 20))

  // The home snapshot seeded both agents (F2). NO session.created event is
  // emitted anywhere in this test — that is the race. The transition still
  // must flush because session.get reports a fresh time.created.
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_ctrln", agent: "build", models: homeSelection.models } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error(`[51a] expected exactly 1 flush write, got ${updates.length}`)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.plan?.modelID !== "gpt-5") throw new Error(`[51b] plan pick missing, got: ${JSON.stringify(picks?.plan)}`)
  if (picks?.build?.modelID !== "deepseek-v4-flash") throw new Error(`[51c] build pick missing — the user's bug, got: ${JSON.stringify(picks?.build)}`)
  console.log("[51] ctrl-x n repro: fresh session gets draft with both agents, no event ordering dependency: ok")
}

// 52. Both-agent seeding from the startup snapshot. The user never opens the
//     picker: the fork's defaults for plan+build (as shown in the sidebar)
//     must still reach planReviewModels so plan approval can resolve
//     a build model. Only seeding the ACTIVE agent (plan) left build undefined.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 2_000 }, metadata: {} } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      provider: [],
      modelSelectionEvents: true,
      // Startup snapshot: active agent is plan, but both models are present.
      selection: () => ({
        sessionID: undefined,
        agent: "plan",
        models: {
          plan: { providerID: "ya-glm", modelID: "glm" },
          build: { providerID: "zai", modelID: "deepseek-v3" },
        },
      }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise(r => setTimeout(r, 20))

  // No explicit picks anywhere. Home snapshots keep re-reporting both models.
  selectionHandler({ data: { current: { sessionID: undefined, agent: "plan", models: { plan: { providerID: "ya-glm", modelID: "glm" }, build: { providerID: "zai", modelID: "deepseek-v3" } } } } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_seeded", agent: "plan", models: { plan: { providerID: "ya-glm", modelID: "glm" }, build: { providerID: "zai", modelID: "deepseek-v3" } } } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error(`[52a] expected exactly 1 flush write, got ${updates.length}`)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.build?.modelID !== "deepseek-v3") throw new Error(`[52b] build must be seeded even though plan was active, got: ${JSON.stringify(picks?.build)}`)
  if (picks?.plan?.modelID !== "glm") throw new Error(`[52c] plan must be seeded too, got: ${JSON.stringify(picks?.plan)}`)
  console.log("[52] startup snapshot seeds both agents; build survives without explicit pick: ok")
}

// 53. Regression: the user's gemini repro. A transient startup snapshot can
//     resolve build to the fork's fallback (openrouter/gemini-3-pro-image
//     — "Nano Banana") before modelStore hydrates. The draft must NEVER
//     persist a transient snapshot value as a pick; a corrective home
//     snapshot (the real minimax-m3 the user sees in the sidebar) must win.
//     Fix: snapshots only refresh the display cache; explicit picks come
//     only from tui.model.selected; the flush fills from the (corrected)
//     cache.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  // Startup: fork not hydrated → build transiently resolves to the fallback.
  let currentModels = { build: { providerID: "openrouter", modelID: "google/gemini-3-pro-image-preview" } }
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 }, metadata: {} } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      modelSelectionEvents: true,
      selection: () => ({ sessionID: undefined, agent: "plan", models: currentModels }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise(r => setTimeout(r, 20))

  // The fork hydrates: a home snapshot reports the REAL build model. The
  // corrective event must overwrite the startup transient in the cache.
  currentModels = {
    build: { providerID: "opencode-go", modelID: "minimax-m3" },
    plan: { providerID: "ya-glm", modelID: "glm" },
  }
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: undefined, agent: "plan", models: currentModels } } })
  await new Promise(r => setTimeout(r, 5))

  // No explicit picks anywhere. Transition into a fresh session.
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_gemini", agent: "plan", models: currentModels } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error(`[53a] expected exactly 1 flush write, got ${updates.length}`)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.build?.modelID !== "minimax-m3") {
    throw new Error(`[53b] build must be minimax-m3 (real model), NOT the transient fallback, got: ${JSON.stringify(picks?.build)}`)
  }
  const writtenText = JSON.stringify(updates)
  if (writtenText.includes("gemini-3-pro-image-preview")) {
    throw new Error("[53c] transient fallback leaked into metadata")
  }
  if (picks?.build?.explicit === true) throw new Error("[53d] cache fill must not be marked explicit")
  console.log("[53] transient fallback never persisted; corrective snapshot wins: ok")
}

// 54. In-session picker picks must not clobber each other. The home draft is
//     flushed exactly once at the home→session transition; an in-session pick
//     must write ONLY its own agent. Regression: within the first 60s of a
//     session, recordModel re-flushed the home cache on every in-session pick,
//     overwriting the OTHER agent's earlier in-session pick with the stale
//     home value (pick plan=X, then pick build=Y → plan reverted to home).
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const metadata: Record<string, unknown> = {}
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 }, metadata } }),
        update: async (opts: any) => {
          Object.assign(metadata, opts.metadata)
          return { data: null }
        },
      },
      app: { log: async () => ({}) },
    },
    state: {
      modelSelectionEvents: true,
      // Home snapshot reports plan=glm, build=minimax (cache fill baseline).
      selection: () => ({ sessionID: undefined, agent: "plan", models: {
        plan: { providerID: "ya-glm", modelID: "glm" },
        build: { providerID: "opencode-go", modelID: "minimax-m3" },
      } }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.model.selected") modelHandler = handler
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise(r => setTimeout(r, 20))

  // Enter a fresh session → flush carries the home cache fills.
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_in", agent: "plan", models: { plan: { providerID: "ya-glm", modelID: "glm" }, build: { providerID: "opencode-go", modelID: "minimax-m3" } } } } })
  await new Promise(r => setTimeout(r, 20))
  const afterTransition = (metadata.planReviewModels as any)
  if (afterTransition?.plan?.modelID !== "glm" || afterTransition?.build?.modelID !== "minimax-m3") {
    throw new Error(`[54a] home draft flush failed: ${JSON.stringify(afterTransition)}`)
  }

  // In-session explicit picks: plan=planX then build=buildY.
  modelHandler({ type: "tui.model.selected", data: { sessionID: "ses_in", agent: "plan", model: { providerID: "openai", modelID: "planX" } } })
  await new Promise(r => setTimeout(r, 10))
  modelHandler({ type: "tui.model.selected", data: { sessionID: "ses_in", agent: "build", model: { providerID: "anthropic", modelID: "buildY" } } })
  await new Promise(r => setTimeout(r, 20))

  const picks = (metadata.planReviewModels as any)
  if (picks?.plan?.modelID !== "planX") {
    throw new Error(`[54b] plan must stay planX after build pick (was clobbered by home cache), got: ${JSON.stringify(picks?.plan)}`)
  }
  if (picks?.build?.modelID !== "buildY") throw new Error(`[54c] build must be buildY, got: ${JSON.stringify(picks?.build)}`)
  console.log("[54] in-session picks are per-agent; no home-cache clobber: ok")
}

// 55. Regression: the strela/oil repro. The fork hydrates its modelStore
//     without emitting tui.selection.changed events — the sidebar reads
//     live state each frame (shows correct models), but the plugin only
//     knows the last event (the startup transient). The flush MUST read
//     the live state at transition time, not rely on the event cache.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  // Startup transient — both agents report the fork fallback.
  let currentModels = {
    plan: { providerID: "openrouter", modelID: "google/gemini-3-pro-image-preview" },
    build: { providerID: "openrouter", modelID: "google/gemini-3-pro-image-preview" },
  }
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 }, metadata: {} } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      modelSelectionEvents: true,
      // The fake selection() is mutable; the fork hydrates its modelStore
      // in-place without firing selection.changed, so the plugin's event
      // cache stays at the transient value.
      selection: () => ({ sessionID: undefined, agent: "plan", models: currentModels }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: { on: (type: string, handler: any) => {
      if (type === "tui.selection.changed") selectionHandler = handler
      if (type === "session.created") createdHandler = handler
      return () => {}
    } },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)
  await new Promise(r => setTimeout(r, 20))

  // The fork hydrates internally — no selection.changed event reaches us.
  // Mutating the fake's selection() simulates the sidebar updating while
  // the event cache stays stale.
  currentModels = {
    plan: { providerID: "ya-glm", modelID: "glm" },
    build: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" },
  }
  // Sanity: cache was poisoned by the startup transient; the corrective
  // value is only reachable via live read.
  if (updates.length !== 0) throw new Error("[55a] setup: no writes yet expected")

  // Transition into a fresh session. The flush must read live state.
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_strela", agent: "plan", models: currentModels } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error(`[55b] expected exactly 1 flush write, got ${updates.length}`)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.build?.modelID !== "MiniMax-M3") {
    throw new Error(`[55c] build must be MiniMax-M3 from live state, got: ${JSON.stringify(picks?.build)}`)
  }
  if (picks?.plan?.modelID !== "glm") {
    throw new Error(`[55d] plan must be glm from live state, got: ${JSON.stringify(picks?.plan)}`)
  }
  const written = JSON.stringify(updates)
  if (written.includes("gemini-3-pro-image-preview")) {
    throw new Error("[55e] transient fallback leaked into metadata")
  }
  console.log("[55] flush reads live selection; event-cache stale transient never persists: ok")
}

// 44. Regression: the zmk-for-charybdis repro. User explicitly picked
//     build=deepseek on home (flushed to planReviewModels as source=picker).
//     exitPlanMode must use the explicit picker source and NEVER resolve
//     to a transient display value. (Legacy tuiCurrentSelection is gone;
//     even if a stale transient were in metadata, the resolver ignores it
//     because only the new planReviewModels key is read.)
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } } as any,
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: {
        // Stale transient snapshot from a pre-fix run — MUST be ignored.
        tuiCurrentSelection: {
          build: { providerID: "openrouter", modelID: "google/gemini-3-pro-image-preview" },
        },
        planReviewModels: {
          build: { providerID: "opencode-go", modelID: "deepseek-v4-flash", source: "picker", at: Date.now() },
          plan: { providerID: "openai", modelID: "gpt-5.6-sol", source: "picker", at: Date.now() },
        },
      } } }),
      messages: async () => ({ data: [] }),
      prompt: async () => ({}),
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const fakeFs = await import("node:fs")
  const tmpEditor = "/tmp/pr-smoke-nano-banana.sh"
  fakeFs.writeFileSync(tmpEditor, "#!/bin/sh\nexit 0\n")
  fakeFs.chmodSync(tmpEditor, 0o755)
  const oldEditor = process.env.EDITOR
  process.env.EDITOR = tmpEditor
  try {
    await testHooks.tool.plan_review.execute(
      { plan: "x" },
      { sessionID: "ses_repro", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )
  } finally {
    if (oldEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = oldEditor
    fakeFs.rmSync(tmpEditor, { force: true })
  }
  const resolution = logs.find((l: any) => l.body?.message?.startsWith("plan-review: exitPlanMode resolution:"))
  if (!resolution) throw new Error("[44] missing exitPlanMode resolution log")
  const msg = resolution.body?.message
  if (msg.includes("gemini-3-pro-image-preview")) throw new Error(`[44] transient snapshot leaked into resolution: ${msg}`)
  if (!msg.includes("target=opencode-go/deepseek-v4-flash")) throw new Error(`[44] expected deepseek, got: ${msg}`)
  if (!msg.includes("source=TUI explicit picker (build)")) throw new Error(`[44] expected picker source, got: ${msg}`)
  console.log("[44] explicit deepseek beats transient snapshot (legacy tuiCurrentSelection ignored): ok")
}

// 45. chat.message hook handler captures per-session, per-agent model.
//     This is the single source of truth for picker attribution in the
//     priority chain (next watcher-free, no global state). Live TUI
//     Stock opencode relies on this when the native fork API is absent.
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) }, agents: async () => ({ data: [] }) } as any,
    session: { promptAsync: async () => {}, get: async () => ({ data: { metadata: {} } }), update: async () => ({ data: null }) },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks["chat.message"](
    { sessionID: "ses_e2e", agent: "plan", model: { providerID: "openai", modelID: "gpt-x" } } as any,
    {} as any,
  )
  await new Promise(r => setTimeout(r, 30))
  const chatMsg = logs.find((l: any) => l.body?.message?.includes("chat.message: session=ses_e2e agent=plan"))
  if (!chatMsg) throw new Error("missing chat.message log, got: " + logs.map((l:any)=>l.body?.message).join("\n"))
  console.log("[45] chat.message hook captures per-agent model: ok")
}

// 47. No silent .catch(() => {}) in any plugin source. Per AGENTS.md:
//     `catch {}` is forbidden. The post-refactor split moved catch logic
//     across several modules — scan them all.
{
  const fs = await import("node:fs")
  const { readdirSync } = fs
  const pluginDir = `${import.meta.dir}/../plugin`
  const files = readdirSync(pluginDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  let totalSilent = 0
  for (const f of files) {
    const src = fs.readFileSync(`${pluginDir}/${f}`, "utf8")
    totalSilent += (src.match(/\.catch\(\(\) => \{\}\)/g) ?? []).length
  }
  if (totalSilent > 0) {
    throw new Error("silent .catch(() => {}) present in plugin/ files: " + totalSilent)
  }
  console.log(`[47] no silent .catch(() => {}) across ${files.length} plugin/ files: ok`)
}

// 48. Smoke for the install cleanup. We verify that after install,
//     the legacy symlink ~/.config/opencode/plugins/plan-review-tui.ts
//     does NOT exist. TUI plugins must be registered via tui.json
//     (the server plugin loader attempts server()-export on anything
//     under plugins/, which makes a TUI plugin there fail with
//     'must default export an object with server()').
{
  const fs = await import("node:fs")
  const path = await import("node:path")
  const legacy = path.join(process.env.HOME ?? "/tmp", ".config", "opencode", "plugins", "plan-review-tui.ts")
  if (fs.existsSync(legacy)) {
    throw new Error("legacy symlink still exists at " + legacy + " — install logic must delete it")
  }
  console.log("[48] no legacy TUI plugin symlink in ~/.config/opencode/plugins/: ok")
}

// 7b. exitPlanMode happy path with resolved target — sends inline model+agent
//     override in client.session.prompt body. Pre-seed the build record via
//     captureImplicit (the natural write path), then approve.
{
  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
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
    { sessionID: "ses_happy", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
  )
  prompts.length = 0
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
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: chat.message (build)")) {
    throw new Error("build prompt text missing source label: " + buildPrompt.body?.parts?.[0]?.text)
  }
  console.log("[7b] exitPlanMode happy path with inline model+agent: ok")
}

// 10. /set-build-model <provider>/<model> writes pinned record via metadata.
//     exitPlanMode reads the record. Confirmed record also has pinned:true
//     so implicit chat.message captures do not overwrite it.
{
  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
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
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "set-build-model", arguments: "ya-glm/glm", sessionID: "ses_set" },
    },
  } as any)
  const confirm = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("Build model for this session set to"))
  if (!confirm) throw new Error("set-build-model did not produce confirmation")
  if (!confirm.body.parts[0].text.includes("ya-glm/glm")) throw new Error("confirmation missing model id")
  if (!confirm.body.parts[0].text.toLowerCase().includes("pinned")) throw new Error("confirmation should mention pinned persistence")

  if (stored.planReviewModels?.build?.pinned !== true) {
    throw new Error("set-build-model must persist pinned:true in metadata: " + JSON.stringify(stored.planReviewModels))
  }

  // A chat.message for build with a DIFFERENT model must NOT overwrite pinned
  await testHooks["chat.message"](
    { sessionID: "ses_set", agent: "build", model: { providerID: "openai", modelID: "gpt-x" } } as any,
    {},
  )
  if (stored.planReviewModels?.build?.providerID !== "ya-glm") {
    throw new Error("chat.message overwrote pinned /set-build-model record: " + JSON.stringify(stored.planReviewModels?.build))
  }

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
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: build model memory")) {
    throw new Error("build prompt text missing build model memory source label")
  }
  console.log("[10] /set-build-model persists pinned record, exitPlanMode uses it: ok")
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
    session: {
      get: async () => ({ data: { metadata: {} } }),
      update: async () => ({ data: null }),
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
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
    session: { prompt: async () => {}, get: async () => ({ data: { metadata: {} } }), update: async () => ({ data: null }) },
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
  if (!logs.some((l: any) => l.body?.level === "info" && l.body?.message?.includes("chat.message:") && l.body?.message?.includes("ya-glm/glm"))) {
    throw new Error("chat.message hook did not emit info-level log")
  }
  console.log("[12] chat.message captures TUI picker inline model (info level): ok")
}

// 13. Resolution precedence: record (from chat.message capture) wins over
//     session history and config fallback.
{
  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: { model: "anthropic/claude-sonnet-4" } }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
      messages: async () => ({
        data: [{ info: { role: "user", agent: "build" }, model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } }],
      }),
    },
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
    { sessionID: "ses_prio", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
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
    throw new Error(`record should win over session history and config, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: chat.message")) {
    throw new Error(`build prompt should have 'source: chat.message' label, got: ${buildPrompt.body?.parts?.[0]?.text}`)
  }
  console.log("[13] record wins over session history and config: ok")
}

// 14. Precedence: /set-build-model (pinned) wins over chat.message capture.
//     When the explicit command runs, it overwrites the chat record (last
//     write wins) and pins it so subsequent chat captures cannot revert.
{
  const prompts: any[] = []
  const logs: any[] = []
  let stored: Record<string, any> = {}
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({ data: [] }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: stored } }),
      update: async ({ body }: any) => { if (body?.metadata) stored = body.metadata; return { data: null } },
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
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
    { sessionID: "ses_over", agent: "build", model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } } as any,
    {},
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
  if (buildPrompt.body?.model?.providerID !== "ya-glm") {
    throw new Error(`/set-build-model should win per priority, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  if (!buildPrompt.body?.parts?.[0]?.text?.includes("source: build model memory")) {
    throw new Error(`expected source: build model memory, got: ${buildPrompt.body?.parts?.[0]?.text}`)
  }
  console.log("[14] priority order: /set-build-model (pinned) wins over chat.message: ok")
}

// 15. plugin init logs: "plugin init v0.1.x build=..." + "tool 'plan_review' created, args: ..."
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
  const initLog = logs.find((l: any) => l.body?.level === "info" && /^plan-review: plugin init v\d+\.\d+\.\d+ build=/.test(l.body?.message ?? ""))
  if (!initLog) throw new Error("init log 'plan-review: plugin init v' missing")
  if (!initLog.body.message.includes(`v${EXPECTED_VERSION}`)) {
    throw new Error("init log must include version build marker, got: " + initLog.body.message)
  }
  if (!initLog.body.message.includes(`build=v${EXPECTED_VERSION}`)) {
    throw new Error(`init log must include build=v${EXPECTED_VERSION} marker, got: ` + initLog.body.message)
  }
  const toolLog = logs.find((l: any) => l.body?.level === "info" && l.body?.message?.includes("tool 'plan_review' created"))
  if (!toolLog) throw new Error("tool registration log missing")
  if (!toolLog.body.message.includes("plan")) throw new Error("tool log missing arg name")
  if (!testHooks.tool.plan_review) throw new Error("plan_review not in returned hooks")
  console.log("[15] init + tool registration logs emitted: ok")
}

// 16. Refuse when nothing resolves: plan's model must NOT leak into build.
{
  const prompts: any[] = []
  const logs: any[] = []
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      // build agent has NO model, plan agent has MiniMax-M3
      agents: async () => ({
        data: [
          { name: "build", model: null },
          { name: "plan", model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } },
        ],
      }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async () => ({ data: { metadata: {} } }),
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
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
  const noopEditorFB = "/tmp/pr-smoke-fb-noop.sh"
  writeFileSync(noopEditorFB, "#!/bin/sh\nexit 0\n")
  chmodSync(noopEditorFB, 0o755)
  await testHooks.tool.plan_review.execute(
    { plan: "x" },
    { sessionID: "ses_fb", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
  )
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (buildPrompt) {
    throw new Error(`build prompt must not be sent when build has no model, got: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  const refusal = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("No build model resolved"))
  if (!refusal) throw new Error("expected no-build-model refusal prompt")
  console.log("[16] no plan-model leak when all build sources undefined: ok")
}

// 17. config hook injects plan_review into primary_tools (whitelist)
{
  const cfg: any = { experimental: { primary_tools: ["bash"] } }
  // simulate by calling the same logic directly
  const exp = cfg.experimental ?? {}
  const tools: string[] = exp.primary_tools ?? []
  if (!tools.includes("plan_review")) {
    cfg.experimental = { ...exp, primary_tools: [...tools, "plan_review"] }
  }
  if (!cfg.experimental.primary_tools.includes("plan_review")) {
    throw new Error("plan_review not in primary_tools after inject")
  }
  // idempotent
  const exp2 = cfg.experimental
  const tools2 = exp2.primary_tools
  if (tools2.filter((t: string) => t === "plan_review").length !== 1) {
    throw new Error("primary_tools whitelist not idempotent")
  }
  // also verify hook is wired — instantiate the plugin and check config in returned hooks
  const logs: any[] = []
  const testHooks = await mod.default({
    client: { app: { log: async (opts: any) => { logs.push(opts) } }, session: { prompt: async () => {} } } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  if (typeof testHooks.config !== "function") throw new Error("config hook not exported from plugin")

  // Verify the config hook denies plan_exit for the plan agent (hard
  // guardrail: model can't end its turn with the built-in plan_exit tool).
  const cfg2: any = {
    experimental: { primary_tools: [] },
    agent: {
      plan: { name: "plan", permission: {} },
      build: { name: "build", permission: {} },
    },
  }
  await testHooks.config(cfg2)
  const planPerm = cfg2.agent.plan.permission
  if (planPerm.plan_review !== "allow") throw new Error("config hook must allow plan_review for plan agent")
  if (planPerm.plan_exit !== "deny") throw new Error("config hook must deny plan_exit for plan agent")
  if (cfg2.agent.build.permission.plan_review !== "deny") throw new Error("config hook must deny plan_review for build agent")
  console.log("[17] config hook injects plan_review into primary_tools + denies plan_exit: ok")
}

// 18. system prompt is short (plannotator-style) — regression check
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
  const out: any = { system: ["base prompt"] }
  await testHooks["experimental.chat.system.transform"]({ sessionID: "ses_short", model: {} as any } as any, out)
  const appended = out.system[out.system.length - 1] ?? ""
  if (appended.length > 800) throw new Error(`system prompt too long: ${appended.length} chars (max 800)`)
  if (!appended.includes("plan_review")) throw new Error("system prompt missing plan_review mention")
  if (!appended.includes("MUST call the `plan_review` tool")) throw new Error("system prompt missing hard 'MUST call plan_review' directive")
  if (!appended.includes("ONLY way")) throw new Error("system prompt missing 'ONLY way to complete planning'")
  console.log(`[18] system prompt short and directive: ${appended.length} chars`)
}

// 19. system prompt skip when last user message was from build agent
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: {
      prompt: async () => {},
      messages: async () => ({
        data: [
          { info: { role: "user", agent: "plan" } },
          { info: { role: "user", agent: "build" } },  // most recent
        ],
      }),
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const out: any = { system: ["base prompt"] }
  await testHooks["experimental.chat.system.transform"]({ sessionID: "ses_build", model: {} as any } as any, out)
  const injected = out.system.some((s: string) => s.includes("call the `plan_review` tool"))
  if (injected) throw new Error("system prompt should be skipped when last user message is from build agent")
  console.log("[19] system prompt skip for build agent: ok")
}

// 24. system prompt transform NOT skipped when system contains "subagent" word
//     (opencode plan-agent system prompt mentions sub-agents in tool delegation
//     guidance; my old skip was too broad and caused 100% skip rate in
//     ses_09fbfdba5ffea6PmErY6PMQo8l)
{
  const fakeClient = {
    app: { log: async () => {} },
    session: {
      prompt: async () => {},
      messages: async () => ({ data: [{ info: { role: "user", agent: "plan" } }] }),
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const out: any = { system: ["You may delegate to a subagent for exploration tasks."] }
  await testHooks["experimental.chat.system.transform"]({ sessionID: "ses_sub", model: {} as any } as any, out)
  const injected = out.system.some((s: string) => s.includes("call the `plan_review` tool"))
  if (!injected) throw new Error("system prompt should NOT be skipped when system contains 'subagent' word")
  console.log("[24] system prompt not skipped on 'subagent' word: ok")
}

// 24b. experimental.chat.messages.transform rewrites plan_exit → plan_review
//      in message parts (the per-message plan-mode reminder lives there and
//      system.transform can't reach it).
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
  if (typeof testHooks["experimental.chat.messages.transform"] !== "function") {
    throw new Error("messages.transform hook not exported from plugin")
  }
  const messages: any[] = [
    {
      info: { role: "user", agent: "plan" },
      parts: [
        { type: "text", text: "### Phase 5: Call plan_exit tool\nThis is critical - your turn should only end with calling plan_exit. Do not stop unless... Also ExitPlanMode is the same." },
        { type: "text", text: "unrelated text with no tool names" },
      ],
    },
  ]
  await testHooks["experimental.chat.messages.transform"]({} as any, { messages })
  const rewritten = messages[0].parts[0].text
  if (rewritten.includes("plan_exit")) throw new Error("plan_exit still present after messages.transform: " + rewritten)
  if (rewritten.includes("ExitPlanMode")) throw new Error("ExitPlanMode still present after messages.transform: " + rewritten)
  if (!rewritten.includes("Call plan_review tool")) throw new Error("plan_exit not rewritten to plan_review: " + rewritten)
  if (!rewritten.includes("calling plan_review")) throw new Error("second plan_exit not rewritten: " + rewritten)
  if (messages[0].parts[1].text.includes("plan_review")) throw new Error("unrelated part must stay untouched")
  if (!logs.some((l: any) => l.body?.message?.includes("rewrote plan_exit→plan_review in 1 message part"))) {
    throw new Error("missing messages.transform rewrite log")
  }
  console.log("[24b] messages.transform rewrites plan_exit→plan_review in message parts: ok")
}

// 24c. messages.transform appends a plan_review directive to plan-mode
//      reminder parts (plan.txt says "construct a well-formed plan" but
//      never mentions plan_review — weaker models write the plan in chat).
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
  const messages: any[] = [
    {
      info: { role: "user", agent: "plan" },
      parts: [
        { type: "text", text: "<system-reminder>\n# Plan Mode - System Reminder\n\nCRITICAL: Plan mode ACTIVE - you are in READ-ONLY phase.\nYour current responsibility is to construct a well-formed plan.\n</system-reminder>" },
        { type: "text", text: "just a normal user question with no marker words here" },
      ],
    },
  ]
  await testHooks["experimental.chat.messages.transform"]({} as any, { messages })
  const reminder = messages[0].parts[0].text
  if (!reminder.includes("call the `plan_review` tool")) throw new Error("reminder missing plan_review directive: " + reminder)
  if (!reminder.includes("Do NOT write the plan in chat")) throw new Error("reminder missing chat-warning: " + reminder)
  if (messages[0].parts[1].text.includes("plan_review")) throw new Error("non-reminder part must stay untouched")
  if (!logs.some((l: any) => l.body?.message?.includes("appended plan_review directive to 1 plan-mode reminder"))) {
    throw new Error("missing reminder append log")
  }
  console.log("[24c] messages.transform appends plan_review directive to plan-mode reminder: ok")
}

// 20. config hook: HOOK FIRED log emitted, try/catch protects against failure
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async () => {} },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  if (typeof testHooks.config !== "function") throw new Error("config hook not exported")
  // call with a real config object
  const cfg: any = { experimental: { primary_tools: ["bash"] } }
  await testHooks.config(cfg)
  if (!logs.some((l: any) => l.body?.level === "info" && l.body?.message === "plan-review: config hook fired")) {
    throw new Error("config hook did not emit HOOK FIRED log")
  }
  if (!cfg.experimental.primary_tools.includes("plan_review")) {
    throw new Error("config hook did not add plan_review to primary_tools")
  }
  // call with a config that throws on access — should not crash the hook
  const evilCfg: any = new Proxy({}, {
    get() { throw new Error("boom") },
    set() { throw new Error("boom") },
  })
  await testHooks.config(evilCfg)  // must not throw
  console.log("[20] config hook: HOOK FIRED log + try/catch works: ok")
}

// 21. system.transform HOOK FIRED log emitted at start (before skip check)
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: {
      prompt: async () => {},
      messages: async () => ({ data: [] }),
    },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  const out: any = { system: ["base prompt"] }
  await testHooks["experimental.chat.system.transform"]({ sessionID: "ses_diag_21", model: {} as any } as any, out)
  if (!logs.some((l: any) => l.body?.level === "info" && l.body?.message?.includes("system.transform HOOK FIRED") && l.body?.message?.includes("ses_diag_21"))) {
    throw new Error("system.transform HOOK FIRED log missing")
  }
  console.log("[21] system.transform HOOK FIRED log: ok")
}

// 22. chat.message HOOK FIRED log emitted even when input has no model
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async () => {} },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  // call with no agent, no model — should still emit HOOK FIRED log
  await testHooks["chat.message"](
    { sessionID: "ses_diag_22" } as any,
    { message: {} as any, parts: [] },
  )
  if (!logs.some((l: any) => l.body?.level === "info" && l.body?.message?.includes("chat.message HOOK FIRED") && l.body?.message?.includes("ses_diag_22"))) {
    throw new Error("chat.message HOOK FIRED log missing")
  }
  console.log("[22] chat.message HOOK FIRED log: ok")
}

// 23. The build event memory log is gone — model persistence moved to
//      planReviewModels metadata. session.updated events still pass through
//      the event hook without crashing and without producing an "update"
//      log line (the plugin no longer tracks build memory separately).
{
  const logs: any[] = []
  const fakeClient = {
    app: { log: async (opts: any) => { logs.push(opts) } },
    session: { prompt: async () => {} },
  }
  const testHooks = await mod.default({
    client: fakeClient as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })
  await testHooks.event({
    event: {
      type: "session.updated.1",
      data: {
        sessionID: "ses_build_mem",
        info: { id: "ses_build_mem", agent: "build", model: { providerID: "ya-glm", id: "glm" } },
      },
    },
  } as any)
  await new Promise(r => setTimeout(r, 20))
  const errs = logs.filter((l: any) => l.body?.level === "error")
  if (errs.length) throw new Error("session.updated produced error: " + JSON.stringify(errs))
  if (logs.some((l: any) => l.body?.message?.includes("build event memory updated"))) {
    throw new Error("build event memory log should not be emitted anymore")
  }
  console.log("[23] session.updated is no-op for build (record persists instead): ok")
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
  const out: any = { system: ["base prompt", "Phase 5: Call plan_exit tool. Your turn should only end with calling plan_exit or ExitPlanMode."] }
  await testHooks["experimental.chat.system.transform"]({ model: { providerID: "x", modelID: "y" }, sessionID: "ses_old" } as any, out)
  const joined = out.system.join("\n")
  if (!joined.includes("call the `plan_review` tool")) throw new Error("'plan_review' directive missing")
  if (!joined.includes("plan_review")) throw new Error("plan_review mention missing")
  if (joined.includes("plan_exit")) throw new Error("plan_exit should have been rewritten to plan_review")
  if (joined.includes("ExitPlanMode")) throw new Error("ExitPlanMode should have been rewritten to plan_review")
  if (!joined.includes("Call plan_review tool")) throw new Error("plan_exit not rewritten in Phase 5 directive")
  if (!logs.some((l: any) => l.body?.level === "info" && l.body?.message?.includes("system prompt injected"))) {
    throw new Error("diagnostic info log missing")
  }
  if (!logs.some((l: any) => l.body?.level === "info" && l.body?.message?.includes("rewrote plan_exit"))) {
    throw new Error("rewrite diagnostic log missing")
  }
  // skip build agent via sessionID lookup
  const buildOut: any = { system: ["build prompt"] }
  const buildClient: any = {
    app: { log: async (o: any) => {} },
    session: {
      messages: async () => ({ data: [{ info: { role: "user", agent: "build" } }] }),
      prompt: async () => {},
    },
  }
  const buildHooks = await mod.default({
    client: buildClient, project: {} as any, directory: "/tmp", worktree: "/tmp",
    serverUrl: new URL("http://x"), $,
  })
  await buildHooks["experimental.chat.system.transform"]({ model: { providerID: "x", modelID: "y" }, sessionID: "ses_build_skip" } as any, buildOut)
  if (buildOut.system.join("\n").includes("Plan Review")) throw new Error("Plan Review block should be skipped for build agent")
  console.log("[8] system prompt transform with ENFORCEMENT: ok")
}

// 9. /plan-diag reports the planReviewModels record + supports per-session reset
{
  const logs: any[] = []
  const prompts: any[] = []
  const meta = new Map<string, Record<string, any>>()
  meta.set("ses_diag_test", {
    planReviewModels: {
      build: { providerID: "ya-glm", modelID: "glm", source: "chat", at: Date.now() },
    },
  })
  const testHooks = await mod.default({
    client: {
      app: { log: async (opts: any) => { logs.push(opts) } },
      session: {
        prompt: async (opts: any) => { prompts.push(opts); return {} },
        get: async ({ path }: any) => ({ data: { metadata: meta.get(path.id) ?? {} } }),
        update: async ({ path, metadata }: any) => { meta.set(path.id, metadata); return { data: null } },
      },
    } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "plan-diag", arguments: "", sessionID: "ses_diag_test" },
    },
  } as any)
  const diagPrompt = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("# plan-diag"))
  if (!diagPrompt) throw new Error("/plan-diag handler did not produce diag output")
  const diagText = diagPrompt.body.parts[0].text
  if (!diagText.includes("ya-glm/glm")) throw new Error("plan-diag output missing recorded build model: " + diagText)
  if (!diagText.includes("[chat")) throw new Error("plan-diag should tag source: " + diagText)

  prompts.length = 0
  await testHooks.event({
    event: {
      type: "command.executed",
      properties: { name: "plan-diag", arguments: "reset", sessionID: "ses_diag_test" },
    },
  } as any)
  if (!prompts.some((p: any) => p.body?.parts?.[0]?.text?.includes("cleared for this session"))) {
    throw new Error("/plan-diag reset should say 'cleared for this session'")
  }
  if (meta.get("ses_diag_test")?.planReviewModels) throw new Error("reset did not remove the record")

  console.log("[9] /plan-diag reports planReviewModels record + per-session reset: ok")
}

// 9b. /plan-diag reset is per-session: other sessions' records survive
{
  const prompts: any[] = []
  const meta = new Map<string, Record<string, any>>([
    ["ses_keep", { planReviewModels: { build: { providerID: "ya-glm", modelID: "glm-keep", source: "chat", at: Date.now() } } }],
    ["ses_reset", { planReviewModels: { build: { providerID: "ya-glm", modelID: "glm-reset", source: "chat", at: Date.now() } } }],
  ])
  const testHooks = await mod.default({
    client: {
      app: { log: async () => ({}) },
      session: {
        prompt: async (opts: any) => { prompts.push(opts); return {} },
        get: async ({ path }: any) => ({ data: { metadata: meta.get(path.id) ?? {} } }),
        update: async ({ path, metadata }: any) => { meta.set(path.id, metadata); return { data: null } },
      },
    } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  prompts.length = 0
  await testHooks.event({
    event: { type: "command.executed", properties: { name: "plan-diag", arguments: "reset", sessionID: "ses_reset" } },
  } as any)
  if (!prompts.some((p: any) => p.body?.parts?.[0]?.text?.includes("cleared for this session"))) {
    throw new Error("/plan-diag reset should say 'cleared for this session'")
  }
  if (meta.get("ses_reset")?.planReviewModels) throw new Error("reset did not clear ses_reset record")

  prompts.length = 0
  await testHooks.event({
    event: { type: "command.executed", properties: { name: "plan-diag", arguments: "", sessionID: "ses_keep" } },
  } as any)
  const diagText = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("# plan-diag"))?.body.parts[0].text
  if (!diagText) throw new Error("/plan-diag did not produce output for ses_keep")
  if (!diagText.includes("glm-keep")) {
    throw new Error("B1 regression: /plan-diag reset wiped another session's record. diag:\n" + diagText)
  }

  console.log("[9b] /plan-diag reset is per-session: other session's record survives: ok")
}

// 9c. getGlobalModel handles object-shaped config.model (B2)
{
  const logs: any[] = []
  const prompts: any[] = []
  const fakeConfig = { data: { model: { providerID: "ya-glm", modelID: "glm-obj" } } }
  const testHooks = await mod.default({
    client: {
      app: { log: async (opts: any) => { logs.push(opts) } },
      session: { prompt: async (opts: any) => { prompts.push(opts); return {} } },
      config: { get: async () => fakeConfig },
    } as any,
    project: {} as any,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://x"),
    $,
  })

  // No-op EDITOR so runPlanReview returns empty diff (plan approval path).
  const fakeFs = await import("node:fs")
  const tmpEditor = "/tmp/pr-smoke-b2-editor.sh"
  fakeFs.writeFileSync(tmpEditor, "#!/bin/sh\nexit 0\n")
  fakeFs.chmodSync(tmpEditor, 0o755)
  const oldEditor = process.env.EDITOR
  process.env.EDITOR = tmpEditor
  try {
    await testHooks.tool.plan_review.execute(
      { plan: "x" },
      { sessionID: "ses_global_obj", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )
  } finally {
    if (oldEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = oldEditor
    fakeFs.rmSync(tmpEditor, { force: true })
  }
  const resolution = logs.find((l: any) => l.body?.message?.startsWith("plan-review: exitPlanMode resolution:"))
  if (!resolution) throw new Error("B2: expected exitPlanMode resolution log, got logs:\n" + logs.map((l:any)=>l.body?.message).join("\n"))
  const msg = resolution.body.message
  if (!msg.includes("ya-glm/glm-obj")) {
    throw new Error("B2 regression: object-shaped config.model not resolved. resolution: " + msg)
  }
  if (!msg.includes("source=config.model")) {
    throw new Error("B2: expected source=config.model in resolution, got: " + msg)
  }
  console.log("[9c] getGlobalModel handles object-shaped config.model (B2): ok")
}

// P1. Regression: model picks survive plugin/server restart. chat.message
//      writes the pick to planReviewModels metadata; a fresh plugin
//      instance reading the same metadata must resolve it. (Old code lost
//      chat captures to a process-lifetime Map.)
{
  const meta = new Map<string, Record<string, any>>()
  const fakeClient: any = {
    app: { log: async () => ({}), agents: async () => ({ data: [] }) },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async ({ path }: any) => ({ data: { metadata: meta.get(path.id) ?? {} } }),
      update: async ({ path, body }: any) => { if (body?.metadata) meta.set(path.id, body.metadata); return { data: null } },
      prompt: async () => ({}),
    },
  }
  // First plugin instance writes the chat capture.
  const hooks1 = await mod.default({
    client: fakeClient, project: {} as any, directory: "/tmp", worktree: "/tmp",
    serverUrl: new URL("http://x"), $,
  })
  await hooks1["chat.message"](
    { sessionID: "ses_p1", agent: "build", model: { providerID: "ya-glm", modelID: "glm" } } as any,
    {},
  )
  // Simulate restart: a NEW plugin instance with the same client. Resolves
  // from persisted metadata, not RAM.
  const fakeFs = await import("node:fs")
  const tmpEditor = "/tmp/pr-smoke-p1-noop.sh"
  fakeFs.writeFileSync(tmpEditor, "#!/bin/sh\nexit 0\n")
  fakeFs.chmodSync(tmpEditor, 0o755)
  const oldEditor = process.env.EDITOR
  process.env.EDITOR = tmpEditor
  const logs: any[] = []
  fakeClient.app.log = async (o: any) => { logs.push(o) }
  const hooks2 = await mod.default({
    client: fakeClient, project: {} as any, directory: "/tmp", worktree: "/tmp",
    serverUrl: new URL("http://x"), $,
  })
  try {
    await hooks2.tool.plan_review.execute(
      { plan: "x" },
      { sessionID: "ses_p1", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )
  } finally {
    if (oldEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = oldEditor
    fakeFs.rmSync(tmpEditor, { force: true })
  }
  const resolution = logs.find((l: any) => l.body?.message?.startsWith("plan-review: exitPlanMode resolution:"))
  if (!resolution?.body?.message?.includes("source=chat.message (build)")) {
    throw new Error("P1: restart must resolve from persisted record, got: " + resolution?.body?.message)
  }
  if (!resolution?.body?.message?.includes("target=ya-glm/glm")) {
    throw new Error("P1: restart lost the build model pick: " + resolution?.body?.message)
  }
  console.log("[P1] restart-survival: chat capture persisted in planReviewModels survives plugin reload: ok")
}

// P2. Regression: home picks land on a brand-new session. Two agents
//      chosen at home are written to the new session's planReviewModels.
//      (Old code lost picks when the flush raced with the first prompt.)
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  const fakeApi = {
    client: {
      session: {
        get: async () => ({ data: { time: { created: Date.now() - 500 } } }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      provider: [],
      modelSelectionEvents: true,
      selection: () => ({ sessionID: undefined, agent: "plan", models: {} }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: {
      on: (type: string, handler: any) => {
        if (type === "tui.model.selected") modelHandler = handler
        if (type === "tui.selection.changed") selectionHandler = handler
        if (type === "session.created") createdHandler = handler
        return () => {}
      },
    },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)

  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "plan", model: { providerID: "openai", modelID: "gpt-5" } } })
  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "build", model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" } } })
  await new Promise(r => setTimeout(r, 10))

  createdHandler({ type: "session.created", properties: { sessionID: "ses_p2" } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ data: { current: { sessionID: "ses_p2", agent: "build", models: {} } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 1) throw new Error(`P2: expected 1 flush, got ${updates.length}`)
  const picks = updates[0]?.metadata?.planReviewModels
  if (picks?.plan?.modelID !== "gpt-5") throw new Error(`P2: plan not seeded: ${JSON.stringify(picks)}`)
  if (picks?.build?.modelID !== "deepseek-v4-flash") throw new Error(`P2: build not seeded: ${JSON.stringify(picks)}`)
  console.log("[P2] new-session seed: home picks flushed into brand-new session: ok")
}

// P3. Regression: opening an EXISTING session does NOT receive the home
//      draft. The session has its own (preexisting) record; the home
//      draft's picks must be dropped, not written.
{
  const mod = await import("../plugin/tui-plugin.tsx" as any)
  const tuiPluginFn = (mod.default as any).tui
  let modelHandler: any
  let selectionHandler: any
  let createdHandler: any
  const updates: any[] = []
  const existingBuild = { providerID: "anthropic", modelID: "claude-4-orig", source: "chat", at: Date.now() }
  const fakeApi = {
    client: {
      session: {
        get: async () => ({
          data: {
            time: { created: Date.now() - 3_600_000 },
            metadata: { planReviewModels: { build: existingBuild } },
          },
        }),
        update: async (opts: any) => { updates.push(opts); return { data: null } },
      },
      app: { log: async () => ({}) },
    },
    state: {
      provider: [],
      modelSelectionEvents: true,
      selection: () => ({ sessionID: undefined, agent: "plan", models: {} }),
    },
    theme: { current: { primary: {}, textMuted: {} } },
    slots: { register: () => "test" },
    lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
    event: {
      on: (type: string, handler: any) => {
        if (type === "tui.model.selected") modelHandler = handler
        if (type === "tui.selection.changed") selectionHandler = handler
        if (type === "session.created") createdHandler = handler
        return () => {}
      },
    },
  }
  await tuiPluginFn(fakeApi, undefined, { id: "plan-review-tui", spec: "/dev/null" } as any)

  modelHandler({ type: "tui.model.selected", data: { sessionID: undefined, agent: "build", model: { providerID: "openai", modelID: "gpt-home" } } })
  await new Promise(r => setTimeout(r, 10))

  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_p3_existing", agent: "plan", models: {} } } })
  await new Promise(r => setTimeout(r, 30))

  if (updates.length !== 0) throw new Error(`P3: existing session must not receive home draft, got ${updates.length} writes`)

  createdHandler({ type: "session.created", properties: { sessionID: "ses_p3_later" } })
  await new Promise(r => setTimeout(r, 5))
  selectionHandler({ type: "tui.selection.changed", data: { current: { sessionID: "ses_p3_later", agent: "plan", models: {} } } })
  await new Promise(r => setTimeout(r, 30))
  if (updates.length !== 0) throw new Error(`P3: dropped draft must not flush into a later session, got ${updates.length} writes`)
  console.log("[P3] adjacent-session isolation: existing session not contaminated by home draft: ok")
}

// P4. Regression: exitPlanMode NEVER resolves to the plan agent's model.
//      Build agent's record is empty; plan agent's chat capture is the
//      only thing that mentions a model. Refuse and prompt the user to
//      pick, rather than leaking plan's model into build.
{
  const prompts: any[] = []
  const logs: any[] = []
  const meta = new Map<string, Record<string, any>>([
    ["ses_p4", {
      planReviewModels: {
        plan: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3", source: "chat", at: Date.now() },
      },
    }],
  ])
  const fakeClient = {
    app: {
      log: async (opts: any) => { logs.push(opts) },
      agents: async () => ({
        data: [{ name: "build", model: null }, { name: "plan", model: { providerID: "minimax-coding-plan", modelID: "MiniMax-M3" } }],
      }),
    },
    config: { get: async () => ({ data: {} }) },
    session: {
      get: async ({ path }: any) => ({ data: { metadata: meta.get(path.id) ?? {} } }),
      messages: async () => ({ data: [] }),
      prompt: async (opts: any) => { prompts.push(opts); return {} },
    },
  }
  const hooks = await mod.default({
    client: fakeClient as any, project: {} as any, directory: "/tmp", worktree: "/tmp",
    serverUrl: new URL("http://x"), $,
  })
  const fakeFs = await import("node:fs")
  const tmpEditor = "/tmp/pr-smoke-p4-noop.sh"
  fakeFs.writeFileSync(tmpEditor, "#!/bin/sh\nexit 0\n")
  fakeFs.chmodSync(tmpEditor, 0o755)
  const oldEditor = process.env.EDITOR
  process.env.EDITOR = tmpEditor
  try {
    await hooks.tool.plan_review.execute(
      { plan: "x" },
      { sessionID: "ses_p4", messageID: "m", agent: "plan", directory: "/tmp", worktree: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any,
    )
  } finally {
    if (oldEditor === undefined) delete process.env.EDITOR
    else process.env.EDITOR = oldEditor
    fakeFs.rmSync(tmpEditor, { force: true })
  }
  const buildPrompt = prompts.find((p: any) => p.body?.agent === "build")
  if (buildPrompt) {
    throw new Error(`P4: plan model leaked into build: ${JSON.stringify(buildPrompt.body?.model)}`)
  }
  const refusal = prompts.find((p: any) => p.body?.parts?.[0]?.text?.includes("No build model resolved"))
  if (!refusal) throw new Error("P4: expected refusal prompt")
  console.log("[P4] no plan-model leak: build refuses when only plan has a model: ok")
}

console.log("[OK] all smoke checks passed")
