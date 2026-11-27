import type { AgentSessionStatusSummary } from '../agent-session-wire'
import { foldAgentLeadStatus } from '../../agent-status/lifecycle/agent-lead-status-fold'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from '../../agent-status/child-work/agent-status-child-work-liveness'
import type { AgentMainAgentStatus } from '../../agent-status/lifecycle/main-agent-status'
import type {
  AgentStatusState,
  AgentWorkingMode
} from '../../agent-status/contracts/agent-status-types'
import type { StructuredAgentSessionProjectedStatus } from './structured-agent-session-projection'

export type StructuredAgentSessionAgentStatus = {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  /** Lead state/verdict before child folding; caller stamps stateStartedAt because the projection has no state clock. */
  mainAgent: Omit<AgentMainAgentStatus, 'stateStartedAt'>
}

function structuredAgentSessionLeadState(
  status: StructuredAgentSessionProjectedStatus,
  awaitsAnswer: boolean,
  asksOnlyQuestions: boolean
): 'working' | 'blocked' | 'waiting' | 'done' {
  if (status === 'attention') {
    return asksOnlyQuestions ? 'waiting' : 'blocked'
  }
  // Like the hook row for Codex's async question: it waits on the person while the turn runs and after.
  if (awaitsAnswer) {
    return 'waiting'
  }
  return status === 'working' ? 'working' : 'done'
}

/** Share hook-equivalent child folding across worktree ps/mobile/sidebar.
 * Use host child records/views; only older summaries without childWork fall back to live background tasks. */
export function structuredAgentSessionAgentStatus(
  summary: Pick<
    AgentSessionStatusSummary,
    'turnOutcome' | 'stopping' | 'awaitsAnswer' | 'attentionAsksOnlyQuestions'
  > & {
    status: StructuredAgentSessionProjectedStatus
    childWork?: readonly AgentChildWorkLivenessCandidate[]
  }
): StructuredAgentSessionAgentStatus {
  const leadState = structuredAgentSessionLeadState(
    summary.status,
    summary.awaitsAnswer === true,
    summary.attentionAsksOnlyQuestions === true
  )
  const resolution = foldAgentLeadStatus({
    leadState,
    childWorkLiveness: agentChildWorkLiveness(summary.childWork)
  })
  return {
    state: resolution.stateName,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    mainAgent: {
      state: leadState,
      ...(leadState === 'done' && summary.turnOutcome ? { outcome: summary.turnOutcome } : {}),
      ...(leadState === 'working' && summary.stopping ? { stopping: true as const } : {})
    }
  }
}
