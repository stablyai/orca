import type {
  AgentSessionAnyRefusalDetails,
  AgentSessionRefusalDetailsByCode
} from './agent-session-refusal-details'
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
       * rejects a `succeeded` row without one: the records file such a build keeps is unusable to it
       * whole, and a row the database holds is dropped from the ledger, so its retry runs again.
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
       * reason `sessionId` above stays required: a load drops a row it rejects. `isAgentLaunchResult`
       * is a hand-maintained mirror of a result type later work will edit, so a field tightened
       * there would reject rows this same build wrote and lose their replay. It is narrowed where
       * the value is read instead, where a payload we cannot read costs one replay.
       */
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

/** A terminal pane an operation laid out before its process existed. */
export type AgentSessionOperationOwnedPane = { worktreeId: string; paneKey: string }

export type AgentSessionOperationRow = {
  callerKey: string
  operationId: string
  fingerprint: string
  operationTimestamp: number
  recordedAt: number
  expiresAt: number
  outcome: AgentSessionOperationOutcome
  /**
   * The pane an `agent.launch` showed before its agent existed. Written with the claim, so the pane
   * can read its fate off this row — attach, couldn't start, couldn't confirm — across a restart,
   * and stops being owned when the row expires. Not checked by `isAgentSessionOperationRow`: a
   * malformed value costs that pane its verdict, never the row.
   */
  ownedPane?: AgentSessionOperationOwnedPane
}

/** Unexpired rows naming this pane as theirs. */
export function listAgentSessionOperationRowsOwningPane(
  rows: Iterable<AgentSessionOperationRow>,
  pane: AgentSessionOperationOwnedPane,
  now: number
): AgentSessionOperationRow[] {
  const owning: AgentSessionOperationRow[] = []
  for (const row of rows) {
    const owned: unknown = row.ownedPane
    if (
      row.expiresAt > now &&
      typeof owned === 'object' &&
      owned !== null &&
      'paneKey' in owned &&
      'worktreeId' in owned &&
      owned.paneKey === pane.paneKey &&
      owned.worktreeId === pane.worktreeId
    ) {
      owning.push(row)
    }
  }
  return owning
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
  args: { callerKey: string; operationId: string; ownedPane?: AgentSessionOperationOwnedPane }
): { rows: Map<string, AgentSessionOperationRow>; claim: AgentSessionOperationClaim } {
  const key = agentSessionOperationKey(args.callerKey, args.operationId)
  const existing = rows.get(key)
  if (!existing) {
    return { rows: new Map(rows), claim: { claim: 'absent' } }
  }
  if (existing.outcome.status !== 'pending') {
    return { rows: new Map(rows), claim: { claim: 'lost', row: existing } }
  }
  const claimed: AgentSessionOperationRow = {
    ...existing,
    outcome: { status: 'unknown' },
    ...(args.ownedPane ? { ownedPane: args.ownedPane } : {})
  }
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
    // Why: once a tombstone could have expired, an unseen replay must never be reinterpreted as
    // permission to start another fresh agent.
    return {
      decision: 'refused',
      code: 'agent_session_operation_expired',
      details: { reason: 'operationExpired' }
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
      details: {
        reason: 'operationCapacity',
        capacityReturnsAt: agentSessionCapacityReturnsAt(
          rows,
          callerKey,
          perClientLimit,
          globalLimit
        )
      }
    }
  }
  return {
    decision: 'admit',
    row: pendingAgentSessionOperationRow({ callerKey, operationId, fingerprint, now })
  }
}

/** When enough counted rows have aged out for both caps to admit one more id. */
function agentSessionCapacityReturnsAt(
  rows: ReadonlyMap<string, AgentSessionOperationRow>,
  callerKey: string,
  perClientLimit: number,
  globalLimit: number
): number {
  const all = [...rows.values()]
  return Math.max(
    expiryFreeingCapacity(
      all.filter((row) => row.callerKey === callerKey),
      perClientLimit
    ),
    expiryFreeingCapacity(all, globalLimit)
  )
}

/** Pruning drops a row once `now` reaches its expiry; the one that brings the count under `limit`. */
function expiryFreeingCapacity(rows: AgentSessionOperationRow[], limit: number): number {
  if (rows.length < limit) {
    return 0
  }
  return rows.map((row) => row.expiresAt).sort((a, b) => a - b)[rows.length - limit]
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
