// How the host declines an `agentSession.*` mutation: the closed code list, its
// narrowing guard, and the refusal body a client reads.

import type { AgentJournalResolution } from './agent-session-journal-types'
import type { AgentSessionRewindReason } from './agent-session-rewind'

export const AGENT_SESSION_WIRE_REFUSAL_CODES = [
  'structured_agent_session_unsupported',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'agent_session_operation_conflict',
  'agent_session_operation_expired',
  'agent_session_operation_capacity',
  'agent_session_operation_invalid',
  'agent_session_operation_unknown',
  'agent_session_item_revision_stale',
  'agent_session_already_resolved',
  'agent_session_identity_required',
  'agent_session_journal_unreadable',
  'execution_owner_reconciling',
  // Older clients hold an unknown code as a blocked send with the host's message shown.
  'agent_session_owner_restart_failed'
] as const
export type AgentSessionWireRefusalCode = (typeof AGENT_SESSION_WIRE_REFUSAL_CODES)[number]

/** For a host path that raises its refusal as the thrown code. Narrowing through this keeps an
 *  unrelated fault from being reported to the client as a tidy, wrong refusal. */
export function isAgentSessionWireRefusalCode(
  value: unknown
): value is AgentSessionWireRefusalCode {
  return (
    typeof value === 'string' &&
    (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(value)
  )
}

/** What the host last proved about a session's provider process; see the SSH execution boundary. */
export type AgentSessionOwnerVerdict = 'live' | 'unverifiable' | 'exited'

/**
 * Why the host refused, one per situation with its own honest next step. A code alone cannot say:
 * `agent_session_operation_invalid` covers a cleared conversation (go to the current one) and a
 * busy command (wait), and `agent_session_ownership_unknown` covers an unattached session (wait)
 * and a replay the lease moved past (start again). Set at every emitter a chat write can reach;
 * terminal-agent refusals carry none. Absent from older hosts, so a reader falls back to the code.
 */
export const AGENT_SESSION_REFUSAL_CAUSES = [
  // The request itself
  'operationIdInvalid',
  'operationIdReused',
  'operationExpired',
  'operationCapacity',
  'operationRefusedEarlier',
  'outcomeUnknown',
  'resultLost',
  'fingerprintMismatch',
  'requestMalformed',
  'messageIdReused',
  'clientCapabilityMissing',
  // The host
  'hostDisabled',
  'hostUnsupported',
  'hostReconciling',
  'hostFault',
  'recordUnreadable',
  'recordMissing',
  'journalUnreadable',
  'journalWriteFailed',
  // The session's owner and lease
  'sessionNotAttached',
  'noLiveOwner',
  'noProviderChild',
  'chatStarting',
  'ownerUnproven',
  'ownerAlive',
  'exitUnproven',
  'claimConflicted',
  'settlementPending',
  'notResumable',
  'leaseMoved',
  'replaySuperseded',
  'spawnIdentityMismatch',
  'identityMismatch',
  'fenceStale',
  'handoffInFlight',
  // Creating or adopting a chat
  'sessionExists',
  'tabIdTaken',
  'tabUnconfirmed',
  'conversationHeldElsewhere',
  'conversationUnavailable',
  'transcriptNotFound',
  'transcriptUnreadable',
  // The provider
  'providerStarting',
  'providerStartFailed',
  'providerRejected',
  'notSignedIn',
  'historyTooLarge',
  'optionRejected',
  'goalsUnsupported',
  // The conversation's state
  'conversationCleared',
  'conversationCommandInFlight',
  'conversationCommandUnconfirmed',
  'rewindRefused',
  'rewindUnconfirmed',
  'turnActive',
  'promptPending',
  'backgroundTasksRunning',
  'messagesUnsettled',
  // A prompt card
  'promptGone',
  'promptMoved',
  'promptAlreadyResolved'
] as const
export type AgentSessionRefusalCause = (typeof AGENT_SESSION_REFUSAL_CAUSES)[number]

export function isAgentSessionRefusalCause(value: unknown): value is AgentSessionRefusalCause {
  return typeof value === 'string' && AGENT_SESSION_REFUSAL_CAUSES.some((cause) => cause === value)
}

/** A refusal named without its prose: what a durable record or an error's data keeps. */
export type AgentSessionRefusalReference = {
  code: AgentSessionWireRefusalCode
  cause?: AgentSessionRefusalCause
}

export type AgentSessionWireRefusal = {
  rewindReason?: AgentSessionRewindReason
  code: AgentSessionWireRefusalCode
  /** Absent from older hosts and from refusals no chat write reaches. */
  cause?: AgentSessionRefusalCause
  message: string
  /** On a stale fence, so the client can retry without another round trip. */
  currentFence?: number
  /** On a lost compare-and-set: the winning answer and who gave it. */
  resolution?: AgentJournalResolution
  /** On a lost compare-and-set: the revision the host actually holds. */
  currentRevision?: number
  /** On a durably failed create: `exited` proves nothing runs for the session, so a new
   *  operation cannot collide with this one. Absent (older hosts) reads as unverifiable. */
  ownerVerdict?: AgentSessionOwnerVerdict
}

/** A refusal built at its emitter, with the situation it stands for. */
export function refuse(
  code: AgentSessionWireRefusalCode,
  cause: AgentSessionRefusalCause,
  message: string
): AgentSessionWireRefusal {
  return { code, cause, message }
}

/** The refusal reduced to what may be stored or put in an error's data. */
export function agentSessionRefusalReference(
  refusal: Pick<AgentSessionWireRefusal, 'code' | 'cause'>
): AgentSessionRefusalReference {
  return { code: refusal.code, ...(refusal.cause ? { cause: refusal.cause } : {}) }
}

/**
 * A refusal raised rather than returned. Its message is the bare code, exactly as the
 * `Error(code)` it replaces: the RPC passthrough, the restart-resume ledger and released clients
 * all read a thrown refusal's message as its code. The cause rides on `refusal` and reaches the
 * client only in the RPC error's data. Deliberately no `code` property, so no `'code' in error`
 * passthrough meant for another subsystem can claim it.
 */
export class AgentSessionRefusalError extends Error {
  readonly refusal: AgentSessionWireRefusal

  constructor(refusal: AgentSessionWireRefusal, options?: { cause?: unknown }) {
    super(refusal.code, options)
    this.name = 'AgentSessionRefusalError'
    this.refusal = refusal
  }
}

/** A store or host refusal thrown under its situation; the message stays the code. */
export function agentSessionRefusalError(
  code: AgentSessionWireRefusalCode,
  cause: AgentSessionRefusalCause,
  message: string = code
): AgentSessionRefusalError {
  return new AgentSessionRefusalError(refuse(code, cause, message))
}

export function isAgentSessionRefusalError(error: unknown): error is AgentSessionRefusalError {
  return error instanceof AgentSessionRefusalError
}

/** The situation a thrown refusal named, whatever wrapped it. */
export function thrownAgentSessionRefusalCause(
  error: unknown
): AgentSessionRefusalCause | undefined {
  return error instanceof AgentSessionRefusalError ? error.refusal.cause : undefined
}
