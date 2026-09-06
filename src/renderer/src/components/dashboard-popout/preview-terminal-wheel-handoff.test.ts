// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionGridWheelTarget } from '../../../../shared/session-grid-types'
import { installPreviewWheelHandoff, isTerminalWheelReplay } from './preview-terminal-wheel-handoff'
import { TUI_WHEEL_PROBE_MS } from './preview-terminal-tui-wheel-probe'

const ROWS = 24
const transcript = Array.from({ length: ROWS }, (_, i) => `line ${i}`)

/** A fake xterm whose screen the test paints; mouse tracking and scrollback are set per test. */
function makeTerminal(opts: { mouseTracking?: boolean; viewportY?: number; baseY?: number } = {}) {
  let screen = transcript
  const writes = new Set<() => void>()
  return {
    terminal: {
      rows: ROWS,
      modes: { mouseTrackingMode: opts.mouseTracking ? 'any' : 'none' },
      buffer: {
        active: {
          viewportY: opts.viewportY ?? 10,
          baseY: opts.baseY ?? 10,
          getLine: (y: number) => ({ translateToString: () => screen[y] ?? '' })
        }
      },
      onWriteParsed: (listener: () => void) => {
        writes.add(listener)
        return { dispose: () => writes.delete(listener) }
      }
    },
    /** Rewrites the screen and lets every write listener parse it. */
    paint(next: string[]): void {
      screen = next
      for (const listener of Array.from(writes)) {
        listener()
      }
    }
  }
}

function mountHandoff(args: {
  wheelTarget?: SessionGridWheelTarget
  terminal: ReturnType<typeof makeTerminal>['terminal']
  now?: () => number
}) {
  const container = document.createElement('div')
  const xterm = document.createElement('div')
  container.appendChild(xterm)
  document.body.appendChild(container)
  const onWheelOverflow = vi.fn((event: WheelEvent) => event.preventDefault())
  const reachedXterm: WheelEvent[] = []
  xterm.addEventListener('wheel', (event) => reachedXterm.push(event))
  const dispose = installPreviewWheelHandoff({
    container,
    getTerminal: () => args.terminal as never,
    onWheelOverflow,
    getWheelTarget: () => args.wheelTarget ?? 'auto',
    now: args.now
  })
  const wheel = (shiftKey = false): WheelEvent => {
    const event = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true })
    // happy-dom's WheelEvent init drops modifier keys.
    Object.defineProperty(event, 'shiftKey', { value: shiftKey })
    xterm.dispatchEvent(event)
    return event
  }
  return {
    wheel,
    onWheelOverflow,
    reachedXterm,
    dispose: () => {
      dispose()
      container.remove()
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('installPreviewWheelHandoff over a mouse-tracking TUI', () => {
  it('hands off the complete short flick, but never after disposal', () => {
    vi.useFakeTimers()
    const tui = makeTerminal({ mouseTracking: true, viewportY: 0, baseY: 0 })
    const { wheel, onWheelOverflow, dispose } = mountHandoff({ terminal: tui.terminal })
    wheel()
    vi.advanceTimersByTime(30)
    wheel()
    vi.advanceTimersByTime(30)
    wheel()
    vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
    expect(onWheelOverflow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deltaY: 120 })
    )
    vi.advanceTimersByTime(500)
    wheel()
    dispose()
    vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
    expect(onWheelOverflow).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hands off isolated notches without waiting for a second wheel event', () => {
    vi.useFakeTimers()
    const tui = makeTerminal({ mouseTracking: true, viewportY: 0, baseY: 0 })
    const { wheel, onWheelOverflow, dispose } = mountHandoff({ terminal: tui.terminal })
    for (let i = 0; i < 4; i++) {
      const event = wheel()
      vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
      expect(onWheelOverflow).toHaveBeenLastCalledWith(
        expect.objectContaining({ deltaY: event.deltaY })
      )
      expect(onWheelOverflow).toHaveBeenCalledTimes(i + 1)
      vi.advanceTimersByTime(500)
    }
    dispose()
  })

  it('probes with the first wheel of a gesture and gives it to whoever reacts', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let at = 1_000
    const tui = makeTerminal({ mouseTracking: true, viewportY: 0, baseY: 0 })
    const { wheel, onWheelOverflow, reachedXterm, dispose } = mountHandoff({
      terminal: tui.terminal,
      now: () => at
    })

    // The first wheel reaches xterm as the probe; the TUI scrolls, so the gesture is its own.
    wheel()
    expect(reachedXterm).toHaveLength(1)
    at = 1_050
    tui.paint([...transcript.slice(1), `line ${ROWS}`])
    at = 1_100
    wheel()
    expect(reachedXterm).toHaveLength(2)
    expect(onWheelOverflow).not.toHaveBeenCalled()

    // A fresh gesture: the TUI only ticks a spinner, so at the window's end the surface takes over.
    at = 2_000
    wheel()
    expect(reachedXterm).toHaveLength(3)
    // One row differs from the scrolled screen: a spinner tick, not a scroll.
    tui.paint([...transcript.slice(1), '⠋ Thinking'])
    vi.advanceTimersByTime(TUI_WHEEL_PROBE_MS)
    at = 2_250
    const overflow = wheel()
    expect(onWheelOverflow).toHaveBeenCalledWith(overflow)
    expect(reachedXterm).toHaveLength(3)

    // A screen already moving is not probed: the surface scrolls at once.
    at = 3_000
    tui.paint(transcript)
    at = 3_100
    const busy = wheel()
    expect(onWheelOverflow).toHaveBeenCalledWith(busy)
    expect(reachedXterm).toHaveLength(3)
    dispose()
  })
})

describe('installPreviewWheelHandoff wheel targets', () => {
  it("never hands off under 'terminal': the wheel is xterm's even at the end of scrollback", () => {
    const { wheel, onWheelOverflow, reachedXterm, dispose } = mountHandoff({
      wheelTarget: 'terminal',
      terminal: makeTerminal().terminal
    })
    const event = wheel()
    expect(onWheelOverflow).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
    expect(reachedXterm).toEqual([event])
    dispose()
  })

  it("replays Shift+wheel to xterm without the modifier under 'grid'", () => {
    const { wheel, onWheelOverflow, reachedXterm, dispose } = mountHandoff({
      wheelTarget: 'grid',
      terminal: makeTerminal().terminal
    })
    const shifted = wheel(true)
    expect(shifted.defaultPrevented).toBe(true)
    expect(onWheelOverflow).not.toHaveBeenCalled()
    expect(reachedXterm).toHaveLength(1)
    const replay = reachedXterm[0]!
    expect(replay).not.toBe(shifted)
    // happy-dom leaves an unset modifier undefined; the replay never carries Shift.
    expect(replay.shiftKey).toBeFalsy()
    expect(replay.deltaY).toBe(40)
    expect(isTerminalWheelReplay(replay)).toBe(true)
    dispose()
  })

  it("hands a plain wheel at the end of scrollback to the surface under 'auto'", () => {
    const { wheel, onWheelOverflow, reachedXterm, dispose } = mountHandoff({
      terminal: makeTerminal().terminal
    })
    const event = wheel()
    expect(onWheelOverflow).toHaveBeenCalledWith(event)
    expect(reachedXterm).toEqual([])
    dispose()
  })
})
