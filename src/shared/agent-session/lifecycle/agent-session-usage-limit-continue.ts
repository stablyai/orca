import type { AgentSessionRecord } from './agent-session-record'
import {
  agentSessionAccountHomesEqual,
  isAgentSessionAccountHome,
  type AgentSessionAccountHome
} from './agent-session-account-home'

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

/** The account whose usage limit ended a turn; that account's reset is the one that holds it. */
export type UsageLimitCutAccount = { turnItemId: string; accountHome: AgentSessionAccountHome }

export function isOptionalUsageLimitCutAccount(
  value: unknown
): value is UsageLimitCutAccount | undefined {
  return (
    value === undefined ||
    (typeof value === 'object' &&
      value !== null &&
      'turnItemId' in value &&
      typeof value.turnItemId === 'string' &&
      value.turnItemId.length > 0 &&
      'accountHome' in value &&
      isAgentSessionAccountHome(value.accountHome))
  )
}

export function hasValidUsageLimitRecordFields(record: {
  usageLimitContinueCancel?: unknown
  usageLimitCutAccount?: unknown
}): boolean {
  return (
    isOptionalUsageLimitContinueCancel(record.usageLimitContinueCancel) &&
    isOptionalUsageLimitCutAccount(record.usageLimitCutAccount)
  )
}

export function recordAgentSessionUsageLimitCutAccount(
  record: AgentSessionRecord,
  cut: UsageLimitCutAccount
): AgentSessionRecord {
  const saved = record.usageLimitCutAccount
  return saved?.turnItemId === cut.turnItemId &&
    agentSessionAccountHomesEqual(saved.accountHome, cut.accountHome)
    ? record
    : { ...record, usageLimitCutAccount: cut, updatedAt: Date.now() }
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
