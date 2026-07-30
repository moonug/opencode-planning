import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, lstatSync, chmodSync, statSync, copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { dirname, resolve, join, basename } from "node:path"
import { homedir as osHomedir, tmpdir } from "node:os"

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

interface TimedModelRef extends ModelRef {
  capturedAt: number
}

type ExitResult =
  | { status: "switched"; target: ModelRef; source: string }
  | { status: "no_model" }
  | { status: "prompt_failed"; error: string }

import { fileURLToPath } from "node:url"

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH =
  process.env.PLAN_REVIEW_SCRIPT ?? join(PLUGIN_DIR, "bin", "plan-review.py")
const COMMAND_SOURCES = [
  join(PLUGIN_DIR, "commands", "plan-review.md"),
  join(PLUGIN_DIR, "commands", "set-build-model.md"),
  join(PLUGIN_DIR, "commands", "plan-diag.md"),
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
  } catch (err) {
    // existsSync catches the missing case later; log unexpected errors.
    console.error(`plan-review: ensureExecutable(${path}) failed: ${(err as Error).message}`)
  }
}

const { parse: parseJsonc, modify: modifyJsonc, applyEdits } = require("jsonc-parser") as {
  parse: (text: string, errors?: unknown[]) => unknown
  modify: (text: string, path: Array<string | number>, value: unknown, options?: { formattingOptions: { insertSpaces: boolean; tabSize: number } }) => any
  applyEdits: (text: string, edits: any) => string
}

// ensureManagedLink — create or refresh a symlink only when the existing
// path is absent, already ours, or a symlink into PLUGIN_DIR. Regular
// files and foreign symlinks are never touched.
function ensureManagedLink(source: string, linkPath: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(linkPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`plan-review: lstat failed for ${linkPath}: ${(err as Error).message}`)
    }
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      try {
        const target = readlinkSync(linkPath)
        const resolved = resolve(dirname(linkPath), target)
        if (resolved === resolve(source)) return // already correct
        if (resolved.startsWith(PLUGIN_DIR)) {
          // Our symlink, stale target — update it.
          unlinkSync(linkPath)
        } else {
          // Foreign symlink — don't touch.
          console.error(`plan-review: not overwriting foreign symlink at ${linkPath} -> ${target}`)
          return
        }
      } catch (err) {
        console.error(`plan-review: readlink failed for ${linkPath}: ${(err as Error).message}`)
        return
      }
    } else {
      // Regular file or directory — user-created, don't touch.
      console.error(`plan-review: not overwriting existing file at ${linkPath}`)
      return
    }
  }
  try {
    symlinkSync(source, linkPath)
  } catch (symErr) {
    console.error(`plan-review: failed to symlink ${linkPath}: ${(symErr as Error).message}. Symlink is required — run as a user with permission to create symlinks in ~/.config/opencode/commands/`)
  }
}

