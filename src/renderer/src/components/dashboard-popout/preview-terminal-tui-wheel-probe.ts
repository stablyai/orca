import type { Terminal } from '@xterm/xterm'

/** Output this recent means the screen is already moving; a moving screen is not probed, the surface scrolls. */
export const TUI_WHEEL_BUSY_MS = 250
/** How long the TUI gets to move its screen after the first wheel report of a gesture. */
export const TUI_WHEEL_PROBE_MS = 200
// A scroll shifts nearly every visible row; a spinner tick or clock changes one or two.
const TUI_WHEEL_SCROLL_ROW_SHARE = 1 / 3
const TUI_WHEEL_SCROLL_MIN_ROWS = 2

export type TuiWheelProbeTerminal = Pick<Terminal, 'rows' | 'onWriteParsed'> & {
  buffer: {
    active: {
      viewportY: number
      getLine: (y: number) => { translateToString: (trimRight?: boolean) => string } | undefined
    }
  }
}

/** 'tui' when the TUI moved its screen on the wheel report, 'grid' when it did not within the window. */
export type TuiWheelVerdict = 'tui' | 'grid'

function readVisibleRows(terminal: TuiWheelProbeTerminal): string[] {
  const top = terminal.buffer.active.viewportY
  return Array.from(
    { length: terminal.rows },
    (_, i) => terminal.buffer.active.getLine(top + i)?.translateToString(true) ?? ''
  )
}

function countChangedRows(before: string[], after: string[]): number {
  let changed = 0
  for (let i = 0; i < before.length; i += 1) {
    if (before[i] !== after[i]) {
      changed += 1
    }
  }
  return changed
}

/**
 * Tells whether a mouse-tracking TUI used a wheel report. Nothing in the mouse
 * protocol answers that, so the probe watches the screen instead: it snapshots
 * the visible rows before the report and, on each parsed write inside the
 * window, counts how many rows differ. A transcript scroll shifts most rows; a
 * redraw that only ticks a spinner does not. The busy check exists because a
 * screen that was already changing cannot be read either way.
 */
export function createTuiWheelProbe(deps: {
  getTerminal: () => TuiWheelProbeTerminal | null
  now?: () => number
}): {
  isBusy: () => boolean
  start: (onVerdict: (verdict: TuiWheelVerdict) => void) => void
  cancel: () => void
  dispose: () => void
} {
  const now = deps.now ?? ((): number => Date.now())
  let trackedTerminal: TuiWheelProbeTerminal | null = null
  let trackedWrites: { dispose: () => void } | null = null
  let lastWriteAt = Number.NEGATIVE_INFINITY
  let probe: { timer: ReturnType<typeof setTimeout>; writes: { dispose: () => void } } | null = null

  // Why lazily: a resync replaces the terminal, and only a wheel event needs the write clock.
  const track = (): TuiWheelProbeTerminal | null => {
    const terminal = deps.getTerminal()
    if (terminal !== trackedTerminal) {
      trackedWrites?.dispose()
      trackedTerminal = terminal
      lastWriteAt = Number.NEGATIVE_INFINITY
      trackedWrites = terminal
        ? terminal.onWriteParsed(() => {
            lastWriteAt = now()
          })
        : null
    }
    return terminal
  }

  const cancel = (): void => {
    if (!probe) {
      return
    }
    clearTimeout(probe.timer)
    probe.writes.dispose()
    probe = null
  }

  const start = (onVerdict: (verdict: TuiWheelVerdict) => void): void => {
    cancel()
    const terminal = track()
    if (!terminal) {
      onVerdict('grid')
      return
    }
    const before = readVisibleRows(terminal)
    const scrollRows = Math.max(
      TUI_WHEEL_SCROLL_MIN_ROWS,
      Math.ceil(terminal.rows * TUI_WHEEL_SCROLL_ROW_SHARE)
    )
    const settle = (verdict: TuiWheelVerdict): void => {
      cancel()
      onVerdict(verdict)
    }
    probe = {
      timer: setTimeout(() => settle('grid'), TUI_WHEEL_PROBE_MS),
      writes: terminal.onWriteParsed(() => {
        if (countChangedRows(before, readVisibleRows(terminal)) >= scrollRows) {
          settle('tui')
        }
      })
    }
  }

  return {
    isBusy: () => {
      track()
      return now() - lastWriteAt < TUI_WHEEL_BUSY_MS
    },
    start,
    cancel,
    dispose: () => {
      cancel()
      trackedWrites?.dispose()
      trackedWrites = null
      trackedTerminal = null
    }
  }
}
