// The background-tasks strip's view of one session's wire state.
//
// The strip stands for work that OUTLIVED a turn, not work in flight: a running
// turn already has the working status, the turn activity line, and its own
// durable rows, so the strip is suppressed while one is open.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../../../shared/agent-session-wire'

export type StructuredSessionBackgroundTasksView = {
  isMonitoringBackgroundTasks: boolean
  backgroundTasks: readonly AgentSessionBackgroundTask[]
  supportsBackgroundTaskStop: boolean
  supportsBackgroundTaskStopAll: boolean
}

export function structuredSessionBackgroundTasksView(
  state: AgentSessionBackgroundTaskState | null | undefined,
  turnId: string | null
): StructuredSessionBackgroundTasksView {
  return {
    isMonitoringBackgroundTasks: turnId === null && state?.state === 'monitoring',
    backgroundTasks: state?.tasks ?? [],
    supportsBackgroundTaskStop: state?.supportsTaskStop === true,
    // Absent means the host predates the field and does accept an untargeted
    // stop; only a host that says `false` has none to offer.
    supportsBackgroundTaskStopAll: state?.supportsStopAll !== false
  }
}
