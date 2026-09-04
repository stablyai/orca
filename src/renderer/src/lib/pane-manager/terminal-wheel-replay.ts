const TERMINAL_WHEEL_REPLAY_PROPERTY = '__orcaPreviewTerminalWheelReplay'

/** A Shift+wheel re-dispatched to xterm without Shift; every surface above the terminal lets it through. */
export function isTerminalWheelReplay(event: WheelEvent): boolean {
  return (
    (event as WheelEvent & { [TERMINAL_WHEEL_REPLAY_PROPERTY]?: true })[
      TERMINAL_WHEEL_REPLAY_PROPERTY
    ] === true
  )
}

/**
 * Why a clone: xterm cannot take the shifted event itself — off macOS its
 * viewport turns Shift+wheel into a horizontal scroll, and a mouse report
 * would carry the modifier to the TUI.
 */
export function replayWheelToTerminal(
  event: WheelEvent,
  deltaY: number,
  target: EventTarget | null = event.target
): void {
  const replay = new WheelEvent(event.type, {
    bubbles: true,
    cancelable: true,
    composed: event.composed,
    view: event.view,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    deltaX: 0,
    deltaY,
    deltaZ: event.deltaZ,
    deltaMode: event.deltaMode
  })
  const legacy = event as WheelEvent & {
    wheelDelta?: number
    wheelDeltaX?: number
    wheelDeltaY?: number
  }
  const wheelDeltaY =
    event.deltaY === 0
      ? legacy.wheelDeltaX || legacy.wheelDeltaY || legacy.wheelDelta
      : (legacy.wheelDeltaY ?? legacy.wheelDelta)
  // Chromium synthesizes different legacy deltas; xterm and the multiplier both read them.
  Object.defineProperties(replay, {
    wheelDeltaX: { value: 0 },
    wheelDeltaY: { value: wheelDeltaY },
    wheelDelta: { value: wheelDeltaY },
    timeStamp: { value: event.timeStamp }
  })
  Object.defineProperty(replay, TERMINAL_WHEEL_REPLAY_PROPERTY, { value: true })
  target?.dispatchEvent(replay)
}
