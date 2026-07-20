import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, lstatSync, chmodSync, statSync, copyFileSync } from "node:fs"
import { dirname, resolve, join, basename } from "node:path"
import { homedir as osHomedir } from "node:os"

// On macOS, node:os's homedir() falls back to /etc/passwd when HOME is
// unset or invalid, regardless of process.env.HOME. This makes it
// awkward to test, and in some sandboxed processes (opencode's server
// can spawn child processes with a reduced env) it can return the
// build user's home instead of the runtime user's. Prefer
// process.env.HOME, fall back to homedir() only when unset/empty.
function homedir(): string {
  const fromEnv = process.env.HOME
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  return osHomedir()
}
import { rememberBuildModel, type ModelRef } from "./model-memory"

const PLUGIN_DIR = dirname(new URL(import.meta.url).pathname)
const REPO_DIR = resolve(PLUGIN_DIR, "..")
const SCRIPT_PATH =
  process.env.PLAN_REVIEW_SCRIPT ?? join(REPO_DIR, "bin", "plan-review.py")
const COMMAND_SOURCES = [
  join(REPO_DIR, "commands", "plan-review.md"),
  join(REPO_DIR, "commands", "set-build-model.md"),
  join(REPO_DIR, "commands", "plan-diag.md"),
]

const FEEDBACK_HEADER =
  "User reviewed the plan in their editor and made changes.\n" +
  "Diff below (lines starting with + are user additions/annotations, " +
  "- are removals):\n"

const REVISION_PROMPT =
  "\nRevise the plan to address each annotation, then call plan_review " +
  "again with the revised plan. When the user closes the editor without " +
  "making changes, this tool returns an empty/no-diff result and the " +
  "plan is approved."

function ensureExecutable(path: string): void {
  try {
    if ((statSync(path).mode & 0o111) === 0) chmodSync(path, 0o755)
  } catch {
    // ignore — existsSync catches the missing case later
  }
}

function ensureCommandSymlink(): void {
  for (const source of COMMAND_SOURCES) {
    const linkPath = join(homedir(), ".config", "opencode", "commands", basename(source))
    try {
      mkdirSync(dirname(linkPath), { recursive: true })
    } catch {
      continue
    }
    try {
      const existing = readlinkSync(linkPath)
      if (resolve(existing) === resolve(source)) continue
      unlinkSync(linkPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        try { unlinkSync(linkPath) } catch {}
      }
    }
    try {
      symlinkSync(source, linkPath)
    } catch {
      copyFileSync(source, linkPath)
    }
  }
  // also register the TUI plugin via tui.json so the opencode TUI
  // plugin host picks it up on launch. Without this, the TUI's local
  // agent state (which is purely in-memory in a private SolidJS store
  // that is not exposed through TuiPluginApi) cannot be observed, and
  // the server plugin cannot attribute model.json picker changes to
  // the agent the user is actually in. The TUI plugin's keymap.intercept
  // handler fires on Tab/Shift+Tab and forwards the resulting agent
  // change to the server via client.session.update({metadata:{...}}).
  //
  // NOTE: TUI plugins are NOT auto-discovered from
  // ~/.config/opencode/plugins/ — that path is server-side only and
  // tries to load the file as a server plugin (which fails with
  // 'must default export an object with server()'). TUI plugins
  // MUST be registered in tui.json (or tui.jsonc) under the 'plugin'
  // field, see packages/opencode/src/config/tui.ts:89.
  //
  // Prior iterations wrote both ~/.config/opencode/tui.json AND
  // ~/.config/opencode/tui.jsonc with the same path; that created
  // duplicate plugin origins that the plugin loader couldn't tell apart.
  // We now write only tui.jsonc (and migrate any old tui.json by
  // reading from it but writing to tui.jsonc).
  try {
    const tuiPluginPath = join(REPO_DIR, "plugin", "tui-plugin.ts")
    const tuiJsonPath = join(homedir(), ".config", "opencode", "tui.jsonc")
    const tuiJsonLegacy = join(homedir(), ".config", "opencode", "tui.json")
    // Always remove a legacy symlink at ~/.config/opencode/plugins/
    // plan-review-tui.ts. That path is server-plugin territory and the
    // server loader requires .server() export on whatever it loads —
    // a TUI plugin there produces 'must default export an object with
    // server()' and clutters every opencode startup with a failed
    // plugin load log. Earlier install iterations (before tui.json was
    // adopted) created this symlink; we now delete it on every init.
    const legacySymlink = join(homedir(), ".config", "opencode", "plugins", "plan-review-tui.ts")
    try {
      const stat = lstatSync(legacySymlink)
      if (stat.isSymbolicLink()) {
        unlinkSync(legacySymlink)
      }
    } catch {}

    let existing: string | undefined
    try { existing = readFileSync(tuiJsonPath, "utf8") } catch (err) {
      // ENOENT expected on first run; log other errors so silent
      // permission/parse failures don't recur.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`plan-review: failed to read ${tuiJsonPath}: ${(err as Error).message}`)
      }
    }
    if (existing === undefined) {
      try { existing = readFileSync(tuiJsonLegacy, "utf8") } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error(`plan-review: failed to read ${tuiJsonLegacy}: ${(err as Error).message}`)
        }
      }
    }
    let parsed: any = {}
    if (existing) {
      try { parsed = JSON.parse(existing) } catch {}
    }
    const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : []
    if (!plugins.includes(tuiPluginPath)) {
      plugins.push(tuiPluginPath)
      parsed.plugin = plugins
      try { mkdirSync(dirname(tuiJsonPath), { recursive: true }) } catch {}
      writeFileSync(tuiJsonPath, JSON.stringify(parsed, null, 2) + "\n")
    }
  } catch {}
}

