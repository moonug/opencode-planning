import type {
  TuiEventBus,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"
import type { Event } from "@opencode-ai/sdk/v2"

// solid-js is available inside opencode's TUI process but not in our
// project's node_modules. Try require() first (fast, sync), then fall
// back to dynamic import() (async, resolves bundled modules in Bun).
// If both fail, model.json fallback is used.
let solidGetOwner: (() => any) | undefined
try { solidGetOwner = require("solid-js").getOwner } catch { /* not available in smoke tests */ }

// Build-time markers. Bump BUILD_TAG when this file changes in a way that
// must be observable across runs — Bun caches plugin module imports so the
// only reliable way to confirm the new code is loaded is to log the marker
// at startup and compare.
const VERSION = "0.2.0"
const BUILD_TAG = "v0.2.0"

const logInfo = (api: TuiPluginApi, message: string): void => {
  void api.client.app
    .log({ service: "plan-review-tui", level: "info", message })
    .catch((e: unknown) =>
      api.client.app.log({
        service: "plan-review-tui",
        level: "warn",
        message: `plan-review-TUI: log failed: ${(e as Error)?.message ?? String(e)}`,
      }),
    )
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  logInfo(api, `plan-review-TUI: plugin loaded v${VERSION} build=${BUILD_TAG}`)
  // Smoke-friendly meta fingerprint line — useful when reading logs across
  // multiple opencode processes; the spec carries the absolute path so we
  // know which copy of tui-plugin.ts was activated.
  try {
    const processArg = (process.argv[1] ?? "unknown") as string
    logInfo(api, `plan-review-TUI: argv0=${processArg.split("/").slice(-3).join("/")}`)
  } catch {}

  const getActiveSessionID = (): string | undefined => {
    const current = api.route.current
    if (current && current.name === "session") {
      const sid = (current as { params?: { sessionID?: string } }).params?.sessionID
      if (typeof sid === "string" && sid.startsWith("ses_")) return sid
    }
    return undefined
  }

  const getLastUserAgent = (sessionID: string): string | undefined => {
    const msgs = api.state.session.messages(sessionID)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m) continue
      if (m.role === "user") {
        const agent = (m as { agent?: string }).agent
        if (typeof agent === "string" && agent) return agent
      }
    }
    return undefined
  }

  // Read all primary agents (filter mirrors packages/tui/src/context/local.tsx:78).
  // Loaded before prevAgent init so the fallback below has something to
  // default to when there are no prior user messages in this session.
  let primaryAgents: string[] = []
  try {
    const res = await api.client.app.agents()
    const data = (res as { data?: unknown[] }).data ?? []
    primaryAgents = (Array.isArray(data) ? data : [])
      .filter((a: any) => a && typeof a.name === "string" && a.mode !== "subagent" && a.hidden !== true)
      .map((a: any) => a.name as string)
    logInfo(api, `plan-review-TUI: agents=${primaryAgents.join(",") || "<none>"}`)
  } catch (e) {
    void api.client.app
      .log({
        service: "plan-review-tui",
        level: "warn",
        message: `plan-review-TUI: app.agents() failed: ${(e as Error)?.message ?? String(e)}`,
      })
      .catch(() => {})
  }

  let prevAgent: string | undefined
  let sessionID: string | undefined = getActiveSessionID()
  if (sessionID) prevAgent = getLastUserAgent(sessionID)
  // Default prevAgent to the first primary agent when there is no last
  // user message (fresh session / home route). Mirrors
  // packages/tui/src/context/local.tsx:97 where local.agent.current()
  // falls back to agents().at(0). Without this default the watcher
  // silently bails on its first tick when the user opens a brand-new
  // session and the picker changes before they type anything.
  if (!prevAgent && primaryAgents[0]) prevAgent = primaryAgents[0] as string

  // Deferred picker state — when the user picks a model on the home
  // screen there is no sessionID to forward to. We stash the choice
  // here keyed by agent so the user can pick one model per agent
  // (build → mimo-v2.5, plan → deepseek-v4-flash) before any session
  // exists. refresh() flushes every entry via promptAsync the first
  // time session.updated fires with a real sessionID.
  //
  // Single-variable version lost picks: if you tabbed build → pick
  // mimo, tab plan → pick deepseek, the second write overwrote the
  // first and only the last agent's pick got attributed. Map keys by
  // the agent that was active when the pick was made.
  const lastPickedModels = new Map<string, { providerID: string; modelID: string }>()

  // lastSeenModel tracks the model.json recent[0] value at the last Tab.
  // Change detection: only record for prevAgent if the model actually
  // changed since the last Tab (prevents stale overwrites when the user
  // Tabs without changing the model).
  let lastSeenModel = ""
  let getOwnerAvailable: boolean | null = null

  // Load fs once at init — used for model.json reads on Tab
  let fsModule: typeof import("node:fs") | undefined
  const getFs = (): typeof import("node:fs") | undefined => {
    if (!fsModule) {
      try { fsModule = require("node:fs") } catch { /* not available */ }
    }
    return fsModule
  }

  // Initialize lastSeenModel from model.json at startup
  try {
    const stateDir = api.state?.path?.state
    if (stateDir && typeof stateDir === "string") {
      const fs = getFs()
      if (fs) {
        const raw = fs.readFileSync(`${stateDir}/model.json`, "utf8")
        const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: string; modelID?: string }> }
        const first = Array.isArray(parsed.recent) ? parsed.recent[0] : undefined
        if (first?.providerID && first?.modelID) {
          lastSeenModel = `${first.providerID}/${first.modelID}`
        }
      }
    }
  } catch {
    // model.json may not exist on a fresh install — fine.
  }

  // Record startup model for prevAgent (default: build).
  // This is the model the user sees on screen when opencode opens.
  // Without this, plan-mode sessions have no build model and fall
  // through to plan's model. No watcher — one-time read, no
  // continuous contamination.
  if (prevAgent && lastSeenModel) {
    const slashIdx = lastSeenModel.indexOf("/")
    if (slashIdx > 0) {
      const providerID = lastSeenModel.slice(0, slashIdx)
      const modelID = lastSeenModel.slice(slashIdx + 1)
      lastPickedModels.set(prevAgent, { providerID, modelID })
      logInfo(api, `plan-review-TUI: startup model snapshot agent=${prevAgent} model=${lastSeenModel}`)
    }
  }

  // readLocalModel tries to access the TUI's internal modelStore via
  // Solid's reactive Owner chain. getOwner() returns the current
  // reactive scope; walking up the owner chain finds ancestor contexts
  // including LocalProvider which holds modelStore.model[agentName].
  // Returns { model, agentName } or undefined if not inside a reactive
  // scope (keymap handler may run outside Solid's tree).
  const readLocalModel = (): { providerID: string; modelID: string; agentName: string } | undefined => {
    if (!solidGetOwner) return undefined
    const owner = solidGetOwner()
    if (getOwnerAvailable === null) {
      getOwnerAvailable = owner !== null
      logInfo(api, `plan-review-TUI: getOwner available=${getOwnerAvailable}`)
    }
    if (!owner) return undefined
    let o: any = owner
    let depth = 0
    while (o && depth < 30) {
      const ctx = o.context
      if (ctx instanceof Map && ctx.size > 0) {
        for (const val of ctx.values()) {
          if (val && typeof val === "object" && typeof (val as any).model?.current === "function") {
            const model = (val as any).model.current()
            const agent = (val as any).agent?.current?.()
            if (model?.providerID && model?.modelID && typeof agent?.name === "string") {
              return { providerID: model.providerID, modelID: model.modelID, agentName: agent.name }
            }
          }
        }
      }
      o = o.owner
      depth++
    }
    return undefined
  }

  logInfo(
    api,
    `plan-review-TUI: ready sessionID=${sessionID ?? "none"} prevAgent=${prevAgent ?? "?"} build=${BUILD_TAG} lastSeenModel=${lastSeenModel || "<none>"}`,
  )

  const computeNext = (current: string | undefined, direction: 1 | -1): string | undefined => {
    if (primaryAgents.length === 0) return undefined
    const idx = current ? primaryAgents.indexOf(current) : -1
    if (idx === -1) return direction === 1 ? primaryAgents[0] : primaryAgents[primaryAgents.length - 1]
    const next = (idx + direction + primaryAgents.length) % primaryAgents.length
    return primaryAgents[next]
  }

  // writeDeferredToMetadata stores the pending picks directly on the
  // session row via session.update({metadata:{planReviewDeferredPicks}}).
  // The server-plugin's chat.message hook promotion reads this
  // metadata, but the actual promotion now lives in exitPlanMode
  // (commit 967170b) — chat.message races the TUI flush, exitPlanMode
  // runs seconds-to-minutes later and wins.
  //
  // No synthetic "." user messages anywhere in this plugin. Tab
  // cycling and picker changes stay local-only; the user prompt
  // is the only message the server ever sees for these flows.
  //
  // MERGE behaviour: reads existing planReviewDeferredPicks from
  // session.metadata before writing, then merges the new picks on top.
  // Without this, each call replaces the entire metadata object and
  // picks from a previous watcher tick (for a different agent) are
  // silently dropped — model.json is global and the watcher fires
  // for every Ctrl-X M pick, but each tick only carries the single
  // agent that was active at that moment.
  const writeDeferredToMetadata = async (
    sid: string,
    picks: Record<string, { providerID: string; modelID: string }>,
  ): Promise<void> => {
    try {
      // Read existing picks first so we don't drop entries from
      // other agents that were recorded by a previous watcher tick.
      let existing: Record<string, unknown> = {}
      try {
        const sessionRes = await api.client.session.get({ sessionID: sid })
        const data = (sessionRes as { data?: { metadata?: Record<string, unknown> } }).data
        const old = data?.metadata?.planReviewDeferredPicks
        if (old && typeof old === "object") {
          existing = old as Record<string, unknown>
        }
      } catch {
        // session.get can fail (new session, race) — start fresh.
      }
      const merged = { ...existing, ...picks }
      // Strip metadata-internal keys from existing so re-pick for
      // the same agent overwrites rather than stacking.
      for (const key of Object.keys(merged)) {
        if (key.startsWith("_") && key !== "_writtenAt") {
          delete merged[key]
        }
      }
      await api.client.session.update({
        sessionID: sid,
        metadata: {
          planReviewDeferredPicks: {
            ...merged,
            _writtenAt: new Date().toISOString(),
          },
        },
      })
    } catch (e) {
      void api.client.app
        .log({
          service: "plan-review-tui",
          level: "warn",
          message: `plan-review-TUI: writeDeferredToMetadata session=${sid} failed: ${(e as Error)?.message ?? String(e)}`,
        })
        .catch(() => {})
    }
  }

  // Refresh prevAgent from real TUI events. `api.event.on` is typed against
  // the v2 Event union, which has `message.updated`, `session.updated`,
  // `session.status`, etc. — but no `chat.message` (that is a server-side
  // plugin hook name, not a TUI bus name). Subscribe to `message.updated`
  // and re-read the latest user message on every change. Also flushes
  // any deferred picker pick that landed while there was no sessionID
  // (home-screen picker selections made before the user typed anything).
  const refresh = (): void => {
    const sid = getActiveSessionID()
    if (!sid) return
    sessionID = sid
    const agent = getLastUserAgent(sid)
    if (typeof agent === "string" && agent) {
      prevAgent = agent
    } else if (primaryAgents[0]) {
      // No last user message yet (fresh session, just opened). Fall
      // back to the first primary agent so subsequent picker changes
      // can attribute without waiting for the user to type.
      prevAgent = primaryAgents[0]
    }
    if (lastPickedModels.size > 0) {
        // First chance to push the deferred picks through to the server:
        // sessionID is now real. Each pick was keyed by the agent that
        // was active when the user made it (built-up state across
        // Tab + Ctrl-X M cycles on the home screen). Server plugin's
        // chat.message hook reads session.metadata on the user's first
        // real message and merges deferredPicks into chatMessageMemory.
        // No prompt() calls needed — synthetic "." messages would show
        // up in the TUI as actual user messages and trigger vim edit.
        const entries = Array.from(lastPickedModels.entries())
        lastPickedModels.clear()
        logInfo(
          api,
          `plan-review-TUI: flush deferred pickers count=${entries.length} sessionID=${sid}`,
        )
      const picksRecord: Record<string, { providerID: string; modelID: string }> = {}
      for (const [agentName, model] of entries) {
        picksRecord[agentName] = model
        logInfo(
          api,
          `plan-review-TUI: flush deferred picker agent=${agentName} model=${model.providerID}/${model.modelID} sessionID=${sid}`,
        )
      }
      // Single channel: session.update(metadata) only. No prompt()
      // calls — those would create visible "." user messages in the
      // session and trigger vim's edit-mode popup. The server
      // plugin's chat.message hook reads this metadata on the user's
      // first real message and merges deferredPicks into
      // chatMessageMemory. Race-free because session.update is a
      // synchronous server write (no fork, no createUserMessage).
      void (async () => {
        await writeDeferredToMetadata(
          sid,
          Object.fromEntries(entries.map(([a, m]) => [a, m])),
        )
      })()
    }
  }

  const subs: Array<() => void> = []
  for (const evt of ["message.updated", "session.updated", "session.status"] as Event["type"][]) {
    subs.push(api.event.on(evt, () => refresh()))
  }

  api.keymap.intercept(
    "key",
    (input: { event: { name?: string; ctrl?: boolean; meta?: boolean; alt?: boolean } }) => {
      const event = input.event as { name?: string; ctrl?: boolean; meta?: boolean; alt?: boolean }
      if (!event || event.ctrl || event.meta || event.alt) return
      const name = event.name
      if (name !== "tab" && name !== "shift+tab") return
      // Tab works at home too (no session yet) so the user can switch
      // agents and pick models per agent before opening a session.
      refresh()

      // Snapshot the model for prevAgent BEFORE switching away.
      // Two strategies: Solid getOwner (exact per-agent from modelStore)
      // or model.json read (global recent[0] with change detection).
      const localModel = readLocalModel()
      if (localModel && prevAgent) {
        // getOwner path: read EXACT per-agent model from modelStore
        lastPickedModels.set(prevAgent, { providerID: localModel.providerID, modelID: localModel.modelID })
        lastSeenModel = `${localModel.providerID}/${localModel.modelID}`
        logInfo(api, `plan-review-TUI: model snapshot (getOwner) agent=${prevAgent} model=${localModel.providerID}/${localModel.modelID}`)
      } else if (prevAgent) {
        // Fallback: read model.json recent[0] with change detection.
        // Only record if the model changed since last Tab — prevents
        // stale overwrites when the user Tabs without picking.
        try {
          const stateDir = api.state?.path?.state
          if (stateDir && typeof stateDir === "string") {
            const fs = getFs()
            if (fs) {
              const raw = fs.readFileSync(`${stateDir}/model.json`, "utf8")
              const parsed = JSON.parse(raw) as { recent?: Array<{ providerID?: string; modelID?: string }> }
              const first = Array.isArray(parsed.recent) ? parsed.recent[0] : undefined
              if (first?.providerID && first?.modelID) {
                const currentModel = `${first.providerID}/${first.modelID}`
                if (currentModel !== lastSeenModel) {
                  lastPickedModels.set(prevAgent, { providerID: first.providerID, modelID: first.modelID })
                  logInfo(api, `plan-review-TUI: model snapshot (model.json) agent=${prevAgent} model=${currentModel}`)
                }
                lastSeenModel = currentModel
              }
            }
          }
        } catch {
          // model.json may not exist — skip
        }
      }

      const direction: 1 | -1 = name === "tab" ? 1 : -1
      const next = computeNext(prevAgent, direction)
      const sid = getActiveSessionID() ?? sessionID
      logInfo(api, `plan-review-TUI: intercept ${name}: prev=${prevAgent ?? "?"} next=${next ?? "?"} sessionID=${sid ?? "none"}`)
      if (!next || next === prevAgent) return
      prevAgent = next
      // Local-only: Tab cycle updates `prevAgent` here without sending
      // a synthetic "." message to the server. The server learns
      // about the active agent on the user's next real user prompt
      // (chat.message hook fires with input.agent = the new agent
      // because OpenCode already syncs that from local.agent on
      // submit). Server-plugin's exitPlanMode reads metadata to
      // pick the model so we don't need to proactively notify the
      // server either.
    },
    { priority: -1 },
  )

  // model.json watcher REMOVED. It fired in ALL TUI instances
  // simultaneously (model.json is global), causing cross-session
  // contamination: each instance attributed the same model change
  // to its own prevAgent. Replaced with Tab-based snapshot that
  // reads model.json (or modelStore via getOwner) only on Tab —
  // a per-instance event with no contamination.

  api.lifecycle.onDispose(() => {
    for (const off of subs) {
      try {
        off()
      } catch (e) { console.error(`plan-review-TUI: dispose sub failed: ${(e as Error)?.message ?? String(e)}`) }
    }
  })
}

export default {
  id: "plan-review-tui",
  tui,
}
