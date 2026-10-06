// What a refusal says beyond its code: one reason list and one set of facts per code.
//
// A code alone cannot say what to do: `agent_session_operation_invalid` covers a cleared
// conversation (open the current one) and a busy command (wait). Each reason here is one situation
// with its own honest words and next step; a reason two codes share is listed under each. There is
// no catch-all: a site that cannot name its situation sends the code with no reason, the same as an
// older host, and the reader falls back to what it does for the code.

import type { AgentJournalResolution } from './agent-session-journal-types'
import { isAgentJournalResolution } from './agent-session-journal-schemas'
import { AGENT_SESSION_REWIND_REASONS, type AgentSessionRewindReason } from './agent-session-rewind'
import type {
  AgentSessionOwnerVerdict,
  AgentSessionWireRefusalCode
} from './agent-session-wire-refusals'

export const AGENT_SESSION_REFUSAL_REASONS = {
  agent_session_operation_invalid: [
    // The request
    'requestMalformed',
    'operationIdInvalid',
    'messageIdReused',
    'operationRefusedEarlier',
    'journalWriteFailed',
    // The conversation's state
    'conversationCleared',
    /** Older hosts only: a /clear that never committed; its replacement may not exist. */
    'clearUnconfirmed',
    /** Older hosts only: a command blocked behind that /clear. */
    'conversationCommandUnconfirmed',
    'conversationCommandInFlight',
    'handoffInFlight',
    'turnActive',
    'promptPending',
    'backgroundTasksRunning',
    'messagesUnsettled',
    'rewindRefused',
    'rewindUnconfirmed',
    // A prompt card or an option
    'promptGone',
    'optionRejected',
    // The provider
    'providerStarting',
    'goalsUnsupported',
    'providerRejected',
    'providerStartFailed',
    'notSignedIn',
    /** The agent's command is not installed where this host looks for it. */
    'providerMissing',
    'historyTooLarge',
    /** The launch's own Anthropic sign-in variables would override the managed Claude account. */
    'managedAccountEnvOverride',
    'accountSwitchInProgress',
    /** A Claude account is added in WSL and no Windows one is selected, which a chat can't run under. */
    'managedAccountUnsupported',
    /** The agent started, then Orca could not open the chat's conversation for it. */
    'attachFailed'
  ],
  agent_session_ownership_unknown: [
    'sessionNotAttached',
    'noLiveOwner',
    /** Orca cannot prove an agent process it recorded or started has exited. */
    'ownerUnproven',
    'claimConflicted',
    'recordMissing',
    'replaySuperseded',
    'leaseMoved',
    'spawnIdentityMismatch',
    'notResumable',
    'noProviderChild',
    'conversationHeldElsewhere',
    /** The close a stop began could not prove its child gone: that child takes no input and none
     *  starts beside it. Sent with `ownerVerdict: 'unverifiable'`. */
    'previousExitUnverifiable'
  ],
  agent_session_conflict: [
    'chatStarting',
    'ownerUnproven',
    'claimConflicted',
    'ownerAlive',
    'identityMismatch',
    'sessionExists',
    'conversationHeldElsewhere',
    'tabIdTaken'
  ],
  execution_owner_reconciling: ['hostReconciling', 'recordUnreadable'],
  agent_session_checkpoint_stale: ['fenceStale', 'leaseMoved', 'recordMissing'],
  agent_session_identity_required: ['recordMissing', 'transcriptNotFound', 'transcriptUnreadable'],
  agent_session_operation_conflict: ['fingerprintMismatch', 'operationIdReused', 'handoffInFlight'],
  agent_session_operation_expired: ['operationExpired'],
  agent_session_operation_capacity: ['operationCapacity'],
  agent_session_operation_unknown: [
    'outcomeUnknown',
    'resultLost',
    'rewindUnconfirmed',
    'tabUnconfirmed'
  ],
  agent_session_item_revision_stale: ['promptMoved'],
  agent_session_already_resolved: ['promptAlreadyResolved'],
  agent_session_journal_unreadable: [
    /** SQLite reports the chat's journal damaged or not a database; no retry reads past it. */
    'journalCorrupt',
    /** Any other failed open, which can clear. */
    'journalUnavailable',
    /** A newer Orca wrote the journal, or this chat's rows; only an update writes past it. */
    'journalWrittenByNewerOrca'
  ],
  structured_agent_session_unsupported: [
    'clientCapabilityMissing',
    'hostDisabled',
    'hostUnsupported'
  ],
  // Sent with no reason when starting the agent for an operation throws; older clients read it too.
  agent_session_owner_restart_failed: []
} as const satisfies Record<AgentSessionWireRefusalCode, readonly string[]>

export type AgentSessionRefusalReason<C extends AgentSessionWireRefusalCode> =
  (typeof AGENT_SESSION_REFUSAL_REASONS)[C][number]

/** A reason under any code, for a reader that keys words on the name alone. */
export type AgentSessionAnyRefusalReason = AgentSessionRefusalReason<AgentSessionWireRefusalCode>

type RewindFacts = {
  /** Which rewind check refused. */
  rewindReason?: AgentSessionRewindReason
}

type PromptFacts = {
  /** The revision the host actually holds. */
  currentRevision?: number
  /** The winning answer and who gave it. */
  resolution?: AgentJournalResolution
}

type NoFacts = Record<never, never>

