import { withTimeoutSafe } from "./helpers"
import { readRecord, sourceLabel, type ModelsRecord, type SdkAdapter } from "./model-store"

export type ModelRef = { providerID: string; modelID: string; variant?: string }

export type ExitResult =
  | { status: "switched"; target: ModelRef; source: string }
  | { status: "no_model" }
  | { status: "prompt_failed"; error: string }

export interface ProviderListEntry {
  providerID: string
  providerName?: string
  modelID: string
  displayName?: string
}

export function parseModelString(s: string): ModelRef | undefined {
  const m = s.trim().match(/^([^/\s]+)\/(.+)$/)
  if (!m) return undefined
  return { providerID: m[1]!, modelID: m[2]! }
}

export async function getBuildAgentModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.app.agents()
    const agents = (res as any)?.data ?? res
    const buildAgent = (Array.isArray(agents) ? agents : []).find(
      (a: any) => a.name === "build" || a.id === "build"
    )
    if (buildAgent?.model?.providerID && buildAgent?.model?.modelID) {
      const variant = buildAgent.variant ?? buildAgent.model.variant
      return {
        providerID: buildAgent.model.providerID,
        modelID: buildAgent.model.modelID,
        ...(variant && variant !== "default" ? { variant } : {}),
      }
    }
  } catch (err) {
    console.error(`plan-review: getBuildAgentModel failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

export async function getGlobalModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.config.get()
    const model = (res as any)?.data?.model ?? (res as any)?.model
    if (typeof model === "string") return parseModelString(model)
    if (
      model &&
      typeof model === "object" &&
      typeof model.providerID === "string" &&
      typeof model.modelID === "string"
    ) {
      return { providerID: model.providerID, modelID: model.modelID }
    }
  } catch (err) {
    console.error(`plan-review: getGlobalModel failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

export async function listAvailableModels(client: any): Promise<ProviderListEntry[]> {
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

export function formatProviderList(entries: ProviderListEntry[]): string {
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

export async function getSessionHistoryBuildMessage(
  client: any,
  sessionID: string
): Promise<ModelRef | undefined> {
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const data = (res as any)?.data ?? res
    const list = Array.isArray(data) ? data : []
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]
      const model = m?.model ?? m?.info?.model
      if (
        m?.info?.role === "user" &&
        m?.info?.agent === "build" &&
        model?.providerID &&
        model?.modelID
      ) {
        const variant = model.variant && model.variant !== "default" ? model.variant : undefined
        return {
          providerID: model.providerID,
          modelID: model.modelID,
          ...(variant ? { variant } : {}),
        }
      }
    }
  } catch (err) {
    console.error(`plan-review: getSessionHistoryBuildMessage failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

/**
 * Resolve the build model by source ABSENCE only — no timestamp tournament.
 * The persisted record is authoritative; everything else is a fallback.
 */
export async function resolveBuildModel(
  client: any,
  sdk: SdkAdapter,
  sessionID: string
): Promise<{ target?: ModelRef; source: string }> {
  const record: ModelsRecord = await readRecord(sdk, sessionID)
  if (record.build) {
    const m = record.build
    return {
      target: { providerID: m.providerID, modelID: m.modelID, ...(m.variant ? { variant: m.variant } : {}) },
      source: sourceLabel(record.build),
    }
  }
  const [historyBuild, agentCfg, globalCfg] = await Promise.all([
    withTimeoutSafe(getSessionHistoryBuildMessage(client, sessionID), 3000, undefined),
    withTimeoutSafe(getBuildAgentModel(client), 2000, undefined),
    withTimeoutSafe(getGlobalModel(client), 2000, undefined),
  ])
  if (historyBuild) return { target: historyBuild, source: "session history (build)" }
  if (agentCfg) return { target: agentCfg, source: "agent.build.model" }
  if (globalCfg) return { target: globalCfg, source: "config.model" }
  return { target: undefined, source: "no build model" }
}

export async function exitPlanMode(
  client: any,
  sdk: SdkAdapter,
  log: (level: "info" | "warn" | "error", message: string) => Promise<void>,
  syntheticPrompt: { active: boolean; sessionID?: string },
  sessionID: string | undefined,
  summary: string
): Promise<ExitResult> {
  if (!sessionID) return { status: "no_model" }
  await log("info", `plan-review: exitPlanMode called for session ${sessionID}`)

  const { target, source } = await resolveBuildModel(client, sdk, sessionID)
  await log(
    "info",
    `plan-review: exitPlanMode resolution: session=${sessionID} target=${target ? `${target.providerID}/${target.modelID}` : "undefined"} source=${source}`
  )

  if (!target) {
    await log("warn", "auto-exit: no build model resolved, asking user to switch manually")
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [
            {
              type: "text",
              text: `Plan approved. ${summary}\n\n⚠ No build model resolved (tried planReviewModels record, session history, agent.build.model, config.model — all undefined). Run \`/set-build-model <provider>/<model>\` (or \`/set-build-model\` for a picker), \`/agent build\`, then \`/model <provider>/<model>\` before continuing.`,
            },
          ],
        },
      })
    } catch (err) {
      console.error(`plan-review: no-target prompt failed: ${(err as Error)?.message ?? String(err)}`)
    }
    return { status: "no_model" }
  }

  await log("info", `auto-exit to build. model=${target.providerID}/${target.modelID} source=${source}`)

  try {
    // Window guard for our own synthetic switch prompts. While active, the
    // chat.message hook must not write a fresh "user intent" capture — the
    // resolved target is recorded via captureImplicit on the synthetic
    // prompt's own chat.message firing, which would be a no-op write of
    // the same value, but we still skip it to keep diagnostics clean and
    // match pre-refactor behavior. See smoke test [36f].
    syntheticPrompt.active = true
    syntheticPrompt.sessionID = sessionID
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: "build",
        model: { providerID: target.providerID, modelID: target.modelID },
        ...(target.variant ? { variant: target.variant } : {}),
        noReply: true,
        parts: [
          {
            type: "text",
            text: `Plan approved. ${summary} Build model: ${target.providerID}/${target.modelID} (source: ${source}). Proceed with implementation.`,
          },
        ],
      },
    })
    return { status: "switched", target, source }
  } catch (err) {
    const errMsg = (err as Error)?.message ?? String(err)
    await log("error", `failed to send build-exit prompt: ${errMsg}`)
    return { status: "prompt_failed", error: errMsg }
  } finally {
    syntheticPrompt.active = false
  }
}