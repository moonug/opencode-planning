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

  const pendingHomePicks: Record<string, { providerID: string; modelID: string; pickedAt: number }> = {}
  let pendingInitialSelection: { plan?: { providerID: string; modelID: string }; build?: { providerID: string; modelID: string }; capturedAt: number } | null = null

  const flushHomePicks = (sessionID: string): void => {
    const agents = Object.keys(pendingHomePicks)
    if (agents.length === 0) return

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

      for (const agent of agents) {
        const pick = pendingHomePicks[agent]!
        merged[agent] = { providerID: pick.providerID, modelID: pick.modelID, pickedAt: pick.pickedAt }
        delete pendingHomePicks[agent]
      }
      merged._writtenAt = new Date(capturedAt).toISOString()

      await api.client.session.update({
        sessionID,
        metadata: { ...metadata, planReviewDeferredPicks: merged },
      })
      logInfo(api, `plan-review-TUI: flushed home picks to session=${sessionID} agents=${agents.join(",")}`)
    }).catch((error: unknown) => {
      logInfo(api, `plan-review-TUI: flush home picks failed session=${sessionID}: ${(error as Error)?.message ?? String(error)}`)
    })
  }

  const flushInitialSelection = (sessionID: string): void => {
    if (!pendingInitialSelection) return
    const sel = pendingInitialSelection
    pendingInitialSelection = null

    const capturedAt = Date.now()
    writeChain = writeChain.then(async () => {
      if (disposed) return
      const response = await api.client.session.get({ sessionID })
      if (disposed) return
      const metadata = response.data?.metadata ?? {}

      const snapshot: Record<string, unknown> = {}
      if (sel.plan) snapshot.plan = { providerID: sel.plan.providerID, modelID: sel.plan.modelID, pickedAt: capturedAt }
      if (sel.build) snapshot.build = { providerID: sel.build.providerID, modelID: sel.build.modelID, pickedAt: capturedAt }
      snapshot.capturedAt = new Date(capturedAt).toISOString()

      await api.client.session.update({
        sessionID,
        metadata: { ...metadata, tuiCurrentSelection: snapshot },
      })
      logInfo(api, `plan-review-TUI: flushed initial selection to session=${sessionID}`)
    }).catch((error: unknown) => {
      logInfo(api, `plan-review-TUI: flush initial selection failed session=${sessionID}: ${(error as Error)?.message ?? String(error)}`)
    })
  }

  const snapshotCurrentSelection = (sessionID: string, current: Selection): void => {
    const planModel = current.models.plan
    const buildModel = current.models.build
    if (!planModel && !buildModel) return

    const capturedAt = Date.now()
    writeChain = writeChain.then(async () => {
      if (disposed) return
      const response = await api.client.session.get({ sessionID })
      if (disposed) return
      const metadata = response.data?.metadata ?? {}
      const previous = (metadata.tuiCurrentSelection as Record<string, unknown> | undefined) ?? {}

      const snapshot: Record<string, unknown> = { ...previous }
      if (planModel) snapshot.plan = { providerID: planModel.providerID, modelID: planModel.modelID, pickedAt: capturedAt }
      if (buildModel) snapshot.build = { providerID: buildModel.providerID, modelID: buildModel.modelID, pickedAt: capturedAt }
      snapshot.capturedAt = new Date(capturedAt).toISOString()

      await api.client.session.update({
        sessionID,
        metadata: { ...metadata, tuiCurrentSelection: snapshot },
      })
      logInfo(api, `plan-review-TUI: snapshot current selection session=${sessionID} plan=${planModel?.modelID ?? "-"} build=${buildModel?.modelID ?? "-"}`)
    }).catch((error: unknown) => {
      logInfo(api, `plan-review-TUI: snapshot current selection failed session=${sessionID}: ${(error as Error)?.message ?? String(error)}`)
    })
  }

  const recordModel = ({ sessionID, agent, model }: ModelSelectedEventData): void => {
    if ((agent !== "plan" && agent !== "build") || !model?.providerID || !model.modelID) return

    if (!sessionID?.startsWith("ses_")) {
      pendingHomePicks[agent] = { providerID: model.providerID, modelID: model.modelID, pickedAt: Date.now() }
      return
    }

    flushHomePicks(sessionID)

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

  const readAndCaptureInitial = (): void => {
    if (typeof readSelection !== "function") return
    const current = readSelection.call(native.state)
    const sid = current.sessionID
    const capturedAt = Date.now()

    if (sid?.startsWith("ses_")) {
      const planModel = current.models.plan
      const buildModel = current.models.build
      if (!planModel && !buildModel) return
      writeChain = writeChain.then(async () => {
        if (disposed) return
        const response = await api.client.session.get({ sessionID: sid })
        if (disposed) return
        const metadata = response.data?.metadata ?? {}
        const snapshot: Record<string, unknown> = {}
        if (planModel) snapshot.plan = { providerID: planModel.providerID, modelID: planModel.modelID, pickedAt: capturedAt }
        if (buildModel) snapshot.build = { providerID: buildModel.providerID, modelID: buildModel.modelID, pickedAt: capturedAt }
        snapshot.capturedAt = new Date(capturedAt).toISOString()
        await api.client.session.update({ sessionID: sid, metadata: { ...metadata, tuiCurrentSelection: snapshot } })
        logInfo(api, `plan-review-TUI: startup snapshot session=${sid} plan=${planModel?.modelID ?? "-"} build=${buildModel?.modelID ?? "-"}`)
      }).catch((error: unknown) => {
        logInfo(api, `plan-review-TUI: startup snapshot failed session=${sid}: ${(error as Error)?.message ?? String(error)}`)
      })
    } else {
      const planModel = current.models.plan
      const buildModel = current.models.build
      if (!planModel && !buildModel) return
      pendingInitialSelection = {
        plan: planModel ? { providerID: planModel.providerID, modelID: planModel.modelID } : undefined,
        build: buildModel ? { providerID: buildModel.providerID, modelID: buildModel.modelID } : undefined,
        capturedAt,
      }
      logInfo(api, `plan-review-TUI: pending initial selection plan=${planModel?.modelID ?? "-"} build=${buildModel?.modelID ?? "-"}`)
    }
  }

  readAndCaptureInitial()

  const unsubscribeModel = (api.event as any)["on"]("tui.model.selected", (event: any) => recordModel(event.data))
  let previousSessionID: string | undefined
  const unsubscribeSelection = (api.event as any)["on"]("tui.selection.changed", (event: any) => {
    const current = event.data.current
    const sid = current.sessionID
    const prevSid = previousSessionID

    if (sid?.startsWith("ses_") && prevSid !== sid) {
      flushHomePicks(sid)
      if (!prevSid?.startsWith("ses_") && pendingInitialSelection) {
        flushInitialSelection(sid)
      } else if (sid !== prevSid) {
        snapshotCurrentSelection(sid, current)
      }
    } else if (sid?.startsWith("ses_") && sid === prevSid) {
      const planModel = current.models.plan
      const buildModel = current.models.build
      if (planModel || buildModel) {
        snapshotCurrentSelection(sid, current)
      }
    }
    previousSessionID = sid
  })
  api.lifecycle.onDispose(() => {
    disposed = true
    unsubscribeModel()
    unsubscribeSelection()
  })
  logInfo(api, `plan-review-TUI: ready native-model-events build=${BUILD_TAG}`)
}

export default { id: "plan-review-tui", tui }
