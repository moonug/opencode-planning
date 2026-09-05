import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execFile } from "node:child_process"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { handleCommand } from "./commands"
import { logged, visibleErr } from "./helpers"
import { captureImplicit, METADATA_KEY, writePicker, type Agent, type SdkAdapter } from "./model-store"
import { exitPlanMode, type ProviderListEntry } from "./resolution"

const SCRIPT_PATH = process.env.PLAN_REVIEW_SCRIPT ?? join(dirname(fileURLToPath(import.meta.url)), "bin", "plan-review.py")
const FEEDBACK_HEADER =
  "User reviewed the plan in their editor and made changes.\n" +
  "Diff below (lines starting with + are user additions/annotations, - are removals):\n"
const REVISION_PROMPT =
  "\nRevise the plan to address each annotation, then call plan_review again with the revised plan. " +
  "When the user closes the editor without changes, this tool returns an empty/no-diff result and the plan is approved."
const REVIEW_INSTRUCTION = `
## CRITICAL: Plan Review
You MUST call the \`plan_review\` tool to submit your plan. This is the ONLY way to complete planning.
Do NOT write your plan in chat. Do NOT ask for approval in chat. Do NOT call the disabled exit tool.
Call \`plan_review\` with the full plan markdown as the \`plan\` argument. If your plan is rejected, revise it and call \`plan_review\` again.
`

function runPlanReview(plan: string) {
  const directory = mkdtempSync(join(tmpdir(), "opencode-plan-review-"))
  const file = join(directory, "plan.md")
  writeFileSync(file, plan, "utf8")
  return runScript(SCRIPT_PATH, file).finally(() => rmSync(directory, { recursive: true, force: true }))
}

function runScript(script: string, file: string) {
  return new Promise<string>((resolve, reject) =>
    execFile(script, ["--file", file], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message, { cause: error }))
        return
      }
      resolve(stdout)
    }),
  )
}

function shell(_strings: TemplateStringsArray, script: string, file: string) {
  return {
    text: () => runScript(script, file),
  }
}

function modelKey(model: { providerID: string; id: string; variant?: string }) {
  return `${model.providerID}/${model.id}/${model.variant ?? ""}`
}

