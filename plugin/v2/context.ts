/**
 * Host types for the opencode2 promise plugin API.
 *
 * Everything here is an ALIAS of the real `@opencode-ai/plugin/v2` types,
 * resolved by tsconfig `paths` to the local opencode-v2 checkout. That way
 * `tsc` validates our calls against the actual host contract instead of a
 * hand-rolled copy — the v0.3.0 lesson was that fake contexts happily accept
 * shapes the real bridge never sends.
 *
 * Test-only fakes stay in the test files; they are not the contract.
 */
import type { Plugin } from "@opencode-ai/plugin/v2"
import type { AnyTool, Context as ToolExecuteContext } from "@opencode-ai/plugin/v2/tool"

export type Context = Plugin.Context
export type Cleanup = Plugin.Cleanup
export type Session = Context["session"]
export type Tool = AnyTool
export type ToolContext = ToolExecuteContext

/** Runtime model reference as the host stores it (`Model.Ref`). */
export type Model = { readonly id: string; readonly providerID: string; readonly variant?: string }

/** Plugin-side logger: server log when reachable, terminal stderr otherwise. */
export type Logger = (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
