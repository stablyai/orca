import type { AgentJournalSubmission } from './agent-session-journal-submission-types'
export {
  AGENT_JOURNAL_DISPATCH_STATES,
  type AgentJournalAnsweredTurn,
  type AgentJournalTurnJoin,
  type AgentJournalAnsweredTurnIdentity,
  type AgentJournalDispatchState,
  type AgentJournalSubmission,
  type AgentJournalAcceptanceReceipt
} from './agent-session-journal-submission-types'
import type { AgentJournalTurnScope } from './agent-session-journal-turn-scope'
export type { AgentJournalTurnScope } from './agent-session-journal-turn-scope'
import type { AgentSessionProviderContextBoundary } from './agent-session-provider-context'
// ─── Canonical agent-session journal: cross-process wire shapes ─────────────
// The host-owned timeline for a structured agent session. Everything here must
// be plain JSON: rows are persisted verbatim and later republished to clients,
// so no class instances, Maps, or Dates.
//
// Rows are append-only. `schemaVersion` is upcast at read time and never
// rewritten in place, so a host that cannot read a row (a newer version, or a
// newer kind) refuses to write the journal rather than skipping or compacting
// past it.

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
export const AGENT_SESSION_JOURNAL_SCHEMA_VERSION = 5
export const AGENT_SESSION_JOURNAL_TEXT_SCHEMA_VERSION = 5
export const AGENT_SESSION_JOURNAL_TURN_ITEM_SCHEMA_VERSION = 3
/** v4 introduced the `queue` row: an older build keeps a chat holding one read-only rather than
 *  meeting a kind it does not know. Every other row keeps its own version. */
export const AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION = 4
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

/** A tool output or diff body. A row keeps the whole value (`truncated: false`). `truncated: true`
 *  marks a head: the copy sent to a client (fetch the whole item with `agentSession.item`), a
 *  call still running, or a row an older build saved, whose remainder is gone. */
export type AgentJournalBoundedPayload = {
  head: string
  /** Byte length of the ORIGINAL payload, not of `head`. */
  byteLength: number
  /** sha256 of the original payload, for identification only. */
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

export type AgentJournalSkillRef = { name: string; path: string }

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
  /** The skills the user picked from the menu for this message, by the file the agent selects
   *  each by. The text still carries each `$name`; agents that select by name ignore this. */
  skills?: AgentJournalSkillRef[]
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

export type AgentJournalFreeTextInput = {
  allowEmpty?: boolean
  multiline?: boolean
  initialValue?: string
  placeholder?: string
}

export type AgentJournalQuestion = {
  id: string
  question: string
  header?: string
  multiSelect: boolean
  options: AgentJournalPromptOption[]
  /** Present when the provider accepts an answer outside the offered options. */
  freeTextQuestionId?: string
  freeTextInput?: AgentJournalFreeTextInput
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
  freeTextInput?: AgentJournalFreeTextInput
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
  contextClear?: AgentSessionProviderContextBoundary
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
  /** Set on the copy sent to a client when text in it was shortened to fit; never saved. The whole
   *  item comes from `agentSession.item`. A cut tool output or diff also says so in `truncated`. */
  shortened?: true
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
