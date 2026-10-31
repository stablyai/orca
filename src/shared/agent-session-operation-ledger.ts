import type {
  AgentSessionAnyRefusalDetails,
  AgentSessionRefusalDetailsByCode
} from './agent-session-refusal-details'
import {
  isAgentSessionRewindResult,
  type AgentSessionRewindReason,
  type AgentSessionRewindResult
} from './agent-session-rewind'
/** Persist retry/fingerprint/expiry rules atomically with lease reservations so restarts cannot turn replays into duplicate spawns. Never cap row count: background traffic would block user writes; expire only by replay window. */

import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from './agent-session-host-authority'
import {
  isAgentSessionConversationCommandResult,
  type AgentSessionConversationCommandResult
} from './agent-session/agent-session-conversation-command'

export type AgentSessionOperationOutcome =
  | { status: 'pending' }
  | {
      status: 'succeeded'
      /** Empty for terminal launch: PTYs have handles, not session IDs. Keep the string required because older builds reject/drop rows without it, losing replay evidence. */
      sessionId: string
      conversationCommand?: AgentSessionConversationCommandResult
      rewind?: AgentSessionRewindResult
      /** A no-choice answer cannot be rebuilt from saved picks; narrow at replay, not row load. */
      optionResult?: unknown
      /** Store the whole launch answer: changed settings cannot reconstruct its mode/downgrade reason. Keep unknown and do not validate at row admission: stricter isAgentLaunchResult checks could drop old rows and permit duplicate effects. Narrow at replay read, where an unreadable payload costs only that reply. */
      launch?: unknown
    }
  | {
      status: 'failed'
      code: string
      message?: string
      rewindReason?: AgentSessionRewindReason
      /** Beside the code, so a replay says what the first answer did. Read back against the code,
       *  since the code is a string here; a row written before details carries none. */
      details?: AgentSessionAnyRefusalDetails
    }
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

export type AgentSessionOperationDecision =
  | { decision: 'replay'; row: AgentSessionOperationRow }
  | { decision: 'admit'; row: AgentSessionOperationRow }
  | {
      [C in AgentSessionOperationRefusalCode]: {
        decision: 'refused'
        code: C
        details: AgentSessionRefusalDetailsByCode[C]
      }
    }[AgentSessionOperationRefusalCode]

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
      (targetKey ? key === targetKey : row.operationId === args.operationId) &&
      !supersedesSettledOutcome(row.outcome, args.outcome)
        ? { ...row, outcome: args.outcome }
        : row
    ])
  )
}

/** Never replace settled success/failure with unknown: slower crash/restart reconciliation must not erase a replayable result. */
function supersedesSettledOutcome(
  current: AgentSessionOperationOutcome,
  next: AgentSessionOperationOutcome
): boolean {
  return (
    next.status === 'unknown' && (current.status === 'succeeded' || current.status === 'failed')
  )
}

/** Who owns the right to run this operation's effect. */
export type AgentSessionOperationClaim =
  /** This caller moved the row from `pending`; it alone may run the effect. */
  | { claim: 'won'; row: AgentSessionOperationRow }
  /** Someone else already took it. The row says what to answer with. */
  | { claim: 'lost'; row: AgentSessionOperationRow }
  /** Pruned or never admitted. */
  | { claim: 'absent' }

/** Atomically CAS pending to unknown and return the winner before effects. Admission or unconditional writes let two callers run; unknown durably records possible effects if the host dies mid-run. */
export function claimAgentSessionOperation(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  args: { callerKey: string; operationId: string }
): { rows: Map<string, AgentSessionOperationRow>; claim: AgentSessionOperationClaim } {
  const key = agentSessionOperationKey(args.callerKey, args.operationId)
  const existing = rows.get(key)
  if (!existing) {
    return { rows: new Map(rows), claim: { claim: 'absent' } }
  }
  if (existing.outcome.status !== 'pending') {
    return { rows: new Map(rows), claim: { claim: 'lost', row: existing } }
  }
  const claimed: AgentSessionOperationRow = { ...existing, outcome: { status: 'unknown' } }
  const next = new Map(rows)
  next.set(key, claimed)
  return { rows: next, claim: { claim: 'won', row: claimed } }
}

/** Retain tombstones beyond admission age plus future skew; a gap would turn retries into duplicate spawns. */
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

/** The unexpired row a globally scoped id already holds, under whichever caller admitted it. */
export function findAgentSessionGlobalOperationRow(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  operationId: string,
  now: number
): AgentSessionOperationRow | undefined {
  for (const row of rows.values()) {
    if (row.expiresAt > now && row.operationId === operationId) {
      return row
    }
  }
  return undefined
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

/** Prune before deciding: every retained row remains authoritative for retries. */
export function evaluateAgentSessionOperation(args: {
  rows: ReadonlyMap<string, AgentSessionOperationRow>
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}): AgentSessionOperationDecision {
  const { rows, callerKey, operationId, fingerprint, now } = args
  const operationTimestamp = parseAgentSessionOperationTimestamp(operationId)
  if (
    operationTimestamp === null ||
    operationTimestamp > now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
  ) {
    // Why: a future-dated id could look new again after its tombstone is collected.
    return {
      decision: 'refused',
      code: 'agent_session_operation_invalid',
      details: { reason: 'operationIdInvalid' }
    }
  }
  const key = agentSessionOperationKey(callerKey, operationId)
  const existing = rows.get(key)
  if (existing) {
    return existing.fingerprint === fingerprint
      ? { decision: 'replay', row: existing }
      : {
          decision: 'refused',
          code: 'agent_session_operation_conflict',
          details: { reason: 'operationIdReused' }
        }
  }
  if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
    // Once the tombstone could have expired, unseen retries cannot authorize a fresh agent.
    return {
      decision: 'refused',
      code: 'agent_session_operation_expired',
      details: { reason: 'operationExpired' }
    }
  }
  return {
    decision: 'admit',
    row: pendingAgentSessionOperationRow({ callerKey, operationId, fingerprint, now })
  }
}

/** A `pending` row for this id, retained for the full replay window from `now`. */
export function pendingAgentSessionOperationRow(args: {
  callerKey: string
  operationId: string
  fingerprint: string
  now: number
}): AgentSessionOperationRow {
  const operationTimestamp = parseAgentSessionOperationTimestamp(args.operationId)
  if (operationTimestamp === null) {
    throw new Error('agent_session_operation_invalid')
  }
  return {
    callerKey: args.callerKey,
    operationId: args.operationId,
    fingerprint: args.fingerprint,
    operationTimestamp,
    recordedAt: args.now,
    expiresAt: agentSessionOperationExpiry(operationTimestamp, args.now),
    outcome: { status: 'pending' }
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
      // `launch` is intentionally absent from this check; see the field's own note above.
      (outcome.status === 'succeeded' &&
        typeof outcome.sessionId === 'string' &&
        (outcome.rewind === undefined || isAgentSessionRewindResult(outcome.rewind)) &&
        (outcome.conversationCommand === undefined ||
          isAgentSessionConversationCommandResult(outcome.conversationCommand))) ||
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
