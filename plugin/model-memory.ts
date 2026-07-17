export type ModelRef = { providerID: string; modelID: string }

export function sessionUpdateInfo(event: any): any {
  if (event?.type === "session.updated") {
    return event.properties?.info ?? event.data?.info
  }
  if (event?.type === "session.updated.1") {
    return event.data?.info
  }
  if (event?.type === "sync" && event.syncEvent?.type === "session.updated.1") {
    return event.syncEvent.data?.info
  }
  return undefined
}

export function rememberBuildModel(event: any, models: Map<string, ModelRef>): void {
  const info = sessionUpdateInfo(event)
  const modelID = info?.model?.modelID ?? info?.model?.id
  const sessionID = info?.id ?? info?.sessionID
  if (!sessionID || !info?.model?.providerID || !modelID) return
  if (info?.agent !== "build") return
  models.set(sessionID, { providerID: info.model.providerID, modelID })
}