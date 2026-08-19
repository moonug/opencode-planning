import { logged } from "./helpers"

/**
 * System prompt injection: rewrite plan_exit/ExitPlanMode references in
 * existing system blocks and append the plan_review enforcement block.
 *
 * Skips:
 *   - the title generator ("generate a title")
 *   - the build agent (last user message was from build)
 */
export async function systemTransform(
  client: any,
  input: { sessionID?: string },
  output: { system: string[] }
): Promise<void> {
  await logged(
    client,
    "info",
    `plan-review: system.transform HOOK FIRED: session=${input.sessionID ?? "?"} system_blocks=${output.system.length}`
  )

  const joined = output.system.join("\n").toLowerCase()
  if (joined.includes("title generator") || joined.includes("generate a title")) return

  if (input.sessionID) {
    try {
      const msgs = await client.session.messages({ path: { id: input.sessionID } })
      const data = (msgs as any)?.data ?? msgs
      const list = Array.isArray(data) ? data : []
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (m?.info?.role === "user" && m?.info?.agent) {
          if (m.info.agent === "build") return
          break
        }
      }
    } catch (e) {
      console.error(`plan-review: agent check failed: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  let rewrites = 0
  for (let i = 0; i < output.system.length; i++) {
    const before = output.system[i]!
    output.system[i] = before
      .replace(/\bplan_exit\b/g, "plan_review")
      .replace(/\bExitPlanMode\b/g, "plan_review")
    if (output.system[i] !== before) rewrites++
  }
  if (rewrites > 0) {
    await logged(client, "info", `plan-review: rewrote plan_exit→plan_review in ${rewrites} system block(s)`)
  }
  output.system.push(
    `
## CRITICAL: Plan Review
You MUST call the \`plan_review\` tool to submit your plan. This is the ONLY way to complete planning.
Do NOT write your plan in chat. Do NOT ask for approval in chat. Do NOT call the disabled exit tool.
Call \`plan_review\` with the full plan markdown as the \`plan\` argument. If your plan is rejected, revise it and call \`plan_review\` again.
`
  )
  await logged(
    client,
    "info",
    `plan-review: system prompt injected (${output.system.length} blocks, ${output.system[output.system.length - 1]!.length} chars)`
  )
}

/**
 * Rewrite plan_exit → plan_review in message parts (the per-message
 * plan-mode reminder at packages/opencode/src/session/reminders.ts:76-88
 * is appended as a user message PART, which system.transform never sees).
 * Also append a plan_review directive to plan-mode reminders.
 */
export async function messagesTransform(
  client: any,
  output: { messages?: Array<{ parts?: Array<{ type?: string; text?: string }> }> }
): Promise<void> {
  let rewrites = 0
  let reminders = 0
  for (const msg of output.messages ?? []) {
    for (const part of msg.parts ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        const before = part.text
        part.text = part.text
          .replace(/\bplan_exit\b/g, "plan_review")
          .replace(/\bExitPlanMode\b/g, "plan_review")
        if (part.text !== before) rewrites++
        if (!part.text.includes("call the `plan_review` tool") && part.text.toLowerCase().includes("plan mode")) {
          part.text += `
When your plan is ready, call the \`plan_review\` tool to submit it. Do NOT write the plan in chat.`
          reminders++
        }
      }
    }
  }
  if (rewrites > 0) {
    await logged(client, "info", `plan-review: rewrote plan_exit→plan_review in ${rewrites} message part(s)`)
  }
  if (reminders > 0) {
    await logged(client, "info", `plan-review: appended plan_review directive to ${reminders} plan-mode reminder(s)`)
  }
}