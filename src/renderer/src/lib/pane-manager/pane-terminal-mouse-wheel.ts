import type { Terminal } from '@xterm/xterm'

const XTERM_MOUSE_REPORTING_CLASS = 'enable-mouse-events'
const REPLAYED_WHEEL_EVENT_PROPERTY = '__orcaReplayedTerminalWheelEvent'
const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1
const DISCRETE_PIXEL_WHEEL_DELTA_MIN = 50
const LEGACY_MOUSE_WHEEL_DELTA_MIN = 100

export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER = 1
export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN = 1
export const TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX = 10

type TerminalWheelTarget = Pick<Terminal, 'attachCustomWheelEventHandler' | 'element'>

type TerminalMouseWheelMultiplierOptions = {
  getTuiMouseWheelMultiplier?: () => number | undefined
}

type ReplayedWheelEvent = WheelEvent & {
  [REPLAYED_WHEEL_EVENT_PROPERTY]?: boolean
}

type WheelEventWithLegacyDelta = WheelEvent & {
  wheelDelta?: number
  wheelDeltaY?: number
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

function legacyVerticalWheelDelta(event: WheelEvent): number | null {
  const wheelEvent = event as WheelEventWithLegacyDelta
  if (typeof wheelEvent.wheelDeltaY === 'number' && Number.isFinite(wheelEvent.wheelDeltaY)) {
    return wheelEvent.wheelDeltaY
  }
  if (typeof wheelEvent.wheelDelta === 'number' && Number.isFinite(wheelEvent.wheelDelta)) {
    return wheelEvent.wheelDelta
  }
  return null
}

function isDiscreteWheelEvent(event: WheelEvent): boolean {
  if (event.deltaMode !== DOM_DELTA_PIXEL) {
    return true
  }

  if (Math.abs(event.deltaY) >= DISCRETE_PIXEL_WHEEL_DELTA_MIN) {
    return true
  }

  const legacyDelta = legacyVerticalWheelDelta(event)
  return legacyDelta !== null && Math.abs(legacyDelta) >= LEGACY_MOUSE_WHEEL_DELTA_MIN
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

export function shouldMultiplyTerminalMouseWheel(
  event: WheelEvent,
  terminalElement: HTMLElement | null | undefined
): boolean {
  if (
    isReplayedWheelEvent(event) ||
    !terminalElement?.classList.contains(XTERM_MOUSE_REPORTING_CLASS) ||
    event.deltaY === 0 ||
    event.shiftKey ||
    !isDiscreteWheelEvent(event)
  ) {
    return false
  }

  return true
}

export function normalizeTerminalTuiMouseWheelMultiplier(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER
  }
  return Math.round(
    Math.min(
      TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MAX,
      Math.max(TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER_MIN, value)
    )
  )
}

export function attachTerminalMouseWheelMultiplier(
  terminal: TerminalWheelTarget,
  options: TerminalMouseWheelMultiplierOptions = {}
): void {
  terminal.attachCustomWheelEventHandler((event) => {
    if (!shouldMultiplyTerminalMouseWheel(event, terminal.element)) {
      return true
    }

    const target =
      event.currentTarget instanceof EventTarget ? event.currentTarget : terminal.element
    if (!target) {
      return true
    }

    // Why: xterm dampens small pixel deltas before emitting mouse reports;
    // line-mode replays make each notched wheel tick produce immediate reports.
    queueMicrotask(() => {
      const multiplier = normalizeTerminalTuiMouseWheelMultiplier(
        options.getTuiMouseWheelMultiplier?.()
      )
      for (let i = 0; i < multiplier; i++) {
        target.dispatchEvent(cloneWheelReportEvent(event))
      }
    })

    return false
  })
}
