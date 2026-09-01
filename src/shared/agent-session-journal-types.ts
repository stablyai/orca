// ─── Canonical agent-session journal: cross-process wire shapes ─────────────
// The host-owned timeline for a structured agent session. Everything here must
// be plain JSON: rows are persisted verbatim and later republished to clients,
// so no class instances, Maps, or Dates.
//
// Rows are append-only. `schemaVersion` is upcast at read time and never
// rewritten in place, so a host that cannot read a row refuses to write the
// journal rather than skipping or compacting past it.

import type { AgentType } from './agent-status-types'
import type { NativeChatBlock, NativeChatRole } from './native-chat-types'

export { type AgentType }

/** Bump only alongside a read-time upcaster in `journal-row-schema.ts`. */
export const AGENT_SESSION_JOURNAL_SCHEMA_VERSION = 2

/** Epoch-qualified position in one journal. `sequence` 0 means "before the first row". */
export type AgentJournalCursor = {
  epoch: string
  sequence: number
}

/** The durable provider session a journal is bound to.
 *  Codex is one thread id; Claude needs the leaf because concurrent resumes of
 *  one session id branch the same transcript. */
export type AgentSessionProviderHandle =
  | { kind: 'codex'; threadId: string }
  | { kind: 'claude'; sessionId: string; leafUuid: string | null }
  | { kind: 'opaque'; agent: AgentType; value: string }

/** The narrow slice of the durable session record the journal needs. The full
 *  record (owner, lease, account home) belongs to the session store. */
export type AgentSessionJournalIdentity = {
  /** Orca agent-session id — the journal's primary key. */
  sessionId: string
  /** Execution-host workspace key. Identical for a worktree, a folder
   *  workspace, a WSL distro, and an SSH host; never a path. */
  workspaceId: string
  /** Execution host that owns the process, so a client restart adjudicates nothing. */
  hostId: string
  agent: AgentType
  providerHandle: AgentSessionProviderHandle
}

// ─── Item identity ──────────────────────────────────────────────────────────
// Reconciliation keys, settled by the provider spikes. Codex renumbers items
// positionally on resume, so a persisted item id is never an identity. Claude
// copies the original uuids on fork, so the uuid is.

export type AgentJournalItemIdentity =
  | { provider: 'codex'; threadId: string; turnId: string; ordinal: number }
  | { provider: 'claude'; sessionId: string; uuid: string }
  /** A submission Orca minted before any provider echo existed. */
  | { provider: 'orca'; clientMessageId: string }
  /** Bridge-era transcript record with no provider-stable identity. */
  | { provider: 'legacy'; agent: AgentType; sessionId: string; recordId: string }

// ─── Bounded payloads ───────────────────────────────────────────────────────

/** A tool output or diff body clipped to a head plus a content-addressed
 *  remainder. Crossing a bound sets `truncated`; it never silently drops. */
export type AgentJournalBoundedPayload = {
  head: string
  /** Byte length of the ORIGINAL payload, not of `head`. */
  byteLength: number
  /** sha256 of the original payload, and the blob store key when `truncated`. */
  digest: string
  truncated: boolean
}

// ─── Render-model items ─────────────────────────────────────────────────────

export type AgentJournalMessageItem = {
  kind: 'message'
  role: NativeChatRole
  blocks: NativeChatBlock[]
}

export type AgentJournalToolCallState = 'running' | 'completed' | 'failed'

export type AgentJournalToolCallItem = {
  kind: 'tool-call'
  name: string
  input: unknown
  state: AgentJournalToolCallState
  output?: AgentJournalBoundedPayload
}

export type AgentJournalDiffItem = {
  kind: 'diff'
  path: string
  patch: AgentJournalBoundedPayload
}

export const AGENT_JOURNAL_RESOLUTION_STATES = ['pending', 'resolved', 'cancelled'] as const
export type AgentJournalResolutionState = (typeof AGENT_JOURNAL_RESOLUTION_STATES)[number]

