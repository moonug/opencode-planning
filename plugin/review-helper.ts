import { spawn, type ChildProcess } from "node:child_process"
import type { Readable } from "node:stream"

const ABORT_GRACE_MS = 2000

const SPAWN_ERROR_HINT =
  "If this session lives on an arc worktree mount (arcadia-wt), the macfuse (FUSE) " +
  "mount may be stalled — check `ls` on the project directory and retry."

async function drain(stream: Readable | null): Promise<string> {
  if (!stream) return ""
  let text = ""
  for await (const chunk of stream) text += chunk.toString()
  return text
}

function exited(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => proc.once("exit", (code) => resolve(code ?? -1)))
}

/**
 * Run the plan-review helper on a temp plan file and return its stdout
 * (a unified diff, empty when the user closed the editor without changes).
 *
 * Abort contract: when `signal` fires, the helper is killed (SIGTERM, then
 * SIGKILL after ABORT_GRACE_MS) and this function THROWS — never resolve
 * with empty stdout on abort, because the tool path treats empty output
 * as "plan approved" and switches the session to the build agent.
 */
export async function runReviewHelper(
  scriptPath: string,
  tmpPath: string,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) {
    throw new Error("plan_review aborted before start (session interrupt)")
  }
  const proc = spawn(scriptPath, ["--file", tmpPath], {
    stdio: ["inherit", "pipe", "pipe"],
  })
  const onAbort = () => {
    proc.kill()
    const timer = setTimeout(() => {
      proc.kill("SIGKILL")
    }, ABORT_GRACE_MS)
    timer.unref()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const [stdout, stderr, done] = await Promise.all([
      drain(proc.stdout),
      drain(proc.stderr),
      new Promise<{ code: number }>((resolve, reject) => {
        proc.once("exit", (code) => resolve({ code: code ?? -1 }))
        proc.once("error", (err) =>
          reject(
            new Error(
              `plan-review helper failed: ${err.message} (spawn). ${SPAWN_ERROR_HINT}`
            )
          )
        )
      }),
    ])
    if (signal?.aborted) {
      throw new Error("plan_review aborted: editor process killed (session interrupt)")
    }
    if (done.code !== 0) {
      // Never surface an empty error: opencode records status:"error" with
      // whatever we throw, and an empty string gives the model nothing to act on.
      const detail = stderr.trim() || `exit code ${done.code}`
      throw new Error(
        `plan-review helper failed: ${detail} (exit ${done.code}). ${SPAWN_ERROR_HINT}`
      )
    }
    return stdout
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}