// ensureCommandLinks — symlink each slash-command into
// ~/.config/opencode/commands/ without clobbering user files or foreign
// links. Then register the TUI plugin in tui.jsonc using jsonc-parser
// so comments/trailing commas are preserved.
function ensureCommandLinks(): void {
  for (const source of COMMAND_SOURCES) {
    const linkPath = join(homedir(), ".config", "opencode", "commands", basename(source))
    try {
      mkdirSync(dirname(linkPath), { recursive: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        console.error(`plan-review: mkdir failed for ${dirname(linkPath)}: ${(err as Error).message}`)
      }
    }
    ensureManagedLink(source, linkPath)
  }
  // Register TUI plugin in tui.jsonc (NOT in ~/.config/opencode/plugins/ —
  // that path is server-plugin territory and the server loader requires
  // a .server() export, which a TUI plugin doesn't have).
  try {
    const tuiPluginPath = join(PLUGIN_DIR, "tui-plugin.tsx")
    const previousTuiPluginPath = join(PLUGIN_DIR, "tui-plugin.ts")
    const tuiJsonPath = join(homedir(), ".config", "opencode", "tui.jsonc")
    const tuiJsonLegacy = join(homedir(), ".config", "opencode", "tui.json")

    // Remove legacy symlink at ~/.config/opencode/plugins/plan-review-tui.ts
    // only if it was created by THIS package (symlink target inside PLUGIN_DIR).
    const legacySymlink = join(homedir(), ".config", "opencode", "plugins", "plan-review-tui.ts")
    try {
      const lstat = lstatSync(legacySymlink)
      if (lstat.isSymbolicLink()) {
        const target = readlinkSync(legacySymlink)
        if (resolve(dirname(legacySymlink), target).startsWith(PLUGIN_DIR)) {
          unlinkSync(legacySymlink)
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`plan-review: legacy symlink check failed: ${(err as Error).message}`)
      }
    }

    // Read existing config (tui.jsonc first, then legacy tui.json).
    let existing: string | undefined
    try { existing = readFileSync(tuiJsonPath, "utf8") } catch (err) {
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

    if (existing !== undefined) {
      // Parse with JSONC support; on error, do NOT overwrite the file.
      const errors: unknown[] = []
      const parsed = (parseJsonc(existing, errors) ?? {}) as { plugin?: unknown }
      if (errors.length > 0) {
        console.error(`plan-review: ${tuiJsonPath} has parse errors, not modifying: ${JSON.stringify(errors)}`)
        return
      }
      const plugins = Array.isArray(parsed.plugin) ? parsed.plugin as unknown[] : []
      const nextPlugins = plugins.filter((plugin) => plugin !== previousTuiPluginPath)
      if (!nextPlugins.includes(tuiPluginPath)) nextPlugins.push(tuiPluginPath)
      if (JSON.stringify(nextPlugins) !== JSON.stringify(plugins)) {
        const edits = modifyJsonc(existing, ["plugin"], nextPlugins, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        })
        const newText = applyEdits(existing, edits)
        try { mkdirSync(dirname(tuiJsonPath), { recursive: true }) } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
        }
        writeFileSync(tuiJsonPath, newText)
      }
    } else {
      // No config yet — create fresh.
      const newText = JSON.stringify({ plugin: [tuiPluginPath] }, null, 2) + "\n"
      try { mkdirSync(dirname(tuiJsonPath), { recursive: true }) } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      }
      writeFileSync(tuiJsonPath, newText)
    }
  } catch (err) {
    console.error(`plan-review: tui.jsonc registration failed: ${(err as Error).message}`)
  }
}

function parseModelString(s: string): ModelRef | undefined {
  const m = s.trim().match(/^([^/\s]+)\/(.+)$/)
  if (!m) return undefined
  return { providerID: m[1]!, modelID: m[2]! }
}

async function runPlanReview($: any, planText: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "opencode-plan-review-"))
  const tmpPath = join(tmpDir, "plan.md")
  writeFileSync(tmpPath, planText, "utf8")
  try {
    return await $`${SCRIPT_PATH} --file ${tmpPath}`.text()
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`plan-review: failed to clean temp dir ${tmpDir}: ${(err as Error).message}`)
      }
    }
  }
}

function log(client: any, level: "debug" | "info" | "warn" | "error", message: string): Promise<unknown> {
  return client.app.log({ body: { service: "plan-review", level, message } })
}

// logged() — fire-and-forget variant of log() that never swallows an
// error silently. Per AGENTS.md: `catch {}` is forbidden. This is the only
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

