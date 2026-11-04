import {
  beginTerminalReplayPresentation,
  type TerminalReplayPresentationTarget
} from '@/lib/pane-manager/terminal-replay-presentation'

export const PTY_RESIZE_INITIAL_WAIT_MS = 90
export const PTY_RESIZE_POST_PARSE_SETTLE_MS = 48
export const PTY_RESIZE_MAX_HOLD_MS = 380
export const PTY_RESIZE_STREAM_GAP_MS = 60
export const PTY_RESIZE_ABSOLUTE_MAX_HOLD_MS = 1200

export type PtyResizeRepaintHoldTarget = TerminalReplayPresentationTarget & {
  scrollToBottom?: () => void
  buffer?: {
    active?: {
      type?: string
      viewportY?: number
      baseY?: number
    }
  }
}

export type PtyResizeRepaintHold = {
  hold: () => void
  noteOutputQueued: () => void
  noteOutputParsed: () => void
  releaseNow: (present?: boolean) => void
  dispose: () => void
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function isTerminalAtBottom(terminal: PtyResizeRepaintHoldTarget): boolean {
  const active = terminal.buffer?.active
  if (!active || active.type === 'alternate') {
    return false
  }
  return (active.viewportY ?? 0) >= (active.baseY ?? 0)
}

function hasRetainableCanvasScreen(terminal: TerminalReplayPresentationTarget): HTMLElement | null {
  const element = terminal.element
  if (typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) {
    return null
  }
  const screen = element.querySelector<HTMLElement>('.xterm-screen')
  if (!screen || !screen.querySelector('canvas')) {
    return null
  }
  const bounds = screen.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0 ? screen : null
}

/**
 * Freeze the visible terminal bitmap across post-SIGWINCH agent TUI full-history repaints
 * so multi-chunk normal-buffer redraws swap atomically to the settled bottom viewport
 * instead of visibly scrolling from top to bottom.
 */
export function createPtyResizeRepaintHold(
  terminal: PtyResizeRepaintHoldTarget
): PtyResizeRepaintHold {
  let activeRelease: ((present: boolean) => void) | null = null
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let maxTimer: ReturnType<typeof setTimeout> | null = null
  let holdStartedAt = 0
  let holdDeadlineAt = 0
  let lastOutputAt = Number.NEGATIVE_INFINITY
  let inFlightWrites = 0
  let sawOutput = false
  let wasAtBottom = false
  let disposed = false

  const clearTimers = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    if (maxTimer !== null) {
      clearTimeout(maxTimer)
      maxTimer = null
    }
  }

  const armMaxTimer = (): void => {
    if (maxTimer !== null) {
      clearTimeout(maxTimer)
      maxTimer = null
    }
    const remainingMs = Math.max(0, holdDeadlineAt - nowMs())
    maxTimer = setTimeout(() => {
      maxTimer = null
      finishHold(true)
    }, remainingMs)
  }

  const finishHold = (present: boolean): void => {
    clearTimers()
    const release = activeRelease
    if (!release) {
      return
    }
    activeRelease = null
    const restoreBottom = present && sawOutput && wasAtBottom
    inFlightWrites = 0
    sawOutput = false
    wasAtBottom = false
    lastOutputAt = Number.NEGATIVE_INFINITY
    if (restoreBottom) {
      try {
        terminal.scrollToBottom?.()
      } catch {}
    }
    release(present)
  }

  const armSettleTimer = (delayMs: number): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    const remainingMs = Math.max(0, holdDeadlineAt - nowMs())
    const boundedDelay = Math.min(delayMs, remainingMs)
    if (boundedDelay <= 0) {
      finishHold(true)
      return
    }
    settleTimer = setTimeout(() => {
      settleTimer = null
      finishHold(true)
    }, boundedDelay)
  }

  return {
    hold() {
      if (disposed) {
        return
      }
      if (activeRelease !== null) {
        // Extend settle within the existing max deadline during continuous resize steps.
        if (inFlightWrites === 0) {
          armSettleTimer(PTY_RESIZE_INITIAL_WAIT_MS)
        }
        return
      }
      const screen = hasRetainableCanvasScreen(terminal)
      if (!screen) {
        return
      }
      const capturedAtBottom = isTerminalAtBottom(terminal)
      const release = beginTerminalReplayPresentation(terminal)
      if (!screen.parentElement?.querySelector('[data-terminal-replay-frame="true"]')) {
        release(false)
        return
      }
      const start = nowMs()
      activeRelease = release
      wasAtBottom = capturedAtBottom
      sawOutput = false
      inFlightWrites = 0
      holdStartedAt = start
      lastOutputAt = Number.NEGATIVE_INFINITY
      holdDeadlineAt = start + PTY_RESIZE_MAX_HOLD_MS
      armMaxTimer()
      armSettleTimer(PTY_RESIZE_INITIAL_WAIT_MS)
    },

    noteOutputQueued() {
      if (activeRelease === null) {
        return
      }
      const now = nowMs()
      if (!sawOutput || now - lastOutputAt <= PTY_RESIZE_STREAM_GAP_MS) {
        const extendedDeadline = Math.min(
          holdStartedAt + PTY_RESIZE_ABSOLUTE_MAX_HOLD_MS,
          Math.max(holdDeadlineAt, now + PTY_RESIZE_MAX_HOLD_MS)
        )
        if (extendedDeadline > holdDeadlineAt) {
          holdDeadlineAt = extendedDeadline
          armMaxTimer()
        }
      }
      lastOutputAt = now
      sawOutput = true
      inFlightWrites += 1
      if (settleTimer !== null) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
    },

    noteOutputParsed() {
      if (activeRelease === null) {
        return
      }
      inFlightWrites = Math.max(0, inFlightWrites - 1)
      if (inFlightWrites === 0) {
        armSettleTimer(PTY_RESIZE_POST_PARSE_SETTLE_MS)
      }
    },

    releaseNow(present = true) {
      finishHold(present)
    },

    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      finishHold(false)
    }
  }
}
