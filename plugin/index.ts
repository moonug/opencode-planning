import { tool, type Plugin, type BunShell } from "@opencode-ai/plugin"
import { existsSync, readFileSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, chmodSync, statSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import { homedir } from "node:os"

const PLUGIN_DIR = dirname(new URL(import.meta.url).pathname)
const REPO_DIR = resolve(PLUGIN_DIR, "..")
const SCRIPT_PATH =
  process.env.PLAN_REVIEW_SCRIPT ?? join(REPO_DIR, "bin", "plan-review.py")
const COMMAND_SOURCE = join(REPO_DIR, "commands", "plan-review.md")

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
  const linkPath = join(homedir(), ".config", "opencode", "commands", "plan-review.md")
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    const existing = readlinkSync(linkPath)
    if (resolve(existing) === resolve(COMMAND_SOURCE)) return
    unlinkSync(linkPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      try { unlinkSync(linkPath) } catch {}  // not a symlink, replace
    }
  }
  try {
    symlinkSync(COMMAND_SOURCE, linkPath)
  } catch {
    // symlink failed (windows without dev mode?) — fall back to copy
    const { copyFileSync } = require("node:fs") as typeof import("node:fs")
    copyFileSync(COMMAND_SOURCE, linkPath)
  }
}

async function exitPlanMode(client: any, sessionID: string | undefined, summary: string): Promise<void> {
  if (!sessionID) return
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: `Plan approved. ${summary} Proceed with implementation.` }],
      },
    })
  } catch {
    // not in plan mode, or session busy — silent fail, build agent prompt will sort it out
  }
}

export const PlanReviewPlugin: Plugin = async ({ $, client }) => {
  if (!existsSync(SCRIPT_PATH)) {
    throw new Error(
      `plan-review: helper script not found at ${SCRIPT_PATH}. ` +
        `Set PLAN_REVIEW_SCRIPT env var or restore bin/plan-review.py next to the plugin.`
    )
  }
  ensureExecutable(SCRIPT_PATH)
  ensureCommandSymlink()

  const plan_review = tool({
    description:
      "Open the current plan in $EDITOR for the user to annotate. " +
      "Pass the full markdown of your plan as the `plan` argument. " +
      "Returns a unified diff of the user's edits, or empty output if the " +
      "user closed the editor without changes (which means approved, and " +
      "the session will auto-switch to the build agent). " +
      "Iterate until the result is empty.",
    args: {
      plan: tool.schema.string().describe(
        "full markdown of the plan to show the user for review"
      ),
    },
    async execute(args, context) {
      const result = await ($ as BunShell)`${SCRIPT_PATH} --plan-text ${args.plan}`.text()
      const trimmed = result.trim()
      if (!trimmed) {
        await exitPlanMode(client, context.sessionID, "User closed editor without changes.")
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
`)
    },

    event: async ({ event }) => {
      const e = event as { type?: string; properties?: Record<string, unknown> }
      if (e.type !== "command.executed" && e.type !== "tui.command.execute") return

      const props = e.properties ?? {}
      const name = (props.name ?? (e as Record<string, unknown>).command) as string | undefined
      if (name !== "plan-review") return

      const rawArgs = (props.arguments ?? "") as string
      const filePath = rawArgs.trim()
      const sessionID = props.sessionID as string | undefined
      if (!filePath) {
        await client.app.log({ level: "error", message: "Usage: /plan-review <path-to-plan.md>" })
        return
      }
      if (!sessionID) {
        await client.app.log({ level: "error", message: "plan-review: no active session" })
        return
      }

      const absolutePath = resolve(filePath)
      if (!existsSync(absolutePath)) {
        await client.app.log({ level: "error", message: `plan-review: file not found: ${absolutePath}` })
        return
      }

      const planContent = readFileSync(absolutePath, "utf8")
      const diff = await ($ as BunShell)`${SCRIPT_PATH} --plan-text ${planContent}`.text()
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
          await exitPlanMode(client, sessionID, `User approved \`${absolutePath}\`.`)
        }
      } catch (err) {
        await client.app.log({
          level: "error",
          message: `plan-review: failed to send feedback: ${(err as Error).message}`,
        })
      }
    },
  }
}

export default PlanReviewPlugin