/** The facts a code carries beside its reason. */
type AgentSessionRefusalFactsByCode = {
  agent_session_operation_invalid: RewindFacts
  agent_session_operation_unknown: RewindFacts
  agent_session_checkpoint_stale: {
    /** So the client can retry without another round trip. */
    currentFence?: number
  }
  agent_session_item_revision_stale: PromptFacts
  agent_session_already_resolved: PromptFacts
  agent_session_ownership_unknown: NoFacts
  agent_session_conflict: NoFacts
  execution_owner_reconciling: NoFacts
  agent_session_identity_required: NoFacts
  agent_session_operation_conflict: NoFacts
  agent_session_operation_expired: NoFacts
  agent_session_operation_capacity: NoFacts
  agent_session_journal_unreadable: NoFacts
  structured_agent_session_unsupported: NoFacts
  agent_session_owner_restart_failed: NoFacts
}

/** A durably failed create says whether anything still runs for it, whichever code it failed
 *  with: `exited` proves nothing does, so a new operation cannot collide with this one. */
type AgentSessionRefusalCommonFacts = { ownerVerdict?: AgentSessionOwnerVerdict }

export type AgentSessionRefusalFacts<C extends AgentSessionWireRefusalCode> =
  AgentSessionRefusalFactsByCode[C] & AgentSessionRefusalCommonFacts

/** What an emitter must name: a reason its code lists, and that code's facts. */
export type AgentSessionRefusalDetailsByCode = {
  [C in AgentSessionWireRefusalCode]: {
    reason: AgentSessionRefusalReason<C>
  } & AgentSessionRefusalFacts<C>
}

/** Details as the wire and a durable record carry them. The reason is absent where the host could
 *  not name the situation; the whole object is absent from older hosts. */
export type AgentSessionRefusalDetails<C extends AgentSessionWireRefusalCode> = {
  reason?: AgentSessionRefusalReason<C>
} & AgentSessionRefusalFacts<C>

/** Details under whichever code, for a store that keeps them beside a code it reads as a string. */
export type AgentSessionAnyRefusalDetails = AgentSessionRefusalDetails<AgentSessionWireRefusalCode>

/** The loose top-level fields released clients read; the host writes them only from details. */
export type AgentSessionLegacyRefusalFields = {
  currentFence?: number
  currentRevision?: number
  resolution?: AgentJournalResolution
  ownerVerdict?: AgentSessionOwnerVerdict
  rewindReason?: AgentSessionRewindReason
}

const FACT_KEYS_BY_CODE: Partial<
  Record<AgentSessionWireRefusalCode, readonly (keyof AgentSessionLegacyRefusalFields)[]>
> = {
  agent_session_operation_invalid: ['rewindReason'],
  agent_session_operation_unknown: ['rewindReason'],
  agent_session_checkpoint_stale: ['currentFence'],
  agent_session_item_revision_stale: ['currentRevision', 'resolution'],
  agent_session_already_resolved: ['currentRevision', 'resolution']
}

const OWNER_VERDICTS: readonly AgentSessionOwnerVerdict[] = ['live', 'unverifiable', 'exited']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFact(
  key: keyof AgentSessionLegacyRefusalFields,
  value: unknown
): AgentSessionLegacyRefusalFields {
  switch (key) {
    case 'currentFence':
      return Number.isSafeInteger(value) && typeof value === 'number' ? { currentFence: value } : {}
    case 'currentRevision':
      return Number.isSafeInteger(value) && typeof value === 'number'
        ? { currentRevision: value }
        : {}
    case 'resolution':
      return isAgentJournalResolution(value) ? { resolution: value } : {}
    case 'ownerVerdict': {
      const ownerVerdict = OWNER_VERDICTS.find((verdict) => verdict === value)
      return ownerVerdict ? { ownerVerdict } : {}
    }
    case 'rewindReason': {
      const rewindReason = AGENT_SESSION_REWIND_REASONS.find((reason) => reason === value)
      return rewindReason ? { rewindReason } : {}
    }
  }
}

export function isAgentSessionRefusalReason<C extends AgentSessionWireRefusalCode>(
  code: C,
  value: unknown
): value is AgentSessionRefusalReason<C> {
  const reasons: readonly string[] = AGENT_SESSION_REFUSAL_REASONS[code]
  return typeof value === 'string' && reasons.includes(value)
}

/**
 * Details as a reader meets them: from the wire, a ledger row or a stored failure, possibly
 * written by another build. Keeps only a reason and facts this code lists, so a reason a newer
 * host added reads as none; undefined when nothing is left.
 */
export function readAgentSessionRefusalDetails<C extends AgentSessionWireRefusalCode>(
  code: C,
  value: unknown
): AgentSessionRefusalDetails<C> | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const keys = [...(FACT_KEYS_BY_CODE[code] ?? []), 'ownerVerdict' as const]
  const facts = keys.reduce<AgentSessionLegacyRefusalFields>(
    (kept, key) => ({ ...kept, ...readFact(key, value[key]) }),
    {}
  )
  const read = {
    ...(isAgentSessionRefusalReason(code, value.reason) ? { reason: value.reason } : {}),
    ...facts
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reason was checked against `code`'s list and only the facts `code` lists (plus the verdict every code may carry) were kept.
  return Object.keys(read).length > 0 ? (read as AgentSessionRefusalDetails<C>) : undefined
}

/** The loose fields released clients read, taken from details; the one place they are written. */
export function agentSessionLegacyRefusalFields(
  details: AgentSessionLegacyRefusalFields | undefined
): AgentSessionLegacyRefusalFields {
  if (!details) {
    return {}
  }
  const { currentFence, currentRevision, resolution, ownerVerdict, rewindReason } = details
  return {
    ...(rewindReason !== undefined ? { rewindReason } : {}),
    ...(currentFence !== undefined ? { currentFence } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {}),
    ...(ownerVerdict !== undefined ? { ownerVerdict } : {})
  }
}
