// ─── Canonical agent-session journal: cross-process wire shapes ─────────────
// The host-owned timeline for a structured agent session. Everything here must
// be plain JSON: rows are persisted verbatim and later republished to clients,
// so no class instances, Maps, or Dates.
//
// Rows are append-only. `schemaVersion` is upcast at read time and never
// rewritten in place, so a host that cannot read a row refuses to write the
// journal rather than skipping or compacting past it.

import type { AgentType } from './agent-status-types'
import type { NativeChatToolMetadata } from './native-chat-tool-identity'
import type { NativeChatBlock, NativeChatRole } from './native-chat-types'

export { type AgentType }

/** Bump only alongside a read-time upcaster in `journal-row-schema.ts`. */
/** v3 introduced the `turn` item. A row without one is still written at v2 so
 *  an older host keeps reading it; the first v3 row latches that host read-only
 *  instead of truncating the epoch. */
export const AGENT_SESSION_JOURNAL_SCHEMA_VERSION = 3
export const AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION = 3
const AGENT_SESSION_JOURNAL_PRE_TURN_SCHEMA_VERSION = 2

export function journalRowSchemaVersion(bodies: readonly { kind: string }[]): number {
  return bodies.some((body) => body.kind === 'turn')
    ? AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION
    : AGENT_SESSION_JOURNAL_PRE_TURN_SCHEMA_VERSION
}

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

/** A tool output or diff body clipped to a head. The remainder is DISCARDED,
 *  never stored: crossing a bound sets `truncated` and the two fields below
 *  describe what was dropped, so it is marked rather than silently lost. */
