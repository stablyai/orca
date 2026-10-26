import type { DesktopAppAgentActivity } from '../../../../shared/desktop-app-types'
import type { Point } from './desktop-app-point-mapping'

// Why: agents think between actions for seconds at a time; dropping the indicator on every gap
// would flash the border, so control stays shown until the agent has been quiet this long.
export const AGENT_CONTROL_IDLE_MS = 20_000
// Why: a lost `end` (renderer reload, crashed runtime) must not pin the border on forever.
export const AGENT_ACTION_MAX_MS = 120_000

export type DesktopAppAgentControlState = {
  controlling: boolean
  stopped: boolean
  // Last known agent cursor position, in window points.
  cursor: Point | null
  // Actions that started on this pane and have not ended, by activity id -> start time.
  inFlight: Readonly<Record<string, number>>
  lastActivityAt: number
}

export const INITIAL_AGENT_CONTROL_STATE: DesktopAppAgentControlState = {
  controlling: false,
  stopped: false,
  cursor: null,
  inFlight: {},
  lastActivityAt: 0
}

export type DesktopAppAgentControlEvent =
  // `targetsPane`: whether this event alone names the pane's app; an `end` whose start did still
  // closes it, since the end can carry a resolved pid or window the start did not know yet.
  | { type: 'activity'; activity: DesktopAppAgentActivity; targetsPane: boolean }
  | { type: 'idle'; now: number }
  | { type: 'stop' }
  // Main never blocked the pid, so the agent can still act: the pane must not claim it stopped.
  | { type: 'stopFailed' }
  | { type: 'allow' }
  | { type: 'reset' }
  | { type: 'hydrateStopped' }

export function reduceAgentControl(
  state: DesktopAppAgentControlState,
  event: DesktopAppAgentControlEvent
): DesktopAppAgentControlState {
  switch (event.type) {
    case 'activity':
      return reduceActivity(state, event.activity, event.targetsPane)
    case 'idle': {
      const inFlight = dropExpired(state.inFlight, event.now)
      const next = inFlight === state.inFlight ? state : { ...state, inFlight }
      if (!next.controlling || Object.keys(inFlight).length > 0) {
        return next
      }
      if (event.now - next.lastActivityAt < AGENT_CONTROL_IDLE_MS) {
        return next
      }
      return { ...next, controlling: false, cursor: null }
    }
    case 'stop':
      return { ...state, controlling: false, stopped: true, cursor: null, inFlight: {} }
    case 'allow':
    case 'stopFailed':
      return { ...state, stopped: false }
    case 'hydrateStopped':
      return { ...state, stopped: true }
    case 'reset':
      return INITIAL_AGENT_CONTROL_STATE
  }
}

/** Shows Stop at once and takes it back if main could not block the agent. */
export async function requestAgentStop(
  dispatch: (event: DesktopAppAgentControlEvent) => void,
  stop: (() => Promise<unknown>) | undefined,
  isCurrent: () => boolean = () => true
): Promise<void> {
  dispatch({ type: 'stop' })
  try {
    await stop?.()
  } catch (error) {
    console.warn('[desktop-app] stopAgent failed:', error)
    // Why: the pane may show another app by now; its state must not change for this one.
    if (isCurrent()) {
      dispatch({ type: 'stopFailed' })
    }
  }
}

/** Clears Stop at once and shows it again if main could not lift the block. */
export async function requestAgentAllow(
  dispatch: (event: DesktopAppAgentControlEvent) => void,
  allow: (() => Promise<unknown>) | undefined,
  isCurrent: () => boolean = () => true
): Promise<void> {
  dispatch({ type: 'allow' })
  try {
    await allow?.()
  } catch (error) {
    console.warn('[desktop-app] allowAgent failed:', error)
    // Why: the pane may show another app by now; its state must not change for this one.
    if (isCurrent()) {
      dispatch({ type: 'hydrateStopped' })
    }
  }
}

function reduceActivity(
  state: DesktopAppAgentControlState,
  activity: DesktopAppAgentActivity,
  targetsPane: boolean
): DesktopAppAgentControlState {
  if (state.stopped) {
    return state
  }
  const { activityId } = activity
  const startedHere = Object.hasOwn(state.inFlight, activityId)
  if (!targetsPane && !startedHere) {
    return state
  }
  let inFlight = state.inFlight
  if (activity.phase === 'start') {
    inFlight = { ...inFlight, [activityId]: activity.at }
  } else if (startedHere) {
    const { [activityId]: _ended, ...rest } = inFlight
    inFlight = rest
  }
  return {
    ...state,
    controlling: true,
    // Why: an end that resolved to another window still closes its action, but its point is
    // in that window's coordinates, not this pane's.
    cursor: targetsPane ? (activity.point ?? state.cursor) : state.cursor,
    inFlight,
    lastActivityAt: activity.at
  }
}

function dropExpired(
  inFlight: Readonly<Record<string, number>>,
  now: number
): Readonly<Record<string, number>> {
  const entries = Object.entries(inFlight)
  const live = entries.filter(([, startedAt]) => now - startedAt < AGENT_ACTION_MAX_MS)
  return live.length === entries.length ? inFlight : Object.fromEntries(live)
}
