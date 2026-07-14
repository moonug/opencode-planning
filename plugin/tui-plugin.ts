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
    prompt: (input: { path: { id: string }; body: { agent?: string; noReply?: boolean; parts?: Array<{ type: string; text?: string }> } }) => Promise<unknown>
  }
  // v2 SDK client (opencode 1.17+). Kept for potential future use but not
  // currently called — v2.session.switchAgent's event hits the server
  // plugin's location filter and is silently dropped
  // (packages/opencode/src/plugin/index.ts:252). Switch to v1
  // session.prompt instead.
  v2?: {
    session: {
      switchAgent: (input: { path: { sessionID: string }; body: { agent: string } }) => Promise<unknown>
    }
  }
  app: {
    agents: () => Promise<{ data?: Array<{ name: string; mode?: string; builtIn?: boolean; hidden?: boolean }> }>
    log: (input: { service?: string; level?: "info" | "warn" | "error" | "debug"; message: string }) => Promise<unknown>
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
  // diagnostic: confirm the plugin was loaded by the TUI plugin host.
  // This appears in ~/.local/share/opencode/log/opencode.log and lets
  // us distinguish three failure modes:
  //   1. plugin never loaded   -> no log line
  //   2. plugin loaded but init threw -> error from .log() .catch
  //   3. plugin loaded and intercept handler never fires -> need to
  //      inspect keymap priority or the event.name shape
  void api.client.app
    .log({ service: "plan-review-tui", level: "info", message: "plan-review-TUI: plugin loaded" })
    .catch(() => {})

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
  //
  // Mirror the TUI's own filter from
  // packages/tui/src/context/local.tsx:78 exactly:
  //   sync.data.agent.filter((agent) => agent.mode !== "subagent" && !agent.hidden)
  //
  // Agent definitions (packages/opencode/src/agent/agent.ts) show that
  // compaction, code-review, explore, general, and title all set
  // { mode: "primary", native: true, hidden: true }. The v1 SDK renames
  // `native` to `builtIn` but the API often omits `builtIn` for agents
  // where it would be false, leaving `builtIn: undefined` in the
  // runtime response — so filtering by `builtIn !== true` lets hidden
  // agents through. Filtering by `hidden !== true` matches the TUI's
  // own behavior exactly.
  let primaryAgents: string[] = []
  try {
    const res = await api.client.app.agents()
    const data = (res as any)?.data ?? []
    primaryAgents = (Array.isArray(data) ? data : [])
      .filter((a: any) => a && typeof a.name === "string" && a.mode !== "subagent" && a.hidden !== true)
      .map((a: any) => a.name as string)
  } catch (e) {
    void api.client.app
      .log({ service: "plan-review-tui", level: "warn", message: `plan-review-TUI: app.agents() failed: ${(e as Error).message}` })
      .catch(() => {})
  }

  const computeNext = (current: string | undefined, direction: 1 | -1): string | undefined => {
    if (primaryAgents.length === 0) return undefined
    const idx = current ? primaryAgents.indexOf(current) : -1
    if (idx === -1) return direction === 1 ? primaryAgents[0] : primaryAgents[primaryAgents.length - 1]
    const next = (idx + direction + primaryAgents.length) % primaryAgents.length
    return primaryAgents[next]
  }

  // Forward the agent switch to the server. We need the server plugin's
  // lastSessionAgent cache to know which agent the user is in, so the
  // model.json watcher can attribute picker changes correctly.
  //
  // The naive path is v2.session.switchAgent({agent}) which is the
  // documented "right" way. We tried it in 00ebea7 and saw the call
  // go through ("plan-review-TUI: switchAgent build -> plan") but the
  // server plugin's event hook never received the corresponding
  // session.next.agent.switched event.
  //
  // Root cause (from opencode source):
  // - packages/opencode/src/plugin/index.ts:251: server plugin's
  //   event hook filters by event.location.directory === ctx.directory
  // - packages/core/src/session.ts:393: v2 switchAgent publishes via
  //   EventV2.Service (without a location context, so InstanceRef is
  //   not set when the bridge forwards it)
  // - packages/opencode/src/event-v2-bridge.ts:39: the bridge emits
  //   with directory: undefined, which the plugin filter then drops.
  //   plugin.added works because PluginV2.Service is location-aware.
  //
  // Workaround without patching opencode: instead of v2.switchAgent
  // (whose event is dropped by the server plugin's location filter),
  // use v1 client.session.prompt({body:{noReply: true, agent: to,
  // parts: [{type:"text", text: "."}]}}).
  // - packages/opencode/src/session/prompt.ts:635-689: createUserMessage
  //   runs through location-aware middleware and calls
  //   sessions.setAgentModel({agent, ...}) which patches the session
  //   row AND publishes SessionV1.Event.Updated with the new info.agent.
  //   That event passes through the server plugin's filter (correct
  //   location) and triggers the existing handler at plugin/index.ts
  //   that sets lastSessionAgent = info.agent.
  // - noReply: true means the server does NOT call the provider LLM;
  //   only a tiny "." user message is recorded in session history
  //   so the picker-watcher attribution is correct on the next cycle.
  //
  // Trade-off: each Tab cycle creates a 1-character "." user message
  // in the session history. Acceptable given the alternative (no
  // picker attribution at all when the user cycles agents without
  // sending a message in each).
  const forward = (from: string | undefined, to: string | undefined) => {
    if (!sessionID) return
    if (!to) return
    void api.client.session
      .prompt({
        path: { id: sessionID },
        body: {
          agent: to,
          noReply: true,
          parts: [{ type: "text", text: "." }],
        },
      })
      .catch(() => {})
    void api.client.app
      .log({
        service: "plan-review-tui",
        level: "info",
        message: `plan-review-TUI: forwardTab ${from ?? "?"} -> ${to}`,
      })
      .catch(() => {})
  }

  api.keymap.intercept(
    "key",
    ({ event }) => {
      if (!event || event.ctrl || event.meta || event.alt) return
      const name = event.name
      if (name !== "tab" && name !== "shift+tab") return
      const direction: 1 | -1 = name === "tab" ? 1 : -1
      // diagnostic: confirm the intercept handler is being called for
      // Tab/Shift+Tab. The first cycle attempt logs the candidate next
      // agent even if computeNext returns undefined — that way we know
      // whether the handler fired at all (vs. keymap priority dropping
      // it before ours gets a turn).
      const next = computeNext(prevAgent, direction)
      void api.client.app
        .log({
          service: "plan-review-tui",
          level: "info",
          message: `plan-review-TUI: intercept ${name}: prev=${prevAgent ?? "?"} next=${next ?? "?"} sessionID=${sessionID ?? "?"}`,
        })
        .catch(() => {})
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
