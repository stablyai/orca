import type { AgentSessionExecutionOptions } from './agent-session-execution-options'
import type { UnreadAgentSessionFailureFact } from './agent-session-failure'
import type { AgentJournalCursor, AgentJournalItemIdentity } from './agent-session-journal-types'

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
  /** Immutable choices captured on acceptance and applied when the agent is handed the message;
   *  absent on older submissions. The host's alone: clients ignore it. */
  options?: AgentSessionExecutionOptions
}

/** Durable answer to "did my send land?", keyed by client message id. Only an
 *  `accepted` dispatch mints one, and it outlives the journal tail. */
export type AgentJournalAcceptanceReceipt = {
  clientMessageId: string
  providerItemId: string
  cursor: AgentJournalCursor
  acceptedAt: number
}
