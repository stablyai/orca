import type { AgentSessionStatusSummary } from './agent-session-wire'
import { foldAgentLeadStatus } from './agent-lead-status-fold'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from './agent-status-child-work-liveness'
import type { AgentMainAgentStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

export type StructuredAgentSessionAgentStatus = {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  /** The main agent's own state and last-turn verdict, before child work is folded in. The caller
   *  stamps the clock: this projection has no view of when the main agent's state first appeared. */
  mainAgent: Omit<AgentMainAgentStatus, 'stateStartedAt'>
}

/** The lead state one projected session status stands for, before child work is folded in. */
function structuredAgentSessionLeadState(
  status: StructuredAgentSessionProjectedStatus
): 'working' | 'blocked' | 'done' {
  return status === 'working' ? 'working' : status === 'attention' ? 'blocked' : 'done'
}

/** The agent-status state one structured session summary stands for, with its live child
 *  work folded in the same way the hook lane folds a subagent roster. Shared across the
 *  process boundary so `worktree ps`, mobile and the sidebar cannot disagree about one session.
 *  `childWork` is the host's child records (or their views); only an older host's summary, which
 *  publishes none, is read by its live background tasks. */
export function structuredAgentSessionAgentStatus(
  summary: Pick<AgentSessionStatusSummary, 'turnOutcome'> & {
    status: StructuredAgentSessionProjectedStatus
    childWork?: readonly AgentChildWorkLivenessCandidate[]
  }
): StructuredAgentSessionAgentStatus {
  const leadState = structuredAgentSessionLeadState(summary.status)
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: agentChildWorkLiveness(summary.childWork)
  })
  return {
    state: resolution.stateName,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    mainAgent: {
      state: leadState,
      ...(leadState === 'done' && summary.turnOutcome ? { outcome: summary.turnOutcome } : {})
    }
  }
}
