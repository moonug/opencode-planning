import { logged } from "./helpers"
import type { Logger } from "./context"

type SystemBlock = { type: "text"; text: string }

export type ContextHook = {
  readonly sessionID: string
  readonly agent: string
  readonly system: Array<SystemBlock>
}

/** Add plan-review instructions to plan turns without touching build turns. */
export async function systemTransform(logger: Logger, event: ContextHook): Promise<void> {
  await logged(
    logger,
    "info",
    `plan-review: session context hook fired: session=${event.sessionID} agent=${event.agent} system_blocks=${event.system.length}`,
  )
  if (event.agent === "build") return

  let rewrites = 0
  for (const block of event.system) {
    const before = block.text
    block.text = before.replace(/\bplan_exit\b/g, "plan_review").replace(/\bExitPlanMode\b/g, "plan_review")
    if (block.text !== before) rewrites++
  }
  if (rewrites > 0) await logged(logger, "info", `plan-review: rewrote plan_exit in ${rewrites} system block(s)`)
  event.system.push({
    type: "text",
    text: [
      "## CRITICAL: Plan Review",
      "You MUST call the `plan_review` tool to submit your plan. This is the ONLY way to complete planning.",
      "Do NOT write your plan in chat. Do NOT call the disabled plan_exit tool.",
      "Call `plan_review` with the full plan markdown as the `plan` argument. If the plan is rejected, revise it and call `plan_review` again.",
    ].join("\n"),
  })
  await logged(logger, "info", `plan-review: system prompt injected (${event.system.length} blocks)`)
}
