import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'
import type { AgentSessionStatusSummary } from '../../agent-session-wire'

/** Runtime reports describe the process whose options answer carried them; a newer fence has none until it answers. */
export function structuredAgentSessionReportsAtFence<
  T extends Pick<
    StructuredAgentSessionOptionState,
    'reportedPermissionMode' | 'reportedEffort' | 'reportedAgent' | 'interactionModes'
  >
>(state: T, answeredFence: number | null | undefined, fence: number | null): T {
  return answeredFence === fence ||
    (state.reportedPermissionMode === undefined &&
      state.reportedEffort === undefined &&
      state.reportedAgent === undefined &&
      state.interactionModes === undefined)
    ? state
    : {
        ...state,
        reportedPermissionMode: undefined,
        reportedEffort: undefined,
        reportedAgent: undefined,
        interactionModes: undefined
      }
}

export function projectRuntimeInteractionMode<
  T extends Pick<StructuredAgentSessionOptionState, 'reportedAgent' | 'interactionModes'>
>(state: T, report: AgentSessionStatusSummary['runtimeInteractionMode'], fence: number | null): T {
  if (report === undefined) {
    return state
  }
  return {
    ...state,
    reportedAgent: report?.fence === fence ? report.reportedAgent : undefined,
    interactionModes: report?.fence === fence ? report.interactionModes : undefined
  }
}