function client(context: any, pendingModelSwitches: Map<string, string>) {
  const messageHistory = async (sessionID: string) => {
    const messages = await context.session.context({ sessionID })
    let agent: string | undefined
    let model: { providerID: string; id: string; variant?: string } | undefined
    return messages.flatMap((message: any) => {
      if (message.type === "agent-switched") agent = message.agent
      if (message.type === "model-switched") model = message.model
      if (message.type === "assistant")
        return [
          {
            info: { role: "user", agent: message.agent },
            model: {
              providerID: message.model.providerID,
              modelID: message.model.id,
              ...(message.model.variant ? { variant: message.model.variant } : {}),
            },
          },
        ]
      if (message.type !== "user") return []
      return [
        {
          info: { role: "user", agent },
          model: model
            ? { providerID: model.providerID, modelID: model.id, ...(model.variant ? { variant: model.variant } : {}) }
            : undefined,
        },
      ]
    })
  }

  return {
    app: {
      agents: async () => {
        const response = await context.agent.list()
        return {
          data: response.data.map((agent: any) => ({
            ...agent,
            model: agent.model
              ? { ...agent.model, modelID: agent.model.id }
              : undefined,
          })),
        }
      },
      log: async (input: any) => {
        if (input.body.level === "error" || input.body.level === "warn") console.error(input.body.message)
      },
    },
    config: {
      get: async () => {
        const response = await context.catalog.model.default()
        return {
          data: {
            model: response.data ? `${response.data.providerID}/${response.data.id}` : undefined,
          },
        }
      },
      providers: async () => {
        const [providers, models] = await Promise.all([
          context.catalog.provider.list(),
          context.catalog.model.list(),
        ])
        return {
          data: {
            providers: providers.data.map((provider: any) => ({
              ...provider,
              models: Object.fromEntries(
                models.data
                  .filter((model: any) => model.providerID === provider.id)
                  .map((model: any) => [model.id, { ...model, name: model.name ?? model.id }]),
              ),
            })),
          },
        }
      },
    },
    session: {
      messages: (input: any) => messageHistory(input.path.id).then((data) => ({ data })),
      prompt: async (input: any) => {
        const sessionID = input.path.id
        const body = input.body ?? {}
        if (body.agent) await context.session.switchAgent({ sessionID, agent: body.agent })
        if (body.model) {
          const model = {
            providerID: body.model.providerID,
            id: body.model.modelID,
            ...(body.variant ? { variant: body.variant } : {}),
          }
          pendingModelSwitches.set(sessionID, modelKey(model))
          await context.session.switchModel({ sessionID, model }).catch((error: unknown) => {
            pendingModelSwitches.delete(sessionID)
            throw error
          })
        }
        const text = (body.parts ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
        if (body.noReply)
          return context.session.synthetic({
            sessionID,
            text,
            description: "Plan review",
            resume: false,
          })
        return context.session.prompt({ sessionID, text, delivery: "steer" })
      },
    },
  }
}

function storage(context: any): SdkAdapter {
  const key = (sessionID: string) => `session.${sessionID}.models`
  return {
    async getMetadata(sessionID) {
      const value = await context.storage.get(key(sessionID))
      if (value && typeof value === "object" && !Array.isArray(value)) return { [METADATA_KEY]: value }
      const session = await context.session.get({ sessionID })
      return session.metadata ?? {}
    },
    async setMetadata(sessionID, metadata) {
      const value = metadata[METADATA_KEY]
      if (value === undefined) return context.storage.set(key(sessionID), {})
      return context.storage.set(key(sessionID), value)
    },
  }
}

export default {
  id: "plan-review",
  async setup(context: any) {
    const pendingModelSwitches = new Map<string, string>()
    const api = client(context, pendingModelSwitches)
    const sdk = storage(context)
    const syntheticPrompt: { active: boolean; sessionID?: string } = { active: false }
    const lastShownModels = new Map<string, ProviderListEntry[]>()
    const log = (level: "info" | "warn" | "error", message: string) => logged(api, level, message)
    const onPlanApproved = async (sessionID: string, summary: string) => {
      const exit = await exitPlanMode(api, sdk, log, syntheticPrompt, sessionID, summary)
      if (exit.status === "no_model") await log("warn", `plan-review: no build model after approval in ${sessionID}`)
      if (exit.status === "prompt_failed") await log("error", `plan-review: build-exit prompt failed: ${exit.error}`)
    }
    const registrations: Array<{ dispose: () => Promise<void> }> = []
    const eventController = new AbortController()
    let writeChain = Promise.resolve()
    const queueWrite = <Value>(write: () => Promise<Value>) => {
      const result = writeChain.then(write)
      writeChain = result.then(
        () => undefined,
        (error: unknown) => {
          console.error(`plan-review: model write failed: ${(error as Error)?.message ?? String(error)}`)
        },
      )
      return result
    }

    registrations.push(
      await context.agent.transform((editor: any) => {
        editor.update("plan", (agent: any) => {
          agent.permissions = agent.permissions.filter(
            (rule: any) => rule.action !== "plan_review" && rule.action !== "plan_exit",
          )
          agent.permissions.push({ action: "plan_review", resource: "*", effect: "allow" })
          agent.permissions.push({ action: "plan_exit", resource: "*", effect: "deny" })
        })
        editor.update("build", (agent: any) => {
          agent.permissions = agent.permissions.filter((rule: any) => rule.action !== "plan_review")
          agent.permissions.push({ action: "plan_review", resource: "*", effect: "deny" })
        })
      }),
    )

    registrations.push(
      await context.tool.transform((editor: any) => {
        editor.add({
          name: "plan_review",
          description:
            "Open the current plan in $EDITOR for the user to annotate. Pass the full markdown in the plan argument.",
          input: {
            type: "object",
            properties: {
              plan: { type: "string", description: "Full markdown plan to show the user for review" },
            },
            required: ["plan"],
            additionalProperties: false,
          },
          async execute(input: { plan: string }, toolContext: { sessionID: string }) {
            const result = await runPlanReview(input.plan)
            if (result.trim()) return { content: FEEDBACK_HEADER + result + REVISION_PROMPT }
            const exit = await exitPlanMode(
              api,
              sdk,
              log,
              syntheticPrompt,
              toolContext.sessionID,
              "User closed editor without changes.",
            )
            if (exit.status === "switched")
              return {
                content: `Plan reviewed, no changes. Approved by user. Switched to build agent (${exit.target.providerID}/${exit.target.modelID}).`,
              }
            if (exit.status === "no_model")
              return {
                content:
                  "Plan approved by user, but no build model resolved. Use /set-build-model, then switch to build manually.",
              }
            return { content: `Plan approved, but switching to build failed: ${exit.error}` }
          },
        })
        editor.update("plan_exit", (tool: any) => {
          tool.description = "Do not call this tool. Use plan_review to submit your plan for review."
        })
        editor.update("todowrite", (tool: any) => {
          tool.description = "During planning, call plan_review when your plan is complete."
        })
      }),
    )

    registrations.push(
      await context.command.transform((editor: any) => {
        for (const definition of [
          { name: "set-build-model", description: "Set or list the build model for this session" },
          { name: "plan-diag", description: "Show or reset plan-review model state" },
          { name: "plan-review", description: "Review a plan file" },
        ])
          editor.add({
            ...definition,
            execute: (input: any) =>
              handleCommand(
                {
                  type: "command.executed",
                  properties: {
                    name: definition.name,
                    arguments: input.prompt.text,
                    sessionID: input.sessionID,
                  },
                },
                {
                  client: api,
                  sdk,
                  $: shell,
                  scriptPath: SCRIPT_PATH,
                  directory: context.location.directory,
                  lastShownModels,
                  onPlanApproved,
                },
              ).then(() => undefined),
          })
      }),
    )

    registrations.push(
      await context.session.hook("prompt", async (event: any) => {
        const session = await context.session.get({ sessionID: event.sessionID })
        if ((session.agent !== "plan" && session.agent !== "build") || !session.model) return
        await queueWrite(() =>
          captureImplicit(sdk, event.sessionID, session.agent as Agent, {
            providerID: session.model.providerID,
            modelID: session.model.id,
            ...(session.model.variant ? { variant: session.model.variant } : {}),
          }),
        ).catch((error: unknown) => visibleErr(api, `prompt capture session=${event.sessionID}`, error))
      }),
    )

    const eventListener = (async () => {
      for await (const event of context.event.subscribe({ signal: eventController.signal })) {
        if (event.type !== "session.model.selected") continue
        const session = await context.session.get({ sessionID: event.data.sessionID }).catch((error: unknown) => {
          console.error(
            `plan-review: failed to inspect model event session=${event.data.sessionID}: ${(error as Error)?.message ?? String(error)}`,
          )
          return undefined
        })
        if (!session) continue
        if (
          session.location.directory !== context.location.directory ||
          session.location.workspaceID !== context.location.workspaceID ||
          (session.agent !== "plan" && session.agent !== "build")
        )
          continue
        const pending = pendingModelSwitches.get(session.id)
        if (pending) pendingModelSwitches.delete(session.id)
        if (pending === modelKey(event.data.model)) continue
        await queueWrite(() =>
          writePicker(sdk, session.id, session.agent as Agent, {
            providerID: event.data.model.providerID,
            modelID: event.data.model.id,
            ...(event.data.model.variant ? { variant: event.data.model.variant } : {}),
          }),
        ).catch((error: unknown) => visibleErr(api, `model event capture session=${event.data.sessionID}`, error))
      }
    })().catch((error: unknown) => {
      if (eventController.signal.aborted) return
      console.error(`plan-review: event listener failed: ${(error as Error)?.message ?? String(error)}`)
    })

    registrations.push(
      await context.session.hook("context", (event: any) => {
        if (event.agent !== "plan") return
        if (event.system.some((part: any) => part.text.toLowerCase().includes("generate a title"))) return
        for (const part of event.system)
          part.text = part.text.replace(/\bplan_exit\b/g, "plan_review").replace(/\bExitPlanMode\b/g, "plan_review")
        for (const message of event.messages)
          for (const part of Array.isArray(message.content) ? message.content : [])
            if (part.type === "text")
              part.text = part.text.replace(/\bplan_exit\b/g, "plan_review").replace(/\bExitPlanMode\b/g, "plan_review")
        if (!event.system.some((part: any) => part.text.includes("## CRITICAL: Plan Review")))
          event.system.push({ type: "text", text: REVIEW_INSTRUCTION })
      }),
    )

    return async () => {
      eventController.abort()
      await eventListener
      await writeChain
      await Promise.all([...registrations].reverse().map((registration) => registration.dispose()))
    }
  },
}
