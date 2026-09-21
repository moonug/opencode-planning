#!/usr/bin/env bun
/**
 * `tsc --noEmit` for this plugin, against the REAL opencode2 host types.
 *
 * The host types come from the local opencode-v2 checkout (tsconfig `paths`),
 * so tsc also walks that checkout's sources. A few of its internal files do not
 * compile under our stricter options (`packages/ai`), which is noise: those are
 * not our contract and we do not touch them. This wrapper keeps every
 * diagnostic EXCEPT the ones whose file lives in the checkout, and fails the
 * run if anything of ours is reported.
 */
import { spawnSync } from "node:child_process"

const HOST_PREFIX = "/opencode-v2/"
const DIAGNOSTIC = /^\S.*\(\d+,\d+\): error TS\d+/

const result = spawnSync("bunx", ["tsc", "--noEmit"], { encoding: "utf8" })
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`

// Diagnostics span multiple lines; only the header carries the file path.
const blocks: string[][] = []
for (const line of output.split("\n")) {
  if (DIAGNOSTIC.test(line)) blocks.push([line])
  else if (blocks.length > 0 && /^\s+\S/.test(line)) blocks[blocks.length - 1]!.push(line)
}

const ours = blocks.filter((block) => !block[0]!.includes(HOST_PREFIX))
const hostNoise = blocks.length - ours.length

if (result.error) {
  console.error(`typecheck: could not run tsc: ${result.error.message}`)
  process.exit(1)
}

if (ours.length > 0) {
  for (const block of ours) console.error(block.join("\n"))
  console.error(`\ntypecheck: ${ours.length} error(s) in plugin code`)
  process.exit(1)
}

if (hostNoise > 0) {
  console.log(`typecheck: ok (${hostNoise} pre-existing diagnostic(s) ignored inside the opencode-v2 checkout)`)
} else {
  console.log("typecheck: ok")
}
