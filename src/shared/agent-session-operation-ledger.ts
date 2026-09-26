import type { AgentSessionRefusalCause } from './agent-session-wire-refusals'
import {
  isAgentSessionRewindResult,
  type AgentSessionRewindReason,
  type AgentSessionRewindResult
} from './agent-session-rewind'
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
import {
  isAgentSessionConversationCommandResult,
  type AgentSessionConversationCommandResult
} from './agent-session-conversation-command'

export const AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT = 512
export const AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT = 4_096

export type AgentSessionOperationOutcome =
  | { status: 'pending' }
  | {
      status: 'succeeded'
      /**
       * Empty exactly when `launch` recorded a terminal surface — a PTY has a handle, not a session
       * id. Kept a required string rather than made optional because a build that predates `launch`
       * rejects a `succeeded` row without one, and a single rejected row invalidates the whole
       * store on load (`agent-session-record-store-file.ts`). A downgrade must skip what it cannot
       * read, not lose every lease in the file.
       */
      sessionId: string
      conversationCommand?: AgentSessionConversationCommandResult
      rewind?: AgentSessionRewindResult
      /**
       * The full `agent.launch` answer. Recorded whole rather than rebuilt, because the preferred
       * mode and the reason a launch downgraded away from it cannot be recomputed once the user's
       * settings move: a replay must return what ran, not what would run now.
       *
       * Typed `unknown`, and deliberately NOT checked by `isAgentSessionOperationRow`, for the same
       * reason `sessionId` above stays required: a row this file rejects makes the whole store
       * unparseable, and a primary and backup that both fail to parse raise
       * `agent_session_store_corrupt` rather than degrading. `isAgentLaunchResult` is a
       * hand-maintained mirror of a result type later work will edit, so a field tightened there
       * would reject rows this same build wrote and take every lease in the file with them. It is
       * narrowed where the value is read instead, where a payload we cannot read costs one replay.
       */
      launch?: unknown
    }
  | {
      status: 'failed'
      code: string
      message?: string
      rewindReason?: AgentSessionRewindReason
      /** Beside the code, so a replay names the situation the first answer did. */
      cause?: AgentSessionRefusalCause
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
  | 'agent_session_operation_capacity'

export type AgentSessionOperationDecision =
  | { decision: 'replay'; row: AgentSessionOperationRow }
  | { decision: 'admit'; row: AgentSessionOperationRow }
  | {
      decision: 'refused'
      code: AgentSessionOperationRefusalCode
      cause: Extract<
        AgentSessionRefusalCause,
        'operationIdInvalid' | 'operationIdReused' | 'operationExpired' | 'operationCapacity'
      >
    }

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

/**
 * Settlement is monotone in one direction only: once an operation is known to have succeeded or
 * failed, a later `unknown` must not take that certainty away. A crash handler, a restart
 * reconciler and the operation's own settle can all reach the same row, and the slowest of them is
 * not the best informed — an `unknown` landing after a recorded success would turn a replayable
 * answer into a permanent refusal for work that demonstrably completed.
 */
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

/**
 * Take exclusive ownership of an admitted operation, atomically.
 *
 * Admission alone does not decide who runs: two callers replaying one id both read `pending`, and
 * two unconditional writes of `unknown` are not a compare-and-swap — both would see their own write
 * land and both would execute. The swap has to be conditional on the state it read, in one step,
 * and it has to report which caller won. `pending` is the only state that can be claimed.
 *
 * The row moves to `unknown` rather than staying `pending` on purpose: from the instant the effect
 * may start, the truthful durable answer is "this may have happened", and a host that dies mid-run
 * leaves exactly that behind.
 */
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
    return {
      decision: 'refused',
      code: 'agent_session_operation_invalid',
      cause: 'operationIdInvalid'
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
          cause: 'operationIdReused'
        }
  }
  if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
    // Why: once a tombstone could have expired, an unseen replay must never be reinterpreted as
    // permission to start another fresh agent.
    return {
      decision: 'refused',
      code: 'agent_session_operation_expired',
      cause: 'operationExpired'
    }
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
    return {
      decision: 'refused',
      code: 'agent_session_operation_capacity',
      cause: 'operationCapacity'
    }
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
