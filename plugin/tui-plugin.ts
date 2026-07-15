import type {
  TuiEventBus,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"
import type { Event } from "@opencode-ai/sdk/v2"

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  void api.client.app
    .log({
      service: "plan-review-tui",
      level: "info",
      message: "plan-review-TUI: plugin loaded",
    })
    .catch((e: unknown) =>
      api.client.app.log({
        service: "plan-review-tui",
        level: "warn",
        message: `plan-review-TUI: load-log failed: ${(e as Error)?.message ?? String(e)}`,
      }),
    )

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

  let prevAgent: string | undefined
  let sessionID: string | undefined = getActiveSessionID()
  if (sessionID) prevAgent = getLastUserAgent(sessionID)

  // Read all primary agents (filter mirrors packages/tui/src/context/local.tsx:78).
  let primaryAgents: string[] = []
  try {
    const res = await api.client.app.agents()
    const data = (res as { data?: unknown[] }).data ?? []
    primaryAgents = (Array.isArray(data) ? data : [])
      .filter((a: any) => a && typeof a.name === "string" && a.mode !== "subagent" && a.hidden !== true)
      .map((a: any) => a.name as string)
  } catch (e) {
    void api.client.app
      .log({
        service: "plan-review-tui",
        level: "warn",
        message: `plan-review-TUI: app.agents() failed: ${(e as Error)?.message ?? String(e)}`,
      })
      .catch(() => {})
  }

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
          message: `plan-review-TUI: forwardTab to=${to} failed: ${(e as Error)?.message ?? String(e)}`,
        })
        .catch(() => {})
    }
  }

  // Refresh prevAgent from real TUI events. `api.event.on` is typed against
  // the v2 Event union, which has `message.updated`, `session.updated`,
  // `session.status`, etc. — but no `chat.message` (that is a server-side
  // plugin hook name, not a TUI bus name). Subscribe to `message.updated`
  // and re-read the latest user message on every change.
  const refresh = (): void => {
    const sid = getActiveSessionID()
    if (!sid) return
    sessionID = sid
    const agent = getLastUserAgent(sid)
    if (typeof agent === "string" && agent) prevAgent = agent
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
      const sid = getActiveSessionID()
      if (!sid) return
      refresh()
      const direction: 1 | -1 = name === "tab" ? 1 : -1
      const next = computeNext(prevAgent, direction)
      void api.client.app
        .log({
          service: "plan-review-tui",
          level: "info",
          message: `plan-review-TUI: intercept ${name}: prev=${prevAgent ?? "?"} next=${next ?? "?"} sessionID=${sid}`,
        })
        .catch(() => {})
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
          if (!sid) return
          refresh()
          if (!prevAgent) return
          void api.client.app
            .log({
              service: "plan-review-tui",
              level: "info",
              message: `plan-review-TUI: picker changed agent=${prevAgent} model=${picked.providerID}/${picked.modelID} sessionID=${sid}`,
            })
            .catch(() => {})
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
      api.lifecycle.onDispose(() => {
        try {
          watcher!.close()
        } catch {}
      })
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
