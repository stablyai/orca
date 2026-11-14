import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

/** Runtime reports describe the process whose options answer carried them; a newer fence has none until it answers. */
export function structuredAgentSessionReportsAtFence<
  T extends Pick<StructuredAgentSessionOptionState, 'reportedPermissionMode' | 'reportedEffort'>
>(state: T, answeredFence: number | null | undefined, fence: number | null): T {
  return answeredFence === fence ||
    (state.reportedPermissionMode === undefined && state.reportedEffort === undefined)
    ? state
    : {
        ...state,
        reportedPermissionMode: undefined,
        reportedEffort: undefined
      }
}
