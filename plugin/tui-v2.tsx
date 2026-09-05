/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import type { ModelRef } from "./model-store"

type Context = {
  location?: { directory?: string; workspaceID?: string }
  theme: {
    text: {
      default: RGBA
      subdued: RGBA
      action: { primary: { default: RGBA } }
    }
  }
  data: {
    session: {
      get(sessionID: string): { agent?: string; model?: { providerID: string; id: string; variant?: string } } | undefined
      message: { list(sessionID: string): Array<Record<string, any>> }
    }
    location: {
      model: {
        list(location?: Context["location"]): Array<{ providerID: string; id: string; name?: string }> | undefined
      }
    }
  }
  ui: {
    slot(claim: {
      append: "sidebar.content"
      render(input: { sessionID: string }): unknown
    }): () => void
  }
}

function modelsForSession(context: Context, sessionID: string) {
  const models: Partial<Record<"plan" | "build", ModelRef>> = {}
  let active: string | undefined

  for (const message of context.data.session.message.list(sessionID)) {
    if (message.type === "agent-switched") active = message.agent
    if (message.type === "model-switched" && (active === "plan" || active === "build")) {
      models[active] = {
        providerID: message.model.providerID,
        modelID: message.model.id,
        ...(message.model.variant ? { variant: message.model.variant } : {}),
      }
    }
    const agent: "plan" | "build" | undefined =
      message.agent === "plan" || message.agent === "build" ? message.agent : undefined
    if (message.type === "assistant" && agent) {
      models[agent] = {
        providerID: message.model.providerID,
        modelID: message.model.id,
        ...(message.model.variant ? { variant: message.model.variant } : {}),
      }
    }
  }

  const session = context.data.session.get(sessionID)
  if ((session?.agent === "plan" || session?.agent === "build") && session.model) {
    models[session.agent] = {
      providerID: session.model.providerID,
      modelID: session.model.id,
      ...(session.model.variant ? { variant: session.model.variant } : {}),
    }
  }
  return { active: session?.agent, models }
}

function modelLabel(context: Context, model: ModelRef | undefined) {
  if (!model) return "-"
  const info = context.data.location.model
    .list(context.location)
    ?.find((item) => item.providerID === model.providerID && item.id === model.modelID)
  return `${info?.name ?? model.modelID} · ${model.providerID}${model.variant ? ` · ${model.variant}` : ""}`
}

export default {
  id: "plan-review.tui",
  setup(context: Context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const state = modelsForSession(context, sessionID)
        return (
          <box>
            <text fg={context.theme.text.default}>
              <b>Agent models</b>
            </text>
            {(["plan", "build"] as const).map((agent) => {
              const selected = state.active === agent
              return (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={selected ? context.theme.text.action.primary.default : context.theme.text.subdued}>
                    •
                  </text>
                  <text fg={selected ? context.theme.text.action.primary.default : context.theme.text.default} wrapMode="word">
                    <b>{agent.charAt(0).toUpperCase() + agent.slice(1)}</b>{" "}
                    <span style={{ fg: context.theme.text.subdued }}>{modelLabel(context, state.models[agent])}</span>
                  </text>
                </box>
              )
            })}
          </box>
        )
      },
    })
  },
}