function parseModelString(s: string): ModelRef | undefined {
  const m = s.trim().match(/^([^/\s]+)\/(.+)$/)
  if (!m) return undefined
  return { providerID: m[1]!, modelID: m[2]! }
}

function runPlanReview($: any, planText: string): Promise<string> {
  // Write plan to a temp file and pass via --file so Bun Shell's
  // $.escape() never touches the markdown content (backticks, $,
  // etc.). The helper reads the file, opens it in $EDITOR, diffs,
  // and prints the result on stdout.
  const tmpPath = join(REPO_DIR, ".plan-review-tmp.md")
  writeFileSync(tmpPath, planText, "utf8")
  const promise = $`${SCRIPT_PATH} --file ${$.escape(tmpPath)}`.text()
  promise.then(() => { try { unlinkSync(tmpPath) } catch {} }, () => { try { unlinkSync(tmpPath) } catch {} })
  return promise
}

function log(client: any, level: "debug" | "info" | "warn" | "error", message: string): Promise<unknown> {
  return client.app.log({ body: { service: "plan-review", level, message } })
}

// logged() — fire-and-forget variant of log() that never swallows an
// error silently. Per AGENTS.md: `catch {}` — нельзя. This is the only
// place in this file where a catch is allowed to fail open — it routes
// the failure through console.error so it lands in terminal stderr
// even when the server log API is unreachable.
function logged(client: any, level: "debug" | "info" | "warn" | "error", message: string): Promise<void> {
  return log(client, level, message)
    .then(() => undefined)
    .catch((e: unknown) => {
      const errText = (e as Error)?.message ?? String(e)
      console.error(`plan-review: log(${level}) call failed: ${errText}; original=${message}`)
    })
}

// visibleErr() — helper for replacing `.catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L143): ${(e as Error)?.message ?? String(e)}`) })` on non-log
// promises. Records the error on the server log first, falls back to
// console.error if server is unreachable. Use this everywhere instead
// of bare `.catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L146): ${(e as Error)?.message ?? String(e)}`) })` so we never silently lose a fail signal.
async function visibleErr(client: any, context: string, e: unknown): Promise<void> {
  const errText = (e as Error)?.message ?? String(e)
  try {
    await log(client, "warn", `swallowed error in ${context}: ${errText}`)
  } catch {
    console.error(`plan-review: swallowed error in ${context}: ${errText}`)
  }
}

async function getBuildAgentModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.app.agents()
    const agents = (res as any)?.data ?? res
    const buildAgent = (Array.isArray(agents) ? agents : []).find(
      (a: any) => a.name === "build" || a.id === "build"
    )
    if (buildAgent?.model?.providerID && buildAgent?.model?.modelID) {
      return { providerID: buildAgent.model.providerID, modelID: buildAgent.model.modelID }
    }
  } catch {}
  return undefined
}

async function getPlanAgentModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.app.agents()
    const agents = (res as any)?.data ?? res
    const planAgent = (Array.isArray(agents) ? agents : []).find(
      (a: any) => a.name === "plan" || a.id === "plan"
    )
    if (planAgent?.model?.providerID && planAgent?.model?.modelID) {
      return { providerID: planAgent.model.providerID, modelID: planAgent.model.modelID }
    }
  } catch {}
  return undefined
}

