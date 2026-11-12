import type { AgentSessionRecord } from './agent-session-record'

export type UsageLimitContinueIdentity = { turnItemId: string; resetsAt: number }

export function isOptionalUsageLimitContinueCancel(
  value: unknown
): value is UsageLimitContinueIdentity | undefined {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      'turnItemId' in value &&
      typeof value.turnItemId === 'string' &&
      value.turnItemId.length > 0 &&
      'resetsAt' in value &&
      typeof value.resetsAt === 'number' &&
      Number.isFinite(value.resetsAt))
  )
}

export function cancelAgentSessionUsageLimitContinue(
  record: AgentSessionRecord,
  cut: UsageLimitContinueIdentity
): AgentSessionRecord {
  return record.usageLimitContinueCancel?.turnItemId === cut.turnItemId &&
    record.usageLimitContinueCancel.resetsAt === cut.resetsAt
    ? record
    : { ...record, usageLimitContinueCancel: cut, updatedAt: Date.now() }
}