// visibleErr() — helper for non-log promises. Records the error on the
// server log first, falls back to console.error if server is unreachable.
async function visibleErr(client: any, context: string, e: unknown): Promise<void> {
  const errText = (e as Error)?.message ?? String(e)
  try {
    await logged(client, "warn", `swallowed error in ${context}: ${errText}`)
  } catch (logErr) {
    // logged() already tried console.error; this is a last resort.
    console.error(`plan-review: swallowed error in ${context}: ${errText} (log also failed: ${(logErr as Error)?.message ?? String(logErr)})`)
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
  } catch (err) {
    console.error(`plan-review: getBuildAgentModel failed: ${(err as Error)?.message ?? String(err)}`)
  }
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
  } catch (err) {
    console.error(`plan-review: getPlanAgentModel failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

async function getGlobalModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.config.get()
    const model = (res as any)?.data?.model ?? (res as any)?.model
    if (typeof model === "string") return parseModelString(model)
    if (model && typeof model === "object"
      && typeof model.providerID === "string"
      && typeof model.modelID === "string") {
      return { providerID: model.providerID, modelID: model.modelID }
    }
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

interface BuildCandidate extends ModelRef {
  capturedAt: number
  source: string
}

async function getSessionHistoryBuildMessage(client: any, sessionID: string): Promise<{ providerID: string; modelID: string; capturedAt: number } | undefined> {
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const data = (res as any)?.data ?? res
    const list = Array.isArray(data) ? data : []
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      if (m?.info?.role === "user" && m?.info?.agent === "build" && m?.model?.providerID && m?.model?.modelID) {
        const time = m.info.time?.created ? new Date(m.info.time.created).getTime() : Date.now()
        return { providerID: m.model.providerID, modelID: m.model.modelID, capturedAt: time }
      }
    }
  } catch (err) {
    console.error(`plan-review: getSessionHistoryBuildMessage failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

async function getTuiCurrentSelection(client: any, sessionID: string): Promise<{ plan?: BuildCandidate; build?: BuildCandidate } | undefined> {
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = (res as any)?.data ?? res
    const metadata = data?.metadata
    const sel = metadata?.tuiCurrentSelection
    if (!sel || typeof sel !== "object") return undefined
    const result: { plan?: BuildCandidate; build?: BuildCandidate } = {}
    if (sel.plan && typeof sel.plan === "object") {
      const p = sel.plan as any
      if (p.providerID && p.modelID) {
        result.plan = { providerID: p.providerID, modelID: p.modelID, capturedAt: typeof p.pickedAt === "number" ? p.pickedAt : Date.now(), source: "TUI current selection (plan)" }
      }
    }
    if (sel.build && typeof sel.build === "object") {
      const b = sel.build as any
      if (b.providerID && b.modelID) {
        result.build = { providerID: b.providerID, modelID: b.modelID, capturedAt: typeof b.pickedAt === "number" ? b.pickedAt : Date.now(), source: "TUI current selection (build)" }
      }
    }
    if (!result.plan && !result.build) return undefined
    return result
  } catch (err) {
    console.error(`plan-review: getTuiCurrentSelection failed: ${(err as Error)?.message ?? String(err)}`)
    return undefined
  }
}

async function getDeferredPicks(client: any, sessionID: string): Promise<{ plan?: BuildCandidate; build?: BuildCandidate } | undefined> {
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = (res as any)?.data ?? res
    const deferred = data?.metadata?.planReviewDeferredPicks
    if (!deferred || typeof deferred !== "object") return undefined
    const result: { plan?: BuildCandidate; build?: BuildCandidate } = {}
    for (const agent of ["plan", "build"] as const) {
      const m = (deferred as any)[agent]
      if (m && typeof m === "object" && typeof m.providerID === "string" && typeof m.modelID === "string") {
        const pickTime = typeof m.pickedAt === "number" ? m.pickedAt : 0
        result[agent] = { providerID: m.providerID, modelID: m.modelID, capturedAt: pickTime, source: `TUI explicit picker (${agent})` }
      }
    }
    if (!result.plan && !result.build) return undefined
    return result
  } catch (err) {
    console.error(`plan-review: getDeferredPicks failed: ${(err as Error)?.message ?? String(err)}`)
    return undefined
  }
}

