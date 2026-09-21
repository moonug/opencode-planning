/**
 * Readable errors for the python helper spawn.
 *
 * opencode records the message a tool throws verbatim, so an empty message
 * leaves the model and the user with nothing to act on. That is exactly what
 * happened in ses_f6f600deeffe: a stalled macfuse/arc worktree mount made the
 * spawn fail with ENXIO and the tool surfaced a bare `status: "error"`.
 *
 * Shared by the V1 entry (index.ts) and the opencode2 entry (v2/index.ts).
 */

export const TEMP_PREPARE_ERROR =
  "plan-review could not prepare the temp plan file (mkdtemp/writeFileSync failed). " +
  "Check TMPDIR free space and permissions, then retry."

export const SPAWN_ERROR_HINT =
  "If this session lives on an arc worktree mount (arcadia-wt), the macfuse (FUSE) " +
  "mount may be stalled — check `ls` on the project directory and retry."

type HelperError = Error & { code?: string | number; exitCode?: number }

/** Always returns non-empty, actionable text — never an empty message. */
export function describeHelperFailure(err: unknown): string {
  const e = err as HelperError | undefined
  const message = e?.message && e.message.length > 0 ? e.message : String(err)
  const parts = [`plan-review helper failed: ${message}`]
  if (e?.code !== undefined) parts.push(`(code ${e.code})`)
  if (e?.exitCode !== undefined && e.exitCode !== 0) parts.push(`(exit ${e.exitCode})`)
  parts.push(SPAWN_ERROR_HINT)
  return parts.join(" ")
}

export function describeTempPrepareFailure(err: unknown): string {
  const message = (err as Error)?.message ?? String(err)
  return `${TEMP_PREPARE_ERROR} Underlying error: ${message}`
}
