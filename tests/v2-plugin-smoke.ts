import plugin from "../plugin/v2"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

for (const key of ["VISUAL", "AGTERM_SESSION_ID", "TMUX", "ZELLIJ", "KITTY_LISTEN_ON", "WEZTERM_PANE"])
  delete process.env[key]
process.env.EDITOR = "/usr/bin/true"

const agents = {
  plan: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
  build: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
}
const commands = new Map<string, { execute(input: unknown): Promise<void> }>()
const tools = new Map<string, { execute?: (input: unknown, context: unknown) => Promise<{ content: string }> }>([
  ["plan_exit", {}],
  ["todowrite", {}],
])
const hooks = new Map<string, (event: any) => Promise<void> | void>()
const stored = new Map<string, any>()
const synthetic: Array<{ text: string; description?: string; resume?: boolean }> = []
const operations: string[] = []
let publishEvent: (event: {
  type: "session.model.selected"
  data: { sessionID: string; model: { providerID: string; id: string; variant?: string } }
}) => void = () => {
  throw new Error("event subscriber is not ready")
}
const nextEvent = new Promise<Parameters<typeof publishEvent>[0]>((resolve) => {
  publishEvent = resolve
})
let publishProgrammaticEvent: typeof publishEvent = () => {
  throw new Error("event subscriber is not ready")
}
const programmaticEvent = new Promise<Parameters<typeof publishEvent>[0]>((resolve) => {
  publishProgrammaticEvent = resolve
})
const session = {
  id: "ses_v2_smoke",
  agent: "plan",
  model: { providerID: "plan-provider", id: "plan-model" },
  location: { directory: "/workspace" },
  metadata: {
    planReviewModels: {
      build: { providerID: "legacy-provider", modelID: "legacy-model", source: "chat", at: 1 },
    },
  },
}
const registration = () => ({ dispose: async () => {} })

const context = {
  location: { directory: "/workspace" },
  agent: {
    transform: async (transform: (editor: any) => void) => {
      transform({
        update: (id: "plan" | "build", update: (agent: any) => void) => update(agents[id]),
      })
      return registration()
    },
    list: async () => ({ data: [] }),
  },
  tool: {
    transform: async (transform: (editor: any) => void) => {
      transform({
        add: (tool: { name: string }) => tools.set(tool.name, tool),
        update: (name: string, update: (tool: any) => void) => {
          const tool = tools.get(name)
          if (tool) update(tool)
        },
      })
      return registration()
    },
  },
  command: {
    transform: async (transform: (editor: any) => void) => {
      transform({ add: (command: { name: string }) => commands.set(command.name, command) })
      return registration()
    },
  },
  session: {
    hook: async (name: string, hook: (event: any) => Promise<void> | void) => {
      hooks.set(name, hook)
      return registration()
    },
    get: async () => session,
    context: async () => [],
    switchAgent: async (input: { agent: string }) => {
      operations.push("agent")
      session.agent = input.agent
    },
    switchModel: async (input: { model: { providerID: string; id: string } }) => {
      operations.push("model")
      session.model = input.model
      publishProgrammaticEvent({ type: "session.model.selected", data: { sessionID: session.id, model: input.model } })
    },
    synthetic: async (input: { text: string; description?: string; resume?: boolean }) => {
      operations.push("synthetic")
      synthetic.push(input)
      return input
    },
    prompt: async (input: unknown) => {
      operations.push("prompt")
      return input
    },
  },
  catalog: {
    provider: { list: async () => ({ data: [] }) },
    model: {
      list: async () => ({ data: [] }),
      default: async () => ({ data: null }),
    },
  },
  storage: {
    get: async (key: string) => stored.get(key),
    set: async (key: string, value: unknown) => void stored.set(key, value),
    remove: async (key: string) => void stored.delete(key),
  },
  event: {
    subscribe: ({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield await nextEvent
        yield await programmaticEvent
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      },
    }),
  },
}

const cleanup = await plugin.setup(context)

if (!agents.plan.permissions.some((rule) => rule.action === "plan_review" && rule.effect === "allow"))
  throw new Error("plan_review is not allowed for plan")
if (!agents.build.permissions.some((rule) => rule.action === "plan_review" && rule.effect === "deny"))
  throw new Error("plan_review is not denied for build")
if (!["plan-review", "plan-diag", "set-build-model"].every((name) => commands.has(name)))
  throw new Error("V2 commands were not registered")
if (!tools.get("plan_review")?.execute) throw new Error("plan_review tool was not registered")

await commands.get("plan-diag")!.execute({ sessionID: session.id, prompt: { text: "" } })
if (!synthetic.at(-1)?.text.includes("legacy-provider/legacy-model"))
  throw new Error("V1 session metadata was not available as a V2 migration fallback")

await hooks.get("prompt")!({ sessionID: session.id })
if (stored.get(`session.${session.id}.models`)?.plan?.modelID !== "plan-model")
  throw new Error("prompt admission did not capture the active plan model")

await commands.get("set-build-model")!.execute({
  sessionID: session.id,
  prompt: { text: "build-provider/build-model" },
})
const record = stored.get(`session.${session.id}.models`)
if (record?.build?.providerID !== "build-provider" || record.build.pinned !== true)
  throw new Error(`set-build-model was not persisted: ${JSON.stringify(record)}`)
if (!synthetic.some((message) => message.description === "Plan review" && message.resume === false))
  throw new Error("command acknowledgement is not a visible, admit-only synthetic message")

session.agent = "build"
publishEvent({
  type: "session.model.selected",
  data: { sessionID: session.id, model: { providerID: "build-event-provider", id: "build-event-model" } },
})
await Array.from({ length: 100 }).reduce(async (found) => {
  if (await found) return true
  await Bun.sleep(5)
  return stored.get(`session.${session.id}.models`)?.build?.modelID === "build-event-model"
}, Promise.resolve(false))
const selected = stored.get(`session.${session.id}.models`)?.build
if (selected?.providerID !== "build-event-provider" || selected.source !== "picker" || selected.pinned)
  throw new Error("explicit session.model.selected did not replace the pinned build model")

const contextEvent = {
  agent: "plan",
  system: [{ type: "text", text: "Call plan_exit when done." }],
  messages: [],
}
await hooks.get("context")!(contextEvent)
if (!contextEvent.system[0].text.includes("plan_review") || !contextEvent.system.at(-1)?.text.includes("CRITICAL"))
  throw new Error("plan context was not rewritten")

operations.length = 0
const result = await tools.get("plan_review")!.execute!(
  { plan: "# Plan\n\nNo changes." },
  { sessionID: session.id },
)
if (operations.join(",") !== "agent,model,synthetic")
  throw new Error(`approval switched in the wrong order: ${operations.join(",")}`)
if (!result.content.includes("Switched to build agent")) throw new Error(`approval failed: ${result.content}`)
await Bun.sleep(20)
if (stored.get(`session.${session.id}.models`)?.build?.source !== "picker")
  throw new Error("the plugin's own model switch was incorrectly recorded as a user selection")

const directory = mkdtempSync(join(tmpdir(), "opencode-plan-review-v2-test-"))
const file = join(directory, "plan.md")
writeFileSync(file, "# Approved plan\n", "utf8")
operations.length = 0
try {
  await commands.get("plan-review")!.execute({ sessionID: session.id, prompt: { text: file } })
  if (operations.join(",") !== "agent,model,synthetic")
    throw new Error(`approved command scheduled an extra provider run: ${operations.join(",")}`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

await cleanup?.()
console.log("V2 plugin smoke: ok")