async function exitPlanMode(
  client: any,
  buildModels: Map<string, ModelRef>,
  chatMessageMemory: Map<string, Map<string, TimedModelRef>>,
  lastResolution: { target?: ModelRef; source?: string },
  sessionID: string | undefined,
  summary: string,
): Promise<ExitResult> {
  if (!sessionID) return { status: "no_model" }
  await logged(client, "info", `plan-review: exitPlanMode called for session ${sessionID}`)

  const overridden = buildModels.get(sessionID)
  const perAgent = chatMessageMemory.get(sessionID)
  const fromChat = perAgent?.get("build")

  const [tuiSelection, historyBuild, agentCfg, planCfg, globalCfg] = await Promise.all([
    withTimeoutSafe(getTuiCurrentSelection(client, sessionID), 3000, undefined),
    withTimeoutSafe(getSessionHistoryBuildMessage(client, sessionID), 3000, undefined),
    withTimeoutSafe(getBuildAgentModel(client), 2000, undefined),
    withTimeoutSafe(getPlanAgentModel(client), 2000, undefined),
    withTimeoutSafe(getGlobalModel(client), 2000, undefined),
  ])

  const deferredPicks = await withTimeoutSafe(getDeferredPicks(client, sessionID), 3000, undefined)

  await logged(
    client,
    "info",
    `plan-review: exitPlanMode sources: session=${sessionID} ` +
      `fromChat=${fromChat ? `${fromChat.providerID}/${fromChat.modelID}` : "∅"} ` +
      `historyBuild=${historyBuild ? `${historyBuild.providerID}/${historyBuild.modelID}` : "∅"} ` +
      `tuiCurrentBuild=${tuiSelection?.build ? `${tuiSelection.build.providerID}/${tuiSelection.build.modelID}` : "∅"} ` +
      `tuiCurrentPlan=${tuiSelection?.plan ? `${tuiSelection.plan.providerID}/${tuiSelection.plan.modelID}` : "∅"} ` +
      `deferredBuild=${deferredPicks?.build ? `${deferredPicks.build.providerID}/${deferredPicks.build.modelID}` : "∅"} ` +
      `overridden=${overridden ? `${overridden.providerID}/${overridden.modelID}` : "∅"} ` +
      `agentCfg=${agentCfg ? `${agentCfg.providerID}/${agentCfg.modelID}` : "∅"} ` +
      `planCfg=${planCfg ? `${planCfg.providerID}/${planCfg.modelID}` : "∅"} ` +
      `globalCfg=${globalCfg ? `${globalCfg.providerID}/${globalCfg.modelID}` : "∅"}`,
  )

  interface ResolvedCandidate extends ModelRef {
    capturedAt: number
    source: string
  }

  const candidates: Array<ResolvedCandidate> = []

  if (fromChat) {
    candidates.push({ providerID: fromChat.providerID, modelID: fromChat.modelID, capturedAt: fromChat.capturedAt, source: "chat.message (build)" })
  }
  if (deferredPicks?.build) {
    candidates.push({ providerID: deferredPicks.build.providerID, modelID: deferredPicks.build.modelID, capturedAt: deferredPicks.build.capturedAt, source: deferredPicks.build.source })
  }
  if (tuiSelection?.build) {
    candidates.push({ providerID: tuiSelection.build.providerID, modelID: tuiSelection.build.modelID, capturedAt: tuiSelection.build.capturedAt, source: tuiSelection.build.source })
  }
  if (historyBuild) {
    candidates.push({ providerID: historyBuild.providerID, modelID: historyBuild.modelID, capturedAt: historyBuild.capturedAt, source: "session history (build)" })
  }

  const fromChatPlan = perAgent?.get("plan")

  let target: ModelRef | undefined
  let source: string

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.capturedAt - a.capturedAt)
    const best = candidates[0]!
    target = { providerID: best.providerID, modelID: best.modelID }
    source = best.source
  } else if (overridden) {
    target = overridden; source = "build model memory"
  } else if (fromChatPlan) {
    target = { providerID: fromChatPlan.providerID, modelID: fromChatPlan.modelID }; source = "chat.message (plan)"
  } else if (tuiSelection?.plan) {
    target = { providerID: tuiSelection.plan.providerID, modelID: tuiSelection.plan.modelID }; source = "TUI current selection (plan)"
  } else if (agentCfg) {
    target = agentCfg; source = "agent.build.model"
  } else if (globalCfg) {
    target = globalCfg; source = "config.model"
  } else if (planCfg) {
    target = planCfg; source = "agent.plan.model (fallback)"
  } else {
    source = "opencode default"
  }

  lastResolution.target = target
  lastResolution.source = source

  await logged(
    client,
    "info",
    `plan-review: exitPlanMode resolution: session=${sessionID} target=${target ? `${target.providerID}/${target.modelID}` : "undefined"} source=${source}`,
  )

  if (!target) {
    await logged(client, "warn", `auto-exit: no build model resolved (sources tried: ${source}), asking user to switch manually`)
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
    return { status: "no_model" }
  }

  await logged(client, "info", `auto-exit to build. model=${target.providerID}/${target.modelID} source=${source}`)

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
    return { status: "switched", target, source }
  } catch (err) {
    const errMsg = (err as Error)?.message ?? String(err)
    await logged(client, "error", `failed to send build-exit prompt: ${errMsg}`)
    return { status: "prompt_failed", error: errMsg }
  }
}

