import type { StructuredAgentSessionState } from './structured-agent-session-reducer'
import {
  activeStructuredAgentSessionTurnId,
  hasUnansweredStructuredAgentSessionDispatch
} from './structured-agent-session-projection'

/** One presentation policy for host evidence; older hosts retain their legacy read path. */
export function selectStructuredSessionCurrentExecution(state: StructuredAgentSessionState) {
  const execution = state.status === 'ready' ? state.execution : undefined
  const turnId =
    state.status !== 'ready'
      ? null
      : state.execution
        ? execution?.control === 'native'
          ? execution.turnId
          : null
        : activeStructuredAgentSessionTurnId(state.items)
  return {
    execution,
    turnId,
    isWorking:
      state.status === 'ready' &&
      (state.execution
        ? execution?.activity === 'working'
        : turnId !== null ||
          hasUnansweredStructuredAgentSessionDispatch(state.submissions, state.fence)),
    unverifiable: state.status !== 'ready' || execution?.activity === 'unverifiable',
    verificationAvailable: state.execution !== undefined
  }
}
