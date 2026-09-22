import { withTimeoutSafe } from "./helpers"
import { readRecord, sourceLabel, type ModelsRecord, type SdkAdapter } from "../model-store"
import type { Context, Logger, Model, Session } from "./context"

export type ModelRef = { providerID: string; modelID: string; variant?: string }

export type ExitResult =
  | { status: "switched"; target: ModelRef; source: string }
  | { status: "no_model" }
  | { status: "prompt_failed"; error: string }

/**
 * Plugin-instance-scoped window guard for exitPlanMode's OWN switchModel call.
 * The host broadcasts that switch as `session.model.selected`, which the picker
 * capture would otherwise record as an explicit pick. `writePicker`'s equality
 * skip already makes the echo a no-op; this guard is defense-in-depth (same
 * shape as the V1 synthetic-prompt guard) so diagnostics stay clean.
 */
export type PickerGuard = { active: boolean; sessionID?: string }

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

export async function getBuildAgentModel(context: Context): Promise<ModelRef | undefined> {
  try {
    const agent = await context.agent.get("build")
    return agent?.model && fromModel(agent.model)
  } catch (err) {
    console.error(`plan-review: getBuildAgentModel failed: ${(err as Error)?.message ?? String(err)}`)
    return undefined
  }
}

export async function getGlobalModel(context: Context): Promise<ModelRef | undefined> {
  try {
    const result = await context.catalog.model.default()
    return result.data ? fromModel(result.data) : undefined
  } catch (err) {
    console.error(`plan-review: getGlobalModel failed: ${(err as Error)?.message ?? String(err)}`)
    return undefined
  }
}

export async function listAvailableModels(context: Context): Promise<ProviderListEntry[]> {
  try {
    const result = await context.catalog.model.list()
    return result.data
      .filter((model) => model.status !== "deprecated")
      .map((model) => ({
        providerID: model.providerID,
        modelID: model.id,
        displayName: model.name,
      }))
  } catch (err) {
    console.error(`plan-review: listAvailableModels failed: ${(err as Error)?.message ?? String(err)}`)
    return []
  }
}

export function formatProviderList(entries: ProviderListEntry[]): string {
  if (entries.length === 0) return "  (no providers found — check opencode config)"
  return entries
    .map((entry, index) => {
      const label = entry.displayName && entry.displayName !== entry.modelID
        ? `${entry.displayName} (\`${entry.modelID}\`)`
        : `\`${entry.modelID}\``
      return `  ${(index + 1).toString().padStart(3, " ")}. ${entry.providerID.padEnd(24)} ${label}`
    })
    .join("\n")
}

export async function getSessionHistoryBuildMessage(
  session: Session,
  sessionID: string,
): Promise<ModelRef | undefined> {
  try {
    const messages = await session.messages({ sessionID })
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.type === "model-switched" && message.model) return fromModel(message.model)
    }
  } catch (err) {
    console.error(`plan-review: getSessionHistoryBuildMessage failed: ${(err as Error)?.message ?? String(err)}`)
  }
  return undefined
}

/** Resolve by explicit record, then current agent/default model, then history. */
export async function resolveBuildModel(
  context: Context,
  sdk: SdkAdapter,
  sessionID: string,
): Promise<{ target?: ModelRef; source: string }> {
  const record: ModelsRecord = await readRecord(sdk, sessionID)
  if (record.build) {
    return { target: toModelRef(record.build), source: sourceLabel(record.build) }
  }
  const [agentCfg, globalCfg, historyBuild] = await Promise.all([
    withTimeoutSafe(getBuildAgentModel(context), 2000, undefined),
    withTimeoutSafe(getGlobalModel(context), 2000, undefined),
    withTimeoutSafe(getSessionHistoryBuildMessage(context.session, sessionID), 3000, undefined),
  ])
  if (agentCfg) return { target: agentCfg, source: "agent.build.model" }
  if (globalCfg) return { target: globalCfg, source: "config.model" }
  if (historyBuild) return { target: historyBuild, source: "session history (build)" }
  return { target: undefined, source: "no build model" }
}

export async function exitPlanMode(
  context: Context,
  sdk: SdkAdapter,
  log: Logger,
  sessionID: string | undefined,
  summary: string,
  pickerGuard?: PickerGuard,
): Promise<ExitResult> {
  if (!sessionID) return { status: "no_model" }
  await log("info", `exitPlanMode called for session ${sessionID}`)

  const { target, source } = await resolveBuildModel(context, sdk, sessionID)
  await log(
    "info",
    `exitPlanMode resolution: session=${sessionID} target=${target ? `${target.providerID}/${target.modelID}` : "undefined"} source=${source}`,
  )

  if (!target) {
    const text = `Plan approved. ${summary}\n\nNo build model resolved. Call the \`set_build_model\` tool with no arguments to list available models (or with \`provider/model-id\` to pin one), then approve again.`
    try {
      await context.session.synthetic({ sessionID, text, delivery: "steer", resume: true })
    } catch (err) {
      console.error(`plan-review: no-target synthetic failed: ${(err as Error)?.message ?? String(err)}`)
    }
    return { status: "no_model" }
  }

  if (pickerGuard) {
    pickerGuard.active = true
    pickerGuard.sessionID = sessionID
  }
  try {
    // Stage-by-stage: one combined try collapsed three distinct failure modes
    // (agent switch, model switch, prompt delivery) into one message, so the
    // user could not tell whether the build agent was already active.
    try {
      await context.session.switchAgent({ sessionID, agent: "build" })
    } catch (err) {
      const error = `failed to switch to the build agent: ${(err as Error)?.message ?? String(err)}`
      await log("error", `exitPlanMode: ${error}`)
      return { status: "prompt_failed", error }
    }
    try {
      await context.session.switchModel({
        sessionID,
        model: {
          providerID: target.providerID,
          id: target.modelID,
          ...(target.variant ? { variant: target.variant } : {}),
        },
      })
    } catch (err) {
      const error = `switched to the build agent, but failed to set model ${target.providerID}/${target.modelID}: ${(err as Error)?.message ?? String(err)}`
      await log("error", `exitPlanMode: ${error}`)
      return { status: "prompt_failed", error }
    }
    try {
      await context.session.synthetic({
        sessionID,
        text: `Plan approved. ${summary} Build model: ${target.providerID}/${target.modelID} (source: ${source}). Proceed with implementation.`,
        delivery: "steer",
        resume: true,
      })
    } catch (err) {
      const error = `switched to the build agent (${target.providerID}/${target.modelID}), but failed to deliver the proceed prompt: ${(err as Error)?.message ?? String(err)}`
      await log("error", `exitPlanMode: ${error}`)
      return { status: "prompt_failed", error }
    }
    return { status: "switched", target, source }
  } finally {
    // Cleared on EVERY outcome — a throwing switch must never latch the guard
    // and swallow the user's real picks for the rest of the session.
    if (pickerGuard) {
      pickerGuard.active = false
      pickerGuard.sessionID = undefined
    }
  }
}

function fromModel(model: Model): ModelRef {
  return {
    providerID: model.providerID,
    modelID: model.id,
    ...(model.variant && model.variant !== "default" ? { variant: model.variant } : {}),
  }
}

function toModelRef(model: ModelRef): ModelRef {
  return model
}
