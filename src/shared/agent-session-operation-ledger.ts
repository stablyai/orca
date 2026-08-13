/**
 * Durable client-operation ledger.
 *
 * `terminal.ensureAgentSession` / `terminal.createAgentSession` already enforce timestamped
 * operation ids with fingerprint conflict detection, age expiry, capacity limits, and tombstone
 * retention — but in memory, so a host restart turns "replay this create" into "spawn another
 * agent". These are the same rules over rows that survive a restart; the store writes a row in
 * the same atomic transaction as the lease reservation.
 */

import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from './agent-session-host-authority'

export const AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT = 512
export const AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT = 4_096

export type AgentSessionOperationOutcome =
  | { status: 'pending' }
  | { status: 'succeeded'; sessionId: string }
  | { status: 'failed'; code: string; message?: string }
  /** The effect may or may not have happened; replay this answer instead of spawning again. */
  | { status: 'unknown' }

export type AgentSessionOperationRow = {
  callerKey: string
  operationId: string
  fingerprint: string
  operationTimestamp: number
  recordedAt: number
  expiresAt: number
  outcome: AgentSessionOperationOutcome
}

export type AgentSessionOperationRefusalCode =
  | 'agent_session_operation_invalid'
  | 'agent_session_operation_conflict'
  | 'agent_session_operation_expired'
  | 'agent_session_operation_capacity'

export type AgentSessionOperationDecision =
  | { decision: 'replay'; row: AgentSessionOperationRow }
  | { decision: 'admit'; row: AgentSessionOperationRow }
  | { decision: 'refused'; code: AgentSessionOperationRefusalCode }

/** NUL cannot occur in a caller key or operation id, so no pair can forge another pair's key. */
const OPERATION_KEY_SEPARATOR = '\u0000'

export function agentSessionOperationKey(callerKey: string, operationId: string): string {
  return `${callerKey}${OPERATION_KEY_SEPARATOR}${operationId}`
}

export function settleAgentSessionOperation(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  args: {
    /** Restart reconciliation omits this because the lease persists no client identity. */
    callerKey?: string
    operationId: string
    outcome: AgentSessionOperationOutcome
  }
): Map<string, AgentSessionOperationRow> {
  const targetKey = args.callerKey
    ? agentSessionOperationKey(args.callerKey, args.operationId)
    : null
  return new Map(
    [...rows].map(([key, row]) => [
      key,
      (targetKey ? key === targetKey : row.operationId === args.operationId)
        ? { ...row, outcome: args.outcome }
        : row
    ])
  )
}

/**
 * Retention floor. The tombstone must outlive the window in which its id could still be admitted
 * as new, plus the accepted future skew — otherwise a retry arriving in the gap becomes a second
 * spawn instead of a replay.
 */
export function agentSessionOperationExpiry(
  operationTimestamp: number,
  recordedAt: number
): number {
  return (
    Math.max(recordedAt, operationTimestamp) +
    AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS +
    AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
  )
}

export function pruneAgentSessionOperationRows(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  now: number
): Map<string, AgentSessionOperationRow> {
  const kept = new Map<string, AgentSessionOperationRow>()
  for (const [key, row] of rows) {
    if (row.expiresAt > now) {
      kept.set(key, row)
    }
  }
  return kept
}

/**
 * Decide what a mutating call with this operation id means against the persisted ledger. Callers
 * must prune first; a row that is present is a row that is still authoritative.
 */
export function evaluateAgentSessionOperation(args: {
  rows: ReadonlyMap<string, AgentSessionOperationRow>
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
  perClientLimit?: number
  globalLimit?: number
}): AgentSessionOperationDecision {
  const { rows, callerKey, operationId, fingerprint, now } = args
  const operationTimestamp = parseAgentSessionOperationTimestamp(operationId)
  if (
    operationTimestamp === null ||
    operationTimestamp > now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
  ) {
    // Why: a future-dated id could look new again after its tombstone is collected.
    return { decision: 'refused', code: 'agent_session_operation_invalid' }
  }
  const key = agentSessionOperationKey(callerKey, operationId)
  const existing = rows.get(key)
  if (existing) {
    return existing.fingerprint === fingerprint
      ? { decision: 'replay', row: existing }
      : { decision: 'refused', code: 'agent_session_operation_conflict' }
  }
  if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
    // Why: once a tombstone could have expired, an unseen replay must never be reinterpreted as
    // permission to start another fresh agent.
    return { decision: 'refused', code: 'agent_session_operation_expired' }
  }
  const perClientLimit = args.perClientLimit ?? AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT
  const globalLimit = args.globalLimit ?? AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT
  let callerCount = 0
  for (const row of rows.values()) {
    if (row.callerKey === callerKey) {
      callerCount += 1
    }
  }
  if (callerCount >= perClientLimit || rows.size >= globalLimit) {
    // Why: tombstones cannot be evicted early without making an old replay capable of spawning
    // again; reject new ids until retained rows age out.
    return { decision: 'refused', code: 'agent_session_operation_capacity' }
  }
  return {
    decision: 'admit',
    row: {
      callerKey,
      operationId,
      fingerprint,
      operationTimestamp,
      recordedAt: now,
      expiresAt: agentSessionOperationExpiry(operationTimestamp, now),
      outcome: { status: 'pending' }
    }
  }
}

const OPERATION_ID_MAX_LENGTH = 128

export function isAgentSessionOperationRow(value: unknown): value is AgentSessionOperationRow {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const row = value as Partial<AgentSessionOperationRow>
  const outcome = row.outcome as AgentSessionOperationOutcome | undefined
  const outcomeValid =
    typeof outcome === 'object' &&
    outcome !== null &&
    ((outcome.status === 'pending' && true) ||
      (outcome.status === 'succeeded' && typeof outcome.sessionId === 'string') ||
      (outcome.status === 'failed' && typeof outcome.code === 'string') ||
      outcome.status === 'unknown')
  return (
    typeof row.callerKey === 'string' &&
    row.callerKey.length > 0 &&
    typeof row.operationId === 'string' &&
    row.operationId.length <= OPERATION_ID_MAX_LENGTH &&
    parseAgentSessionOperationTimestamp(row.operationId) !== null &&
    typeof row.fingerprint === 'string' &&
    row.fingerprint.length > 0 &&
    Number.isSafeInteger(row.operationTimestamp) &&
    Number.isSafeInteger(row.recordedAt) &&
    Number.isSafeInteger(row.expiresAt) &&
    outcomeValid
  )
}
