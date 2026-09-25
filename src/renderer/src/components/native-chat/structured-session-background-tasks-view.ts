// The background-tasks strip's view of one session's wire state.
//
// The strip reports work that is IN FLIGHT, whether or not it outlived a turn:
// a fan-out's children keep reporting long after the parent settles, and a
// foreground fan-out is running work while the turn is still open. It stays
// mounted through a running turn — turn state is not a filter on the rows,
// because the producers publish only tasks they still have live evidence for.
// A host that publishes its child records also keeps a finished child listed,
// with how it ended, until the session's next turn. Only an idle session with
// live work lets the strip animate or speak for itself.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../../../shared/agent-session-wire'
import { agentChildWorkLiveness } from '../../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import { decodeAgentChildWorkViews } from '../../../../shared/agent-status-child-work-view-wire'

export type StructuredSessionBackgroundTasksView = {
  /** The strip renders whenever the host reports rows — mid-turn included. */
  show: boolean
  /** Idle-only: gates the animated monitoring indicator and conversation
   *  commands, never the strip itself. A running turn owns the voice. */
  isMonitoring: boolean
  tasks: AgentSessionBackgroundTask[]
  settledTasks: AgentSessionBackgroundTask[]
  /** The host's child records, when it publishes them; the rows then read these. */
  children?: AgentChildWorkView[]
  supportsStop: boolean
  supportsStopAll: boolean
}

export function structuredSessionBackgroundTasksView(
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined,
  turnId: string | null
): StructuredSessionBackgroundTasksView {
  const monitoring = backgroundTasks?.state === 'monitoring'
  const children = monitoring ? decodeAgentChildWorkViews(backgroundTasks.children) : undefined
  // A roster of finished children is shown, but nothing in it is running.
  const liveWork = children ? agentChildWorkLiveness(children) !== null : monitoring
  return {
    show: monitoring,
    isMonitoring: turnId === null && liveWork,
    tasks: backgroundTasks?.tasks ?? [],
    settledTasks: backgroundTasks?.settledTasks ?? [],
    ...(children ? { children } : {}),
    supportsStop: backgroundTasks?.supportsTaskStop === true,
    // Absent means the host predates the field and does accept an untargeted
    // stop; only a host that says `false` has none to offer.
    supportsStopAll: backgroundTasks?.supportsStopAll !== false
  }
}
