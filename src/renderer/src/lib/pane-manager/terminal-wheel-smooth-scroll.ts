import type { IDisposable, Terminal } from '@xterm/xterm'

// Matches VS Code's terminal.integrated.smoothScrolling animation length.
export const TERMINAL_SMOOTH_SCROLL_DURATION_MS = 125
// Why: xterm's animation cannot follow a moving bottom; recent output means more is likely mid-animation.
const OUTPUT_ACTIVE_WINDOW_MS = 250
// One frame past the animation, so xterm has applied its final scroll position.
const DOWNWARD_ARRIVAL_CHECK_DELAY_MS = TERMINAL_SMOOTH_SCROLL_DURATION_MS + 17

type TerminalWheelSmoothScrollTarget = Pick<
  Terminal,
  'buffer' | 'element' | 'modes' | 'options' | 'rows' | 'scrollToBottom'
> & {
  onWriteParsed: Terminal['onWriteParsed']
}

/**
 * True for a physical mouse-wheel notch, mirroring xterm's own wheel classifier: line-mode
 * deltas, or a Chromium wheelDeltaY that is a non-zero multiple of 120. Trackpad and other
 * pixel deltas are scrolled immediately by xterm, so they must not cause any option write.
 */
export function isMouseWheelNotch(event: WheelEvent): boolean {
  // Why a literal: DOM_DELTA_LINE is 1, and the WheelEvent global is absent in some hosts.
  if (event.deltaMode === 1) {
    return true
  }
  // Why: wheelDeltaY is non-standard (Chromium) and missing from the DOM typings.
  const wheelDeltaY = 'wheelDeltaY' in event ? event.wheelDeltaY : undefined
  return typeof wheelDeltaY === 'number' && wheelDeltaY !== 0 && wheelDeltaY % 120 === 0
}

/** Extra time an enabled wheel animation needs before the viewport settles. */
export function resolveTerminalWheelScrollAnimationMs(
  enabled: boolean | undefined,
  event: WheelEvent
): number {
  return enabled === true && isMouseWheelNotch(event) ? TERMINAL_SMOOTH_SCROLL_DURATION_MS : 0
}

/**
 * Call before a scroll that must land synchronously (restore, scrollbar sync, keyboard
 * actions). A wheel notch leaves smoothScrollDuration non-zero until its reset timer fires,
 * and rAF, ResizeObserver and key events can run before that. Writing 0 when it is already 0
 * fires no xterm option event.
 */
export function ensureImmediateTerminalScroll<Target extends object>(terminal: Target): void {
  if (
    'options' in terminal &&
    typeof terminal.options === 'object' &&
    terminal.options !== null &&
    'smoothScrollDuration' in terminal.options &&
    terminal.options.smoothScrollDuration
  ) {
    terminal.options.smoothScrollDuration = 0
  }
}

/**
 * Animates mouse-wheel scrollback; xterm leaves trackpad deltas immediate. A non-zero
 * smoothScrollDuration also makes scrollToLine/scrollLines asynchronous, which Orca's
 * restore and scrollbar-sync paths cannot tolerate, so it is only set for the wheel event.
 */
export function attachTerminalWheelSmoothScroll(
  terminal: TerminalWheelSmoothScrollTarget,
  isEnabled: () => boolean
): IDisposable {
  const element = terminal.element
  if (!element) {
    return { dispose: () => {} }
  }
  let lastOutputAt = Number.NEGATIVE_INFINITY
  let downwardArrival: { baseY: number; timer: ReturnType<typeof setTimeout> } | null = null

  const outputSubscription = terminal.onWriteParsed(() => {
    lastOutputAt = performance.now()
  })

  const cancelDownwardArrival = (): void => {
    if (downwardArrival) {
      clearTimeout(downwardArrival.timer)
      downwardArrival = null
    }
  }

  // Why: xterm keeps the animation's target at the bottom it had when the notch started. Output
  // that lands mid-animation moves the bottom, so the notch ends one or more rows above it and
  // xterm stops following output. A notch that reached the old bottom is finished at the real one.
  const finishDownwardNotch = (armedBaseY: number): void => {
    downwardArrival = null
    const buffer = terminal.buffer.active
    if (
      buffer.type !== 'normal' ||
      buffer.viewportY < armedBaseY ||
      buffer.viewportY >= buffer.baseY
    ) {
      return
    }
    ensureImmediateTerminalScroll(terminal)
    try {
      terminal.scrollToBottom()
    } catch (error) {
      // Why: a suspended WebGL renderer throws until the pane re-attaches; the next restore covers it.
      if (!(error instanceof TypeError) || !/dimensions/.test(error.message)) {
        throw error
      }
    }
  }

  const onWheel = (event: WheelEvent): void => {
    // Why: a pending downward finish would pull the viewport back to the bottom after the user scrolled up.
    if (event.deltaY < 0) {
      cancelDownwardArrival()
    }
    const buffer = terminal.buffer.active
    if (
      !isEnabled() ||
      !isMouseWheelNotch(event) ||
      buffer.type !== 'normal' ||
      terminal.modes.mouseTrackingMode !== 'none'
    ) {
      return
    }
    // Why: output cancels xterm's animation whenever it moves the viewport row — at the
    // bottom, toward a growing bottom, or when a full scrollback trims lines above it.
    if (
      performance.now() - lastOutputAt < OUTPUT_ACTIVE_WINDOW_MS &&
      (buffer.viewportY >= buffer.baseY ||
        event.deltaY > 0 ||
        buffer.length >= terminal.rows + (terminal.options.scrollback ?? 0))
    ) {
      return
    }
    // Why: with a full scrollback, output arriving mid-animation trims lines and shifts the
    // viewport row, which cancels xterm's animation short of the bottom. How far a notch
    // reaches depends on sensitivity, Alt and row height, so every downward notch is immediate.
    if (event.deltaY > 0 && buffer.length >= terminal.rows + (terminal.options.scrollback ?? 0)) {
      return
    }
    if (event.deltaY > 0) {
      cancelDownwardArrival()
      const baseY = buffer.baseY
      downwardArrival = {
        baseY,
        timer: setTimeout(() => finishDownwardNotch(baseY), DOWNWARD_ARRIVAL_CHECK_DELAY_MS)
      }
    }
    terminal.options.smoothScrollDuration = TERMINAL_SMOOTH_SCROLL_DURATION_MS
    // Why a task, not a microtask: browsers drain microtasks between listeners of a native
    // event, which would reset the duration before xterm's wheel handler reads it. The
    // started animation keeps its own duration, so the reset does not cut it short.
    setTimeout(() => {
      terminal.options.smoothScrollDuration = 0
    }, 0)
  }

  // Why capture: the duration must be set before xterm's scrollable (a descendant) handles the wheel.
  element.addEventListener('wheel', onWheel, { capture: true, passive: true })

  return {
    dispose: () => {
      element.removeEventListener('wheel', onWheel, { capture: true })
      outputSubscription.dispose()
      cancelDownwardArrival()
    }
  }
}
