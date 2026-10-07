// ─── Canonical agent-session journal: cross-process wire shapes ─────────────
// The host-owned timeline for a structured agent session. Everything here must
// be plain JSON: rows are persisted verbatim and later republished to clients,
// so no class instances, Maps, or Dates.
//
// Rows are append-only. `schemaVersion` is upcast at read time and never
// rewritten in place, so a host that cannot read a row (a newer version, or a
// newer kind) refuses to write the journal rather than skipping or compacting
// past it.

import type { UnreadAgentSessionFailureFact } from './agent-session-failure'
import type { AgentSessionFailureRowWords } from './agent-session-failure-words'
import type { AgentType } from './agent-status-types'
import type { AgentSessionQuestionAnswer } from './agent-session-question-answer'
import type { AgentJournalTurnOutcome } from './agent-turn-outcome'
import type { NativeChatToolMetadata } from './native-chat-tool-identity'
import type { AgentSessionContextUsage } from './agent-session-context-usage'
import type { AgentSessionProviderHandle } from './agent-session-provider-handle'
import type { NativeChatBlock, NativeChatRole } from './native-chat-types'
import type { AgentMessageSource } from './agent-session-message-source'

export { type AgentType }

/** Bump only alongside a read-time upcaster in `journal-row-schema.ts`. */
/** v3 introduced the `turn` item. A row without one is still written at v2 so
 *  an older host keeps reading it; the first v3 row stops that host writing the chat
 *  (a released one keeps it read-only, this build fails its load) instead of truncating. */
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

/** A provider handle as journal rows record it, and (without `opaque`) as
 *  `agentSession.attach` carries it. Persisted and on the wire: never reshape an
 *  arm. Derived from the in-memory handle by `agentSessionJournalProviderHandle`;
 *  `opaque` names any other transport, or `pending` before a handle is proved. */
export type AgentSessionJournalProviderHandle =
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
  /** The record's proved handle; null before the provider has proved one. */
  providerHandle: AgentSessionProviderHandle | null
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

/** How a user message reached the provider when it was not an ordinary turn
 *  input. Persisted and open for growth: a reader that cannot place a value
 *  renders an ordinary message. */
export const AGENT_JOURNAL_MESSAGE_SEND_MODES = ['goal'] as const
export type AgentJournalMessageSendMode = (typeof AGENT_JOURNAL_MESSAGE_SEND_MODES)[number]

/** Whether the provider is still producing a message. Persisted and open for growth: a reader
 *  that cannot place a value reads it as `completed`. */
export const AGENT_JOURNAL_MESSAGE_STATES = ['running', 'completed'] as const
export type AgentJournalMessageState = (typeof AGENT_JOURNAL_MESSAGE_STATES)[number]

export type AgentJournalMessageItem = {
  kind: 'message'
  role: NativeChatRole
  blocks: NativeChatBlock[]
  /** Absent ⇒ an ordinary turn input. `goal` ⇒ the text was set as the thread
   *  goal's objective, and the provider pursues it without a turn of its own. */
  sentAs?: AgentJournalMessageSendMode
  /** Present on a conversation command the user sent, such as `/compact`. The text is what the
   *  user typed; this names the command so no reader parses it. Open like `sentAs`. */
  command?: { name: string }
  /** Present on a message another agent sent through Orca; absent, the person's. Host-written,
   *  outside every fingerprint, never sent to the provider. */
  from?: AgentMessageSource
  /** Written on reasoning rows. ABSENT MEANS UNKNOWN — an older host, or a row from before the
   *  field — and never reads as live. The row's `observedAt` is when it started. */
  state?: AgentJournalMessageState
  /** Host clock when the host saw the message end: its own end, or the end of the turn or
   *  stream that cut it off. Absent only when no end was seen live — history, a crash sweep — so
   *  no duration is claimed. */
  completedAt?: number
}

export type AgentJournalToolCallState = 'running' | 'completed' | 'failed'

/** How a call that did not finish on its own ended, finer than its `failed` state. Persisted and
 *  open for growth: a reader that cannot place a value reads `state`. `unverifiable` is a call its
 *  session's end closed when nothing proved that end, so a later proof naming its owner finds it
 *  and revises it to `interrupted`, as it does the turn. */
export const AGENT_JOURNAL_TOOL_CALL_ENDINGS = ['interrupted', 'unverifiable'] as const
export type AgentJournalToolCallEnding = (typeof AGENT_JOURNAL_TOOL_CALL_ENDINGS)[number]