async function withTimeoutSafe<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export const PlanReviewPlugin: Plugin = async ({ $, client, serverUrl }) => {
  const VERSION = require("./package.json").version
  await logged(client, "info", `plan-review: plugin init v${VERSION} build=v${VERSION}`)
  await logged(client, "info", `plan-review: argv0=${(process.argv[1] ?? "unknown").split("/").slice(-3).join("/")}`)

  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `plan-review: helper script not found at ${SCRIPT_PATH}. ` +
        `Set PLAN_REVIEW_SCRIPT env var or restore bin/plan-review.py next to the plugin.`
    )
  }
  ensureExecutable(SCRIPT_PATH)
  ensureCommandLinks()

  const buildModels = new Map<string, ModelRef>()
  const lastResolution: { target?: ModelRef; source?: string } = {}
  const lastShownModels = new Map<string, ProviderListEntry[]>()
  const chatMessageMemory = new Map<string, Map<string, TimedModelRef>>()
  // Keyed by sessionID → agent → model. Populated by chat.message hook
  // (fires for every real and synthetic prompt). exitPlanMode uses it as
  // the first candidate in a timestamp-ordered resolution chain.
  // No model.json reads — model.json is global and leaks model choices
  // across sessions. All model attribution is per-session:
  // chatMessageMemory, buildModels, and session metadata (per-session row
  // written by TUI plugin with tuiCurrentSelection and planReviewDeferredPicks).

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
        const exit = await exitPlanMode(client, buildModels, chatMessageMemory, lastResolution, context.sessionID, "User closed editor without changes.")
        if (exit.status === "switched") {
          return `Plan reviewed, no changes. Approved by user. Switched to build agent (${exit.target.providerID}/${exit.target.modelID}).`
        }
        if (exit.status === "no_model") {
          return "Plan approved by user, but no build model resolved. See the message above for manual switch instructions. Do NOT proceed until the user has switched."
        }
        return `Plan approved by user, but failed to switch to build agent: ${exit.error}. Run \`/agent build\` manually before proceeding.`
      }
      return FEEDBACK_HEADER + result + REVISION_PROMPT
    },
  })

  await logged(client, "info", `plan-review: tool 'plan_review' created, args: ${Object.keys(plan_review.args).join(",")}`)

  return {
    tool: { plan_review },

    // Whitelist plan_review in primary_tools (mirrors plannotator). Keeps the
    // tool visible to primary agents even when an `agent.tools` map would
    // otherwise filter it out.
    config: async (opencodeConfig) => {
      await logged(client, "info", "plan-review: config hook fired")
      try {
        const exp = (opencodeConfig as any).experimental ?? {}
        const tools: string[] = exp.primary_tools ?? []
        if (!tools.includes("plan_review")) {
          ;(opencodeConfig as any).experimental = {
            ...exp,
            primary_tools: [...tools, "plan_review"],
          }
          await logged(client, "info", `plan-review: config hook added plan_review to primary_tools (count=${tools.length + 1})`)
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
        await logged(client, "warn", `plan-review: config hook failed: ${(err as Error).message}`)
      }
    },

    "chat.message": async (input, _output) => {
      await logged(client,
        "info",
        `plan-review: chat.message HOOK FIRED: session=${input.sessionID ?? "?"} agent=${input.agent ?? "?"} model=${input.model?.providerID ?? "?"}/${input.model?.modelID ?? "?"}`,
      )

      // chat.message is the ONLY server-plugin hook that reliably fires
      // for both user-typed and programmatic prompts — see
      // packages/opencode/src/session/prompt.ts:999. It is the safe
      // stock-opencode fallback when the fork's native local selection
      // API is absent. Use it as per-session, per-agent memory;
      // exitPlanMode() uses it as first candidate in timestamp-ordered
      // resolution (chat.message → explicit picker → TUI snapshot →
      // session history → /set-build-model → config defaults).
      if (input.sessionID && input.agent && input.model) {
        let perSession = chatMessageMemory.get(input.sessionID)
        if (!perSession) {
          perSession = new Map()
          chatMessageMemory.set(input.sessionID, perSession)
        }
        perSession.set(input.agent, {
          providerID: input.model.providerID,
          modelID: input.model.modelID,
          capturedAt: Date.now(),
        })
        await logged(client, "info", `chat.message: session=${input.sessionID} agent=${input.agent} model=${input.model.providerID}/${input.model.modelID}`)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      await logged(client,
        "info",
        `plan-review: system.transform HOOK FIRED: session=${input.sessionID ?? "?"} system_blocks=${output.system.length}`,
      )
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
        const before = output.system[i]!
        output.system[i] = before
          .replace(/\bplan_exit\b/g, "plan_review")
          .replace(/\bExitPlanMode\b/g, "plan_review")
        if (output.system[i] !== before) rewrites++
      }
      if (rewrites > 0) {
        await logged(client, "info", `plan-review: rewrote plan_exit→plan_review in ${rewrites} system block(s)`)
      }
      output.system.push(`
## Plan Review

When you have completed your plan, call the \`plan_review\` tool to submit it for user review. The user can annotate, approve, or request changes.

Do NOT ask the user for confirmation or approval in chat — always use the \`plan_review\` tool. Just call it directly.

If your plan is rejected, you will receive feedback — revise the plan and call \`plan_review\` again.

Do NOT proceed with implementation until the plan is approved.
`)
      await logged(client, "info", `plan-review: system prompt injected (${output.system.length} blocks, ${output.system[output.system.length - 1]!.length} chars)`)
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
        await logged(client, "warn", `plan-review: rememberBuildModel failed: ${(err as Error).message}`)
      }
      if (e.type === "session.updated" || e.type === "session.updated.1") {
        const info = e.properties?.info ?? e.data?.info
        const sid = info?.id
        if (info?.agent === "build" && sid && buildModels.has(sid)) {
          const m = buildModels.get(sid)!
          await logged(client, "info", `plan-review: build event memory updated: session=${sid} -> ${m.providerID}/${m.modelID}`)
        }
      }

      if (e.type !== "command.executed" && e.type !== "tui.command.execute") return

      const props = e.properties ?? {}
      const name = (props.name ?? (e as Record<string, unknown>).command) as string | undefined
      const rawArgs = (props.arguments ?? "") as string
      const sessionID = props.sessionID as string | undefined

      if (name === "set-build-model") {
        if (!sessionID) {
          await logged(client, "error", "set-build-model: no active session")
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
            })
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
          })
          return
        }

        // explicit provider/model string
        if (arg !== "") {
          const parsed = parseModelString(arg)
          if (!parsed) {
            await logged(client, "error", `set-build-model: invalid format "${arg}". Expected "provider/model-id".`)
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
          })
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
        })
        return
      }

      if (name === "plan-diag") {
        if (!sessionID) {
          await logged(client, "error", "plan-diag: no active session")
          return
        }
        const subCmd = rawArgs.trim()
        if (subCmd === "reset") {
          buildModels.delete(sessionID)
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{
                type: "text",
                text: `plan-diag: build-event memory cleared for this session. Next session.updated will repopulate it.`,
              }],
            },
          })
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
1. chat.message (build agent, runtime)
2. TUI explicit picker (build agent)
3. TUI current selection (build agent, startup snapshot)
4. session history (build agent, last user prompt)
5. /set-build-model override
6. TUI current selection (plan agent)
7. agent.build.model from opencode.jsonc
8. config.model global default
9. agent.plan.model (last resort)

