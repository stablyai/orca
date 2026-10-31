// Hosts select background work; clients additionally hide current-turn commands in old rosters while retaining child agents/earlier commands.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from './agent-session-wire'
import { isLiveChildWork } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'

export type StructuredSessionBackgroundTasksView = {
  /** Background rows remain visible during a foreground turn. */
  show: boolean
  /** Idle-only monitoring/command gate; a running turn owns the indicator, but background rows remain visible. */
  isMonitoring: boolean
  tasks: AgentSessionBackgroundTask[]
  settledTasks: AgentSessionBackgroundTask[]
  /** The host's child records, when it publishes them; the rows then read these. */
  children?: AgentChildWorkView[]
  supportsStop: boolean
  /** Offer untargeted Stop if no targeted stop exists and host supports it, or if idle unlisted work can be reached by ending the agent. */
  offersStopAll: boolean
  /** Some running work is not listed: the strip stays, and says details are unavailable. */
  incomplete: boolean
}

/** Reuse empty lists to preserve strip memoization across renders. */
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
  const settledTasks = backgroundTasks?.settledTasks ?? NO_TASKS
  const onlyForeground =
    foregroundCommands.size > 0 &&
    !children?.length &&
    !tasks.length &&
    !settledTasks.length &&
    Boolean(backgroundTasks?.children?.length || backgroundTasks?.tasks?.length)
  const incomplete = monitoring && backgroundTasks.incomplete === true
  const show = monitoring && (incomplete || !onlyForeground)
  // Commands and rewind follow the listed records, as the host's own admission does.
  const liveWork = children
    ? children.some((child) => child.membership === 'live' && isLiveChildWork(child))
    : tasks.length > 0 || (show && !settledTasks.length)
  const supportsStop = backgroundTasks?.supportsTaskStop === true
  return {
    show,
    isMonitoring: turnId === null && liveWork,
    tasks,
    settledTasks,
    ...(children ? { children } : {}),
    supportsStop,
    // Missing supportsStopAll is legacy support; only explicit false means no untargeted Stop.
    offersStopAll:
      (!supportsStop && liveWork && backgroundTasks?.supportsStopAll !== false) ||
      (incomplete && turnId === null),
    incomplete
  }
}

/** Identify listed runs by invocation because providers reuse IDs across child runs; old hosts fall back to provider ID. */
export function structuredSessionListedTaskRun(
  view: StructuredSessionBackgroundTasksView,
  providerId: string
): string | null {
  if (!view.show) {
    return null
  }
  if (!view.children) {
    return view.tasks.some((task) => task.id === providerId) ? providerId : null
  }
  const child = view.children.find((candidate) => candidate.providerId === providerId)
  return child ? `${child.invocation.invocationId}#${child.invocation.generation}` : null
}

/** Retain confirmed Stops only for still-listed runs; preserve map identity if none left. */
export function structuredSessionConfirmedStopsStillListed(
  view: StructuredSessionBackgroundTasksView,
  confirmed: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  const listed = [...confirmed].filter(
    ([providerId, run]) => structuredSessionListedTaskRun(view, providerId) === run
  )
  return listed.length === confirmed.size ? confirmed : new Map(listed)
}
