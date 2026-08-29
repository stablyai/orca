// ─── Structured agent-session wire contract ─────────────────────────────────
// The shapes `agentSession.*` accepts and publishes. Phase 2 builds provider
// adapters and clients against exactly these types, so everything here must be
// plain JSON. The whole surface is gated by agent-session.structured.v1, which
// no released baseline advertises; after that capability ships, every new field
// must remain optional to old readers (docs/reference/remote-wire-compatibility.md).

import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalResetReason,
  AgentJournalResolution,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type { AgentSessionHandoffStage, AgentSessionOwnerRuntimeKind } from './agent-session-record'
import type { AgentProviderSessionMetadata } from './agent-session-resume'

export type AgentSessionHandoffDirection = 'to-tui' | 'to-native'
export type AgentSessionHandoffMode = 'now' | 'after-turn' | 'stop-turn'
export type AgentSessionHandoffAction = 'start' | 'cancel-queued' | 'retry' | 'recover'

export type AgentSessionHandoffStatus = {
  owner: AgentSessionOwnerRuntimeKind | 'none'
  direction: AgentSessionHandoffDirection | null
  phase: 'idle' | 'queued' | 'switching' | 'waiting-for-exit' | 'failed'
  stage: AgentSessionHandoffStage | null
  operationId: string | null
  hostLabel?: string
  terminal?: {
    handle: string
    tabId: string
    paneKey: string
    ptyId?: string
  }
  error?: {
    message: string
    details?: string
    recoverableOwner: AgentSessionOwnerRuntimeKind | 'none'
    canRetryProof?: boolean
  }
}

export type AgentSessionHandoffRequest = {
  envelope: AgentSessionMutationEnvelope
  direction: AgentSessionHandoffDirection
  mode: AgentSessionHandoffMode
  action?: AgentSessionHandoffAction
}

export type AgentSessionHandoffResult = { status: AgentSessionHandoffStatus }

/** Backward paging is the client's normal read; 40 matches the page size the
 *  mobile list renders without a visible fill-in. */
export const AGENT_SESSION_HISTORY_DEFAULT_LIMIT = 40
export const AGENT_SESSION_HISTORY_MAX_LIMIT = 200

export const AGENT_SESSION_HISTORY_DIRECTIONS = ['tail', 'before', 'after'] as const
/** `tail` is the newest page, `before` pages backward, `after` catches a live
 *  reader up. Only `after` needs replayable rows; the other two read the
 *  reduced timeline and so survive compaction. */
export type AgentSessionHistoryDirection = (typeof AGENT_SESSION_HISTORY_DIRECTIONS)[number]

export type AgentSessionHistoryRequest = {
  sessionId: string
  direction: AgentSessionHistoryDirection
  /** Required for `before` and `after`; ignored for `tail`. */
  cursor?: AgentJournalCursor
  limit?: number
}

export type AgentSessionHistoryPage = {
  sessionId: string
  epoch: string
  /** Optional for mixed-version readers; write-capable clients use the
   *  checkpoint without forcing a second attach or a redundant snapshot. */
  fence?: number
  direction: AgentSessionHistoryDirection
  items: AgentJournalRenderItem[]
  /** Populated by `after` reads so a disconnected client can apply tombstones. */
  removedItemIds: string[]
  /** Submissions overlapping this page, so an unconfirmed bubble renders with
   *  its dispatch state instead of as a plain message. */
  submissions: AgentJournalSubmission[]
  /** Page edges. `nextCursor` is what the client sends back for the same
   *  direction; it equals the request cursor when the page is empty. */
  window: {
    oldest: AgentJournalCursor | null
    newest: AgentJournalCursor | null
    nextCursor: AgentJournalCursor
  }
  /** Current journal head for switching from a bounded page to live subscribe. */
  liveCursor?: AgentJournalCursor
  hasOlder: boolean
  hasNewer: boolean
}

