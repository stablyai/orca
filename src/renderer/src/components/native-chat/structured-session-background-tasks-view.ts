// The background-tasks strip's view of one session's wire state.
//
// The strip stands for work that OUTLIVES a turn. It stays mounted through a
// running turn — a fan-out's children keep reporting long after the parent
// settles — but only an idle session lets it animate or speak for itself.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../../../shared/agent-session-wire'

export type StructuredSessionBackgroundTasksView = {
  /** The strip renders whenever the host reports monitoring — mid-turn included. */
  show: boolean
  /** Idle-only: gates the animated monitoring indicator and conversation
   *  commands, never the strip itself. A running turn owns the voice. */
  isMonitoring: boolean
  tasks: AgentSessionBackgroundTask[]
  settledTasks: AgentSessionBackgroundTask[]
  supportsStop: boolean
  supportsStopAll: boolean
}

export function structuredSessionBackgroundTasksView(
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined,
  turnId: string | null
): StructuredSessionBackgroundTasksView {
  const monitoring = backgroundTasks?.state === 'monitoring'
  return {
    show: monitoring,
    isMonitoring: turnId === null && monitoring,
    tasks: backgroundTasks?.tasks ?? [],
    settledTasks: backgroundTasks?.settledTasks ?? [],
    supportsStop: backgroundTasks?.supportsTaskStop === true,
    // Absent means the host predates the field and does accept an untargeted
    // stop; only a host that says `false` has none to offer.
    supportsStopAll: backgroundTasks?.supportsStopAll !== false
  }
}
