// The background-tasks strip's view of one session's wire state.
//
// Hosts select background work; newer clients also exclude their current turn's commands
// from an older host's roster. Child agents and earlier commands stay visible mid-turn.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from './agent-session-wire'
import { agentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'

export type StructuredSessionBackgroundTasksView = {
  /** Background rows remain visible during a foreground turn. */
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
const NO_FOREGROUND_COMMANDS: ReadonlySet<string> = new Set()

function withoutForeground<T>(
  rows: T[],
  foreground: ReadonlySet<string>,
  id: (row: T) => string | undefined
): T[] {
  const visible = (row: T) => !foreground.has(id(row) ?? '')
  return rows.every(visible) ? rows : rows.filter(visible)
}

export function structuredSessionBackgroundTasksView(
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined,
  turnId: string | null,
  foregroundCommands: ReadonlySet<string> = NO_FOREGROUND_COMMANDS
): StructuredSessionBackgroundTasksView {
  const monitoring = backgroundTasks?.state === 'monitoring'
  // Decoded once where the frame entered the client's state, so its identity holds between frames.
  const children =
    monitoring && backgroundTasks.children
      ? withoutForeground(backgroundTasks.children, foregroundCommands, (child) => child.providerId)
      : undefined
  const tasks = withoutForeground(
    backgroundTasks?.tasks ?? NO_TASKS,
    foregroundCommands,
    (task) => task.id
  )
  // Only running children arrive; a roster with none holds nothing open either way.
  // An older host's roster whose listed rows have all finished shows nothing that runs.
  const onlyFinished = !children && !tasks.length && Boolean(backgroundTasks?.settledTasks?.length)
  const onlyForeground =
    foregroundCommands.size > 0 &&
    !children?.length &&
    !tasks.length &&
    Boolean(backgroundTasks?.children?.length || backgroundTasks?.tasks?.length)
  const show = monitoring && !onlyFinished && !onlyForeground
  const liveWork = children ? agentChildWorkLiveness(children) !== null : show
  return {
    show,
    isMonitoring: turnId === null && liveWork,
    tasks,
    // Running work only, from any host: an older host's finished rows are not shown either.
    settledTasks: NO_TASKS,
    ...(children ? { children } : {}),
    supportsStop: backgroundTasks?.supportsTaskStop === true,
    // Absent means the host predates the field and does accept an untargeted
    // stop; only a host that says `false` has none to offer.
    supportsStopAll: backgroundTasks?.supportsStopAll !== false
  }
}

/** Whether the strip still lists the task a Stop named, live or settled. */
function listsTask(view: StructuredSessionBackgroundTasksView, providerId: string): boolean {
  return (
    view.show &&
    (view.children
      ? view.children.some((child) => child.providerId === providerId)
      : view.tasks.some((task) => task.id === providerId))
  )
}

/** The host-confirmed Stops whose rows the strip still lists, each holding its row's button; the
 *  same set when none has left, so a caller can tell when to drop the rest. */
export function structuredSessionConfirmedStopsStillListed(
  view: StructuredSessionBackgroundTasksView,
  confirmed: ReadonlySet<string>
): ReadonlySet<string> {
  const listed = [...confirmed].filter((providerId) => listsTask(view, providerId))
  return listed.length === confirmed.size ? confirmed : new Set(listed)
}
