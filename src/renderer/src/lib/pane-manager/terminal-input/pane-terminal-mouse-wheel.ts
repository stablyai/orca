import {
  createTerminalTuiMouseWheelDistanceState,
  normalizeTerminalTuiMouseWheelMultiplier,
  resolveTerminalTuiMouseWheelReportCount,
  resolveTerminalWheelDirection
} from './pane-terminal-tui-wheel-reports'
import type { TerminalTuiMouseWheelDistanceState } from './pane-terminal-tui-wheel-reports'
import {
  emitCoalescedCoreWheelReports,
  measureScreenRect,
  resolveScreenElement,
  resolveTerminalWheelCellHeight
} from './pane-terminal-core-wheel-encoder'
import type { CachedScreenRect, TerminalWheelTarget } from './pane-terminal-core-wheel-encoder'

const XTERM_MOUSE_REPORTING_CLASS = 'enable-mouse-events'
const REPLAYED_WHEEL_EVENT_PROPERTY = '__orcaReplayedTerminalWheelEvent'
const DOM_DELTA_LINE = 1

type TerminalMouseWheelMultiplierOptions = {
  getTuiMouseWheelMultiplier?: () => number | undefined
}

type TerminalTuiMouseWheelReplayState = {
  distance: TerminalTuiMouseWheelDistanceState
  drainScheduled: boolean
  pendingDirection: -1 | 0 | 1
  pendingEvent: WheelEvent | null
  pendingReports: number
  pendingTarget: EventTarget | null
  cachedScreenRect: CachedScreenRect | null
  observedScreenElement: HTMLElement | null
  screenResizeObserver: ResizeObserver | null
}

function createTerminalTuiMouseWheelReplayState(): TerminalTuiMouseWheelReplayState {
  return {
    distance: createTerminalTuiMouseWheelDistanceState(),
    drainScheduled: false,
    pendingDirection: 0,
    pendingEvent: null,
    pendingReports: 0,
    pendingTarget: null,
    cachedScreenRect: null,
    observedScreenElement: null,
    screenResizeObserver: null
  }
}

function isReplayedWheelEvent(event: WheelEvent): boolean {
  return Object.getOwnPropertyDescriptor(event, REPLAYED_WHEEL_EVENT_PROPERTY)?.value === true
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

function refreshCachedScreenOrigin(
  state: TerminalTuiMouseWheelReplayState,
  terminal: TerminalWheelTarget
): CachedScreenRect | null {
  const measured = measureScreenRect(terminal)
  if (!measured) {
    return state.cachedScreenRect
  }
  state.cachedScreenRect = state.cachedScreenRect
    ? {
        left: measured.left,
        top: measured.top,
        width: state.cachedScreenRect.width,
        height: state.cachedScreenRect.height
      }
    : measured
  return state.cachedScreenRect
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
  const direction = state.pendingDirection
  const reportsToDispatch = state.pendingReports
  state.pendingReports = 0
  state.drainScheduled = false
  state.pendingDirection = 0
  state.pendingEvent = null
  state.pendingTarget = null

  if (!target || !event || reportsToDispatch <= 0 || direction === 0) {
    return
  }
  if (terminal.modes.mouseTrackingMode === 'none') {
    return
  }
  const rect = refreshCachedScreenOrigin(state, terminal)
  if (emitCoalescedCoreWheelReports(terminal, rect, event, direction, reportsToDispatch)) {
    return
  }
  for (let i = 0; i < reportsToDispatch; i += 1) {
    target.dispatchEvent(cloneWheelReportEvent(event))
  }
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
  // Report after xterm's wheel handler, without frame caps that lose fullscreen-TUI scroll distance.
  queueMicrotask(() => {
    drainTerminalTuiWheelReports(state, terminal)
  })
}

export function attachTerminalMouseWheelMultiplier(
  terminal: TerminalWheelTarget,
  options: TerminalMouseWheelMultiplierOptions = {}
): () => void {
  const replayState = createTerminalTuiMouseWheelReplayState()
  let disposed = false
  const invalidateScreenRect = (): void => {
    replayState.cachedScreenRect = null
  }
  const syncScreenObserver = (): void => {
    if (disposed) {
      return
    }
    const screenElement = resolveScreenElement(terminal)
    if (!screenElement || screenElement === replayState.observedScreenElement) {
      return
    }
    replayState.screenResizeObserver?.disconnect()
    replayState.screenResizeObserver = null
    replayState.observedScreenElement = screenElement
    invalidateScreenRect()
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(invalidateScreenRect)
      observer.observe(screenElement)
      replayState.screenResizeObserver = observer
    }
  }

  syncScreenObserver()
  const resizeSubscription = terminal.onResize?.(invalidateScreenRect)
  const cleanup = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    replayState.screenResizeObserver?.disconnect()
    replayState.screenResizeObserver = null
    replayState.observedScreenElement = null
    replayState.cachedScreenRect = null
    resizeSubscription?.dispose()
  }
  if (typeof terminal._core?._register === 'function') {
    terminal._core._register({ dispose: cleanup })
  } else if (typeof terminal._core?.register === 'function') {
    terminal._core.register({ dispose: cleanup })
  }

  terminal.attachCustomWheelEventHandler((event) => {
    if (
      terminal.modes.mouseTrackingMode === 'none' ||
      !shouldMultiplyTerminalMouseWheel(event, terminal.element)
    ) {
      return true
    }

    syncScreenObserver()
    const target =
      event.currentTarget instanceof EventTarget ? event.currentTarget : terminal.element
    if (!target) {
      return true
    }

    const reportCount = resolveTerminalTuiMouseWheelReportCount(
      event,
      normalizeTerminalTuiMouseWheelMultiplier(options.getTuiMouseWheelMultiplier?.()),
      replayState.distance,
      {
        cellHeight: resolveTerminalWheelCellHeight(
          terminal,
          replayState.cachedScreenRect,
          (rect) => {
            replayState.cachedScreenRect = rect
          }
        ),
        rows: terminal.rows
      }
    )
    queueTerminalTuiWheelReports(replayState, terminal, target, event, reportCount)
    return false
  })
  return cleanup
}
