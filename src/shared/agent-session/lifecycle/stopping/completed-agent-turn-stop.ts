import type { AgentStatusEntry } from '../../../agent-status/contracts/agent-status-types'
import { agentTurnEndedUncleanly } from '../../../agent-status/lifecycle/agent-main-agent-verdict'
import { getAgentResumeArgv } from '../../../agent-launch/startup/agent-resume-argv'
import { isResumableTuiAgent } from '../agent-session-resume'

type CompletedTurnStatus = Pick<
  AgentStatusEntry,
  'state' | 'interrupted' | 'mainAgent' | 'agentType' | 'providerSession' | 'subagents' | 'orchestration'
>

// Why: provider done hooks can fire mid-Dispatch; only runtime-confirmed settlement makes a stop safe.
function hasUnsettledOrUnknownDispatch({ orchestration }: CompletedTurnStatus): boolean {
  return orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false
}

/** A cleanly finished turn with no live children or open dispatch, whose conversation a stopped
 *  process can resume; shared by Agent Sleep and quit. */
export function completedAgentTurnAllowsStop(status: CompletedTurnStatus): boolean {
  return Boolean(
    status.state === 'done' &&
    !agentTurnEndedUncleanly(status) &&
    !status.subagents?.length &&
    !hasUnsettledOrUnknownDispatch(status) &&
    isResumableTuiAgent(status.agentType) &&
    status.providerSession &&
    getAgentResumeArgv(status.agentType, status.providerSession)
  )
}
