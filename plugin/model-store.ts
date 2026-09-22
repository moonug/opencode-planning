/**
 * Single source of truth for per-session model picks.
 *
 * Each session carries ONE instruction entry (`planReviewModels`) holding at
 * most one entry per agent (plan / build). All writers — chat.message
 * capture, TUI explicit picker, home→session flush, /set-build-model — go
 * through this module via `updateRecord` (single GET → mutate → PUT). No
 * timestamp sort across mixed clocks: the record IS the current pick.
 *
 * Precedence is decided at WRITE time:
 *   - explicit sources (picker event, /set-build-model) overwrite freely;
 *   - /set-build-model also sets `pinned: true`, which makes implicit
 *     captures (`captureImplicit`) skip that agent;
 *   - chat.message captures are implicit, last-write-wins;
 *   - home flush fills ONLY agents with no existing record (merge-if-absent).
 *
 * Resolution in `exitPlanMode` reads the record and falls back by source
 * ABSENCE (history scan → agent config → config.model → refuse). There is
 * no read-time tournament.
 *
 * Legacy `planReviewDeferredPicks` metadata is read as a one-shot fallback
 * for sessions written before v0.3.0; the next write migrates to the new
 * key. See PRD §FR-8.
 */

export type ModelRef = { providerID: string; modelID: string; variant?: string }

export type Agent = "plan" | "build"

export type Source = "chat" | "picker" | "home-flush" | "command"

export type PickRecord = ModelRef & { source: Source; at: number; pinned?: boolean }

export type ModelsRecord = Partial<Record<Agent, PickRecord>>

export const METADATA_KEY = "planReviewModels"

const LEGACY_METADATA_KEY = "planReviewDeferredPicks"

export function sourceLabel(r: PickRecord): string {
  switch (r.source) {
    case "chat":
      return "chat.message (build)"
    case "picker":
      return "TUI explicit picker (build)"
    case "home-flush":
      return "TUI home selection (build)"
    case "command":
      return "build model memory"
  }
}

function parsePick(raw: unknown): PickRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.providerID !== "string" || typeof r.modelID !== "string") return undefined
  const variant = typeof r.variant === "string" && r.variant !== "default" ? r.variant : undefined
  const source = r.source
  if (source !== "chat" && source !== "picker" && source !== "home-flush" && source !== "command") return undefined
  const at = typeof r.at === "number" ? r.at : typeof r.pickedAt === "number" ? r.pickedAt : undefined
  if (typeof at !== "number") return undefined
  return {
    providerID: r.providerID,
    modelID: r.modelID,
    ...(variant ? { variant } : {}),
    source,
    at,
    ...(r.pinned === true ? { pinned: true } : {}),
  }
}

function parseRecord(raw: unknown): ModelsRecord {
  if (!raw || typeof raw !== "object") return {}
  const r = raw as Record<string, unknown>
  const out: ModelsRecord = {}
  for (const agent of ["plan", "build"] as const) {
    const pick = parsePick(r[agent])
    if (pick) out[agent] = pick
  }
  return out
}

function parseLegacy(raw: unknown): ModelsRecord {
  // Older metadata from v0.2.x had a { plan?, build? } shape with providerID,
  // modelID, pickedAt, optional explicit:false, optional variant. Map it into
  // the new shape with inferred source.
  if (!raw || typeof raw !== "object") return {}
  const r = raw as Record<string, unknown>
  const out: ModelsRecord = {}
  for (const agent of ["plan", "build"] as const) {
    const v = r[agent]
    if (!v || typeof v !== "object") continue
    const p = v as Record<string, unknown>
    if (typeof p.providerID !== "string" || typeof p.modelID !== "string") continue
    const variant = typeof p.variant === "string" && p.variant !== "default" ? p.variant : undefined
    const pickedAt = typeof p.pickedAt === "number" ? p.pickedAt : 0
    const source: Source = p.explicit === false ? "home-flush" : "picker"
    out[agent] = {
      providerID: p.providerID,
      modelID: p.modelID,
      ...(variant ? { variant } : {}),
      source,
      at: pickedAt,
    }
  }
  return out
}

/**
 * The plugin hosts expose different session APIs. Keep the store independent
 * of those wire shapes by adapting each host at its boundary.
 */
export type SdkAdapter = {
  getMetadata: (sessionID: string) => Promise<Record<string, unknown>>
  setMetadata: (sessionID: string, metadata: Record<string, unknown>) => Promise<unknown>
}