async function getGlobalModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.config.get()
    const model = (res as any)?.data?.model ?? (res as any)?.model
    if (typeof model === "string") return parseModelString(model)
  } catch (err) {
    console.error(`plan-review: getGlobalModel failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

interface ProviderListEntry {
  providerID: string
  providerName?: string
  modelID: string
  displayName?: string
}

async function listAvailableModels(client: any): Promise<ProviderListEntry[]> {
  const entries: ProviderListEntry[] = []
  try {
    const res = await client.config.providers()
    const data = (res as any)?.data ?? res
    const providers: any[] = data?.providers ?? []
    for (const provider of providers) {
      const id = provider.id
      const name = provider.name
      const models: Record<string, any> = provider.models ?? {}
      for (const [modelID, model] of Object.entries(models)) {
        if (model?.status === "deprecated") continue
        const displayName = model?.name ?? modelID
        entries.push({ providerID: id, providerName: name, modelID, displayName })
      }
    }
  } catch (err) {
    console.error(`plan-review: listAvailableModels failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return entries
}

function formatProviderList(entries: ProviderListEntry[]): string {
  if (entries.length === 0) return "  (no providers found — check opencode config)"
  const lines: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const label = e.displayName && e.displayName !== e.modelID
      ? `${e.displayName} (\`${e.modelID}\`)`
      : `\`${e.modelID}\``
    lines.push(`  ${(i + 1).toString().padStart(3, " ")}. ${e.providerID.padEnd(24)} ${label}`)
  }
  return lines.join("\n")
}

