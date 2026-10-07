// The background-tasks strip's view of one session's wire state.
//
// The strip reports work that is IN FLIGHT, whether or not it outlived a turn:
// a fan-out's children keep reporting long after the parent settles, and a
// foreground fan-out is running work while the turn is still open. It stays
// mounted through a running turn — turn state is not a filter on the rows,
// because the producers publish only tasks they still have live evidence for.
// A host that publishes its child records sends the running ones only, and no
// roster once none runs, so the strip hides. Only an idle session with live
// work lets the strip animate or speak for itself.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from './agent-session-wire'
import { agentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'

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

/** One shared empty list: a roster with no rows of a kind keeps the strip's memo on every render. */
const NO_TASKS: AgentSessionBackgroundTask[] = []

export function structuredSessionBackgroundTasksView(
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined,
  turnId: string | null
): StructuredSessionBackgroundTasksView {
  const monitoring = backgroundTasks?.state === 'monitoring'
  // Decoded once where the frame entered the client's state, so its identity holds between frames.
  const children = monitoring ? backgroundTasks.children : undefined
  // Only running children arrive; a roster with none holds nothing open either way.
  // An older host's roster whose listed rows have all finished shows nothing that runs.
  const onlyFinished =
    !children && !backgroundTasks?.tasks?.length && Boolean(backgroundTasks?.settledTasks?.length)
  const show = monitoring && !onlyFinished
  const liveWork = children ? agentChildWorkLiveness(children) !== null : show
  return {
    show,
    isMonitoring: turnId === null && liveWork,
    tasks: backgroundTasks?.tasks ?? NO_TASKS,
    // Running work only, from any host: an older host's finished rows are not shown either.
    settledTasks: NO_TASKS,
    ...(children ? { children } : {}),
    supportsStop: backgroundTasks?.supportsTaskStop === true,
    // Absent means the host predates the field and does accept an untargeted
    // stop; only a host that says `false` has none to offer.
    supportsStopAll: backgroundTasks?.supportsStopAll !== false
  }
}