type V2SessionClient = {
  get: (input: { sessionID: string }) => Promise<{ data?: { metadata?: Record<string, unknown> } }>
  update: (input: { sessionID: string; metadata: Record<string, unknown> }) => Promise<unknown>
}

/** Build the adapter for the legacy TUI's v2 client (`/session` API). */
export function v2SdkAdapter(client: V2SessionClient): SdkAdapter {
  return {
    async getMetadata(sessionID) {
      const response = await client.get({ sessionID })
      return response.data?.metadata ?? {}
    },
    async setMetadata(sessionID, metadata) {
      return client.update({ sessionID, metadata })
    },
  }
}

/**
 * The V2 Promise session slice this adapter needs, derived from the real host
 * type so the wire shape cannot drift from `session.instructions.entry`.
 */
export type SessionInstructions = {
  readonly instructions: import("./v2/context").Context["session"]["instructions"]
}

/** Build the V2 Promise adapter backed by durable instruction entries. */
export function v2InstructionAdapter(session: SessionInstructions): SdkAdapter {
  type EntryPutValue = Parameters<typeof session.instructions.entry.put>[0]["value"]
  return {
    async getMetadata(sessionID) {
      // Fail open like v1SdkAdapter: an unreachable entry store must not take
      // down plan resolution (resolution falls back to agent/config/history).
      try {
        const entries = await session.instructions.entry.list({ sessionID })
        const record = entries.find((entry) => entry.key === METADATA_KEY)?.value
        if (!record || typeof record !== "object" || Array.isArray(record)) return {}
        return { [METADATA_KEY]: record }
      } catch (err) {
        console.error(
          `plan-review: v2 getMetadata failed for session=${sessionID}: ${(err as Error)?.message ?? String(err)}`
        )
        return {}
      }
    },
    async setMetadata(sessionID, metadata) {
      const value = metadata[METADATA_KEY]
      if (value === undefined) return session.instructions.entry.remove({ sessionID, key: METADATA_KEY })
      // The record is plain JSON by construction (providerID/modelID strings,
      // variant string, numeric timestamp) — cast at the host boundary only.
      return session.instructions.entry.put({ sessionID, key: METADATA_KEY, value: value as EntryPutValue })
    },
  }
}

/** Build an adapter for the v1 SDK (server plugin host). */
export function v1SdkAdapter(client: any): SdkAdapter {
  return {
    async getMetadata(sessionID) {
      try {
        const res = await client.session.get({ path: { id: sessionID } })
        return ((res as any)?.data?.metadata ?? {}) as Record<string, unknown>
      } catch (err) {
        console.error(
          `plan-review: v1 getMetadata failed for session=${sessionID}: ${(err as Error)?.message ?? String(err)}`
        )
        return {}
      }
    },
    async setMetadata(sessionID, metadata) {
      return client.session.update({
        path: { id: sessionID },
        body: { metadata },
      })
    },
  }
}

async function fetchMetadata(sdk: SdkAdapter, sessionID: string): Promise<Record<string, unknown>> {
  return sdk.getMetadata(sessionID)
}

// Per-session in-flight write chains. The instructions.entry read-modify-
// write is only atomic if concurrent writers for the same session serialize;
// the host gives no scheduling order between the model.request hook, the
// context hook path, and a TUI write landing on the same record.
const inFlight = new Map<string, Promise<unknown>>()

function serializeWrite<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(sessionID) ?? Promise.resolve()
  const next = previous.then(run)
  inFlight.set(
    sessionID,
    next.catch(() => undefined),
  )
  return next
}

/**
 * Single GET → mutate → PUT. The updater receives the merged record (with
 * legacy fallback applied) and returns either the next record or undefined
 * to skip the write. To skip without changing anything, return the SAME
 * reference the updater was given (no allocation). Writes always target the
 * new key. An optional `aborted` predicate, if it returns true after the
 * read and before the write, skips the PUT (used to honor TUI disposal).
 */
export async function updateRecord(
  sdk: SdkAdapter,
  sessionID: string,
  updater: (current: ModelsRecord) => ModelsRecord | undefined,
  aborted?: () => boolean,
): Promise<ModelsRecord> {
  return serializeWrite(sessionID, async () => {
    const existing = await fetchMetadata(sdk, sessionID)
    const current = parseRecord(existing[METADATA_KEY])
    const hasCurrent = current.plan !== undefined || current.build !== undefined
    const seed: ModelsRecord = hasCurrent ? current : parseLegacy(existing[LEGACY_METADATA_KEY])
    const next = updater(seed)
    if (!next || next === seed) return seed
    if (aborted?.()) return seed
    try {
      await sdk.setMetadata(sessionID, { ...existing, [METADATA_KEY]: next })
    } catch (err) {
      console.error(`plan-review: updateRecord failed for session=${sessionID}: ${(err as Error)?.message ?? String(err)}`)
      throw err
    }
    return next
  })
}

