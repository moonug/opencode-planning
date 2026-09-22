/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import { testRender } from "@opentui/solid"
import plugin from "../tui-v2"

// Real host shape: context = { options, location, client, data, keymap, ui },
// and ui.slot(name, render) (packages/plugin/src/v2/tui/context.ts:183).
let slotName: string | undefined
let render: ((input: { sessionID: string }) => unknown) | undefined
const cleanup = plugin.setup({
  options: {},
  location: { directory: "/workspace" },
  client: {},
  keymap: {},
  data: {
    session: {
      get: () => ({ agent: "plan", model: { providerID: "ya-glm", id: "glm" } }),
      message: {
        list: () => [
          {
            type: "assistant",
            agent: "build",
            model: { providerID: "openai", id: "gpt-5" },
          },
        ],
      },
    },
    location: {
      model: {
        list: () => [
          { providerID: "ya-glm", id: "glm", name: "GLM" },
          { providerID: "openai", id: "gpt-5", name: "GPT-5" },
        ],
      },
    },
  },
  ui: {
    slot: (name: string, view: (input: { sessionID: string }) => unknown) => {
      slotName = name
      render = view
      return () => {}
    },
  },
} as never)

if (plugin.id !== "plan-review.tui" || !render) throw new Error("TUI plugin did not register its sidebar slot")
if (slotName !== "sidebar.content") throw new Error(`TUI plugin registered slot ${slotName}, expected sidebar.content`)
const app = await testRender(() => render!({ sessionID: "ses_test" }), { width: 50, height: 8 })
try {
  await app.renderOnce()
  const frame = app.captureCharFrame()
  if (!["Agent models", "Plan GLM · ya-glm", "Build GPT-5 · openai"].every((text) => frame.includes(text)))
    throw new Error(`TUI model summary did not render expected state:\n${frame}`)
} finally {
  cleanup?.()
  app.renderer.destroy()
}

console.log("V2 TUI smoke: ok")
