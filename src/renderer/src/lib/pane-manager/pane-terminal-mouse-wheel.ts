import type { Terminal } from '@xterm/xterm'
import {
  createTerminalTuiMouseWheelDistanceState,
  normalizeTerminalTuiMouseWheelMultiplier,
  resolveTerminalTuiMouseWheelReportCount,
  resolveTerminalWheelDirection
} from './pane-terminal-tui-wheel-reports'
import type { TerminalTuiMouseWheelDistanceState } from './pane-terminal-tui-wheel-reports'

export {
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER,
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX,
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN,
  createTerminalTuiMouseWheelDistanceState,
  normalizeTerminalTuiMouseWheelMultiplier,
  resolveTerminalTuiMouseWheelReportCount
} from './pane-terminal-tui-wheel-reports'
export type { TerminalTuiMouseWheelDistanceState } from './pane-terminal-tui-wheel-reports'

const XTERM_MOUSE_REPORTING_CLASS = 'enable-mouse-events'
const REPLAYED_WHEEL_EVENT_PROPERTY = '__orcaReplayedTerminalWheelEvent'
const DOM_DELTA_LINE = 1

type TerminalWheelTarget = Pick<Terminal, 'attachCustomWheelEventHandler' | 'element' | 'rows'> & {
  modes: Pick<Terminal['modes'], 'mouseTrackingMode'>
}

type TerminalMouseWheelMultiplierOptions = {
  getTuiMouseWheelMultiplier?: () => number | undefined
}

type ReplayedWheelEvent = WheelEvent & {
  [REPLAYED_WHEEL_EVENT_PROPERTY]?: boolean
}

type TerminalTuiMouseWheelReplayState = {
  distance: TerminalTuiMouseWheelDistanceState
  drainScheduled: boolean
  pendingDirection: -1 | 0 | 1
  pendingEvent: WheelEvent | null
  pendingReports: number
  pendingTarget: EventTarget | null
}

function createTerminalTuiMouseWheelReplayState(): TerminalTuiMouseWheelReplayState {
  return {
    distance: createTerminalTuiMouseWheelDistanceState(),
    drainScheduled: false,
    pendingDirection: 0,
    pendingEvent: null,
    pendingReports: 0,
    pendingTarget: null
  }
}

function isReplayedWheelEvent(event: WheelEvent): boolean {
  return (event as ReplayedWheelEvent)[REPLAYED_WHEEL_EVENT_PROPERTY] === true
}

function markReplayedWheelEvent(event: WheelEvent): void {
  Object.defineProperty(event, REPLAYED_WHEEL_EVENT_PROPERTY, {
    configurable: true,
    value: true
  })
}

function cloneWheelReportEvent(event: WheelEvent): WheelEvent {
  const clone = new WheelEvent(event.type, {
    bubbles: event.bubbles,
    cancelable: event.cancelable,
    composed: event.composed,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    relatedTarget: event.relatedTarget,
    deltaX: 0,
    deltaY: event.deltaY < 0 ? -1 : 1,
    deltaZ: 0,
    deltaMode: DOM_DELTA_LINE
  })
  markReplayedWheelEvent(clone)
  return clone
}

function resolveTerminalWheelCellHeight(terminal: TerminalWheelTarget): number | undefined {
  if (typeof terminal.element?.querySelector !== 'function') {
    return undefined
  }
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
  const rect = screen?.getBoundingClientRect()
  if (!rect || rect.height <= 0 || terminal.rows <= 0) {
    return undefined
  }
  return rect.height / terminal.rows
}

export function shouldMultiplyTerminalMouseWheel(
  event: WheelEvent,
  terminalElement: HTMLElement | null | undefined
): boolean {
  if (
    isReplayedWheelEvent(event) ||
    !terminalElement?.classList.contains(XTERM_MOUSE_REPORTING_CLASS) ||
    event.deltaY === 0 ||
    event.shiftKey
  ) {
    return false
  }

  return true
}

function drainTerminalTuiWheelReports(
  state: TerminalTuiMouseWheelReplayState,
  terminal: TerminalWheelTarget
): void {
  const target = state.pendingTarget
  const event = state.pendingEvent
  if (!target || !event || state.pendingReports <= 0) {
    state.drainScheduled = false
    return
  }

  if (terminal.modes.mouseTrackingMode === 'none') {
    state.pendingReports = 0
    state.drainScheduled = false
    state.pendingDirection = 0
    state.pendingEvent = null
    state.pendingTarget = null
    return
  }

  const reportsToDispatch = state.pendingReports
  for (let i = 0; i < reportsToDispatch; i += 1) {
    target.dispatchEvent(cloneWheelReportEvent(event))
  }
  state.pendingReports = 0
  state.drainScheduled = false
  state.pendingDirection = 0
  state.pendingEvent = null
  state.pendingTarget = null
}

function queueTerminalTuiWheelReports(
  state: TerminalTuiMouseWheelReplayState,
  terminal: TerminalWheelTarget,
  target: EventTarget,
  event: WheelEvent,
  reportCount: number
): void {
  if (reportCount <= 0) {
    return
  }

  const direction = resolveTerminalWheelDirection(event)
  if (state.pendingDirection !== 0 && state.pendingDirection !== direction) {
    state.pendingReports = 0
  }

  state.pendingDirection = direction
  state.pendingEvent = event
  state.pendingTarget = target
  state.pendingReports += reportCount

  if (state.drainScheduled) {
    return
  }

  state.drainScheduled = true
  // Why: dispatch after xterm returns from the original wheel handler, but do
  // not frame-cap reports; fullscreen TUIs need the full wheel distance.
  queueMicrotask(() => {
    drainTerminalTuiWheelReports(state, terminal)
  })
}

export function attachTerminalMouseWheelMultiplier(
  terminal: TerminalWheelTarget,
  options: TerminalMouseWheelMultiplierOptions = {}
): void {
  const replayState = createTerminalTuiMouseWheelReplayState()
  terminal.attachCustomWheelEventHandler((event) => {
    if (
      terminal.modes.mouseTrackingMode === 'none' ||
      !shouldMultiplyTerminalMouseWheel(event, terminal.element)
    ) {
      return true
    }

    const target =
      event.currentTarget instanceof EventTarget ? event.currentTarget : terminal.element
    if (!target) {
      return true
    }

    // Why: xterm dampens small pixel deltas before emitting mouse reports;
    // line-mode replays let fullscreen TUIs receive one report per resolved row.
    const reportCount = resolveTerminalTuiMouseWheelReportCount(
      event,
      normalizeTerminalTuiMouseWheelMultiplier(options.getTuiMouseWheelMultiplier?.()),
      replayState.distance,
      {
        cellHeight: resolveTerminalWheelCellHeight(terminal),
        rows: terminal.rows
      }
    )
    queueTerminalTuiWheelReports(replayState, terminal, target, event, reportCount)

    return false
  })
}
