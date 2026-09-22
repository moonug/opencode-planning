/** @jsxImportSource @opentui/solid */
/**
 * opencode2 TUI sidebar: per-agent (plan/build) model picks for the session.
 *
 * Real host API: `Plugin.define({ id, setup })` from `@opencode-ai/plugin/v2/tui`,
 * `context.ui.slot(name, render)` (packages/plugin/src/v2/tui/context.ts:183).
 * The plugin context exposes no theme, so this view uses no colors — the active
 * agent is marked with a glyph instead.
 *
 * The TUI loads this through the plugin DIRECTORY entry in the v2 config: for a
 * directory target it resolves `<dir>/tui` (tui/src/plugin/context.tsx:348), which
 * is why `plugin/tui.tsx` re-exports this module.
 */
import { Plugin } from "@opencode-ai/plugin/v2/tui"
import { createMemo, For } from "solid-js"

type ModelRef = { readonly providerID: string; readonly id: string; readonly variant?: string }

const AGENTS = ["plan", "build"] as const

function isKnownAgent(value: unknown): value is (typeof AGENTS)[number] {
  return value === "plan" || value === "build"
}

function modelsForSession(context: Plugin.Context, sessionID: string) {
  const models: Partial<Record<(typeof AGENTS)[number], ModelRef>> = {}
  let active: string | undefined

  for (const message of context.data.session.message.list(sessionID)) {
    if (message.type === "agent-switched") active = message.agent
    if (message.type === "model-switched" && isKnownAgent(active)) models[active] = message.model
    if (message.type === "assistant" && isKnownAgent(message.agent)) models[message.agent] = message.model
  }

  const session = context.data.session.get(sessionID)
  if (isKnownAgent(session?.agent) && session.model) models[session.agent] = session.model
  return { active: session?.agent, models }
}

function modelLabel(context: Plugin.Context, model: ModelRef | undefined) {
  if (!model) return "-"
  const info = context.data.location.model
    .list(context.location)
    ?.find((item) => item.providerID === model.providerID && item.id === model.id)
  return `${info?.name ?? model.id} · ${model.providerID}${model.variant ? ` · ${model.variant}` : ""}`
}

function View(props: { context: Plugin.Context; sessionID: string }) {
  const state = createMemo(() => modelsForSession(props.context, props.sessionID))
  return (
    <box>
      <text>
        <b>Agent models</b>
      </text>
      <For each={AGENTS}>
        {(agent) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0}>{state().active === agent ? "▸" : "•"}</text>
            <text wrapMode="word">
              <b>{agent.charAt(0).toUpperCase() + agent.slice(1)}</b> {modelLabel(props.context, state().models[agent])}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

export default Plugin.define({
  id: "plan-review.tui",
  setup(context) {
    return context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})
