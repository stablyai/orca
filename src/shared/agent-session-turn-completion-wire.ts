import type { AgentJournalCursor, AgentJournalTurnOutcome } from './agent-session-journal-types'
import type { AgentSessionExecutionLocation } from './agent-session-record'

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
  /** Execution host's clock at journal commit. */
  completedAt: number
  /** The request settled while a prompt waits on the user. Absent otherwise, and from older hosts. */
  awaitingUser?: true
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
