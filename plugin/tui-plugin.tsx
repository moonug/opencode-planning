/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import {
  mergeHomeFlush,
  writePicker,
  v2SdkAdapter,
  type ModelRef,
  type Agent,
  type SdkAdapter,
} from "./model-store"

const VERSION = require("./package.json").version
const BUILD_TAG = `v${VERSION}`

type SelectionModel = ModelRef

type Selection = {
  sessionID?: string
  agent?: string
  models: Readonly<Record<string, SelectionModel>>
}

type NativeSelectionApi = {
  state: { selection?: () => Selection; modelSelectionEvents?: true }
}

type ModelSelectedEventData = {
  sessionID?: string
  agent: string
  model: SelectionModel
}

const logInfo = (api: TuiPluginApi, message: string): void => {
  void api.client.app.log({ service: "plan-review-tui", level: "info", message }).catch((error: unknown) => {
    console.error(`plan-review-TUI: ${message} (log failed: ${(error as Error)?.message ?? String(error)})`)
  })
}

const modelLabel = (model: SelectionModel | undefined, provider: TuiPluginApi["state"]["provider"]): string => {
  if (! model) return "-"
  const p = provider.find((item) => item.id === model.providerID)
  const name = p?.models[model.modelID]?.name ?? model.modelID
  const extra = model.variant ? ` · ${model.variant}` : ""
  return `${name} · ${model.providerID}${extra}`
}

const tui: TuiPlugin = async (api) => {
  logInfo(api, `plan-review-TUI: plugin loaded v${VERSION} build=${BUILD_TAG}`)

  const native = api as TuiPluginApi & NativeSelectionApi
  const readSelection = native.state?.selection

  if (typeof readSelection !== "function" || native.state.modelSelectionEvents !== true) {
    logInfo(api, "plan-review-TUI: native selection API unavailable; relying on chat.message fallback")
    return
  }

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
        <text fg={theme.textMuted}>plan-review v{VERSION}</text>
      </box>
    )
  }

  api.slots.register({
    order: 50,
    slots: {
      sidebar_content: renderModels,
    },
  })

  let writeChain = Promise.resolve()
  let disposed = false

  // The TUI host hands us a v2 SDK client. Build the matching adapter.
  const sdk: SdkAdapter = v2SdkAdapter(api.client)

  // Draft-scope picks made before a session exists. Only EXPLICIT picker
  // choices (tui.model.selected) land here. The flush merges them into a
  // session record ONLY when the session is brand new (merge-if-absent
  // ensures we never overwrite an existing session's own picks).
  const pendingHomePicks: Partial<Record<Agent, ModelRef>> = {}

  // Sessions created while this TUI is running. Home-scope draft picks
  // are only flushed into a session we observed being created; writing
  // them into an existing session would silently override the models
  // already chosen there.
  const createdSessionIDs = new Set<string>()

  const flushHomePicks = (sessionID: string): void => {
    let liveModels: Partial<Record<Agent, ModelRef>> = {}
    try {
      const live = readSelection.call(native.state)
      liveModels = (live?.models ?? {}) as Partial<Record<Agent, ModelRef>>
    } catch (error: unknown) {
      logInfo(api, `plan-review-TUI: live selection read failed: ${(error as Error)?.message ?? String(error)}`)
    }

    const agents: Agent[] = ["plan", "build"]
    const toFlush: Partial<Record<Agent, ModelRef>> = {}
    for (const agent of agents) {
      const pick = pendingHomePicks[agent] ?? liveModels[agent]
      if (pick?.providerID && pick.modelID) toFlush[agent] = pick
    }
    if (Object.keys(toFlush).length === 0) return
    logInfo(api, `plan-review-TUI: queuing home flush session=${sessionID} agents=${Object.keys(toFlush).join(",")}`)

    writeChain = writeChain
      .then(async () => {
        if (disposed) return
        const response = await api.client.session.get({ sessionID })
        if (disposed) return
        const data = response.data as { time?: { created?: number } } | undefined
        const created = data?.time?.created
        const isNew = createdSessionIDs.has(sessionID) || (typeof created === "number" && Date.now() - created < 60_000)
        if (!isNew) {
          // Existing session: its own picks are authoritative. Drop the
          // draft without writing.
          for (const agent of agents) delete pendingHomePicks[agent]
          logInfo(api, `plan-review-TUI: dropped home draft for existing session=${sessionID}`)
          return
        }
        const written = await mergeHomeFlush(sdk, sessionID, toFlush, () => disposed)
        if (disposed) return
        // Drop only the picks that actually landed; a record-absent agent
        // is fine to retry on the next transition.
        for (const agent of written) delete pendingHomePicks[agent]
        if (written.length > 0) {
          logInfo(api, `plan-review-TUI: flushed home picks session=${sessionID} agents=${written.join(",")}`)
        }
      })
      .catch((error: unknown) => {
        logInfo(api, `plan-review-TUI: flush home picks failed session=${sessionID}: ${(error as Error)?.message ?? String(error)}`)
      })
  }

  const recordModel = ({ sessionID, agent, model }: ModelSelectedEventData): void => {
    if ((agent !== "plan" && agent !== "build") || !model?.providerID || !model.modelID) return

    if (!sessionID?.startsWith("ses_")) {
      pendingHomePicks[agent as Agent] = { providerID: model.providerID, modelID: model.modelID, ...(model.variant ? { variant: model.variant } : {}) }
      return
    }

    writeChain = writeChain
      .then(async () => {
        if (disposed) return
        await writePicker(
          sdk,
          sessionID,
          agent as Agent,
          {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(model.variant ? { variant: model.variant } : {}),
          },
          () => disposed,
        )
        if (disposed) return
        logInfo(api, `plan-review-TUI: native model saved session=${sessionID} agent=${agent}`)
      })
      .catch((error: unknown) => {
        logInfo(api, `plan-review-TUI: native model metadata write failed session=${sessionID}: ${(error as Error)?.message ?? String(error)}`)
      })
  }

  const unsubscribeModel = (api.event as any)["on"]("tui.model.selected", (event: any) => recordModel(event.data))
  const unsubscribeCreated = (api.event as any)["on"]("session.created", (event: any) => {
    const sid = event?.properties?.sessionID ?? event?.data?.sessionID ?? event?.sessionID
    if (typeof sid === "string" && sid.startsWith("ses_")) createdSessionIDs.add(sid)
  })
  let previousSessionID: string | undefined
  const unsubscribeSelection = (api.event as any)["on"]("tui.selection.changed", (event: any) => {
    const current = event.data.current
    const sid = current.sessionID
    const prevSid = previousSessionID
    previousSessionID = sid

    if (sid?.startsWith("ses_")) {
      if (prevSid !== sid) flushHomePicks(sid)
      return
    }
    // Home/draft scope: snapshot data is display-only, no metadata writes.
  })
  api.lifecycle.onDispose(() => {
    disposed = true
    unsubscribeModel()
    unsubscribeCreated()
    unsubscribeSelection()
  })
  logInfo(api, `plan-review-TUI: ready native-model-events build=${BUILD_TAG}`)
}

export default { id: "plan-review-tui", tui }