export type AgentJournalBoundedPayload = {
  head: string
  /** Byte length of the ORIGINAL payload, not of `head`. */
  byteLength: number
  /** sha256 of the original payload — identification only; nothing stores or
   *  retrieves the discarded remainder by it. */
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

export type AgentJournalToolCallItem = NativeChatToolMetadata & {
  kind: 'tool-call'
  name: string
  input: unknown
  /** Provider-supplied identity within this item stream; optional for mixed-version peers. */
  callId?: string
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
  description?: string
}

export type AgentJournalQuestion = {
  id: string
  question: string
  header?: string
  multiSelect: boolean
  options: AgentJournalPromptOption[]
  /** Present when the provider accepts an answer outside the offered options. */
  freeTextQuestionId?: string
}

export type AgentJournalApprovalMatchedAskRule = {
  source: string
  toolName: string
  ruleContent?: string
}

export type AgentJournalApprovalSubject = {
  kind: 'plan'
  text: string
  filePath?: string
}

export type AgentJournalApprovalItem = {
  kind: 'approval'
  title: string
  displayName?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  matchedAskRule?: AgentJournalApprovalMatchedAskRule
  subject?: AgentJournalApprovalSubject
  detail: string | null
  options: AgentJournalPromptOption[]
  resolution: AgentJournalResolution
}

export type AgentJournalQuestionItem = {
  kind: 'question'
  question: string
  options: AgentJournalPromptOption[]
  questions?: AgentJournalQuestion[]
  /** Present when the provider accepts an answer outside the offered options. */
  freeTextQuestionId?: string
  resolution: AgentJournalResolution
}

export const AGENT_JOURNAL_TURN_LIFECYCLE_STATES = [
  'running',
  'completed',
  'interrupted',
  'unverifiable'
] as const
export type AgentJournalTurnLifecycleState = (typeof AGENT_JOURNAL_TURN_LIFECYCLE_STATES)[number]

/** What the PROVIDER said became of a turn, kept separate from the lifecycle
 *  state so the four arms above stay a report on what the HOST observed.
 *  `cancellation` is a stop somebody asked for, `failure` is the provider's own
 *  error, and the two are never interchangeable: only `failure` is a fault. */
export const AGENT_JOURNAL_TURN_OUTCOMES = ['success', 'failure', 'cancellation'] as const
export type AgentJournalTurnOutcome = (typeof AGENT_JOURNAL_TURN_OUTCOMES)[number]

export type AgentJournalTurnLifecycle = {
  turnId: string
  state: AgentJournalTurnLifecycleState
  /** The provider's own verdict, when it gave one. ABSENT MEANS UNKNOWN and must
   *  never be read as success: a row from a host that predates the field, an end
   *  the host inferred rather than heard, and a verdict vocabulary this build
   *  cannot place all land here. `completed` alone proves nothing — the provider
   *  reports an API error as a finished turn. */
  outcome?: AgentJournalTurnOutcome
  /** Journal key of the user item that opened the turn. A lifecycle row may key
   *  itself when provider output opened a turn with no user item; absent means
   *  an older host. */
  userItemId?: string
  startedAt?: number
  /** Host clock at the send that opened this turn, when one is known. `startedAt`
   *  remains the provider turn-open instant and is never rewritten. */
  requestedAt?: number
  completedAt?: number
  /** The provider's own measured turn duration, preferred over the host interval. */
  durationMs?: number
}

export type AgentJournalStatusItem = {
  kind: 'status'
  text: string
  /** Optional display hints; unknown values retain the ordinary text fallback. */
  presentation?: string
  tone?: string
  /** Legacy carrier of a turn record: written by hosts before v3, and published
   *  to clients that predate the `turn` item. New code reads turns through
   *  `readAgentJournalTurn`, never this field. */
  turnLifecycle?: AgentJournalTurnLifecycle
  /** Additive fallback for provider traffic this host cannot model yet. Older
   *  clients still render `text`; newer clients expose the bounded frame. */
  providerFrame?: {
    provider: string
    kind: string
    payload: AgentJournalBoundedPayload
  }
}

/** The durable record of one root turn. `running` exposes cancellation while
 *  the provider can still accept it; the item is revised to a terminal state,
 *  never tombstoned, so the endpoints survive. Timestamps are the execution
 *  host's clock at provider-event receipt; `durationMs` is the provider's own
 *  measurement. `unverifiable` carries no end: the host lost the child without
 *  observing its exit. `outcome` is the provider's separate verdict and is
 *  absent whenever nothing told the host one. */
export type AgentJournalTurnItem = { kind: 'turn' } & AgentJournalTurnLifecycle

export type AgentJournalItemBody =
  | AgentJournalMessageItem
  | AgentJournalToolCallItem
  | AgentJournalDiffItem
  | AgentJournalApprovalItem
  | AgentJournalQuestionItem
  | AgentJournalStatusItem
  | AgentJournalTurnItem

/** Agent work, versus a backgrounded shell or command task. Classified once by
 *  the producer, which holds the provider vocabulary, so no reader re-derives it. */
export type AgentJournalProducerKind = 'agent' | 'background'

/**
 * Which agent produced a row, repeated on every row that agent produced.
 *
 * One journal is the durable record of one agent SESSION, and a session that
 * runs subagents journals their rows into it too. Absence is a positive claim
 * and never "unknown": no `agentId` means the session's own agent wrote the row.
 * Repeated per row rather than held once on a start row, so a row answers for
 * itself: every reader here scans backwards from the tail and stops at the
 * turn, so one that had to find a start row first would have to scan past that
 * stop to attribute anything. Repetition is near-free — absent on the session's
 * own rows, which are most of them — and it is what keeps the field correct
 * without a second lookup.
 */
export type AgentJournalProducerLinkage = {
  /** The producing subagent's canonical id. Absent ⇒ the session's own agent. */
  agentId?: string
  /** The producing agent's own parent. Absent ⇒ its parent is the session root. */
  parentAgentId?: string
  /** The provider's own parent reference for this row. Provenance only: it names
   *  the tool CALL, which is re-minted on every resume, so it is never a join key. */
  providerParentRef?: string
  producerKind?: AgentJournalProducerKind
  /** Which run of the agent, when past the first. Identity answers "which agent";
   *  this answers "which run of it", and is deliberately not part of the identity. */
  attempt?: number
}

/** One reduced timeline entry. `sequence` orders the list; `observedAt` is the
 *  provider's own clock and may sort earlier than a later sequence when the row
 *  was recovered after a crash. */
export type AgentJournalRenderItem = AgentJournalProducerLinkage & {
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
  /** Execution fence of the latest dispatch attempt or recovery. */
  fence: number
  payloadFingerprint: string
  dispatchState: AgentJournalDispatchState
  /** Provider item identity adopted on accept; null otherwise. */
  providerItemId: string | null
  /** Terminal reason on `rejected`. */
  reason: string | null
  submittedAt: number
  resolvedAt: number | null
  /** Set when crash reconciliation resolved the dispatch, not the provider. A live
   *  `unknown` is a send still outstanding; a recovered one outlived its writer. */
  recovered?: true
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
