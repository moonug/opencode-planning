import type {
  TuiEventBus,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"
import type { Event } from "@opencode-ai/sdk/v2"

// Build-time markers. Bump BUILD_TAG when this file changes in a way that
// must be observable across runs — Bun caches plugin module imports so the
// only reliable way to confirm the new code is loaded is to log the marker
// at startup and compare.
const VERSION = "0.1.3"
const BUILD_TAG = "picker-defer-per-agent-v1"

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
      if (typeof sid === "string" && sid) return sid
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

  logInfo(
    api,
    `plan-review-TUI: ready sessionID=${sessionID ?? "none"} prevAgent=${prevAgent ?? "?"} build=${BUILD_TAG}`,
  )

  const computeNext = (current: string | undefined, direction: 1 | -1): string | undefined => {
    if (primaryAgents.length === 0) return undefined
    const idx = current ? primaryAgents.indexOf(current) : -1
    if (idx === -1) return direction === 1 ? primaryAgents[0] : primaryAgents[primaryAgents.length - 1]
    const next = (idx + direction + primaryAgents.length) % primaryAgents.length
    return primaryAgents[next]
  }

  // Forward agent/model change to the server. Use the v2 SDK
  // (client.session.promptAsync). The TUI host injects an `OpencodeClient`
  // from @opencode-ai/sdk/v2 which has `promptAsync(...)` as the no-stream
  // sibling of `prompt(...)` — see
  // packages/sdk/js/src/v2/gen/sdk.gen.ts:4095. plugin hook `chat.message`
  // fires for every prompt via `packages/opencode/src/session/prompt.ts:999`,
  // so this single noReply call carries the agent/model to the server-side
  // picker watcher (which routes through exitPlanMode).
  const forward = async (
    to: string,
    model?: { providerID: string; modelID: string },
  ): Promise<void> => {
    const sid = getActiveSessionID()
    if (!sid) return
    try {
      await api.client.session.promptAsync({
        path: { id: sid },
        body: {
          agent: to,
          ...(model ? { model } : {}),
          noReply: true,
          parts: [{ type: "text", text: "." }],
        },
      })
  } catch (e) {
    void api.client.app
      .log({
        service: "plan-review-tui",
        level: "warn",
        message: `plan-review-TUI: forward to=${to} failed: ${(e as Error)?.message ?? String(e)}`,
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
      // Tab + Ctrl-X M cycles on the home screen). We intentionally
      // forward EACH (agent, model) pair separately so the server
      // sees input.agent=build+model=X and input.agent=plan+model=Y
      // in distinct chat.message events — chatMessageMemory is per
      // (sessionID, agent) so all four (plan+model, build+model)
      // combinations land in the right slots.
      //
      // One synthetic "." user message per deferred pick is the
      // accepted trade-off — we discussed flush-on-first-message in
      // 0462c35, and the single-variable version lost picks when
      // the user staggered picks per agent. Map form is the minimal
      // change that preserves attribution.
      const entries = Array.from(lastPickedModels.entries())
      lastPickedModels.clear()
      logInfo(
        api,
        `plan-review-TUI: flush deferred pickers count=${entries.length} sessionID=${sid}`,
      )
      for (const [agentName, model] of entries) {
        logInfo(
          api,
          `plan-review-TUI: flush deferred picker agent=${agentName} model=${model.providerID}/${model.modelID} sessionID=${sid}`,
        )
        void forward(agentName, model)
      }
    }
  }

  const subs: Array<() => void> = []
  for (const evt of ["message.updated", "session.updated", "session.status"] as Event["type"][]) {
    subs.push(api.event.on(evt, () => refresh()))
  }

  api.keymap.intercept(
    "key",
    (input) => {
      const event = input.event as { name?: string; ctrl?: boolean; meta?: boolean; alt?: boolean }
      if (!event || event.ctrl || event.meta || event.alt) return
      const name = event.name
      if (name !== "tab" && name !== "shift+tab") return
      // Tab works at home too (no session yet) so the user can switch
      // agents and pick models per agent before opening a session.
      // refresh() is a no-op without a sessionID, so we fall through
      // and computeNext/forward still work — the only field that
      // needs to stay current is prevAgent itself.
      refresh()
      const direction: 1 | -1 = name === "tab" ? 1 : -1
      const next = computeNext(prevAgent, direction)
      const sid = getActiveSessionID() ?? sessionID
      logInfo(api, `plan-review-TUI: intercept ${name}: prev=${prevAgent ?? "?"} next=${next ?? "?"} sessionID=${sid ?? "none"}`)
      if (!next || next === prevAgent) return
      prevAgent = next
      void forward(next)
    },
    { priority: -1 },
  )

  // Watch the global picker file (model.json) inside the TUI process.
  // The server plugin's fs.watch was removed because model.json is shared
  // by every opencode instance and produced duplicate `matched agent=X`
  // log lines whenever more than one was running (e.g. a long-lived
  // `opencode serve` under plannotator plus every TUI attach). Watchers
  // in TUI process are scoped to that one renderer's session, so the
  // picker change can be forwarded with that agent attached — and the
  // server-side chat.message hook will write it into chatMessageMemory
  // keyed by (sessionID, agent).
  //
  // The TUI host exposes api.state.path.state which is the directory that
  // model.json lives in (default: ~/.local/state/opencode). Watching
  // here is supported because fs is a node:fs primitive available inside
  // any bun/Node host that the TUI plugin runs in.
  const stateDir = api.state?.path?.state
  if (stateDir && typeof stateDir === "string") {
    let lastModelJSON = ""
    const modelJsonPath = `${stateDir}/model.json`
    let watcher: ReturnType<typeof import("node:fs").watch> | undefined
    try {
      // Load node:fs dynamically — it's a stdlib dep that the plugin
      // runtime already uses elsewhere (the server plugin imports from
      // it directly).
      const fs = await import("node:fs")
      // Initialise lastModelJSON so the first watcher tick (which fires
      // once for fs.watch default behaviour on some platforms) doesn't
      // treat the start state as a "change".
      try {
        lastModelJSON = fs.readFileSync(modelJsonPath, "utf8")
      } catch {
        lastModelJSON = ""
      }
      watcher = fs.watch(modelJsonPath, { persistent: false }, () => {
        // Fires on every model.json mtime change. We only act when the
        // file content actually differs from the last snapshot — saves
        // the duplicate "change" events fs.watch emits when writes
        // touch atime too.
        try {
          const raw = fs.readFileSync(modelJsonPath, "utf8")
          if (raw === lastModelJSON) return
          lastModelJSON = raw
          let picked: { providerID: string; modelID: string } | undefined
          try {
            const parsed = JSON.parse(raw) as {
              recent?: Array<{ providerID?: string; modelID?: string }>
            }
            const first = Array.isArray(parsed.recent) ? parsed.recent[0] : undefined
            if (first && typeof first.providerID === "string" && typeof first.modelID === "string") {
              picked = { providerID: first.providerID, modelID: first.modelID }
            }
          } catch {}
          if (!picked) return
          const sid = getActiveSessionID()
          if (!sid) {
            // Home-screen picker: stash the choice keyed by the agent
            // that was active when the pick was made (prevAgent tracks
            // Tab/Shift+Tab in real time via refresh() above). Multiple
            // agents can stage picks before any session exists; refresh()
            // flushes them all in one go on first session.updated.
            const agentKey = prevAgent ?? primaryAgents[0]
            if (!agentKey) {
              logInfo(api, `plan-review-TUI: picker skipped reason=no-agent`)
              return
            }
            lastPickedModels.set(agentKey, picked)
            logInfo(
              api,
              `plan-review-TUI: picker deferred agent=${agentKey} model=${picked.providerID}/${picked.modelID} reason=no-session totalDeferred=${lastPickedModels.size}`,
            )
            return
          }
          refresh()
          if (!prevAgent) {
            // Fall back to the first primary agent — mirrors local.agent
            // fallback in packages/tui/src/context/local.tsx:97.
            prevAgent = primaryAgents[0]
            if (!prevAgent) {
              logInfo(api, `plan-review-TUI: picker skipped reason=no-agent`)
              return
            }
            logInfo(api, `plan-review-TUI: picker using default agent=${prevAgent}`)
          }
          logInfo(
            api,
            `plan-review-TUI: picker changed agent=${prevAgent} model=${picked.providerID}/${picked.modelID} sessionID=${sid}`,
          )
          void forward(prevAgent, picked)
        } catch (e) {
          void api.client.app
            .log({
              service: "plan-review-tui",
              level: "warn",
              message: `plan-review-TUI: model.json watcher failed: ${(e as Error)?.message ?? String(e)}`,
            })
            .catch(() => {})
        }
      })
    } catch (e) {
      void api.client.app
        .log({
          service: "plan-review-tui",
          level: "warn",
          message: `plan-review-TUI: model.json watcher init failed: ${(e as Error)?.message ?? String(e)}`,
        })
        .catch(() => {})
    }

    if (watcher) {
      logInfo(api, `plan-review-TUI: watcher ready path=${modelJsonPath} initialBytes=${lastModelJSON.length}`)
      api.lifecycle.onDispose(() => {
        try {
          watcher!.close()
        } catch {}
      })
    } else {
      logInfo(api, `plan-review-TUI: no watcher (stateDir=${stateDir ?? "?"})`)
    }
  }

  api.lifecycle.onDispose(() => {
    for (const off of subs) {
      try {
        off()
      } catch {}
    }
  })
}

export default {
  id: "plan-review-tui",
  tui,
}