async function exitPlanMode(
  client: any,
  buildModels: Map<string, ModelRef>,
  chatMessageMemory: Map<string, Map<string, ModelRef>>,
  lastResolution: { target?: ModelRef; source?: string },
  sessionID: string | undefined,
  summary: string,
): Promise<void> {
  if (!sessionID) return
  await log(client, "info", `plan-review: exitPlanMode called for session ${sessionID}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L259): ${(e as Error)?.message ?? String(e)}`) })

  // Promote deferred picker picks stored by the TUI plugin into
  // chatMessageMemory. TUI plugin writes
  // `metadata.planReviewDeferredPicks[agent] = {providerID, modelID}`
  // via session.update on session.updated. We read it here at
  // exitPlanMode time because:
  //   - The TUI plugin can't race with us any more: by the time
  //     the user approves the plan, the user has typed their
  //     first message, the plan agent has generated a response,
  //     and the user has reviewed it — seconds-to-minutes after
  //     the TUI plugin's session.update completed.
  //   - Earlier placement in chat.message hook raced: user's
  //     first real prompt fired chat.message BEFORE the TUI's
  //     session.updated handler wrote the metadata.
  //
  // Idempotent: we set perSession[agent] only when no entry
  // exists yet, so a concurrent chat.message write that already
  // populated (agent -> real model) survives intact. The
  // "promoted deferred" log says how many we filled in.
  let deferredPromoted = 0
  try {
    const sessionRes = await client.session.get({ path: { id: sessionID } })
    const data = (sessionRes as any)?.data ?? sessionRes
    const metadata = data?.metadata
    // DIAG: log exact metadata we read so the next live test reveals
    // whether the session.update write reached the server, got
    // overwritten, or never committed. Remove once root cause is
    // identified.
    await log(
      client,
      "info",
      `plan-review: exitPlanMode metadata check: session=${sessionID} keys=${metadata ? Object.keys(metadata).join(",") : "<null>"} deferred=${metadata?.planReviewDeferredPicks ? JSON.stringify(metadata.planReviewDeferredPicks) : "<absent>"} raw=${JSON.stringify(metadata ?? null)}`,
    ).catch((e: unknown) => { console.error(`plan-review: swallowed error in diag (L307): ${(e as Error)?.message ?? String(e)}`) })
    const deferred = metadata?.planReviewDeferredPicks
    if (deferred && typeof deferred === "object") {
      let perSession = chatMessageMemory.get(sessionID)
      if (!perSession) {
        perSession = new Map<string, ModelRef>()
        chatMessageMemory.set(sessionID, perSession)
      }
      for (const [agentName, m] of Object.entries(deferred)) {
        if (!m || typeof m !== "object") continue
        if (agentName.startsWith("_")) continue
        const providerID = (m as any).providerID
        const modelID = (m as any).modelID
        if (typeof providerID !== "string" || typeof modelID !== "string") continue
        perSession.set(agentName, { providerID, modelID })
        deferredPromoted++
      }
      if (deferredPromoted > 0) {
        await log(
          client,
          "info",
          `plan-review: exitPlanMode promoted deferredPicks: count=${deferredPromoted} session=${sessionID}`,
        ).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L287): ${(e as Error)?.message ?? String(e)}`) })
      }
    }
  } catch (err) {
    await log(client, "warn", `plan-review: exitPlanMode deferred-pick lookup failed: ${(err as Error).message}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L289): ${(e as Error)?.message ?? String(e)}`) })
  }

  const overridden = buildModels.get(sessionID)
  const perAgent = chatMessageMemory.get(sessionID)
  const fromChat = perAgent?.get("build")
  const [agentCfg, planCfg, globalCfg] = await Promise.all([
    withTimeoutSafe(getBuildAgentModel(client), 2000, undefined),
    withTimeoutSafe(getPlanAgentModel(client), 2000, undefined),
    withTimeoutSafe(getGlobalModel(client), 2000, undefined),
  ])

  const fromChatPlan = perAgent?.get("plan")

  // DIAG: log all priority chain sources so we can trace why a
  // particular model was picked (user reports build got wrong model).
  await log(
    client,
    "info",
    `plan-review: exitPlanMode chain: session=${sessionID} fromChat=${fromChat ? `${fromChat.providerID}/${fromChat.modelID}` : "∅"} fromChatPlan=${fromChatPlan ? `${fromChatPlan.providerID}/${fromChatPlan.modelID}` : "∅"} overridden=${overridden ? `${overridden.providerID}/${overridden.modelID}` : "∅"} agentCfg=${agentCfg ? `${agentCfg.providerID}/${agentCfg.modelID}` : "∅"} planCfg=${planCfg ? `${planCfg.providerID}/${planCfg.modelID}` : "∅"} globalCfg=${globalCfg ? `${globalCfg.providerID}/${globalCfg.modelID}` : "∅"}`,
  ).catch((e: unknown) => { console.error(`plan-review: swallowed error in diag (L375): ${(e as Error)?.message ?? String(e)}`) })

  let source: string
  let target: ModelRef | undefined
  if (fromChat)         { target = fromChat;    source = "chat.message (build)" }
  else if (overridden)  { target = overridden;  source = "build model memory" }
  else if (fromChatPlan) { target = fromChatPlan; source = "chat.message (plan)" }
  else if (agentCfg)    { target = agentCfg;    source = "agent.build.model" }
  else if (globalCfg)   { target = globalCfg;   source = "config.model" }
  else if (planCfg)     { target = planCfg;     source = "agent.plan.model (fallback)" }
  else                  { source = "opencode default" }

  lastResolution.target = target
  lastResolution.source = source

  await log(
    client,
    "info",
    `plan-review: exitPlanMode resolution: session=${sessionID} target=${target ? `${target.providerID}/${target.modelID}` : "undefined"} source=${source}`,
  ).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L301): ${(e as Error)?.message ?? String(e)}`) })

  if (!target) {
    await log(client, "warn", `auto-exit: no build model resolved (sources tried: ${source}), asking user to switch manually`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L304): ${(e as Error)?.message ?? String(e)}`) })
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{
            type: "text",
            text: `Plan approved. ${summary}\n\n⚠ No build model resolved (tried /set-build-model, agent.build.model, config.model — all undefined). Run \`/set-build-model <provider>/<model>\` (or \`/set-build-model\` for a picker), \`/agent build\`, then \`/model <provider>/<model>\` before continuing.`,
          }],
        },
      })
    } catch (err) {
      console.error(`plan-review: no-target prompt failed: ${(err as Error)?.message ?? String(err)}`)
    }
    return
  }

  await log(
    client,
    "info",
    `auto-exit to build. model=${target.providerID}/${target.modelID} source=${source}`,
  ).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L324): ${(e as Error)?.message ?? String(e)}`) })

  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: "build",
        model: { providerID: target.providerID, modelID: target.modelID },
        noReply: true,
        parts: [{
          type: "text",
          text: `Plan approved. ${summary} Build model: ${target.providerID}/${target.modelID} (source: ${source}). Proceed with implementation.`,
        }],
      },
    })
  } catch (err) {
    await log(client, "error", `failed to send build-exit prompt: ${(err as Error).message}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L340): ${(e as Error)?.message ?? String(e)}`) })
  }
}

async function withTimeoutSafe<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export const PlanReviewPlugin: Plugin = async ({ $, client, serverUrl }) => {
  await log(client, "info", "plan-review: plugin init v0.1.8 build=local-only-picker-v1").catch((e: unknown) => { console.error(`plan-review: log(init) failed: ${(e as Error)?.message ?? String(e)}`) })
  await log(client, "info", `plan-review: argv0=${(process.argv[1] ?? "unknown").split("/").slice(-3).join("/")}`).catch((e: unknown) => { console.error(`plan-review: log(argv0) failed: ${(e as Error)?.message ?? String(e)}`) })

  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `plan-review: helper script not found at ${SCRIPT_PATH}. ` +
        `Set PLAN_REVIEW_SCRIPT env var or restore bin/plan-review.py next to the plugin.`
    )
  }
  ensureExecutable(SCRIPT_PATH)
  ensureCommandSymlink()

  const buildModels = new Map<string, ModelRef>()
  const lastResolution: { target?: ModelRef; source?: string } = {}
  const lastShownModels = new Map<string, ProviderListEntry[]>()
  const chatMessageMemory = new Map<string, Map<string, ModelRef>>()
  // Keyed by sessionID → agent → model. Populated by chat.message hook
  // (fires for every real and synthetic prompt). exitPlanMode reads this
  // as its first-priority source. No model.json reads — model.json is
  // global and leaks model choices across sessions. All model attribution
  // is per-session: chatMessageMemory (sessionID), buildModels (sessionID),
  // and session metadata (per-session row written by TUI plugin).

  const plan_review = tool({
    description:
      "Open the current plan in $EDITOR for the user to annotate. " +
      "Pass the full markdown of your plan as the `plan` argument. " +
      "Returns a unified diff of the user's edits, or empty output if " +
      "the user closed the editor without changes (which means approved, and " +
      "the session will auto-switch to the build agent on a per-session " +
      "build model — set via /set-build-model, or falling back to " +
      "agent.build.model, or config.model). Iterate until the result is empty.",
    args: {
      plan: tool.schema.string().describe(
        "full markdown of the plan to show the user for review"
      ),
    },
    async execute(args, context) {
      const result = await runPlanReview($, args.plan)
      const trimmed = result.trim()
      if (!trimmed) {
        await exitPlanMode(client, buildModels, chatMessageMemory, lastResolution, context.sessionID, "User closed editor without changes.")
        return "Plan reviewed, no changes. Approved by user. Switched to build agent."
      }
      return FEEDBACK_HEADER + result + REVISION_PROMPT
    },
  })

  await log(client, "info", `plan-review: tool 'plan_review' created, args: ${Object.keys(plan_review.args).join(",")}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L554): ${(e as Error)?.message ?? String(e)}`) })

  return {
    tool: { plan_review },

    // Whitelist plan_review in primary_tools (mirrors plannotator). Keeps the
    // tool visible to primary agents even when an `agent.tools` map would
    // otherwise filter it out.
    config: async (opencodeConfig) => {
      await log(client, "info", "plan-review: config hook fired").catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L563): ${(e as Error)?.message ?? String(e)}`) })
      try {
        const exp = (opencodeConfig as any).experimental ?? {}
        const tools: string[] = exp.primary_tools ?? []
        if (!tools.includes("plan_review")) {
          ;(opencodeConfig as any).experimental = {
            ...exp,
            primary_tools: [...tools, "plan_review"],
          }
          await log(client, "info", `plan-review: config hook added plan_review to primary_tools (count=${tools.length + 1})`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L572): ${(e as Error)?.message ?? String(e)}`) })
        }
        // Permission configuration: allow plan agent to call plan_review,
        // deny for build agent so it's not distracted by a planning tool.
        // opencode config can define an agent as a single object or an array
        // of objects when multiple agents share a name. Handle both cases.
        const agents = (opencodeConfig as any).agent ?? {}
        const planEntry = agents.plan
        if (planEntry) {
          const plans = Array.isArray(planEntry) ? planEntry : [planEntry]
          for (const ag of plans) {
            ag.permission ??= {}
            ag.permission.plan_review = "allow"
          }
        }
        const buildEntry = agents.build
        if (buildEntry) {
          const builds = Array.isArray(buildEntry) ? buildEntry : [buildEntry]
          for (const ag of builds) {
            ag.permission ??= {}
            ag.permission.plan_review = "deny"
          }
        }
      } catch (err) {
        await log(client, "warn", `plan-review: config hook failed: ${(err as Error).message}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L575): ${(e as Error)?.message ?? String(e)}`) })
      }
    },

    "chat.message": async (input, _output) => {
      await log(
        client,
        "info",
        `plan-review: chat.message HOOK FIRED: session=${input.sessionID ?? "?"} agent=${input.agent ?? "?"} model=${input.model?.providerID ?? "?"}/${input.model?.modelID ?? "?"}`,
      ).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L584): ${(e as Error)?.message ?? String(e)}`) })

      // chat.message is the ONLY server-plugin hook that reliably fires
      // for both user-typed and programmatic prompts — see
      // packages/opencode/src/session/prompt.ts:999. The TUI plugin
      // calls promptAsync with noReply:true on every Tab cycle, which
      // fires this hook for the new agent even though no real message
      // reaches the LLM. Use this as the single source of truth for
      // per-session, per-agent last-picked model. exitPlanMode()
      // prioritises this map over any global file state.
      if (input.sessionID && input.agent && input.model) {
        let perSession = chatMessageMemory.get(input.sessionID)
        if (!perSession) {
          perSession = new Map()
          chatMessageMemory.set(input.sessionID, perSession)
        }
        perSession.set(input.agent, {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
        })
        await log(
          client,
          "info",
          `chat.message: session=${input.sessionID} agent=${input.agent} model=${input.model.providerID}/${input.model.modelID}`,
        ).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L502): ${(e as Error)?.message ?? String(e)}`) })
      }

      // (Deferred-picker promotion moved out of this hook — see
      // exitPlanMode's promotion block. It used to live here but
      // races with the TUI plugin's metadata write: the user's
      // first real prompt fires chat.message before the TUI's
      // session.updated handler runs writeDeferredToMetadata, so
      // this hook read empty metadata and promoted nothing.
      // exitPlanMode runs much later (when the user approves the
      // plan, seconds-to-minutes after the flush), by which point
      // the metadata is guaranteed to be present.)
    },

    "experimental.chat.system.transform": async (input, output) => {
      await log(
        client,
        "info",
        `plan-review: system.transform HOOK FIRED: session=${input.sessionID ?? "?"} system_blocks=${output.system.length}`,
      ).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L637): ${(e as Error)?.message ?? String(e)}`) })
      const joined = output.system.join("\n").toLowerCase()
      if (joined.includes("title generator") || joined.includes("generate a title")) return
      // Skip injection for the build agent (mirrors plannotator's skip).
      if (input.sessionID) try {
        const msgs = await client.session.messages({ path: { id: input.sessionID } })
        const data = (msgs as any)?.data ?? msgs
        const list = Array.isArray(data) ? data : []
        for (let i = list.length - 1; i >= 0; i--) {
          const m = list[i]
          if (m?.info?.role === "user" && m?.info?.agent) {
            if (m.info.agent === "build") return
            break
          }
        }
      } catch (e) { console.error(`plan-review: agent check failed: ${(e as Error)?.message ?? String(e)}`) }
      // Rewrite plan_exit/ExitPlanMode references in existing system blocks.
      // Built-in plan-mode prompts contain strong directives like "Phase 5:
      // Call plan_exit" and "your turn should only end with calling plan_exit".
      // If left intact, the model follows those and ignores plan_review.
      let rewrites = 0
      for (let i = 0; i < output.system.length; i++) {
        const before = output.system[i]
        output.system[i] = before
          .replace(/\bplan_exit\b/g, "plan_review")
          .replace(/\bExitPlanMode\b/g, "plan_review")
        if (output.system[i] !== before) rewrites++
      }
      if (rewrites > 0) {
        await log(client, "info", `plan-review: rewrote plan_exit→plan_review in ${rewrites} system block(s)`).catch((e: unknown) => { console.error(`plan-review: swallowed error in rewrite-diag: ${(e as Error)?.message ?? String(e)}`) })
      }
      output.system.push(`
## Plan Review

When you have completed your plan, call the \`plan_review\` tool to submit it for user review. The user can annotate, approve, or request changes.

Do NOT ask the user for confirmation or approval in chat — always use the \`plan_review\` tool. Just call it directly.

If your plan is rejected, you will receive feedback — revise the plan and call \`plan_review\` again.

Do NOT proceed with implementation until the plan is approved.
`)
      await log(client, "info", `plan-review: system prompt injected (${output.system.length} blocks, ${output.system[output.system.length - 1]!.length} chars)`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L662): ${(e as Error)?.message ?? String(e)}`) })
    },

    event: async ({ event }) => {
      const e = event as any

      // Diagnostic block removed. Earlier iterations logged the first
      // few event types the server plugin received (plan-review: diag
      // event discovery #N). That served its purpose: it proved that
      // session.* events are filtered out by the server plugin event
      // hook at packages/opencode/src/plugin/index.ts:252 (only
      // plugin.added events reach us, nothing else). Per AGENTS.md,
      // diagnostic code that has done its job should not stay. We
      // removed it once we understood the actual signal flow and
      // confirmed the chat.message handler is what we should rely on
      // for agent-switch notifications.

      // rememberBuildModel takes session.updated events and stores
      // per-session build models when the event carries a build agent
      // line. It is the only event type the hook reliably receives.
      try {
        rememberBuildModel(e, buildModels)
      } catch (err) {
        await log(client, "warn", `plan-review: rememberBuildModel failed: ${(err as Error).message}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L556): ${(e as Error)?.message ?? String(e)}`) })
      }
      if (e.type === "session.updated" || e.type === "session.updated.1") {
        const info = e.properties?.info ?? e.data?.info
        const sid = info?.id
        if (info?.agent === "build" && sid && buildModels.has(sid)) {
          const m = buildModels.get(sid)!
          await log(client, "info", `plan-review: build event memory updated: session=${sid} -> ${m.providerID}/${m.modelID}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L560): ${(e as Error)?.message ?? String(e)}`) })
        }
      }

      if (e.type !== "command.executed" && e.type !== "tui.command.execute") return

      const props = e.properties ?? {}
      const name = (props.name ?? (e as Record<string, unknown>).command) as string | undefined
      const rawArgs = (props.arguments ?? "") as string
      const sessionID = props.sessionID as string | undefined

      if (name === "set-build-model") {
        if (!sessionID) {
          await log(client, "error", "set-build-model: no active session").catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L777): ${(e as Error)?.message ?? String(e)}`) })
          return
        }
        const arg = rawArgs.trim()

        // numeric index from last shown list
        const numIdx = Number(arg)
        if (arg !== "" && Number.isInteger(numIdx) && numIdx > 0) {
          const list = lastShownModels.get(sessionID) ?? []
          const entry = list[numIdx - 1]
          if (!entry) {
            await client.session.prompt({
              path: { id: sessionID },
              body: {
                noReply: true,
                parts: [{
                  type: "text",
                  text: `set-build-model: index ${numIdx} out of range (last list had ${list.length} entries). Run \`/set-build-model\` to refresh.`,
                }],
              },
            }).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L797): ${(e as Error)?.message ?? String(e)}`) })
            return
          }
          buildModels.set(sessionID, { providerID: entry.providerID, modelID: entry.modelID })
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{
                type: "text",
                text: `Build model for this session set to: \`${entry.providerID}/${entry.modelID}\` (picked #${numIdx} from list). On the next plan approval, the session will switch to this model before build executes.`,
              }],
            },
          }).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L810): ${(e as Error)?.message ?? String(e)}`) })
          return
        }

        // explicit provider/model string
        if (arg !== "") {
          const parsed = parseModelString(arg)
          if (!parsed) {
            await log(client, "error", `set-build-model: invalid format "${arg}". Expected "provider/model-id".`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L818): ${(e as Error)?.message ?? String(e)}`) })
            return
          }
          buildModels.set(sessionID, parsed)
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{
                type: "text",
                text: `Build model for this session set to: \`${parsed.providerID}/${parsed.modelID}\`. On the next plan approval, the session will switch to this model before build executes.`,
              }],
            },
          }).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L831): ${(e as Error)?.message ?? String(e)}`) })
          return
        }

        // no args: list providers
        const entries = await listAvailableModels(client)
        lastShownModels.set(sessionID, entries)
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{
              type: "text",
              text: `# set-build-model picker\n\nAvailable models (${entries.length}):\n\n${formatProviderList(entries)}\n\nReply with:\n- \`/set-build-model <number>\` to pick from this list (e.g. \`/set-build-model 5\`)\n- \`/set-build-model <provider>/<model-id>\` to set directly (e.g. \`/set-build-model ya-glm/glm\`)\n\nStored in this plugin's in-memory session memory — lost on opencode restart. For runtime model picker use the opencode UI (Ctrl-X M).`,
            }],
          },
        }).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L847): ${(e as Error)?.message ?? String(e)}`) })
        return
      }

      if (name === "plan-diag") {
        if (!sessionID) {
          await log(client, "error", "plan-diag: no active session").catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L853): ${(e as Error)?.message ?? String(e)}`) })
          return
        }
        const subCmd = rawArgs.trim()
        if (subCmd === "reset") {
          buildModels.clear()
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{
                type: "text",
                text: `plan-diag: build-event memory cleared. Next session.updated will repopulate it.`,
              }],
            },
          }).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L868): ${(e as Error)?.message ?? String(e)}`) })
          return
        }
        const memEntries = Array.from(buildModels.entries()).map(([sid, m]) => `  ${sid.slice(0, 16)}… → ${m.providerID}/${m.modelID}`).join("\n") || "  (empty)"
        const chatEntries = Array.from(chatMessageMemory.entries()).map(([sid, byAgent]) => {
          const lines = Array.from(byAgent.entries()).map(([agent, m]) => `    ${agent}: ${m.providerID}/${m.modelID}`).join("\n")
          return `  ${sid.slice(0, 16)}…\n${lines}`
        }).join("\n") || "  (empty)"
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{
              type: "text",
              text: `# plan-diag

