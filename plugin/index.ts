import { tool, type Plugin } from "@opencode-ai/plugin"
import { createOpencodeClient as createV2Client } from "@opencode-ai/sdk/v2/client"
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
const BUILD_MODEL_METADATA_KEY = "plan_review_build_model"

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

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

function log(client: any, level: "debug" | "info" | "warn" | "error", message: string): Promise<unknown> {
  return client.app.log({ body: { service: "plan-review", level, message } })
}

async function getOverrideFromMetadata(v2: any, sessionID: string): Promise<ModelRef | undefined> {
  try {
    const res = await v2.session.get({ path: { sessionID } })
    const md = res?.data?.metadata ?? res?.metadata
    const override = md?.[BUILD_MODEL_METADATA_KEY]
    if (typeof override === "string") return parseModelString(override)
  } catch {}
  return undefined
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

async function getGlobalModel(client: any): Promise<ModelRef | undefined> {
  try {
    const res = await client.config.get()
    const model = (res as any)?.data?.model ?? (res as any)?.model
    if (typeof model === "string") return parseModelString(model)
  } catch {}
  return undefined
}

async function getSessionRuntimeModel(v2: any, sessionID: string): Promise<ModelRef | undefined> {
  try {
    const res = await v2.session.get({ path: { sessionID } })
    const m = (res as any)?.data?.model ?? (res as any)?.model
    if (m?.providerID && m?.id) return { providerID: m.providerID, modelID: m.id }
  } catch {}
  return undefined
}

async function setBuildOverride(v2: any, sessionID: string, modelStr: string): Promise<void> {
  let existing: Record<string, unknown> = {}
  try {
    const res = await v2.session.get({ path: { sessionID } })
    existing = (res?.data?.metadata ?? res?.metadata ?? {}) as Record<string, unknown>
  } catch {}
  await v2.session.update({
    path: { sessionID },
    body: { metadata: { ...existing, [BUILD_MODEL_METADATA_KEY]: modelStr } },
  })
}

async function exitPlanMode(
  client: any,
  v2: any | null,
  buildModels: Map<string, ModelRef>,
  lastResolution: { target?: ModelRef; source?: string },
  sessionID: string | undefined,
  summary: string,
): Promise<void> {
  if (!sessionID) return

  // read /set-build-model override from session metadata (only source that
  // needs v2 SDK). Everything else works without v2.
  const metadata = v2
    ? await withTimeout(getOverrideFromMetadata(v2, sessionID), 2000, undefined)
    : undefined
  const [agentCfg, globalCfg] = await Promise.all([
    withTimeout(getBuildAgentModel(client), 2000, undefined),
    withTimeout(getGlobalModel(client), 2000, undefined),
  ])
  const remembered = buildModels.get(sessionID)

  let source: string
  let target: ModelRef | undefined
  if (metadata)        { target = metadata;     source = "/set-build-model" }
  else if (remembered) { target = remembered;   source = "build event memory" }
  else if (agentCfg)   { target = agentCfg;     source = "agent.build.model" }
  else if (globalCfg)  { target = globalCfg;    source = "config.model" }
  else                 { source = "opencode default" }

  lastResolution.target = target
  lastResolution.source = source

  if (!target) {
    await log(client, "warn", `auto-exit: no build model resolved (sources tried: ${source}), asking user to switch manually`).catch(() => {})
    try {
      await client.session.prompt({
        path: { id: sessionID },
        body: {
          noReply: true,
          parts: [{
            type: "text",
            text: `Plan approved. ${summary}\n\n⚠ No build model resolved (tried /set-build-model, build event memory, agent.build.model, config.model — all undefined). Run \`/agent build\` then \`/model <provider>/<model>\` before continuing, or set \`/set-build-model <provider>/<model>\` for next time.`,
          }],
        },
      })
    } catch {}
    return
  }

  // inline v1 SDK override: pass model+agent in body so the next provider
  // turn uses them. Works without v2 SDK and without persistent switchModel.
  // This matches what opencode CLI does internally
  // (~/projects/opencode/packages/opencode/src/cli/cmd/run.ts: client.session.prompt({ sessionID, agent, model, ... })).
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

export const PlanReviewPlugin: Plugin = async ({ $, client, serverUrl }) => {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `plan-review: helper script not found at ${SCRIPT_PATH}. ` +
        `Set PLAN_REVIEW_SCRIPT env var or restore bin/plan-review.py next to the plugin.`
    )
  }
  ensureExecutable(SCRIPT_PATH)
  ensureCommandSymlink()

  let v2: any | null = null
  let v2Tried = false
  const buildModels = new Map<string, ModelRef>()
  const lastResolution: { target?: ModelRef; source?: string } = {}

  async function getV2(): Promise<any> {
    if (v2Tried) return v2
    v2Tried = true
    try {
      v2 = createV2Client({ baseUrl: serverUrl.toString().replace(/\/+$/, ""), directory: process.cwd() })
    } catch (err) {
      await log(client, "warn", `v2 SDK init failed: ${(err as Error).message}, build-model persistence disabled`).catch(() => {})
      v2 = null
    }
    return v2
  }

  const plan_review = tool({
    description:
      "Open the current plan in $EDITOR for the user to annotate. " +
      "Pass the full markdown of your plan as the `plan` argument. " +
      "Returns a unified diff of the user's edits, or empty output if " +
      "the user closed the editor without changes (which means approved, and " +
      "the session will auto-switch to the build agent on a per-session " +
      "build model — set via /set-build-model, or falling back to the " +
      "last model selected while build was active, or agent.build.model, " +
      "or config.model). Iterate until the result is empty.",
    args: {
      plan: tool.schema.string().describe(
        "full markdown of the plan to show the user for review"
      ),
    },
    async execute(args, context) {
      const result = await runPlanReview($, args.plan)
      const trimmed = result.trim()
      if (!trimmed) {
        await exitPlanMode(client, await getV2(), buildModels, lastResolution, context.sessionID, "User closed editor without changes.")
        return "Plan reviewed, no changes. Approved by user. Switched to build agent."
      }
      return FEEDBACK_HEADER + result + REVISION_PROMPT
    },
  })

  return {
    tool: { plan_review },

    "experimental.chat.system.transform": async (_input, output) => {
      const joined = output.system.join("\n").toLowerCase()
      if (joined.includes("subagent") || joined.includes("title generator")) return
      output.system.push(`
# Plan Review REQUIRED (this is a plan-mode session)

You are operating in opencode's plan agent. In this mode, the user reviews plans via the \`plan_review\` tool — NOT by reading inline text responses.

After producing a structured plan in your reasoning or response, your NEXT assistant turn MUST be a single tool call:

  tool_call({ name: "plan_review", args: { plan: "<full markdown plan>" } })

Do NOT:
- Write the plan inline as a plain text response and stop.
- Ask "should I open in editor or proceed?" — the answer is always editor.
- Skip this step even if you think the plan is final.

Do NOT proceed to implementation, do not write code, do not run commands, do not call other tools, until plan_review returns "no changes" (empty diff = user approved). If it returns a unified diff, revise the plan and call plan_review again.

ENFORCEMENT (added by plan-review plugin):
- \`plan_review\` IS in your available tools right now. Call it directly — do not narrate that you "would call" it.
- Your reply after drafting the plan must be EXACTLY ONE tool call to plan_review. No prose, no markdown summary outside the tool args, no questions.
- If you write the plan as a plain text response instead, the user will see no plan-review prompt, the editor will not open, and you have failed this contract. The user has to nudge you manually and that wastes a turn.
- If plan_review is not in your toolset for any reason, fall back to running \`bin/plan-review.py --plan-text "<markdown>"\` via the bash tool and treat its stdout as feedback.
`)
      await log(client, "debug", `plan-review: system prompt injected (${output.system.length} blocks total, ${output.system[output.system.length - 1]!.length} chars appended)`).catch(() => {})
    },

    event: async ({ event }) => {
      const e = event as any

      // diagnostic log: surface every session.updated variant we receive so the
      // user can verify in opencode log whether UI actions (ctrl-x m, agent
      // tab switch) actually emit events. Useful to debug why "build model
      // ignored" — the plugin only knows what opencode tells it.
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
      } catch {
        // ignore — event handler must never throw
      }

      if (e.type !== "command.executed" && e.type !== "tui.command.execute") return

      const props = e.properties ?? {}
      const name = (props.name ?? (e as Record<string, unknown>).command) as string | undefined
      const rawArgs = (props.arguments ?? "") as string
      const sessionID = props.sessionID as string | undefined

      if (name === "set-build-model") {
        const modelStr = rawArgs.trim()
        if (!sessionID) {
          await log(client, "error", "set-build-model: no active session").catch(() => {})
          return
        }
        if (!modelStr) {
          await log(client, "error", "Usage: /set-build-model <provider/model-id>").catch(() => {})
          return
        }
        if (!parseModelString(modelStr)) {
          await log(client, "error", `Invalid model format "${modelStr}". Expected "provider/model-id".`).catch(() => {})
          return
        }
        const v = await getV2()
        if (!v) {
          await log(client, "error", "set-build-model: v2 SDK unavailable, cannot persist override").catch(() => {})
          return
        }
        try {
          await setBuildOverride(v, sessionID, modelStr)
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{
                type: "text",
                text: `Build model for this session set to: \`${modelStr}\`. On the next plan approval, the session will switch to this model before build executes.`,
              }],
            },
          })
        } catch (err) {
          await log(client, "error", `set-build-model failed: ${(err as Error).message}`).catch(() => {})
        }
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
        // show: dump state
        const memEntries = Array.from(buildModels.entries()).map(([sid, m]) => `  ${sid.slice(0, 16)}… → ${m.providerID}/${m.modelID}`).join("\n") || "  (empty)"
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{
              type: "text",
              text: `# plan-diag

## Build event memory (in-memory)
${memEntries}

## Current session
- sessionID: \`${sessionID}\`
- last target resolved: ${lastResolution.target ? `${lastResolution.target.providerID}/${lastResolution.target.modelID} (source: ${lastResolution.source})` : "never called"}

If you switched build agent via ctrl-x m in this session but the memory
above does not show that model, opencode did NOT emit a \`session.updated\`
event for your picker action. Workarounds:
- \`/set-build-model <provider>/<model>\` before approving the plan
- \`/agent build\` → \`/model <provider>/<model>\` → \`/agent plan\`, then approve

Diagnostic lines \`plan-review: session.updated: ...\` appear in opencode log for every session.updated event.
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
          await exitPlanMode(client, await getV2(), buildModels, lastResolution, sessionID, `User approved \`${absolutePath}\`.`)
        }
      } catch (err) {
        await log(client, "error", `plan-review: failed to send feedback: ${(err as Error).message}`).catch(() => {})
      }
    },
  }
}

export default PlanReviewPlugin