export type AgentJournalToolCallItem = NativeChatToolMetadata & {
  kind: 'tool-call'
  name: string
  input: unknown
  /** Provider-supplied identity within this item stream; optional for mixed-version peers. */
  callId?: string
  state: AgentJournalToolCallState
  /** Only beside `state: 'failed'`, which builds that predate it read as they always did. Read
   *  both through `agentJournalToolCallLifecycle`. */
  endedAs?: AgentJournalToolCallEnding
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
  /** Option id the winner picked; null while pending or cancelled. For a question, the answer in the
   *  packed form older clients read; `answers` is the same answer structured. */
  selectedOptionId: string | null
  /** Question answers. Absent on approvals and on rows written before hosts recorded it. */
  answers?: AgentSessionQuestionAnswer[]
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

export type AgentJournalPlanApprovalSubject = {
  kind: 'plan'
  text: string
  filePath?: string
}

declare const agentJournalUnknownKind: unique symbol
/** A kind tag this build does not know. Branded, so it never stands in for a known tag. */
export type AgentJournalUnknownKind = string & { readonly [agentJournalUnknownKind]: true }

/** A subject of a kind a newer Orca wrote: carried as it was, with whatever fields it holds, and
 *  never drawn or approved here. */
export type AgentJournalUnknownApprovalSubject = { readonly kind: AgentJournalUnknownKind }

/** Open, as the journal schema reads it: narrow with `isPlanApprovalSubject` before reading it. */
export type AgentJournalApprovalSubject =
  | AgentJournalPlanApprovalSubject
  | AgentJournalUnknownApprovalSubject

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

// The turn verdict vocabulary lives in agent-turn-outcome.ts so the agent-status
// row can share it without importing the journal; re-exported to keep one import site.
export { AGENT_JOURNAL_TURN_OUTCOMES, type AgentJournalTurnOutcome } from './agent-turn-outcome'

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
  /** What the provider said about its context window during or after this turn.
   *  Usually written by a later revision, since the provider answers after the end. */
  contextUsage?: AgentSessionContextUsage
  /** On a turn a conversation command opened: the provider turn that carried out the command,
   *  once the provider opened one. Nothing else re-derives it after the command settles. */
  providerTurnId?: string
}

/** Provider thread-goal lifecycle. Open like other persisted vocabularies: a
 *  status a newer provider reports must not turn a row malformed. */
export const AGENT_JOURNAL_THREAD_GOAL_STATUSES = [
  'active',
  'paused',
  'blocked',
  'usageLimited',
  'budgetLimited',
  'complete'
] as const
export type AgentJournalThreadGoalStatus = (typeof AGENT_JOURNAL_THREAD_GOAL_STATUSES)[number]

/** The provider's goal as last journaled. Timestamps are epoch ms on the
 *  provider's clock; counters are as of `updatedAt`. */
export type AgentJournalThreadGoal = {
  objective: string
  status: AgentJournalThreadGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

/** A goal transition in typed form, so readers never parse a bounded frame head. */
export type AgentJournalThreadGoalState =
  | { state: 'set'; goal: AgentJournalThreadGoal }
  | { state: 'cleared' }

type AgentJournalStatusItemFields = {
  kind: 'status'
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
  /** Present on thread-goal transitions; absent on rows from older hosts. */
  threadGoal?: AgentJournalThreadGoalState
  /** On the row about a reply Orca's own stop cut off: why Orca stopped. Its cause is open (a newer
   *  host may name one this build does not know), so read it with `readAgentSessionOrcaStop`. */
  orcaStop?: { cause: string }
}

/** A status row that reports no failure; its text is its writer's own. */
export type AgentJournalPlainStatusItem = AgentJournalStatusItemFields & {
  text: string
  failure?: undefined
}

export type AgentJournalStatusItem =
  | AgentJournalPlainStatusItem
  | (AgentJournalStatusItemFields &
      /** A row that reports a failure: what failed, typed, beside the sentence older clients print,
       *  both from `agentSessionFailureWords`. Absent on rows from older hosts. */
      AgentSessionFailureRowWords)

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
   *  the tool CALL, not the agent, and a resumed agent is re-announced under a new
   *  call, so no reader joins on it. Only its producer reads it back, to recall
   *  the ids an earlier run of the session resolved. */
  providerParentRef?: string
  producerKind?: AgentJournalProducerKind
  /** Which run of the agent, when past the first. Identity answers "which agent";
   *  this answers "which run of it", and is deliberately not part of the identity. */
  attempt?: number
}

/** Which turn a row belongs to, stated by the write that created it. `turn` names the turn
 *  record's journal key; `thread` is a row that belongs to no turn — a notice about the
 *  conversation, or a message not yet delivered into one. Turn records themselves are `thread`. */
export type AgentJournalTurnScope = { kind: 'turn'; turnItemId: string } | { kind: 'thread' }

export const AGENT_JOURNAL_THREAD_SCOPE: AgentJournalTurnScope = { kind: 'thread' }

