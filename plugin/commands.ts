import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { logged } from "./helpers"
import {
  writeCommand,
  readRecord,
  clearRecord,
} from "./model-store"
import { formatProviderList, listAvailableModels, parseModelString } from "./resolution"
import type { ProviderListEntry } from "./resolution"

interface CommandEvent {
  type: string
  properties?: { name?: string; arguments?: string; sessionID?: string }
}

export interface CommandHandlers {
  client: any
  $: any
  scriptPath: string
  lastShownModels: Map<string, ProviderListEntry[]>
  onPlanApproved: (sessionID: string, summary: string) => Promise<void>
}

/**
 * Dispatch slash-command events. Returns true if the event was a
 * recognized command (even if it short-circuited), false otherwise.
 */
export async function handleCommand(
  event: CommandEvent,
  h: CommandHandlers
): Promise<boolean> {
  if (event.type !== "command.executed" && event.type !== "tui.command.execute") return false

  const props = event.properties ?? {}
  const name = (props.name ?? (event as unknown as Record<string, unknown>).command) as string | undefined
  const rawArgs = (props.arguments ?? "") as string
  const sessionID = props.sessionID as string | undefined

  if (name === "set-build-model") {
    if (!sessionID) {
      await logged(h.client, "error", "set-build-model: no active session")
      return true
    }
    await handleSetBuildModel(h.client, sessionID, rawArgs.trim(), h.lastShownModels)
    return true
  }
  if (name === "plan-diag") {
    if (!sessionID) {
      await logged(h.client, "error", "plan-diag: no active session")
      return true
    }
    await handlePlanDiag(h.client, sessionID, rawArgs.trim())
    return true
  }
  if (name === "plan-review") {
    if (!sessionID) {
      await logged(h.client, "error", "plan-review: no active session")
      return true
    }
    await handlePlanReview(h.client, h.$, h.scriptPath, sessionID, rawArgs.trim(), h.onPlanApproved)
    return true
  }
  return false
}

async function handleSetBuildModel(
  client: any,
  sessionID: string,
  arg: string,
  lastShownModels: Map<string, ProviderListEntry[]>
): Promise<void> {
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
          parts: [
            {
              type: "text",
              text: `set-build-model: index ${numIdx} out of range (last list had ${list.length} entries). Run \`/set-build-model\` to refresh.`,
            },
          ],
        },
      })
      return
    }
    await writeCommand(client, sessionID, "build", { providerID: entry.providerID, modelID: entry.modelID })
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            text: `Build model for this session set to: \`${entry.providerID}/${entry.modelID}\` (picked #${numIdx} from list, pinned — survives restart). On the next plan approval, the session will switch to this model before build executes.`,
          },
        ],
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
    await writeCommand(client, sessionID, "build", parsed)
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            text: `Build model for this session set to: \`${parsed.providerID}/${parsed.modelID}\` (pinned — survives restart). On the next plan approval, the session will switch to this model before build executes.`,
          },
        ],
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
      parts: [
        {
          type: "text",
          text: `# set-build-model picker\n\nAvailable models (${entries.length}):\n\n${formatProviderList(entries)}\n\nReply with:\n- \`/set-build-model <number>\` to pick from this list (e.g. \`/set-build-model 5\`)\n- \`/set-build-model <provider>/<model-id>\` to set directly (e.g. \`/set-build-model ya-glm/glm\`)\n\nStored in this session's planReviewModels metadata (pinned, survives restart). For runtime model picker use the opencode UI (Ctrl-X M).`,
        },
      ],
    },
  })
}

async function handlePlanDiag(
  client: any,
  sessionID: string,
  subCmd: string
): Promise<void> {
  if (subCmd === "reset") {
    await clearRecord(client, sessionID)
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [
          {
            type: "text",
            text: `plan-diag: planReviewModels record cleared for this session. Next chat.message capture will repopulate it.`,
          },
        ],
      },
    })
    return
  }
  const record = await readRecord(client, sessionID)
  const lines: string[] = []
  for (const agent of ["plan", "build"] as const) {
    const r = record[agent]
    lines.push(`  ${agent}: ${r ? `${r.providerID}/${r.modelID}${r.variant ? ` (variant ${r.variant})` : ""} [${r.source}${r.pinned ? " pinned" : ""}]` : "(empty)"}`)
  }
  await client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [
        {
          type: "text",
          text: `# plan-diag

## planReviewModels record (persisted, per-session)
${lines.join("\n")}

## Current session
- sessionID: \`${sessionID}\`

Resolution priority on plan approval:
1. planReviewModels.build record (chat | picker | home-flush | command)
2. session history scan (last build-agent user message model)
3. agent.build.model from opencode.jsonc
4. config.model global default
5. refuse → user picks manually

Records with source=command are pinned; chat.message captures skip pinned
agents. Run \`/plan-diag reset\` to clear the record for this session.

Diagnostic lines \`plan-review: exitPlanMode ...\` and \`plan-review-TUI: ...\` appear in opencode log.
`,
        },
      ],
    },
  })
}

async function handlePlanReview(
  client: any,
  $: any,
  scriptPath: string,
  sessionID: string,
  filePath: string,
  onApproved: (sessionID: string, summary: string) => Promise<void>
): Promise<void> {
  if (!filePath) {
    await logged(client, "error", "Usage: /plan-review <path-to-plan.md>")
    await client.session
      .prompt({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", text: "Usage: /plan-review <path-to-plan.md>" }] },
      })
      .catch((e: unknown) => logged(client, "error", `plan-review: usage prompt failed: ${(e as Error)?.message ?? String(e)}`))
    return
  }
  const absolutePath = resolve(filePath)
  if (!existsSync(absolutePath)) {
    await logged(client, "error", `plan-review: file not found: ${absolutePath}`)
    await client.session
      .prompt({
        path: { id: sessionID },
        body: { noReply: true, parts: [{ type: "text", text: `plan-review: file not found: ${absolutePath}` }] },
      })
      .catch((e: unknown) =>
        logged(client, "error", `plan-review: not-found prompt failed: ${(e as Error)?.message ?? String(e)}`)
      )
    return
  }
  const planContent = readFileSync(absolutePath, "utf8")
  const diff = await runPlanReview($, scriptPath, planContent)
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
      await onApproved(sessionID, `User approved \`${absolutePath}\`.`)
    }
  } catch (err) {
    await logged(client, "error", `plan-review: failed to send feedback: ${(err as Error).message}`)
  }
}

async function runPlanReview($: any, scriptPath: string, planText: string): Promise<string> {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const tmpDir = mkdtempSync(join(tmpdir(), "opencode-plan-review-"))
  const tmpPath = join(tmpDir, "plan.md")
  writeFileSync(tmpPath, planText, "utf8")
  try {
    return await $`${scriptPath} --file ${tmpPath}`.text()
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`plan-review: failed to clean temp dir ${tmpDir}: ${(err as Error).message}`)
      }
    }
  }
}

const FEEDBACK_HEADER =
  "User reviewed the plan in their editor and made changes.\n" +
  "Diff below (lines starting with + are user additions/annotations, " +
  "- are removals):\n"

const REVISION_PROMPT =
  "\nRevise the plan to address each annotation, then call plan_review " +
  "again with the revised plan. When the user closes the editor without " +
  "making changes, this tool returns an empty/no-diff result and the " +
  "plan is approved."