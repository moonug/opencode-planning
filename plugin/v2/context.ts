export type Model = { readonly id: string; readonly providerID: string; readonly variant?: string }

export type SessionInfo = {
  readonly agent?: string
  readonly model?: Model
}

export type SessionMessage = {
  readonly type: string
  readonly text?: string
  readonly agent?: string
  readonly model?: Model
  readonly metadata?: Record<string, unknown>
}

export type SessionPrompt = {
  readonly sessionID: string
  readonly text: string
  readonly delivery?: "steer" | "queue"
  readonly resume?: boolean
}

export type SessionSynthetic = SessionPrompt & {
  readonly description?: string
}

export type Session = {
  readonly get: (input: { readonly sessionID: string }) => Promise<SessionInfo>
  readonly messages: (input: { readonly sessionID: string }) => Promise<ReadonlyArray<SessionMessage>>
  readonly prompt: (input: SessionPrompt) => Promise<unknown>
  readonly synthetic: (input: SessionSynthetic) => Promise<unknown>
  readonly switchAgent: (input: { readonly sessionID: string; readonly agent: string }) => Promise<void>
  readonly switchModel: (input: { readonly sessionID: string; readonly model: Model }) => Promise<void>
  readonly instructions: {
    readonly entry: {
      readonly list: (input: { readonly sessionID: string }) => Promise<ReadonlyArray<{ key: string; value: unknown }>>
      readonly put: (input: { readonly sessionID: string; readonly key: string; readonly value: unknown }) => Promise<void>
      readonly remove: (input: { readonly sessionID: string; readonly key: string }) => Promise<void>
    }
  }
  readonly hook: (
    name: string,
    callback: (event: unknown) => Promise<void> | void,
  ) => Promise<{ readonly dispose: () => Promise<void> }>
}

export type Tool = {
  readonly name: string
  readonly description: string
  readonly input: unknown
  readonly output: unknown
  readonly execute: (input: unknown, context: { readonly sessionID: string }) => Promise<string>
}

export type Context = {
  readonly options: Record<string, unknown>
  readonly agent: {
    readonly get: (id: string) => Promise<{ readonly model?: Model } | undefined>
  }
  readonly catalog: {
    readonly model: {
      readonly list: () => Promise<{ readonly data: ReadonlyArray<{ readonly id: string; readonly providerID: string; readonly name: string; readonly status: string }> }>
      readonly default: () => Promise<{ readonly data: Model | null }>
    }
  }
  readonly session: Session
  readonly tool: {
    readonly transform: (callback: (draft: { readonly add: (tool: Tool) => void }) => void) => Promise<{ readonly dispose: () => Promise<void> }>
  }
}

export type Logger = (level: "debug" | "info" | "warn" | "error", message: string) => Promise<void>