export async function readRecord(sdk: SdkAdapter, sessionID: string): Promise<ModelsRecord> {
  const existing = await fetchMetadata(sdk, sessionID)
  const current = parseRecord(existing[METADATA_KEY])
  if (current.plan !== undefined || current.build !== undefined) return current
  return parseLegacy(existing[LEGACY_METADATA_KEY])
}

/**
 * chat.message capture. Skips when the existing record is pinned (an
 * explicit /set-build-model for that agent). Otherwise overwrites the
 * agent's entry — last-write-wins for implicit captures. When the captured
 * model equals the recorded one, returns the SAME record reference so
 * updateRecord skips the durable write: the model.request hook fires for
 * EVERY primary request, and rewriting an identical entry each turn would
 * flood the session with no-op instruction entries.
 */
export async function captureImplicit(
  sdk: SdkAdapter,
  sessionID: string,
  agent: Agent,
  model: ModelRef,
): Promise<PickRecord | undefined> {
  const at = Date.now()
  return updateRecord(sdk, sessionID, (cur) => {
    const existing = cur[agent]
    if (existing?.pinned === true) return cur
    if (
      existing &&
      existing.providerID === model.providerID &&
      existing.modelID === model.modelID &&
      (existing.variant ?? undefined) === (model.variant ?? undefined)
    )
      return cur
    return { ...cur, [agent]: { ...model, source: "chat", at } }
  }).then((rec) => rec[agent])
}

/**
 * Explicit picker event. Overwrites freely. Honors `aborted` to skip the
 * write if the caller has disposed (used by the TUI plugin's write chain).
 */
export async function writePicker(
  sdk: SdkAdapter,
  sessionID: string,
  agent: Agent,
  model: ModelRef,
  aborted?: () => boolean,
): Promise<PickRecord | undefined> {
  const at = Date.now()
  return updateRecord(sdk, sessionID, (cur) => {
    if (aborted?.()) return cur
    return { ...cur, [agent]: { ...model, source: "picker", at } }
  }, aborted).then((rec) => rec[agent])
}

/**
 * /set-build-model. Sets pinned:true so future implicit captures leave it
 * alone. Overwrites freely.
 */
export async function writeCommand(
  sdk: SdkAdapter,
  sessionID: string,
  agent: Agent,
  model: ModelRef,
): Promise<PickRecord | undefined> {
  const at = Date.now()
  return updateRecord(sdk, sessionID, (cur) => {
    return { ...cur, [agent]: { ...model, source: "command", at, pinned: true } }
  }).then((rec) => rec[agent])
}

/**
 * Home→session flush. Fills ONLY agents absent from the current record;
 * any existing record wins (the home draft must never overwrite). Returns
 * the agents actually written so callers can clear their pending caches.
 * If nothing was actually filled (every requested agent is already
 * recorded), no metadata write is issued. Honors `aborted` like writePicker.
 */
export async function mergeHomeFlush(
  sdk: SdkAdapter,
  sessionID: string,
  picks: Partial<Record<Agent, ModelRef>>,
  aborted?: () => boolean,
): Promise<Agent[]> {
  const written: Agent[] = []
  await updateRecord(sdk, sessionID, (cur) => {
    let next: ModelsRecord = cur
    let allocated = false
    const at = Date.now()
    for (const agent of ["plan", "build"] as const) {
      if (cur[agent]) continue
      const model = picks[agent]
      if (!model?.providerID || !model.modelID) continue
      if (!allocated) {
        next = { ...cur }
        allocated = true
      }
      next[agent] = { ...model, source: "home-flush", at }
      written.push(agent)
    }
    return next
  }, aborted)
  return written
}

/** Remove the persisted record for a session (used by /plan-diag reset). */
export async function clearRecord(sdk: SdkAdapter, sessionID: string): Promise<void> {
  try {
    const existing = await fetchMetadata(sdk, sessionID)
    const next = { ...existing }
    delete next[METADATA_KEY]
    await sdk.setMetadata(sessionID, next)
  } catch (err) {
    console.error(`plan-review: clearRecord failed for session=${sessionID}: ${(err as Error)?.message ?? String(err)}`)
  }
}
