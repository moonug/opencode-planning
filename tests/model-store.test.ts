import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { readRecord, v1SdkAdapter, v2InstructionAdapter, v2SdkAdapter, writeCommand, writePicker } from "../plugin/model-store"

function memorySdk() {
  const entries = new Map<string, unknown>()
  return v2InstructionAdapter({
    instructions: {
      entry: {
        list: async () => Array.from(entries, ([key, value]) => ({ key, value })),
        put: async ({ key, value }: { key: string; value: unknown }) => void entries.set(key, value),
        remove: async ({ key }: { key: string }) => void entries.delete(key),
      },
    },
  })
}

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

// The host broadcasts exitPlanMode's own switchModel as session.model.selected,
// so the picker capture sees the model it just resolved. An identical model must
// therefore be a no-op — otherwise the echo rewrites (and unpins) the entry.
test("writePicker keeps a pinned entry when the model is unchanged", async () => {
  const sdk = memorySdk()
  await writeCommand(sdk, "ses_pick", "build", { providerID: "p", modelID: "m" })
  assert.equal((await readRecord(sdk, "ses_pick")).build?.pinned, true)

  await writePicker(sdk, "ses_pick", "build", { providerID: "p", modelID: "m" })

  const after = await readRecord(sdk, "ses_pick")
  assert.equal(after.build?.pinned, true)
  assert.equal(after.build?.source, "command")
})

test("writePicker overwrites a pinned entry when the model differs", async () => {
  const sdk = memorySdk()
  await writeCommand(sdk, "ses_pick2", "build", { providerID: "p", modelID: "m" })

  await writePicker(sdk, "ses_pick2", "build", { providerID: "p", modelID: "other" })

  const after = await readRecord(sdk, "ses_pick2")
  assert.equal(after.build?.modelID, "other")
  assert.equal(after.build?.source, "picker")
  assert.equal(after.build?.pinned, undefined)
})
