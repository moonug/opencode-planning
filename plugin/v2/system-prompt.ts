import { logged } from "./helpers"
import type { Logger } from "./context"

type SystemBlock = { type: "text"; text: string }

export type ContextHook = {
  readonly sessionID: string
  readonly agent: string
  readonly system: Array<SystemBlock>
}

/** Add plan-review instructions to plan turns only; never defect the host fiber. */
export async function systemTransform(logger: Logger, event: ContextHook): Promise<void> {
  // Allowlist, not blacklist: the session context hook also fires for
  // subagents and one-shot sessions with arbitrary agent names
  // (generate-node), and title/compaction paths must stay untouched. Only
  // the plan agent should see these blocks.
  if (event.agent !== "plan") return

  try {
    await systemTransformUnsafe(logger, event)
  } catch (err) {
    // The host runs plugin hooks inline with no error recovery: a throw here
    // defects the request fiber. Leave the system prompt unmodified instead.
    await logged(
      logger,
      "error",
      `systemTransform failed, system prompt left unmodified: ${(err as Error)?.message ?? String(err)}`,
    )
  }
}

async function systemTransformUnsafe(logger: Logger, event: ContextHook): Promise<void> {
  let rewrites = 0
  for (const block of event.system) {
    const before = block.text
    block.text = before.replace(/\bplan_exit\b/g, "plan_review").replace(/\bExitPlanMode\b/g, "plan_review")
    if (block.text !== before) rewrites++
  }
  await logged(
    logger,
    "debug",
    `context hook: session=${event.sessionID} agent=${event.agent} blocks=${event.system.length}`,
  )
  if (rewrites > 0) await logged(logger, "info", `rewrote plan_exit in ${rewrites} system block(s)`)
  event.system.push({
    type: "text",
    text: [
      "## CRITICAL: Plan Review",
      "You MUST call the `plan_review` tool to submit your plan. This is the ONLY way to complete planning.",
      "Do NOT write your plan in chat. Do NOT call the disabled plan_exit tool.",
      "Call `plan_review` with the full plan markdown as the `plan` argument. If the plan is rejected, revise it and call `plan_review` again.",
    ].join("\n"),
  })
  await logged(logger, "debug", `plan blocks injected (${event.system.length} blocks)`)
}
