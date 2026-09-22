import { Schema } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setBuildModel, planDiag } from "./commands"
import { type Context, type Model, type Tool, type ToolContext } from "./context"
import { log } from "./helpers"
import { describeHelperFailure, describeTempPrepareFailure } from "../helper-errors"
import { SCRIPT_PATH } from "../install"
import { captureImplicit, v2InstructionAdapter } from "../model-store"
import { exitPlanMode } from "./resolution"
import { systemTransform, type ContextHook } from "./system-prompt"

const VERSION = require("../package.json").version

const FEEDBACK_HEADER =
  "User reviewed the plan in their editor and made changes.\n" +
  "Diff below (lines starting with + are user additions/annotations, - are removals):\n"

const REVISION_PROMPT =
  "\nRevise the plan to address each annotation, then call plan_review again with the revised plan. " +
  "When the user closes the editor without making changes, this tool returns an empty/no-diff result and the plan is approved."

type ModelRequest = {
  readonly sessionID: string
  readonly agent: string
  readonly model: Model
  readonly kind: string
}

type PlanReviewInput = { readonly plan: string }
type SetBuildModelInput = { readonly model?: string }
type PlanDiagInput = { readonly reset?: boolean }

export const PlanReviewPlugin = {
  id: "opencode-plan-review",
  setup: async (context: Context) => {
    const sdk = v2InstructionAdapter(context.session)
    const lastShownModels = new Map<string, import("./resolution").ProviderListEntry[]>()
    const registrations: Array<{ readonly dispose: () => Promise<void> }> = []

    await log("info", `plugin init v${VERSION} build=v${VERSION}`)
    const plan_review: Tool = {
      name: "plan_review",
      description:
        "Open the current plan in $EDITOR for the user to annotate. Pass the full markdown as the plan argument. " +
        "Returns a diff, or empty output when approved; approval switches to the build agent using the per-session build model.",
      input: Schema.Struct({ plan: Schema.String }),
      output: Schema.String,
      execute: async (input: PlanReviewInput, toolContext: ToolContext) => {
        const result = await runPlanReview(input.plan)
        if (result.trim()) return FEEDBACK_HEADER + result + REVISION_PROMPT

        const exit = await exitPlanMode(context, sdk, log, toolContext.sessionID, "User closed editor without changes.")
        if (exit.status === "switched")
          return `Plan reviewed, no changes. Approved by user. Switched to build agent (${exit.target.providerID}/${exit.target.modelID}).`
        if (exit.status === "no_model")
          return "Plan approved by user, but no build model resolved. See the session message above and choose one before continuing."
        return `Plan approved by user, but the build handoff failed: ${exit.error}.`
      },
    }

    const set_build_model: Tool = {
      name: "set_build_model",
      description: "Persist the build model for this session. Pass an empty model to show the available model list.",
      input: Schema.Struct({ model: Schema.optional(Schema.String) }),
      output: Schema.String,
      execute: async (input: SetBuildModelInput, toolContext: ToolContext) =>
        setBuildModel(context, sdk, toolContext.sessionID, input.model ?? "", lastShownModels),
    }

    const plan_diag: Tool = {
      name: "plan_diag",
      description: "Show or reset the persisted per-session plan/build model record.",
      input: Schema.Struct({ reset: Schema.optional(Schema.Boolean) }),
      output: Schema.String,
      execute: async (input: PlanDiagInput, toolContext: ToolContext) =>
        planDiag(context, sdk, toolContext.sessionID, input.reset === true),
    }

    registrations.push(await context.tool.transform((draft) => {
      draft.add(plan_review)
      draft.add(set_build_model)
      draft.add(plan_diag)
    }))

    // Ported from the superseded plugin/v2.ts. Agent permission rules are the
    // opencode2 equivalent of the V1 `config` hook's per-agent permission map:
    // plan_review is available to plan and hidden from build.
    registrations.push(await context.agent.transform((draft) => {
      if (draft.get("plan")) {
        draft.update("plan", (agent) => {
          agent.permissions = agent.permissions.filter(
            (rule) => rule.action !== "plan_review" && rule.action !== "plan_exit",
          )
          agent.permissions.push({ action: "plan_review", resource: "*", effect: "allow" })
          agent.permissions.push({ action: "plan_exit", resource: "*", effect: "deny" })
        })
      }
      if (draft.get("build")) {
        draft.update("build", (agent) => {
          agent.permissions = agent.permissions.filter((rule) => rule.action !== "plan_review")
          agent.permissions.push({ action: "plan_review", resource: "*", effect: "deny" })
        })
      }
    }))

    registrations.push(await context.session.hook("context", async (event) => {
      await systemTransform(log, event as ContextHook)
    }))

    registrations.push(await context.session.hook("model.request", async (event) => {
      const request = event as ModelRequest
      if (request.kind !== "primary" || (request.agent !== "plan" && request.agent !== "build")) return
      await captureImplicit(sdk, request.sessionID, request.agent, {
        providerID: request.model.providerID,
        modelID: request.model.id,
        ...(request.model.variant ? { variant: request.model.variant } : {}),
      }).catch((error: unknown) => log("warn", `model capture failed: ${(error as Error)?.message ?? String(error)}`))
    }))

    await log("info", `tool registration ready v${VERSION}`)
    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
    }
  },
}

export default PlanReviewPlugin

async function runPlanReview(planText: string): Promise<string> {
  let tmpDir: string
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "opencode-plan-review-"))
  } catch (error) {
    const described = describeTempPrepareFailure(error)
    console.error(`plan-review: ${described}`)
    throw new Error(described)
  }
  const tmpPath = join(tmpDir, "plan.md")
  try {
    writeFileSync(tmpPath, planText, "utf8")
  } catch (error) {
    const described = describeTempPrepareFailure(error)
    console.error(`plan-review: ${described}`)
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch (cleanupErr) {
      console.error(`plan-review: failed to clean temp dir ${tmpDir}: ${(cleanupErr as Error).message}`)
    }
    throw new Error(described)
  }
  try {
    return await runHelper(tmpPath)
  } catch (error) {
    // Never surface an empty error: opencode stores the thrown message as the
    // tool error, so a bare `status: "error"` tells the user nothing.
    const described = describeHelperFailure(error)
    console.error(`plan-review: ${described}`)
    throw new Error(described)
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch (error) {
      console.error(`plan-review: failed to clean temp dir ${tmpDir}: ${(error as Error).message}`)
    }
  }
}

function runHelper(tmpPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(SCRIPT_PATH, ["--file", tmpPath], { stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"))
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `plan-review exited with code ${code}`))
    })
  })
}
