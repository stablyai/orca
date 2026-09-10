import type { AgentStatusState, AgentWorkingMode } from './agent-status-types'
type AgentRowState = AgentStatusState | 'idle' | 'unverifiable'

export type AgentRowDotState = AgentRowState | 'monitoring' | 'interrupted'

/** Project normalized facts without owning lifecycle or acknowledgment policy. */
export function agentRowDotState(
  state: AgentRowState,
  workingMode?: AgentWorkingMode,
  interrupted?: boolean
): AgentRowDotState {
  if (state === 'done' && interrupted === true) {
    return 'interrupted'
  }
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
