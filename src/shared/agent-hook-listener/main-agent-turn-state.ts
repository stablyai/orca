import type { AgentStatusState } from '../agent-status/contracts/agent-status-types'
import type { AgentTurnOutcome } from '../agent-status/lifecycle/agent-turn-outcome'
import type { AgentTurnFailure } from '../agent-status/lifecycle/main-agent-status'

/** The Claude main agent's own turn record, published on every row as `mainAgent`. */
export type ClaudeLeadTurnState = {
  state: AgentStatusState
  /** A known background task opened this foreground finishing turn. */
  taskWakeupTurn?: true
  /** Done-turn verdict from provider, inferred cancellation or persisted seed; the fold reads cancellation as interrupted. */
  outcome?: AgentTurnOutcome
  /** On a `failure` outcome: Claude's StopFailure `error` (`rate_limit`) and its message. */
  failure?: AgentTurnFailure
  /** When `state` first appeared; the main agent's own clock, distinct from the gated row's. */
  stateStartedAt: number
  /** Only the waiting child's next activity may clear its card; sibling churn cannot. */
  waitingAgentId?: string
  /** Tool call that owns the wait; late completions from parallel sibling tools must not dismiss its card. */
  waitingToolUseId?: string
  /** End time retained while background work holds working, then repeated on all-clear done. */
  turnCompletedAt?: number
  /** That end time, held because the turn's late prompt event has not said whether a task wakeup started it. */
  unclassifiedTurnCompletedAt?: number
  /** Claude hook model. Later events that omit it keep the last reported value. */
  model?: string
  /** The `prompt_id` of a turn this pane compacted while idle; that compaction's own hooks must not reopen it. */
  idleCompactionTurnId?: string
  /** Restore the lead state displaced by a child wait; inventing working cannot later fold back to done. */
  stateBeforeWait?: Pick<
    ClaudeLeadTurnState,
    'state' | 'outcome' | 'failure' | 'stateStartedAt' | 'turnCompletedAt' | 'taskWakeupTurn'
  >
}

/** When the main agent's own turn last ended, while it has not started another. */
export function mainAgentIdleSince(
  record: Pick<ClaudeLeadTurnState, 'state' | 'stateStartedAt'> | undefined
): number | undefined {
  return record?.state === 'done' ? record.stateStartedAt : undefined
}

/** Root-only Codex state; child waits live on roster entries and affect only the combined fold. */
export type CodexLeadTurnState = {
  state: 'working' | 'waiting' | 'done'
  /** Inferred/persisted verdict; Codex Stop carries none. */
  outcome?: AgentTurnOutcome
  /** When `state` first appeared; the root's own clock, published as `mainAgent.stateStartedAt`. */
  stateStartedAt: number
  model?: string
  /** Execution-host-only identity of the root session and turn whose rollout end can be replayed as Stop. */
  sessionId?: string
  turnId?: string
}
