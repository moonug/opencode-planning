import { tool, type Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, chmodSync, statSync, copyFileSync } from "node:fs"
import { dirname, resolve, join, basename } from "node:path"
import { homedir } from "node:os"
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
}

function parseModelString(s: string): ModelRef | undefined {
  const m = s.trim().match(/^([^/\s]+)\/(.+)$/)
  if (!m) return undefined
  return { providerID: m[1]!, modelID: m[2]! }
}

function runPlanReview($: any, planText: string): Promise<string> {
  return $`${SCRIPT_PATH} --plan-text ${$.escape(planText)}`.text()
}

function log(client: any, level: "debug" | "info" | "warn" | "error", message: string): Promise<unknown> {
  return client.app.log({ body: { service: "plan-review", level, message } })
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
  } catch {}
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
  } catch {}
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
  await log(client, "info", `plan-review: exitPlanMode called for session ${sessionID}`).catch(() => {})

  const overridden = buildModels.get(sessionID)
  const perAgent = chatMessageMemory.get(sessionID)
  const fromChat = perAgent?.get("build")
  const [agentCfg, planCfg, globalCfg] = await Promise.all([
    withTimeoutSafe(getBuildAgentModel(client), 2000, undefined),
    withTimeoutSafe(getPlanAgentModel(client), 2000, undefined),
    withTimeoutSafe(getGlobalModel(client), 2000, undefined),
  ])

  let source: string
  let target: ModelRef | undefined
  if (fromChat)         { target = fromChat;    source = "chat.message" }
  else if (overridden)  { target = overridden;  source = "/set-build-model" }
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
  ).catch(() => {})

  if (!target) {
    await log(client, "warn", `auto-exit: no build model resolved (sources tried: ${source}), asking user to switch manually`).catch(() => {})
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
    } catch {}
    return
  }

  await log(
    client,
    "info",
    `auto-exit to build. model=${target.providerID}/${target.modelID} source=${source}`,
  ).catch(() => {})

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
    await log(client, "error", `failed to send build-exit prompt: ${(err as Error).message}`).catch(() => {})
  }
}

async function withTimeoutSafe<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export const PlanReviewPlugin: Plugin = async ({ $, client }) => {
  await log(client, "info", "plan-review: plugin init v0.2.0").catch(() => {})
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

  await log(client, "info", `plan-review: tool 'plan_review' created, args: ${Object.keys(plan_review.args).join(",")}`).catch(() => {})

  return {
    tool: { plan_review },

    // Whitelist plan_review in primary_tools (mirrors plannotator). Keeps the
    // tool visible to primary agents even when an `agent.tools` map would
    // otherwise filter it out.
    config: async (opencodeConfig) => {
      await log(client, "info", "plan-review: config hook fired").catch(() => {})
      try {
        const exp = (opencodeConfig as any).experimental ?? {}
        const tools: string[] = exp.primary_tools ?? []
        if (!tools.includes("plan_review")) {
          ;(opencodeConfig as any).experimental = {
            ...exp,
            primary_tools: [...tools, "plan_review"],
          }
          await log(client, "info", `plan-review: config hook added plan_review to primary_tools (count=${tools.length + 1})`).catch(() => {})
        }
      } catch (err) {
        await log(client, "warn", `plan-review: config hook failed: ${(err as Error).message}`).catch(() => {})
      }
    },

    "chat.message": async (input, _output) => {
      await log(
        client,
        "info",
        `plan-review: chat.message HOOK FIRED: session=${input.sessionID ?? "?"} agent=${input.agent ?? "?"} model=${input.model?.providerID ?? "?"}/${input.model?.modelID ?? "?"}`,
      ).catch(() => {})
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
        ).catch(() => {})
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      await log(
        client,
        "info",
        `plan-review: system.transform HOOK FIRED: session=${input.sessionID ?? "?"} system_blocks=${output.system.length}`,
      ).catch(() => {})
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
      } catch {}
      output.system.push(`
## Plan Review

When you have completed your plan, you MUST call the \`plan_review\` tool to submit it for user review. The user can annotate, approve, or request changes.

If your plan is rejected, you will receive feedback — revise the plan and call \`plan_review\` again.

Do NOT proceed with implementation until the plan is approved.
`)
      await log(client, "info", `plan-review: system prompt injected (${output.system.length} blocks, ${output.system[output.system.length - 1]!.length} chars)`).catch(() => {})
    },

    event: async ({ event }) => {
      const e = event as any

      // diagnostic log: surface every session.updated variant we receive
      if (e.type === "session.updated" || e.type === "session.updated.1") {
        const info = e.properties?.info ?? e.data?.info
        if (info) {
          await log(client, "debug", `session.updated: agent=${info.agent ?? "?"} model=${info.model?.providerID ?? "?"}/${info.model?.id ?? info.model?.modelID ?? "?"} next_agent=${info.next?.agent ?? "-"} next_model=${info.next?.model?.providerID ?? "-"}/${info.next?.model?.id ?? "-"}`).catch(() => {})
        }
      }
      if (e.type === "session.next.model.switched.1" || e.type === "session.next.agent.switched.1") {
        await log(client, "debug", `${e.type}: ${JSON.stringify({ sessionID: e.sessionID, model: e.model, agent: e.agent })}`).catch(() => {})
      }

      try {
        rememberBuildModel(e, buildModels)
        // log when build agent model captured
        if (e.type === "session.updated" || e.type === "session.updated.1") {
          const info = e.properties?.info ?? e.data?.info
          const sid = info?.id
          if (info?.agent === "build" && sid && buildModels.has(sid)) {
            const m = buildModels.get(sid)!
            await log(client, "info", `plan-review: build event memory updated: session=${sid} -> ${m.providerID}/${m.modelID}`).catch(() => {})
          }
        }
      } catch {}

      if (e.type !== "command.executed" && e.type !== "tui.command.execute") return

      const props = e.properties ?? {}
      const name = (props.name ?? (e as Record<string, unknown>).command) as string | undefined
      const rawArgs = (props.arguments ?? "") as string
      const sessionID = props.sessionID as string | undefined

      if (name === "set-build-model") {
        if (!sessionID) {
          await log(client, "error", "set-build-model: no active session").catch(() => {})
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
            }).catch(() => {})
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
          }).catch(() => {})
          return
        }

        // explicit provider/model string
        if (arg !== "") {
          const parsed = parseModelString(arg)
          if (!parsed) {
            await log(client, "error", `set-build-model: invalid format "${arg}". Expected "provider/model-id".`).catch(() => {})
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
          }).catch(() => {})
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
        }).catch(() => {})
        return
      }

      if (name === "plan-diag") {
        if (!sessionID) {
          await log(client, "error", "plan-diag: no active session").catch(() => {})
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
          }).catch(() => {})
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
        }).catch(() => {})
        return
      }

      if (name !== "plan-review") return

      const filePath = rawArgs.trim()
      if (!filePath) {
        await log(client, "error", "Usage: /plan-review <path-to-plan.md>").catch(() => {})
        return
      }
      if (!sessionID) {
        await log(client, "error", "plan-review: no active session").catch(() => {})
        return
      }

      const absolutePath = resolve(filePath)
      if (!existsSync(absolutePath)) {
        await log(client, "error", `plan-review: file not found: ${absolutePath}`).catch(() => {})
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
        await log(client, "error", `plan-review: failed to send feedback: ${(err as Error).message}`).catch(() => {})
      }
    },
  }
}

export default PlanReviewPlugin