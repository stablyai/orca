import type { AgentSessionStatusSummary } from './agent-session-wire'
import { foldAgentLeadStatus } from './agent-lead-status-fold'
import { agentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentStatusState, AgentWorkingMode } from './agent-status-types'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

export type StructuredAgentSessionAgentStatus = {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  /** The lead had settled and live child work is the only thing holding this row open. The
   *  journal cannot date such a row: its clock stopped when the lead's turn did. */
  fromChildWork: boolean
}

/** The lead state one projected session status stands for, before child work is folded in. */
function structuredAgentSessionLeadState(
  status: StructuredAgentSessionProjectedStatus
): 'working' | 'blocked' | 'done' {
  return status === 'working' ? 'working' : status === 'attention' ? 'blocked' : 'done'
}

/** The agent-status state one structured session summary stands for, with its live child
 *  work folded in the same way the hook lane folds a subagent roster. Shared across the
 *  process boundary so `worktree ps`, mobile and the sidebar cannot disagree about one session. */
export function structuredAgentSessionAgentStatus(
  summary: Pick<AgentSessionStatusSummary, 'backgroundTasks'> & {
    status: StructuredAgentSessionProjectedStatus
  }
): StructuredAgentSessionAgentStatus {
  const leadState = structuredAgentSessionLeadState(summary.status)
  const resolution = foldAgentLeadStatus({
    leadState,
    // Inert, not decided: a projected session status has no interrupted member, so this lane
    // cannot express one. The hook lane's guard exists to distrust a stale inventory snapshot;
    // here the task list is the provider's live roster and a settled task leaves it on its own.
    interrupted: false,
    childWorkLiveness: agentChildWorkLiveness(summary.backgroundTasks)
  })
  return {
    state: resolution.stateName,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    fromChildWork: leadState === 'done' && resolution.stateName !== 'done'
  }
}
