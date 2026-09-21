import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PlanReviewPlugin } from "../plugin/v2/index"
import type { Context, Tool } from "../plugin/v2/context"

process.env.EDITOR = "true"
delete process.env.AGTERM_SESSION_ID

test("legacy plugin exposes a server entrypoint", async () => {
  const module = await import("../plugin/index")
  assert.equal(module.default.id, "opencode-plan-review")
  assert.equal(typeof module.default.server, "function")

  const loader = await import("../../opencode/packages/opencode/src/plugin/shared.ts")
  const spec = new URL("../plugin/index.ts", import.meta.url).href
  const plugin = loader.readV1Plugin(module, spec, "server", "detect")
  assert.ok(plugin)
  const id = await loader.resolvePluginId("file", spec, spec, loader.readPluginId(plugin.id, spec))
  assert.equal(id, "opencode-plan-review")
})

test("legacy server initializes the plan_review tool", async () => {
  const previousHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "plan-review-plugin-test-"))
  process.env.HOME = home
  const metadata = {
    planReviewModels: {
      build: { providerID: "provider", modelID: "model", source: "picker", at: 1 },
    },
  }
  const prompts: unknown[] = []
  const client = {
    app: { log: async () => undefined },
    session: {
      get: async () => ({ data: { metadata } }),
      update: async (input: { body: { metadata: typeof metadata } }) => Object.assign(metadata, input.body.metadata),
      messages: async () => ({ data: [] }),
      prompt: async (input: unknown) => void prompts.push(input),
    },
  }
  const shell = () => ({ text: async () => "" })

  try {
    const module = await import("../plugin/index")
    const hooks = await module.default.server({ client, $: shell, serverUrl: new URL("http://localhost:4096") } as never)
    assert.equal(typeof hooks.tool?.plan_review?.execute, "function")
    await hooks.config?.({ experimental: {}, agent: { plan: {}, build: {} } })
    const result = await hooks.tool.plan_review.execute({ plan: "# Plan\n" }, { sessionID: "ses_legacy" })
    assert.ok(result.includes("Switched to build agent"))
    assert.deepEqual((prompts[0] as { body: { agent: string; model: unknown } }).body, {
      agent: "build",
      model: { providerID: "provider", modelID: "model" },
      noReply: true,
      parts: [{ type: "text", text: "Plan approved. User closed editor without changes. Build model: provider/model (source: TUI explicit picker (build)). Proceed with implementation." }],
    })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test("legacy helper spawn failures surface a non-empty error", async () => {
  const previousHome = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "plan-review-plugin-test-"))
  process.env.HOME = home
  const client = {
    app: { log: async () => undefined },
    session: {
      get: async () => ({ data: { metadata: {} } }),
      update: async () => ({ data: null }),
      messages: async () => ({ data: [] }),
      prompt: async () => undefined,
    },
  }
  const serverUrl = new URL("http://localhost:4096")

  try {
    const module = await import("../plugin/index")

    // ses_f6f600deeffe: a stalled macfuse/arc worktree mount makes the helper
    // spawn fail with ENXIO. opencode records the thrown message verbatim, so
    // an empty message leaves the model and the user with nothing to act on.
    const enxio = () => ({
      text: async () => {
        throw Object.assign(
          new Error("ENXIO: no such device or address, lstat '/Users/x/arcadia-wt/ghostinvship/junk/moonug'"),
          { code: "ENXIO" },
        )
      },
    })
    const hooks = await module.default.server({ client, $: enxio, serverUrl } as never)
    await assert.rejects(
      hooks.tool.plan_review.execute({ plan: "# Plan\n" }, { sessionID: "ses_error" }),
      (error: Error) => {
        assert.ok(error.message.includes("plan-review helper failed"), error.message)
        assert.ok(error.message.includes("ENXIO"), error.message)
        assert.ok(error.message.includes("macfuse"), error.message)
        return true
      },
    )

    // The exact defect: an error carrying no message must still surface text.
    const nameless = () => ({ text: async () => { throw new Error("") } })
    const hooksNameless = await module.default.server({ client, $: nameless, serverUrl } as never)
    await assert.rejects(
      hooksNameless.tool.plan_review.execute({ plan: "# Plan\n" }, { sessionID: "ses_error_nameless" }),
      (error: Error) => {
        assert.ok(error.message.trim().length > 0)
        assert.ok(error.message.includes("plan-review helper failed"), error.message)
        return true
      },
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test("V2 plugin registers tools, captures models, transforms context, and switches", async () => {
const entries = new Map<string, unknown>()
const hooks = new Map<string, (event: unknown) => Promise<void> | void>()
const tools = new Map<string, Tool>()
const transitions: Array<{ type: string; value: unknown }> = []

const context = {
  options: {},
  agent: {
    get: async () => ({ model: { providerID: "provider", id: "model" } }),
  },
  catalog: {
    model: {
      list: async () => ({ data: [{ providerID: "provider", id: "model", name: "Model", status: "active" }] }),
      default: async () => ({ data: { providerID: "provider", id: "model" } }),
    },
  },
  session: {
    get: async () => ({}),
    messages: async () => [],
    prompt: async () => undefined,
    synthetic: async (input: unknown) => transitions.push({ type: "synthetic", value: input }),
    switchAgent: async (input: unknown) => transitions.push({ type: "agent", value: input }),
    switchModel: async (input: unknown) => transitions.push({ type: "model", value: input }),
    instructions: {
      entry: {
        list: async () => Array.from(entries, ([key, value]) => ({ key, value })),
        put: async ({ key, value }: { key: string; value: unknown }) => void entries.set(key, value),
        remove: async ({ key }: { key: string }) => void entries.delete(key),
      },
    },
    hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
      hooks.set(name, callback)
      return { dispose: async () => void hooks.delete(name) }
    },
  },
  tool: {
    transform: async (callback: (draft: { add: (tool: Tool) => void }) => void) => {
      callback({ add: (tool) => void tools.set(tool.name, tool) })
      return { dispose: async () => void tools.clear() }
    },
  },
} satisfies Context

const cleanup = await PlanReviewPlugin.setup(context)
assert.equal(tools.size, 3)
assert.ok(tools.has("plan_review"))
assert.ok(tools.has("set_build_model"))
assert.ok(tools.has("plan_diag"))

await hooks.get("model.request")?.({
  sessionID: "ses_smoke",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  kind: "primary",
})
const modelRecord = entries.get("planReviewModels") as { build?: { source?: string } }
assert.equal(modelRecord.build?.source, "chat")

const contextEvent = {
  sessionID: "ses_smoke",
  agent: "plan",
  system: [{ type: "text" as const, text: "Use plan_exit when finished." }],
}
await hooks.get("context")?.(contextEvent)
assert.ok(contextEvent.system[0].text.includes("plan_review"))
assert.equal(contextEvent.system.length, 2)

const result = await tools.get("plan_review")?.execute({ plan: "# Plan\n" }, { sessionID: "ses_smoke" })
assert.ok(result?.includes("Switched to build agent"))
assert.deepEqual(transitions.map((item) => item.type), ["agent", "model", "synthetic"])

await cleanup?.()
})
