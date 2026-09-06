import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TUI_WHEEL_BUSY_MS,
  TUI_WHEEL_PROBE_MS,
  createTuiWheelProbe,
  type TuiWheelProbeTerminal
} from './preview-terminal-tui-wheel-probe'

const ROWS = 12

/** A screen the test can rewrite; every `write` is what xterm would parse. */
function makeScreen(lines: string[] = []) {
  let rows = Array.from({ length: ROWS }, (_, i) => lines[i] ?? '')
  const listeners = new Set<() => void>()
  const terminal: TuiWheelProbeTerminal = {
    rows: ROWS,
    buffer: {
      active: {
        viewportY: 0,
        getLine: (y: number) => ({ translateToString: () => rows[y] ?? '' })
      }
    },
    onWriteParsed: (listener: () => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    }
  }
  return {
    terminal,
    listenerCount: () => listeners.size,
    write(next: string[]): void {
      rows = Array.from({ length: ROWS }, (_, i) => next[i] ?? '')
      // Snapshot first: a settling probe removes its listener mid-iteration.
      const pending = Array.from(listeners)
      for (const listener of pending) {
        listener()
      }
    }
  }
}

const transcript = Array.from({ length: ROWS }, (_, i) => `line ${i}`)
const scrolledByOne = [...transcript.slice(1), 'line 12']

describe('createTuiWheelProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads a screen that shifts as the TUI taking the wheel', () => {
    const screen = makeScreen(transcript)
    const probe = createTuiWheelProbe({ getTerminal: () => screen.terminal })
    const onVerdict = vi.fn()
    probe.start(onVerdict)

    vi.advanceTimersByTime(40)
    screen.write(scrolledByOne)
    expect(onVerdict).toHaveBeenCalledWith('tui')
    expect(onVerdict).toHaveBeenCalledTimes(1)

    // Settled: the window's end says nothing more.
    vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
    expect(onVerdict).toHaveBeenCalledTimes(1)
  })

  it('reads a spinner tick as no scroll and hands the gesture to the grid at the window', () => {
    const screen = makeScreen(transcript)
    const probe = createTuiWheelProbe({ getTerminal: () => screen.terminal })
    const onVerdict = vi.fn()
    probe.start(onVerdict)

    screen.write([...transcript.slice(0, ROWS - 1), '⠋ Thinking'])
    screen.write([...transcript.slice(0, ROWS - 1), '⠙ Thinking'])
    expect(onVerdict).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
    expect(onVerdict).toHaveBeenCalledWith('grid')
  })

  it('ignores a shift that lands after the window', () => {
    const screen = makeScreen(transcript)
    const probe = createTuiWheelProbe({ getTerminal: () => screen.terminal })
    const onVerdict = vi.fn()
    probe.start(onVerdict)

    vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
    screen.write(scrolledByOne)
    expect(onVerdict).toHaveBeenCalledTimes(1)
    expect(onVerdict).toHaveBeenCalledWith('grid')
  })

  it('counts the TUI as busy only while output is fresh', () => {
    const screen = makeScreen(transcript)
    const probe = createTuiWheelProbe({ getTerminal: () => screen.terminal })
    expect(probe.isBusy()).toBe(false)

    screen.write(scrolledByOne)
    expect(probe.isBusy()).toBe(true)
    vi.advanceTimersByTime(TUI_WHEEL_BUSY_MS)
    expect(probe.isBusy()).toBe(false)
  })

  it('follows a replaced terminal and lets go of everything on dispose', () => {
    const first = makeScreen(transcript)
    const second = makeScreen(transcript)
    let current = first.terminal
    const probe = createTuiWheelProbe({ getTerminal: () => current })
    probe.isBusy()
    expect(first.listenerCount()).toBe(1)

    // The write clock moves with the terminal at the next wheel; the old one is released.
    current = second.terminal
    expect(probe.isBusy()).toBe(false)
    expect(first.listenerCount()).toBe(0)
    second.write(scrolledByOne)
    expect(probe.isBusy()).toBe(true)

    probe.start(vi.fn())
    expect(second.listenerCount()).toBe(2)
    probe.dispose()
    expect(second.listenerCount()).toBe(0)
  })
})
