// TUI plugin for plan-review.
//
// Runs inside the opencode TUI process (loaded via the TUI plugin host
// at packages/opencode/src/plugin/tui/runtime.ts:1116). The server-side
// plugin in plugin/index.ts lives in a different process and cannot
// read the TUI's local SolidJS state — `local.agent.current()` is
// held in a private createStore() and is not exposed through TuiPluginApi.
//
// The opencode TUI's Tab/Shift+Tab keybind (`agent.cycle` /
// `agent.cycle.reverse`, see packages/tui/src/config/keybind.ts:130-131)
// calls local.agent.move() which only mutates that in-memory store.
// The server is never notified when the user switches tabs.
//
// To bridge that gap without patching opencode, we listen for the raw
// Tab key event from inside the TUI process and forward the resulting
// agent change to the server via client.session.update({metadata:{...}}).
// The server plugin sees the metadata change on SessionV1.Event.Updated
// and updates its `lastSessionAgent` so the model.json picker watcher
// and exitPlanMode priority chain can attribute picks to the right agent.
//
// We do NOT preventDefault — the default agent.cycle still runs and
// the TUI's local state changes as before. We only observe and forward.

import { homedir } from "os"
import { existsSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, lstatSync } from "fs"
import { join } from "path"

interface TuiKeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
  preventDefault?: () => void
  stopPropagation?: () => void
}

interface TuiKeymap {
  intercept: (
    type: "key",
    handler: (input: { event: TuiKeyEvent }) => void,
    opts?: { priority?: number },
  ) => () => void
}

interface TuiClient {
  session: {
    list: (input: { query?: { limit?: number } }) => Promise<{ data?: Array<{ id?: string; agent?: string }> }>
    get: (input: { path: { id: string } }) => Promise<{ data?: { agent?: string } }>
    update: (input: { path: { id: string }; body: { metadata?: Record<string, unknown> } }) => Promise<unknown>
  }
  app: {
    agents: () => Promise<{ data?: Array<{ name: string; mode?: string }> }>
  }
}

interface TuiApi {
  client: TuiClient
  keymap: TuiKeymap
}

// Self-install: symlink this TUI plugin into ~/.config/opencode/plugins/
// so opencode's TUI plugin host picks it up on next launch. Mirrors the
// self-install pattern from plugin/index.ts:ensureCommandSymlink, but
// for the TUI plugin host which scans the same plugins/ directory.
export function ensureTuiPluginSymlink(pluginPath: string, id = "plan-review-tui"): string {
  const dir = join(homedir(), ".config", "opencode", "plugins")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const link = join(dir, `${id}.ts`)
  try {
    const stat = lstatSync(link)
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(link)
      if (target === pluginPath) return link
      unlinkSync(link)
    } else {
      unlinkSync(link)
    }
  } catch {}
  symlinkSync(pluginPath, link)
  return link
}

const tuiPlugin = async (api: TuiApi, _options?: unknown, _meta?: unknown) => {
  // closure state for this TUI session (in-memory only, lost on restart)
  let prevAgent: string | undefined
  let sessionID: string | undefined
  let cycleCount = 0

  // Initialise prevAgent and sessionID from server snapshot.
  // session.list({query:{limit:1}}) returns the most recent session in
  // the runtime response along with its current agent — same trick the
  // server plugin uses. Without this, the first Tab press has no prev
  // and we can't tell the server what agent we just left.
  try {
    const list = await api.client.session.list({ query: { limit: 1 } })
    const first = (list as any)?.data?.[0]
    if (first) {
      sessionID = typeof first.id === "string" ? first.id : undefined
      if (typeof first.agent === "string" && first.agent) {
        prevAgent = first.agent
      }
    }
  } catch {}

  // Cache primary agent list. The TUI's local.agent.set() only operates
  // on the same set, and we need the list to compute the next agent on
  // each Tab press without round-tripping the server.
  let primaryAgents: string[] = []
  try {
    const res = await api.client.app.agents()
    const data = (res as any)?.data ?? []
    primaryAgents = (Array.isArray(data) ? data : [])
      .filter((a: any) => a && typeof a.name === "string" && a.mode !== "subagent")
      .map((a: any) => a.name as string)
  } catch {}

  const computeNext = (current: string | undefined, direction: 1 | -1): string | undefined => {
    if (primaryAgents.length === 0) return undefined
    const idx = current ? primaryAgents.indexOf(current) : -1
    if (idx === -1) return direction === 1 ? primaryAgents[0] : primaryAgents[primaryAgents.length - 1]
    const next = (idx + direction + primaryAgents.length) % primaryAgents.length
    return primaryAgents[next]
  }

  // Forward the agent switch to the server. The server plugin sees the
  // metadata change via SessionV1.Event.Updated and updates its
  // lastSessionAgent. Fire-and-forget — we don't block the keypress.
  const forward = (from: string | undefined, to: string | undefined) => {
    if (!sessionID) return
    if (!to) return
    void api.client.session.update({
      path: { id: sessionID },
      body: {
        metadata: {
          planReviewTabSwitchFrom: from ?? "",
          planReviewTabSwitchTo: to,
          planReviewTabSwitchAt: Date.now(),
          planReviewTabSwitchCount: cycleCount,
        },
      },
    }).catch(() => {
      // server may be temporarily unavailable; next Tab will retry
    })
  }

  api.keymap.intercept(
    "key",
    ({ event }) => {
      if (!event || event.ctrl || event.meta || event.alt) return
      const name = event.name
      if (name !== "tab" && name !== "shift+tab") return
      const direction: 1 | -1 = name === "tab" ? 1 : -1
      const next = computeNext(prevAgent, direction)
      if (!next || next === prevAgent) return
      cycleCount++
      const from = prevAgent
      prevAgent = next
      forward(from, next)
    },
    { priority: -1 }, // low priority: observe, don't preempt
  )
}

// opencode's TUI plugin loader (packages/opencode/src/plugin/shared.ts:272-303)
// requires: export default { id, tui } — NOT a direct function. The default
// export must be an object with a tui() method that the loader calls per
// activate. Without { id, tui } wrapping, PluginLoader.readV1Plugin throws
// "Plugin <spec> must default export an object with tui()".
export default {
  id: "plan-review-tui",
  tui: tuiPlugin,
}