export type AgentSessionHistoryResult =
  | { ok: true; page: AgentSessionHistoryPage; providerSession?: AgentProviderSessionMetadata }
  /** Every reset carries a byte-bounded tail page so recovery cannot exceed
   *  remote outbound admission or require another call before resubscribing. */
  | {
      ok: false
      reset: AgentJournalResetReason
      page: AgentSessionHistoryPage
      fence?: number
      providerSession?: AgentProviderSessionMetadata
    }

/** Cursor-qualified incremental publication. Items and submissions carry their
 *  CURRENT reduced state rather than a delta, so applying a batch twice
 *  converges instead of double-appending. */
export type AgentSessionJournalBatch = {
  cursor: AgentJournalCursor
  items: AgentJournalRenderItem[]
  removedItemIds: string[]
  submissions: AgentJournalSubmission[]
}

export type AgentSessionSubscribeEvent =
  | {
      type: 'snapshot'
      sessionId: string
      page: AgentSessionHistoryPage
      fence: number
      handoff?: AgentSessionHandoffStatus
    }
  | {
      type: 'batch'
      sessionId: string
      batch: AgentSessionJournalBatch
      /** Added with handoff state so mixed-version cursors retain the ownership fence. */
      fence?: number
      handoff?: AgentSessionHandoffStatus
    }
  | {
      type: 'reset'
      sessionId: string
      reset: AgentJournalResetReason
      page: AgentSessionHistoryPage
      fence: number
      handoff?: AgentSessionHandoffStatus
    }
  | { type: 'end' }

// ─── Mutation envelope ──────────────────────────────────────────────────────

/**
 * The four fields every mutating call carries. Same operation id and same
 * fingerprint replays the recorded outcome; a different fingerprint under one
 * operation id is a conflict, never a second effect.
 */
export type AgentSessionMutationEnvelope = {
  sessionId: string
  clientOperationId: string
  /** Null only on a create for a session that does not exist yet. */
  expectedRuntimeFence: number | null
  /** Client-declared; the host recomputes it and compares. */
  payloadFingerprint: string
}

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
  'execution_owner_reconciling'
] as const
export type AgentSessionWireRefusalCode = (typeof AGENT_SESSION_WIRE_REFUSAL_CODES)[number]

export type AgentSessionWireRefusal = {
  code: AgentSessionWireRefusalCode
  message: string
  /** On a stale fence, so the client can retry without another round trip. */
  currentFence?: number
  /** On a lost compare-and-set: the winning answer and who gave it. */
  resolution?: AgentJournalResolution
  /** On a lost compare-and-set: the revision the host actually holds. */
  currentRevision?: number
}

export type AgentSessionMutationResult<TValue> =
  | {
      ok: true
      /** True when the recorded outcome was returned instead of a new effect. */
      replayed: boolean
      fence: number
      cursor: AgentJournalCursor
      value: TValue
    }
  | { ok: false; refusal: AgentSessionWireRefusal }

// ─── Per-method payloads ────────────────────────────────────────────────────

export type AgentSessionAttachResult = {
  sessionId: string
  fence: number
  page: AgentSessionHistoryPage
  /** Submissions the crash boundary settled as `unknown` while attaching. */
  unconfirmedClientMessageIds: string[]
}

export type AgentSessionSendResult = {
  clientMessageId: string
  submission: AgentJournalSubmission
}

export type AgentSessionCancelResult = {
  /** The turn the client named, echoed so a late reply can be matched. */
  turnId: string
  cancelled: boolean
}

export type AgentSessionPromptResult = {
  itemId: string
  revision: number
  resolution: AgentJournalResolution
}

export type AgentSessionOptionResult = {
  key: string
  value: string
  /** Full effective next-turn values when the provider reconciled related options. */
  options?: Record<string, string>
}

export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

export type AgentSessionModelOption = {
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  efforts: AgentSessionOptionChoice[]
}

/** Provider-reported choices and effective next-turn values. Additive read-only
 *  surface so older hosts can reject it without changing structured v1 writes. */
export type AgentSessionOptionsResult = {
  models: AgentSessionModelOption[]
  current: {
    model: string
    effort?: string
  }
}
