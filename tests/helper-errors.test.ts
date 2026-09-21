import { strict as assert } from "node:assert"
import { test } from "bun:test"
import { describeHelperFailure, describeTempPrepareFailure } from "../plugin/helper-errors"

test("helper failures always describe something actionable", () => {
  // The ses_f6f600deeffe case: stalled macfuse/arc mount, ENXIO from spawn.
  const enxio = Object.assign(
    new Error("ENXIO: no such device or address, lstat '/Users/x/arcadia-wt/ghostinvship/junk/moonug'"),
    { code: "ENXIO" },
  )
  const described = describeHelperFailure(enxio)
  assert.ok(described.includes("plan-review helper failed"))
  assert.ok(described.includes("ENXIO"))
  assert.ok(described.includes("code ENXIO"))
  assert.ok(described.includes("macfuse"))

  // The exact defect: an error carrying no message must still surface text.
  const nameless = describeHelperFailure(new Error(""))
  assert.ok(nameless.trim().length > 0)
  assert.ok(nameless.includes("plan-review helper failed"))

  // Non-zero exit with empty stderr must name the exit code.
  const exited = Object.assign(new Error(""), { exitCode: 3 })
  assert.ok(describeHelperFailure(exited).includes("exit 3"))

  // Non-Error rejections are stringified rather than dropped.
  assert.ok(describeHelperFailure(undefined).includes("undefined"))
})

test("temp-file preparation failures name the cause", () => {
  const described = describeTempPrepareFailure(new Error("ENOSPC: no space left on device"))
  assert.ok(described.includes("could not prepare the temp plan file"))
  assert.ok(described.includes("ENOSPC"))
})
