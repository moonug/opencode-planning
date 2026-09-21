import { readRecord, clearRecord, writeCommand, type SdkAdapter } from "../model-store"
import type { Context, Logger } from "./context"
import { formatProviderList, listAvailableModels, parseModelString, type ProviderListEntry } from "./resolution"

export async function setBuildModel(
  context: Context,
  sdk: SdkAdapter,
  sessionID: string,
  argument: string,
  lastShownModels: Map<string, ProviderListEntry[]>,
): Promise<string> {
  const number = Number(argument)
  if (argument !== "" && Number.isInteger(number) && number > 0) {
    const entry = (lastShownModels.get(sessionID) ?? [])[number - 1]
    if (!entry) return `Model index ${number} is out of range. Run \`/set-build-model\` to refresh the list.`
    await writeCommand(sdk, sessionID, "build", { providerID: entry.providerID, modelID: entry.modelID })
    return `Build model set to \`${entry.providerID}/${entry.modelID}\` (pinned for this session).`
  }

  if (argument !== "") {
    const model = parseModelString(argument)
    if (!model) return `Invalid model format \`${argument}\`. Expected \`provider/model-id\`.`
    await writeCommand(sdk, sessionID, "build", model)
    return `Build model set to \`${model.providerID}/${model.modelID}\` (pinned for this session).`
  }

  const entries = await listAvailableModels(context)
  lastShownModels.set(sessionID, entries)
  return [
    "# set-build-model picker",
    `Available models (${entries.length}):`,
    "",
    formatProviderList(entries),
    "",
    "Reply with `/set-build-model <number>` or `/set-build-model <provider>/<model-id>`.",
  ].join("\n")
}

export async function planDiag(context: Context, sdk: SdkAdapter, sessionID: string, reset: boolean): Promise<string> {
  if (reset) {
    await clearRecord(sdk, sessionID)
    return "planReviewModels record cleared for this session."
  }
  const record = await readRecord(sdk, sessionID)
  return [
    "# plan-diag",
    `sessionID: \`${sessionID}\``,
    ...(["plan", "build"] as const).map((agent) => {
      const pick = record[agent]
      return `${agent}: ${pick ? `${pick.providerID}/${pick.modelID}${pick.variant ? ` (${pick.variant})` : ""} [${pick.source}${pick.pinned ? " pinned" : ""}]` : "(empty)"}`
    }),
  ].join("\n")
}

export async function sendSynthetic(context: Context, sessionID: string, text: string): Promise<void> {
  await context.session.synthetic({ sessionID, text, delivery: "steer", resume: true })
}

export function logCommandFailure(logger: Logger, command: string, error: unknown): void {
  void logger("error", `${command} failed: ${(error as Error)?.message ?? String(error)}`)
}