/** Approvals and questions are durable items with explicit resolution state, so
 *  a second client answering one prompt loses the compare-and-set instead of
 *  invoking the provider callback twice. */
export type AgentJournalResolution = {
  state: AgentJournalResolutionState
  /** Option id the winner picked; null while pending or cancelled. */
  selectedOptionId: string | null
  /** Opaque client identity of the resolver, for "answered on <device>". */
  resolvedBy: string | null
  resolvedAt: number | null
}

export type AgentJournalPromptOption = {
  id: string
  label: string
}

export type AgentJournalApprovalItem = {
  kind: 'approval'
  title: string
  detail: string | null
  options: AgentJournalPromptOption[]
  resolution: AgentJournalResolution
}

export type AgentJournalQuestionItem = {
  kind: 'question'
  question: string
  options: AgentJournalPromptOption[]
  /** Present when the provider accepts an answer outside the offered options. */
  freeTextQuestionId?: string
  resolution: AgentJournalResolution
}

export type AgentJournalStatusItem = {
  kind: 'status'
  text: string
  /** Durable root-turn lifecycle used by clients to expose cancellation only
   *  while the provider can still accept it. */
  turnLifecycle?: { turnId: string; state: 'running' | 'completed' }
  /** Additive fallback for provider traffic this host cannot model yet. Older
   *  clients still render `text`; newer clients expose the bounded frame. */
  providerFrame?: {
    provider: string
    kind: string
    payload: AgentJournalBoundedPayload
  }
}

export type AgentJournalItemBody =
  | AgentJournalMessageItem
  | AgentJournalToolCallItem
  | AgentJournalDiffItem
  | AgentJournalApprovalItem
  | AgentJournalQuestionItem
  | AgentJournalStatusItem

/** One reduced timeline entry. `sequence` orders the list; `observedAt` is the
 *  provider's own clock and may sort earlier than a later sequence when the row
 *  was recovered after a crash. */
export type AgentJournalRenderItem = {
  itemId: string
  revision: number
  body: AgentJournalItemBody
  sequence: number
  observedAt: number
  /** Set when the row was appended by crash reconciliation rather than live. */
  recovered?: true
}

// ─── Submissions ────────────────────────────────────────────────────────────

export const AGENT_JOURNAL_DISPATCH_STATES = ['pending', 'accepted', 'rejected', 'unknown'] as const
export type AgentJournalDispatchState = (typeof AGENT_JOURNAL_DISPATCH_STATES)[number]

/** The write-ahead submission row, projected. `unknown` is a displayed state:
 *  the turn reads as delivery unconfirmed, never as sent and never as failed. */
export type AgentJournalSubmission = {
  clientMessageId: string
  fence: number
  payloadFingerprint: string
  dispatchState: AgentJournalDispatchState
  /** Provider item identity adopted on accept; null otherwise. */
  providerItemId: string | null
  /** Terminal reason on `rejected`. */
  reason: string | null
  submittedAt: number
  resolvedAt: number | null
}

/** Durable answer to "did my send land?", keyed by client message id. Only an
 *  `accepted` dispatch mints one, and it outlives the journal tail. */
export type AgentJournalAcceptanceReceipt = {
  clientMessageId: string
  providerItemId: string
  cursor: AgentJournalCursor
  acceptedAt: number
}

// ─── Snapshots and cursor resume ────────────────────────────────────────────

export type AgentJournalSnapshot = {
  sessionId: string
  cursor: AgentJournalCursor
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
}

/** Why a cursor could not be resumed. Every value forces a clean snapshot
 *  reload on the client. */
export const AGENT_JOURNAL_RESET_REASONS = [
  'epoch_changed',
  'cursor_ahead',
  'cursor_compacted',
  'journal_gap',
  'schema_unreadable'
] as const
export type AgentJournalResetReason = (typeof AGENT_JOURNAL_RESET_REASONS)[number]
