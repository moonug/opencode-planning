import { tool, type Plugin } from "@opencode-ai/plugin"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { logged, visibleErr } from "./helpers"
import { installSelf, SCRIPT_PATH } from "./install"
import { captureImplicit, v1SdkAdapter, type SdkAdapter } from "./model-store"
import type { Agent } from "./model-store"
import { exitPlanMode } from "./resolution"
import type { ProviderListEntry } from "./resolution"
import { systemTransform, messagesTransform } from "./system-prompt"
import { handleCommand } from "./commands"

const VERSION = require("./package.json").version

const FEEDBACK_HEADER =
  "User reviewed the plan in their editor and made changes.\n" +
  "Diff below (lines starting with + are user additions/annotations, " +
  "- are removals):\n"

const REVISION_PROMPT =
  "\nRevise the plan to address each annotation, then call plan_review " +
  "again with the revised plan. When the user closes the editor without " +
  "making changes, this tool returns an empty/no-diff result and the " +
  "plan is approved."

async function runPlanReview($: any, planText: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), "opencode-plan-review-"))
  const tmpPath = join(tmpDir, "plan.md")
  writeFileSync(tmpPath, planText, "utf8")
  try {
    return await $`${SCRIPT_PATH} --file ${tmpPath}`.text()
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

export const PlanReviewPlugin: Plugin = async ({ $, client, serverUrl }) => {
  await logged(client, "info", `plan-review: plugin init v${VERSION} build=v${VERSION}`)
  await logged(
    client,
    "info",
    `plan-review: argv0=${(process.argv[1] ?? "unknown").split("/").slice(-3).join("/")}`
  )

  installSelf()

  // The server-plugin host hands us a v1 SDK client. Build the matching
  // adapter so the per-session model-store writer produces the right wire
  // shape (metadata under `body`, not at the top level — hey-api on v1
  // silently drops unknown top-level keys).
  const sdk: SdkAdapter = v1SdkAdapter(client)

  // Window guard for our own synthetic switch prompts. While active, the
  // chat.message hook skips recording. With write-time precedence, the
  // switch prompt would write the same value back into the record
  // (no-op), but we keep the guard to keep diagnostics clean.
  const syntheticPrompt: { active: boolean; sessionID?: string } = { active: false }

  const lastShownModels = new Map<string, ProviderListEntry[]>()

  const log = (level: "info" | "warn" | "error", message: string): Promise<void> =>
    logged(client, level, message)
  void log // silence "unused" until exitPlanMode is called

  const onPlanApproved = async (sessionID: string, summary: string): Promise<void> => {
    const exit = await exitPlanMode(client, sdk, log, syntheticPrompt, sessionID, summary)
    if (exit.status === "no_model") {
      await logged(client, "warn", `plan-review: no build model after approval in ${sessionID}`)
    } else if (exit.status === "prompt_failed") {
      await logged(client, "error", `plan-review: build-exit prompt failed: ${exit.error}`)
    }
  }

  const plan_review = tool({
    description:
      "Open the current plan in $EDITOR for the user to annotate. " +
      "Pass the full markdown of your plan as the `plan` argument. " +
      "Returns a unified diff of the user's edits, or empty output if the " +
      "user closed the editor without changes (which means approved, and " +
      "the session will auto-switch to the build agent on a per-session " +
      "build model — set via /set-build-model, or falling back to " +
      "agent.build.model, or config.model). Iterate until the result is empty.",
    args: {
      plan: tool.schema.string().describe(
        "full markdown of your plan to show the user for review"
      ),
    },
    async execute(args, context) {
      const result = await runPlanReview($, args.plan)
      const trimmed = result.trim()
      if (!trimmed) {
      const exit = await exitPlanMode(
        client,
        sdk,
        log,
        syntheticPrompt,
        context.sessionID,
        "User closed editor without changes."
        )
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
        const agents = (opencodeConfig as any).agent ?? {}
        const planEntry = agents.plan
        if (planEntry) {
          const plans = Array.isArray(planEntry) ? planEntry : [planEntry]
          for (const ag of plans) {
            ag.permission ??= {}
            ag.permission.plan_review = "allow"
            ag.permission.plan_exit = "deny"
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
      await logged(
        client,
        "info",
        `plan-review: chat.message HOOK FIRED: session=${input.sessionID ?? "?"} agent=${input.agent ?? "?"} model=${input.model?.providerID ?? "?"}/${input.model?.modelID ?? "?"}`
      )
      if (
        !input.sessionID ||
        (input.agent !== "plan" && input.agent !== "build") ||
        !input.model?.providerID ||
        !input.model?.modelID
      ) {
        return
      }
      if (syntheticPrompt.active && syntheticPrompt.sessionID === input.sessionID) {
        await logged(
          client,
          "info",
          `chat.message: skipped synthetic switch prompt session=${input.sessionID} agent=${input.agent}`
        )
        return
      }
      const agent = input.agent as Agent
      const variant =
        input.variant && input.variant !== "default" ? input.variant : undefined
      const record = await captureImplicit(sdk, input.sessionID, agent, {
        providerID: input.model.providerID,
        modelID: input.model.modelID,
        ...(variant ? { variant } : {}),
      }).catch(async (e: unknown) => {
        await visibleErr(client, `chat.message capture session=${input.sessionID} agent=${agent}`, e)
        return undefined
      })
      if (record) {
        await logged(
          client,
          "info",
          `chat.message: session=${input.sessionID} agent=${agent} model=${record.providerID}/${record.modelID}`
        )
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      await systemTransform(client, input as any, output as any)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      await messagesTransform(client, output as any)
    },

    event: async ({ event }) => {
      const e = event as any
      const handled = await handleCommand(e, {
        client,
        sdk,
        $,
        scriptPath: SCRIPT_PATH,
        lastShownModels,
        onPlanApproved,
      })
      if (!handled) return
    },

    "tool.definition": async (input, output) => {
      if (input.toolID === "plan_review") {
        await logged(client, "info", `plan-review: tool.definition fired for plan_review`)
        return
      }
      if (input.toolID === "plan_exit") {
        output.description = "Do not call this tool. Use plan_review to submit your plan for review."
      }
      if (input.toolID === "todowrite") {
        output.description =
          "During planning, use plan_review instead. Call plan_review when your plan is complete."
      }
    },
  }
}

export default PlanReviewPlugin