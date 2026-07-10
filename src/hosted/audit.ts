export type AuditEvent = {
  event: string
  ts?: string
  requestId?: string
  method?: string
  route?: string
  status?: number
  statusClass?: string
  outcome?: string
  reason?: string
  stage?: string
  errorClass?: string
  errorMessage?: string
  clientIp?: string
  userId?: string
  userEmail?: string
  clientId?: string
  grantType?: string
  accessMode?: string
  toolName?: string
  category?: string
  targetId?: string
  targetprocessMethod?: string
  targetprocessPath?: string
  targetprocessStatus?: number
  targetprocessStatusClass?: string
  durationMs?: number
}

export type AuditLogger = (event: AuditEvent) => void

export const stdoutAuditLogger: AuditLogger = (event) => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...event }))
}

export function targetIdFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined
  const record = args as Record<string, unknown>
  for (const key of ["id", "entityId", "cardId", "userStoryId", "bugId", "featureId", "epicId"]) {
    const value = record[key]
    if (typeof value === "string" && value) return value.slice(0, 80)
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return undefined
}
