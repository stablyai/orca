import type { AgentStatusState } from '../agent-status-types'
import type { AgentJournalTurnOutcome } from '../agent-turn-outcome'
import type { ClaudeAnnouncedCalls, ClaudeApprovalRecord } from './providers/claude-approval-ledger'

/** The Claude main agent's own turn record, published on every row as `mainAgent`. */
export type ClaudeLeadTurnState = {
  state: AgentStatusState
  /** The recorded verdict on the turn this record closed (the provider's, or a `cancellation`
   *  Orca inferred from the interrupt keystroke); only meaningful while `state` is done.
   *  `cancellation` is what the fold reads as an interrupt. */
  outcome?: AgentJournalTurnOutcome
  /** When `state` first appeared; the main agent's own clock, distinct from the gated row's. */
  stateStartedAt: number
  /** Prompts Claude raised on this pane and has not been observed answering for. The pane is
   *  paused for exactly as long as this is non-empty, so a sibling call of a parallel batch (or a
   *  child's unrelated churn) can never dismiss the card of the prompt still on screen. */
  approvals?: readonly ClaudeApprovalRecord[]
  /** Per-call `tool_use_id`s this turn announced, so a prompt that carries none can still refuse
   *  a sibling's completion. Turn-scoped: replaced wholesale at every boundary. */
  announcedCalls?: ClaudeAnnouncedCalls
  /** End time of the main agent turn closed while background inventory kept the pane `working`. Repeated on the later all-clear `done`. */
  turnCompletedAt?: number
  /** Main agent state behind a child-induced wait, restored when the wait clears; can't invent 'working' since the done-gate only downgrades done→working, never back. */
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
}