Diagnostic lines \`plan-review: exitPlanMode ...\` and \`plan-review-TUI: ...\` appear in opencode log.
`,
            }],
          },
        })
        return
      }

      if (name !== "plan-review") return

      const filePath = rawArgs.trim()
      if (!sessionID) {
        await logged(client, "error", "plan-review: no active session")
        return
      }
      if (!filePath) {
        await logged(client, "error", "Usage: /plan-review <path-to-plan.md>")
        await client.session.prompt({
          path: { id: sessionID },
          body: { noReply: true, parts: [{ type: "text", text: "Usage: /plan-review <path-to-plan.md>" }] },
        }).catch((e: unknown) => logged(client, "error", `plan-review: usage prompt failed: ${(e as Error)?.message ?? String(e)}`))
        return
      }

      const absolutePath = resolve(filePath)
      if (!existsSync(absolutePath)) {
        await logged(client, "error", `plan-review: file not found: ${absolutePath}`)
        await client.session.prompt({
          path: { id: sessionID },
          body: { noReply: true, parts: [{ type: "text", text: `plan-review: file not found: ${absolutePath}` }] },
        }).catch((e: unknown) => logged(client, "error", `plan-review: not-found prompt failed: ${(e as Error)?.message ?? String(e)}`))
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
          const exit = await exitPlanMode(client, buildModels, chatMessageMemory, lastResolution, sessionID, `User approved \`${absolutePath}\`.`)
          if (exit.status === "no_model") {
            await logged(client, "warn", `plan-review: no build model after approval of ${absolutePath}`)
          } else if (exit.status === "prompt_failed") {
            await logged(client, "error", `plan-review: build-exit prompt failed after approval of ${absolutePath}: ${exit.error}`)
          }
        }
      } catch (err) {
        await logged(client, "error", `plan-review: failed to send feedback: ${(err as Error).message}`)
      }
    },

    "tool.definition": async (input, output) => {
      // plan_review visibility is injected via the config hook's
      // primary_tools. This branch just logs for diagnostics.
      if (input.toolID === "plan_review") {
        await logged(client, "info", `plan-review: tool.definition fired for plan_review`)
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
