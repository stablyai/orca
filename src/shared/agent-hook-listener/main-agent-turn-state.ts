import type { AgentStatusState } from '../agent-status-types'
import type { AgentJournalTurnOutcome } from '../agent-turn-outcome'

/** The Claude main agent's own turn record, published on every row as `mainAgent`. */
export type ClaudeLeadTurnState = {
  state: AgentStatusState
  /** The recorded verdict on the turn this record closed (the provider's, or a `cancellation`
   *  Orca inferred from the interrupt keystroke); only meaningful while `state` is done.
   *  `cancellation` is what the fold reads as an interrupt. */
  outcome?: AgentJournalTurnOutcome
  /** When `state` first appeared; the main agent's own clock, distinct from the gated row's. */
  stateStartedAt: number
  /** Subagent that induced the wait; only its next tool activity may clear it, so other children's churn can't dismiss a pending human-input card. */
  waitingAgentId?: string
  /** Tool call that owns the wait; late completions from parallel sibling tools must not dismiss its card. */
  waitingToolUseId?: string
  /** End time of the main agent turn closed while background inventory kept the pane `working`. Repeated on the later all-clear `done`. */
  turnCompletedAt?: number
  /** Main agent state a child-induced wait displaced, restored when the wait clears; can't invent 'working' since the done-gate only downgrades done→working, never back. */
  stateBeforeWait?: Pick<
    ClaudeLeadTurnState,
    'state' | 'outcome' | 'stateStartedAt' | 'turnCompletedAt'
  >
}

/** The Codex root's own record, folded with its roster into the combined `state`. A child's wait
 *  lives on the roster entry, never here, so this record is always the root's own truth. */
export type CodexLeadTurnState = {
  state: 'working' | 'waiting' | 'done'
  /** The turn verdict the server inferred; Codex's own Stop hook carries none. */
  outcome?: AgentJournalTurnOutcome
  /** When `state` first appeared; the root's own clock, published as `mainAgent.stateStartedAt`. */
  stateStartedAt: number
  model?: string
  /** Codex `turn_id` of the root turn this record describes; only the execution host sets it. */
  turnId?: string
}
