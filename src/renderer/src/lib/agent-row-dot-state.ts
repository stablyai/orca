import type { AgentDotState } from '@/components/AgentStateDot'
import type { AgentChildRowModel } from '../../../shared/agent-child-row-model'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import type { AgentStatusEntry, AgentWorkingMode } from '../../../shared/agent-status-types'
import type { AgentRowState } from '../../../shared/agent-row-decay-state'

/** Share row-state mapping across sidebar, dashboard and notes so new states cannot diverge. */
export function agentRowDotState(
  state: AgentRowState,
  workingMode?: AgentWorkingMode
): AgentDotState {
  switch (state) {
    case 'working':
      return workingMode === 'monitoring' ? 'monitoring' : 'working'
    case 'blocked':
    case 'waiting':
    case 'done':
    case 'idle':
    case 'unverifiable':
      return state
  }
  return 'idle'
}

/** Use a child’s own verdict; otherwise prefer main-agent stop/failure, including failure while subagents still work. */
export function agentRowDisplayDotState(agent: {
  state: AgentRowState
  entry: Pick<AgentStatusEntry, 'state' | 'interrupted' | 'mainAgent' | 'workingMode'>
  childRow?: Pick<AgentChildRowModel, 'displayState'>
}): AgentDotState {
  if (agent.childRow) {
    return agent.childRow.displayState
  }
  return (
    agentVerdictDisplayMark(agent.entry) ?? agentRowDotState(agent.state, agent.entry.workingMode)
  )
}
