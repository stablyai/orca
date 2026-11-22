import type { AgentJournalCursor } from '../journal/agent-session-journal-identity'
import type { AgentJournalTurnOutcome } from '../../agent-status/lifecycle/agent-turn-outcome'
import type { AgentSessionExecutionLocation } from '../lifecycle/agent-session-record'
import type { AgentSessionFailureFact } from '../failures/agent-session-failure'

// Turn completion feed: the per-turn EDGE beside the status feed's STATE.

/** Emit host-commit request completion edges with turn identity, separate from idle summary state. Repeated summaries are not completions. Use recorded provider/stop/supersede verdicts only: an observed end with no verdict is unknown and emits nothing. */
export type AgentSessionTurnCompletion = {
  journalCursor?: AgentJournalCursor
  /** Host-and-workspace scope; a bare provider turn id is not globally unique. */
  scope: AgentSessionExecutionLocation
  sessionId: string
  /** The request's identity: the root turn's id, or for a send refused before any turn, that
   *  send's journal item key. Neither is minted here. */
  turnId: string
  outcome: AgentJournalTurnOutcome
  /** Provider turns coalesced into a quiet-marker end (the only end that can drop an earlier
   *  answer); absent for a single-turn end and for any end that says something. */
  mergedTurnCount?: number
  /** Execution host's clock at journal commit. */
  completedAt: number
  /** The request settled while a prompt waits on the user. Absent otherwise, and from older hosts. */
  awaitingUser?: true
  /** Why a failed request failed, typed, so its alert can say so. Absent from older hosts. */
  failure?: AgentSessionFailureFact
  /** The turn's last words were a bot's quiet marker: it finished with nothing to tell anyone. */
  quiet?: true
}

/** Emit one host-commit edge per newly pending prompt, usually mid-turn; pending revisions retain identity and emit nothing. */
export type AgentSessionPromptAttention = {
  journalCursor?: AgentJournalCursor
  scope: AgentSessionExecutionLocation
  sessionId: string
  /** The prompt's journal item id. */
  promptId: string
  /** Execution host's clock at journal commit. */
  raisedAt: number
}

/** Live edges only, no snapshots/replay: drop missed completions/prompts and baseline on reconnect so no durable queue can strand. */
export type AgentSessionTurnCompletionEvent =
  | { type: 'completion'; completion: AgentSessionTurnCompletion }
  /** Sent only to a subscriber that asked with `includePrompts`, so an older client never sees it. */
  | { type: 'prompt'; prompt: AgentSessionPromptAttention }
  | { type: 'end' }
