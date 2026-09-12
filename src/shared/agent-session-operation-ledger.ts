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
import { parseAgentJournalItemKey } from './agent-session-journal-item-key'
import {
  isAgentSessionConversationCommandResult,
  type AgentSessionConversationCommandResult
} from './agent-session-conversation-command'

export const AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT = 512
export const AGENT_SESSION_DURABLE_OPERATION_GLOBAL_LIMIT = 4_096
export const AGENT_SESSION_OPERATION_PROVIDER_ID_MAX_BYTES = 512
export const AGENT_SESSION_PROMPT_CANCEL_MAX_PROMPTS = 64
export const AGENT_SESSION_PROMPT_CANCEL_MAX_ITEM_ID_BYTES = 256 * 1024

export type AgentSessionPromptCancelTarget = { itemId: string; expectedRevision: number }

export type AgentSessionPromptCancelSettlement = {
  phase: 'prepared' | 'provider-confirmed'
  sessionId: string
  runtimeFence: number
  threadId?: string
  turnId: string
  target: AgentSessionPromptCancelTarget
  prompts: readonly AgentSessionPromptCancelTarget[]
  resolvedAt: number
}

export type AgentSessionOperationOutcome =
  | { status: 'pending' }
  | {
      status: 'succeeded'
      sessionId: string
      /** Result of a turn-cancel mutation, absent on older rows and other operations. */
      cancelled?: boolean
      cancelledTurnId?: string
      conversationCommand?: AgentSessionConversationCommandResult
      rewind?: AgentSessionRewindResult
    }
  | { status: 'failed'; code: string; message?: string; rewindReason?: AgentSessionRewindReason }
  /** The effect may or may not have happened; replay this answer instead of spawning again. */
  | {
      status: 'unknown'
      /** Durable intent written before interruption, advanced once the provider confirms it. */
      promptCancelSettlement?: AgentSessionPromptCancelSettlement
    }

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
      (outcome.status === 'succeeded' &&
        typeof outcome.sessionId === 'string' &&
        (outcome.cancelled === undefined || typeof outcome.cancelled === 'boolean') &&
        // Older builds persisted provider-owned ids without this release's ingress bound.
        (outcome.cancelledTurnId === undefined || typeof outcome.cancelledTurnId === 'string') &&
        (outcome.rewind === undefined || isAgentSessionRewindResult(outcome.rewind)) &&
        (outcome.conversationCommand === undefined ||
          isAgentSessionConversationCommandResult(outcome.conversationCommand))) ||
      (outcome.status === 'failed' && typeof outcome.code === 'string') ||
      (outcome.status === 'unknown' &&
        (outcome.promptCancelSettlement === undefined ||
          isPromptCancelSettlement(outcome.promptCancelSettlement))))
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

function isPromptCancelSettlement(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const settlement = value as {
    sessionId?: unknown
    threadId?: unknown
    turnId?: unknown
    runtimeFence?: unknown
    phase?: unknown
    target?: unknown
    prompts?: unknown
    resolvedAt?: unknown
  }
  const target = settlement.target
  const prompts = settlement.prompts
  return (
    (settlement.phase === 'prepared' || settlement.phase === 'provider-confirmed') &&
    typeof settlement.sessionId === 'string' &&
    settlement.sessionId.length > 0 &&
    Number.isSafeInteger(settlement.runtimeFence) &&
    (settlement.runtimeFence as number) > 0 &&
    (settlement.threadId === undefined || isBoundedProviderId(settlement.threadId)) &&
    isBoundedProviderId(settlement.turnId) &&
    isAgentSessionPromptCancelTargetsWithinBounds(prompts) &&
    isPromptTarget(target) &&
    prompts.some(
      (prompt) =>
        prompt.itemId === target.itemId && prompt.expectedRevision === target.expectedRevision
    ) &&
    Number.isSafeInteger(settlement.resolvedAt)
  )
}

export function isAgentSessionPromptCancelItemIdListWithinBounds(
  value: unknown
): value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > AGENT_SESSION_PROMPT_CANCEL_MAX_PROMPTS
  ) {
    return false
  }
  let bytes = 0
  const ids = new Set<string>()
  for (const itemId of value) {
    if (typeof itemId !== 'string' || !parseAgentJournalItemKey(itemId) || ids.has(itemId)) {
      return false
    }
    ids.add(itemId)
    bytes += Buffer.byteLength(itemId, 'utf8')
    if (bytes > AGENT_SESSION_PROMPT_CANCEL_MAX_ITEM_ID_BYTES) {
      return false
    }
  }
  return true
}

export function isAgentSessionPromptCancelTargetsWithinBounds(
  value: unknown
): value is readonly AgentSessionPromptCancelTarget[] {
  if (!Array.isArray(value) || !value.every(isPromptTarget)) {
    return false
  }
  return isAgentSessionPromptCancelItemIdListWithinBounds(value.map((target) => target.itemId))
}

export function isBoundedAgentSessionOperationProviderId(value: unknown): value is string {
  return isBoundedProviderId(value)
}

function isBoundedProviderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= AGENT_SESSION_OPERATION_PROVIDER_ID_MAX_BYTES
  )
}

function isPromptTarget(value: unknown): value is AgentSessionPromptCancelTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { itemId?: unknown }).itemId === 'string' &&
    parseAgentJournalItemKey((value as { itemId: string }).itemId) !== null &&
    Number.isSafeInteger((value as { expectedRevision?: unknown }).expectedRevision) &&
    ((value as { expectedRevision: number }).expectedRevision ?? -1) >= 0
  )
}