## /set-build-model overrides (in-memory)
${memEntries}

## chat.message memory (last inline model per agent, from TUI picker)
${chatEntries}

## Current session
- sessionID: \`${sessionID}\`
- last target resolved: ${lastResolution.target ? `${lastResolution.target.providerID}/${lastResolution.target.modelID} (source: ${lastResolution.source})` : "never called"}

Resolution priority on plan approval:
1. chat.message memory for build agent (last picker choice)
2. /set-build-model override
3. agent.build.model from opencode.jsonc
4. config.model global default
5. opencode default

Diagnostic lines \`plan-review: session.updated: ...\` and \`plan-review: chat.message captured: ...\` appear in opencode log.
`,
            }],
          },
        }).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L905): ${(e as Error)?.message ?? String(e)}`) })
        return
      }

      if (name !== "plan-review") return

      const filePath = rawArgs.trim()
      if (!filePath) {
        await log(client, "error", "Usage: /plan-review <path-to-plan.md>").catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L913): ${(e as Error)?.message ?? String(e)}`) })
        return
      }
      if (!sessionID) {
        await log(client, "error", "plan-review: no active session").catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L917): ${(e as Error)?.message ?? String(e)}`) })
        return
      }

      const absolutePath = resolve(filePath)
      if (!existsSync(absolutePath)) {
        await log(client, "error", `plan-review: file not found: ${absolutePath}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L923): ${(e as Error)?.message ?? String(e)}`) })
        return
      }

      const planContent = readFileSync(absolutePath, "utf8")
      const diff = await runPlanReview($, planContent)
      const trimmed = diff.trim()

      const feedback = trimmed
        ? `# Plan Review Feedback\n\nFile: \`${absolutePath}\`\n\n${FEEDBACK_HEADER}${diff}\n${REVISION_PROMPT}`
        : `# Plan Review Approved\n\nFile: \`${absolutePath}\` — no changes.`

      try {
        await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: feedback }] },
        })
        if (!trimmed) {
          await exitPlanMode(client, buildModels, chatMessageMemory, lastResolution, sessionID, `User approved \`${absolutePath}\`.`)
        }
      } catch (err) {
        await log(client, "error", `plan-review: failed to send feedback: ${(err as Error).message}`).catch((e: unknown) => { console.error(`plan-review: swallowed error in anon (L944): ${(e as Error)?.message ?? String(e)}`) })
      }
    },

    "tool.definition": async (input, output) => {
      // Add plan_review to every agent's tool definitions so the model
      // always sees it, even when the agent's default tools exclude it.
      if (input.toolID === "plan_review") {
        await log(client, "info", `plan-review: tool.definition fired for plan_review`).catch((e: unknown) => { console.error(`plan-review: swallowed error in diag (L827): ${(e as Error)?.message ?? String(e)}`) })
        return
      }
      // Suppress plan_exit — model sees two similar tools (plan_exit and
      // plan_review) and often picks the wrong one. Redirect to plan_review.
      if (input.toolID === "plan_exit") {
        output.description = "Do not call this tool. Use plan_review to submit your plan for review."
      }
      // Suppress todowrite during planning — the model should focus
      // on planning, not on writing todo items.
      if (input.toolID === "todowrite") {
        output.description = "During planning, use plan_review instead. Call plan_review when your plan is complete."
      }
    },
  }
}

export default PlanReviewPlugin