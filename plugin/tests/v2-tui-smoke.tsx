/** @jsxImportSource @opentui/solid */
import "@opentui/solid/preload"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import plugin from "../tui-v2"

const color = RGBA.fromInts(200, 200, 200)
let render: ((input: { sessionID: string }) => unknown) | undefined
const cleanup = plugin.setup({
  location: { directory: "/workspace" },
  theme: {
    text: {
      default: color,
      subdued: color,
      action: { primary: { default: color } },
    },
  },
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
    slot: (claim) => {
      render = claim.render
      return () => {}
    },
  },
})

if (plugin.id !== "plan-review.tui" || !render) throw new Error("TUI plugin did not register its sidebar slot")
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