/** Who produced a row and which turn it belongs to: what every item write states. */
export type AgentJournalRowAttribution = AgentJournalProducerLinkage & {
  turnScope: AgentJournalTurnScope
}

/** Where the journal placed an item: the sequence of the row that created it,
 *  then its place among that row's writes. The timeline's only ordering key. */
export type AgentJournalPosition = {
  sequence: number
  index: number
}

/** One reduced timeline entry. `sequence` orders the list; `observedAt` is the
 *  provider's own clock and may sort earlier than a later sequence when the row
 *  was recovered after a crash. */
export type AgentJournalRenderItem = AgentJournalProducerLinkage & {
  itemId: string
  revision: number
  body: AgentJournalItemBody
  sequence: number
  /** Place among the writes of the row at `sequence`, which one lifecycle batch
   *  shares across every item it creates. Absent ⇒ 0, and on a host that predates it. */
  sequenceIndex?: number
  observedAt: number
  /** Set when the row was appended by crash reconciliation rather than live. */
  recovered?: true
  /** When crash reconciliation wrote this revision; present exactly when `recovered` is. */
  recoveredAt?: number
  /** Absent only from a host that predates it. */
  turnScope?: AgentJournalTurnScope
}

// ─── Submissions ────────────────────────────────────────────────────────────

/** The turn a send was answered into: its record's item id, and how the send joined it. `start`:
 *  the provider answered the send's start request with that turn; `steer`: Orca steered it into
 *  that running turn. Known limit: a start the provider silently folds into a running turn reads
 *  as `start`, including into a turn no user entry opened. A newer host may name another way,
 *  which a reader leaves unclaimed. */
export type AgentJournalAnsweredTurn = { turnItemId: string; via: AgentJournalTurnJoin }
export type AgentJournalTurnJoin = 'start' | 'steer'
/** The same, as a writer names it: the turn record's identity, keyed when the row is written. */
export type AgentJournalAnsweredTurnIdentity = {
  turn: AgentJournalItemIdentity
  via: AgentJournalTurnJoin
}

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
  /** Terminal reason on `rejected`: a sentence a person can read, or one of the legacy markers
   *  older clients already recognise. On `unknown`, the doubt marker. */
  reason: string | null
  /** On `rejected`, why, typed; absent on rows from older hosts. */
  rejection?: UnreadAgentSessionFailureFact
  submittedAt: number
  resolvedAt: number | null
  /** Where the journal wrote this submission's row: its sequence, recomputed on every fold and
   *  never stored. Needed because a rejected send's own row moves to its rejection, which erases
   *  where it was sent. Absent from hosts that predate it. */
  submittedSequence?: number
  /** On `rejected`: the turn a Codex send was answered into, when that turn ended without taking
   *  it. null: the host recorded that it was answered into no turn, as every other rejection is
   *  (Claude, a queued message taken back before handover, restart recovery). Absent: written
   *  before this field existed, or not rejected. A stored value this build cannot read is null. */
  answeredInTurn?: AgentJournalAnsweredTurn | null
  /** Set when crash reconciliation resolved the dispatch, not the provider. A live
   *  `unknown` is a send still outstanding; a recovered one outlived its writer. */
  recovered?: true
  /** The host accepted this send to hand over later; absent on sends dispatched as they were
   *  recorded (older hosts). With no `handedOverAt` yet, a pending one is still queued. */
  handoverRecorded?: true
  /** When the host handed it to the provider (its `dispatch{pending}` row). */
  handedOverAt?: number
  /** Host-only: the submission row's sequence, which tells which host process accepted it. Set
   *  only on a send accepted for later handover. The snapshot still carries it, but the submission
   *  schema omits it; no released client reads it, and clients read `submittedSequence` instead. */
  acceptedSequence?: number
  /** The queued draft this submission hands off; absent for a direct send. Read this, never
   *  a draft id compared with `clientMessageId`. */
  queuedMessageId?: string
  /** Host-only: who asked for this turn — a person over the client send RPC, or Orca itself.
   *  A restart or a close keeps only a person's Send cut short as a card. The snapshot still
   *  carries it; no released client reads it. */
  origin?: 'client' | 'host'
  /** Who it is from: the kind of its `AgentSessionMessageSource` ('user' or 'agent'), so a restart
   *  or a close keeps only a person's unsent send as a card. Only the kind: the senders stay on the
   *  card, host-only, and publishing them here would need a strip. A newer build's kind is kept as
   *  written, never read as absent. Absent when its sender named none (a dispatch preamble, a restart continuation). */
  source?: { kind: string }
  /** On a rejected send the host kept as a card: that card's message id. The text lives on the
   *  card, so no surface draws this send, before or after the card is sent, edited or deleted.
   *  Recorded in the rejection's own transaction (`journal-unsent-send-hold.ts`). */
  keptAsQueuedMessageId?: string
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
