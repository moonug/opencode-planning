import { Schema } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setBuildModel, planDiag } from "./commands"
import { type Context, type Model, type Tool } from "./context"
import { log } from "./helpers"
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
      execute: async (input, toolContext) => {
        const args = input as PlanReviewInput
        const result = await runPlanReview(args.plan)
        if (result.trim()) return FEEDBACK_HEADER + result + REVISION_PROMPT

        const exit = await exitPlanMode(context, sdk, log, toolContext.sessionID, "User closed editor without changes.")
        if (exit.status === "switched")
          return `Plan reviewed, no changes. Approved by user. Switched to build agent (${exit.target.providerID}/${exit.target.modelID}).`
        if (exit.status === "no_model")
          return "Plan approved by user, but no build model resolved. See the session message above and choose one before continuing."
        return `Plan approved by user, but failed to switch to build agent: ${exit.error}.`
      },
    }

    const set_build_model: Tool = {
      name: "set_build_model",
      description: "Persist the build model for this session. Pass an empty model to show the available model list.",
      input: Schema.Struct({ model: Schema.optional(Schema.String) }),
      output: Schema.String,
      execute: async (input, toolContext) =>
        setBuildModel(context, sdk, toolContext.sessionID, (input as SetBuildModelInput).model ?? "", lastShownModels),
    }

    const plan_diag: Tool = {
      name: "plan_diag",
      description: "Show or reset the persisted per-session plan/build model record.",
      input: Schema.Struct({ reset: Schema.optional(Schema.Boolean) }),
      output: Schema.String,
      execute: async (input, toolContext) =>
        planDiag(context, sdk, toolContext.sessionID, (input as PlanDiagInput).reset === true),
    }

    registrations.push(await context.tool.transform((draft) => {
      draft.add(plan_review)
      draft.add(set_build_model)
      draft.add(plan_diag)
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
  const tmpDir = mkdtempSync(join(tmpdir(), "opencode-plan-review-"))
  const tmpPath = join(tmpDir, "plan.md")
  writeFileSync(tmpPath, planText, "utf8")
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(SCRIPT_PATH, ["--file", tmpPath], { stdio: ["ignore", "pipe", "pipe"] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.once("error", reject)
      child.once("close", (code) => {
        if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"))
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `plan-review exited with code ${code}`))
      })
    })
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch (error) {
      console.error(`plan-review: failed to clean temp dir ${tmpDir}: ${(error as Error).message}`)
    }
  }
}
