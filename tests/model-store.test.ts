import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { v1SdkAdapter, v2InstructionAdapter, v2SdkAdapter } from "../plugin/model-store"

test("v1 adapter puts metadata under the request body", async () => {
  let updateInput: unknown
  const adapter = v1SdkAdapter({
    session: {
      get: async () => ({ data: { metadata: { existing: true } } }),
      update: async (input: unknown) => {
        updateInput = input
      },
    },
  })

  assert.deepEqual(await adapter.getMetadata("ses_v1"), { existing: true })
  await adapter.setMetadata("ses_v1", { planReviewModels: { build: "model" } })
  assert.deepEqual(updateInput, {
    path: { id: "ses_v1" },
    body: { metadata: { planReviewModels: { build: "model" } } },
  })
})

test("legacy TUI v2 adapter puts metadata at the top level", async () => {
  let updateInput: unknown
  const adapter = v2SdkAdapter({
    get: async () => ({ data: { metadata: { existing: true } } }),
    update: async (input: unknown) => {
      updateInput = input
    },
  })

  assert.deepEqual(await adapter.getMetadata("ses_v2"), { existing: true })
  await adapter.setMetadata("ses_v2", { planReviewModels: { build: "model" } })
  assert.deepEqual(updateInput, {
    sessionID: "ses_v2",
    metadata: { planReviewModels: { build: "model" } },
  })
})

test("V2 Promise adapter stores the record as an instruction entry", async () => {
  const entries = new Map<string, unknown>()
  const adapter = v2InstructionAdapter({
    instructions: {
      entry: {
        list: async () => Array.from(entries, ([key, value]) => ({ key, value })),
        put: async ({ key, value }) => void entries.set(key, value),
        remove: async ({ key }) => void entries.delete(key),
      },
    },
  })

  await adapter.setMetadata("ses_v2", { planReviewModels: { build: "model" } })
  assert.deepEqual(await adapter.getMetadata("ses_v2"), { planReviewModels: { build: "model" } })
  await adapter.setMetadata("ses_v2", {})
  assert.deepEqual(await adapter.getMetadata("ses_v2"), {})
})
