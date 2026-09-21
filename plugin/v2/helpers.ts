// Tiny cross-module helpers — no plugin state, no DOM.
import type { Logger } from "./context"

export function withTimeoutSafe<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

export const log: Logger = async (level, message) => {
  // The v2 host context exposes no log API (app carries only name/version/
  // channel), so terminal output is the only startup diagnostics channel.
  // Keep debug out of it, but never silence info: the `plugin init v...` line
  // is how QA verifies which build actually loaded.
  if (level === "debug") return
  const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log
  write(`plan-review: ${message}`)
}

/**
 * Fire-and-forget variant of log() that never swallows an error silently.
 * Per AGENTS.md: `catch {}` is forbidden. This is the only place in this
 * codebase where a catch is allowed to fail open — it routes the failure
 * through console.error so it lands in terminal stderr even when the
 * server log API is unreachable.
 */
export function logged(
  logger: Logger,
  level: "debug" | "info" | "warn" | "error",
  message: string
): Promise<void> {
  return logger(level, message)
    .then(() => undefined)
    .catch((e: unknown) => {
      const errText = (e as Error)?.message ?? String(e)
      console.error(`plan-review: log(${level}) call failed: ${errText}; original=${message}`)
    })
}

/**
 * visibleErr — helper for non-log promises. Records the error on the
 * server log first, falls back to console.error if server is unreachable.
 */
export async function visibleErr(logger: Logger, context: string, e: unknown): Promise<void> {
  const errText = (e as Error)?.message ?? String(e)
  try {
    await logged(logger, "warn", `swallowed error in ${context}: ${errText}`)
  } catch (logErr) {
    console.error(
      `plan-review: swallowed error in ${context}: ${errText} (log also failed: ${(logErr as Error)?.message ?? String(logErr)})`
    )
  }
}
