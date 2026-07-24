/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

const VERSION = require("./package.json").version
const BUILD_TAG = `v${VERSION}`

type SelectionModel = {
  providerID: string
  modelID: string
  variant?: string
}

type Selection = {
  sessionID?: string
  agent?: string
  models: Readonly<Record<string, SelectionModel>>
}

type ModelSelectedEvent = {
  type: "tui.model.selected"
  data: { sessionID?: string; agent: string; model: SelectionModel }
}

type NativeSelectionApi = {
  state: { selection?: () => Selection; modelSelectionEvents?: true }
  event: {
    on: (type: "tui.model.selected", handler: (event: ModelSelectedEvent) => void) => () => void
  }
}

const logInfo = (api: TuiPluginApi, message: string): void => {
  void api.client.app.log({ service: "plan-review-tui", level: "info", message }).catch((error: unknown) => {
    console.error(`plan-review-TUI: ${message} (log failed: ${(error as Error)?.message ?? String(error)})`)
  })
}

const modelLabel = (model: SelectionModel | undefined, provider: TuiPluginApi["state"]["provider"]): string => {
  if (!model) return "-"
  const p = provider.find((item) => item.id === model.providerID)
  const name = p?.models[model.modelID]?.name ?? model.modelID
  const extra = model.variant ? ` · ${model.variant}` : ""
  return `${name} · ${model.providerID}${extra}`
}

const tui: TuiPlugin = async (api) => {
  logInfo(api, `plan-review-TUI: plugin loaded v${VERSION} build=${BUILD_TAG}`)

  const native = api as TuiPluginApi & NativeSelectionApi
  const readSelection = native.state?.selection

  if (typeof readSelection === "function" && native.state.modelSelectionEvents === true) {
    const renderModels = () => {
      const current = readSelection.call(native.state)
      const theme = api.theme.current
      const active = current.agent
      const rows: Array<{ agent: string; model: SelectionModel | undefined }> = [
        { agent: "plan", model: current.models.plan },
        { agent: "build", model: current.models.build },
      ]
      return (
        <box>
          <text fg={theme.text}>
            <b>Agent models</b>
          </text>
          {rows.map((row) => {
            const isActive = active === row.agent
            const dotFg = isActive ? theme.primary : theme.textMuted
            const labelFg = isActive ? theme.primary : theme.text
            return (
              <box flexDirection="row" gap={1}>
                <text flexShrink={0} fg={dotFg}>•</text>
                <text fg={labelFg} wrapMode="word">
                  <b>{row.agent.charAt(0).toUpperCase() + row.agent.slice(1)}</b>{" "}
                  <span style={{ fg: theme.textMuted }}>{modelLabel(row.model, api.state.provider)}</span>
                </text>
              </box>
            )
          })}
        </box>
      )
    }

    api.slots.register({
      order: 50,
      slots: {
        sidebar_content: renderModels,
      },
    })
  } else {
    logInfo(api, "plan-review-TUI: native selection API unavailable; relying on chat.message fallback")
    return
  }

  let writeChain = Promise.resolve()
  let disposed = false

  const recordModel = ({ sessionID, agent, model }: ModelSelectedEvent["data"]): void => {
    if (!sessionID?.startsWith("ses_")) return
    if ((agent !== "plan" && agent !== "build") || !model?.providerID || !model.modelID) return

    const capturedAt = Date.now()

    writeChain = writeChain.then(async () => {
      if (disposed) return
      const response = await api.client.session.get({ sessionID })
      if (disposed) return
      const metadata = response.data?.metadata ?? {}
      const previous = metadata.planReviewDeferredPicks
      const merged: Record<string, unknown> = previous && typeof previous === "object"
        ? { ...(previous as Record<string, unknown>) }
        : {}

      merged[agent] = {
        providerID: model.providerID,
        modelID: model.modelID,
        pickedAt: capturedAt,
      }
      merged._writtenAt = new Date(capturedAt).toISOString()

      await api.client.session.update({
        sessionID,
        metadata: { ...metadata, planReviewDeferredPicks: merged },
      })
      logInfo(api, `plan-review-TUI: native model saved session=${sessionID} agent=${agent}`)
    }).catch((error: unknown) => {
      logInfo(api, `plan-review-TUI: native model metadata write failed session=${sessionID}: ${(error as Error)?.message ?? String(error)}`)
    })
  }

  const unsubscribe = native.event.on("tui.model.selected", (event) => recordModel(event.data))
  api.lifecycle.onDispose(() => {
    disposed = true
    unsubscribe()
  })
  logInfo(api, `plan-review-TUI: ready native-model-events build=${BUILD_TAG}`)
}

export default { id: "plan-review-tui", tui }
