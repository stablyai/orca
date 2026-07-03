import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER,
  attachTerminalMouseWheelMultiplier,
  createTerminalTuiMouseWheelDistanceState,
  normalizeTerminalTuiMouseWheelMultiplier,
  resolveTerminalTuiMouseWheelReportCount,
  shouldMultiplyTerminalMouseWheel
} from './pane-terminal-mouse-wheel'

const DOM_DELTA_PIXEL = 0
const DOM_DELTA_LINE = 1

class TestWheelEvent extends Event {
  static readonly DOM_DELTA_PIXEL = DOM_DELTA_PIXEL
  static readonly DOM_DELTA_LINE = DOM_DELTA_LINE
  static readonly DOM_DELTA_PAGE = 2

  readonly altKey: boolean
  readonly button: number
  readonly buttons: number
  readonly clientX: number
  readonly clientY: number
  readonly ctrlKey: boolean
  readonly deltaMode: number
  readonly deltaX: number
  readonly deltaY: number
  readonly deltaZ: number
  readonly detail: number
  readonly metaKey: boolean
  readonly relatedTarget: EventTarget | null
  readonly screenX: number
  readonly screenY: number
  readonly shiftKey: boolean
  readonly view: Window | null

  constructor(type: string, init: WheelEventInit = {}) {
    super(type, init)
    this.altKey = init.altKey ?? false
    this.button = init.button ?? 0
    this.buttons = init.buttons ?? 0
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.ctrlKey = init.ctrlKey ?? false
    this.deltaMode = init.deltaMode ?? DOM_DELTA_PIXEL
    this.deltaX = init.deltaX ?? 0
    this.deltaY = init.deltaY ?? 0
    this.deltaZ = init.deltaZ ?? 0
    this.detail = init.detail ?? 0
    this.metaKey = init.metaKey ?? false
    this.relatedTarget = init.relatedTarget ?? null
    this.screenX = init.screenX ?? 0
    this.screenY = init.screenY ?? 0
    this.shiftKey = init.shiftKey ?? false
    this.view = init.view ?? null
  }
}

function terminalElement(mouseReporting = true): HTMLElement {
  return {
    classList: {
      contains: (className: string) => mouseReporting && className === 'enable-mouse-events'
    }
  } as HTMLElement
}

function wheelEvent(
  init: Partial<WheelEventInit> & { wheelDelta?: number; wheelDeltaY?: number } = {}
): WheelEvent {
  return {
    deltaY: 100,
    deltaMode: DOM_DELTA_PIXEL,
    ...init
  } as WheelEvent
}

describe('terminal mouse wheel multiplier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses a one-report multiplier for TUI mouse wheel scrolling', () => {
    expect(TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER).toBe(1)
  })

  it('normalizes TUI wheel multipliers to the supported report range', () => {
    expect(normalizeTerminalTuiMouseWheelMultiplier(undefined)).toBe(1)
    expect(normalizeTerminalTuiMouseWheelMultiplier(0)).toBe(1)
    expect(normalizeTerminalTuiMouseWheelMultiplier(4.4)).toBe(4)
    expect(normalizeTerminalTuiMouseWheelMultiplier(20)).toBe(10)
  })

  it('keeps deliberate TUI wheel ticks precise at the one-report setting', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [0, 200, 400, 600].map(() =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([1, 1, 1, 1])
  })

  it('scales notched TUI wheel ticks by the configured multiplier', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [0, 50, 100, 150].map(() =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 },
        5,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([5, 5, 5, 5])
  })

  it('keeps paced 1x TUI wheel ticks precise', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [0, 80, 160, 240].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120, timeStamp },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([1, 1, 1, 1])
  })

  it('adds a burst boost for very fast 1x TUI wheel scrolling', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [0, 16, 32, 48, 64].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120, timeStamp },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([1, 1, 3, 3, 4])
  })

  it('uses a hotter compressed wheel distance curve for larger TUI wheel movements', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 16, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 },
        1,
        state,
        { cellHeight: 16 }
      ),
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 16 * 12, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 * 12 },
        1,
        state,
        { cellHeight: 16 }
      )
    ]

    expect(reports).toEqual([1, 6])
  })

  it('caps a single accelerated TUI wheel event before it becomes a huge jump', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = resolveTerminalTuiMouseWheelReportCount(
      { deltaY: 16 * 200, deltaMode: DOM_DELTA_PIXEL, wheelDeltaY: -120 * 200 },
      1,
      state,
      { cellHeight: 16 }
    )

    expect(reports).toBe(6)
  })

  it('lets aggressive repeated TUI wheel events exceed the single-event cap', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [0, 16, 32, 48, 64].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        {
          deltaY: 16 * 200,
          deltaMode: DOM_DELTA_PIXEL,
          timeStamp,
          wheelDeltaY: -120 * 200
        },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([6, 6, 8, 8, 9])
  })

  it('does not carry burst boost into a decaying momentum tail', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [
      [200, 0],
      [200, 16],
      [200, 32],
      [80, 48],
      [20, 64],
      [5, 80]
    ].map(([rows, timeStamp]) =>
      resolveTerminalTuiMouseWheelReportCount(
        {
          deltaY: 16 * rows,
          deltaMode: DOM_DELTA_PIXEL,
          timeStamp,
          wheelDeltaY: -120 * rows
        },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([6, 6, 8, 6, 6, 4])
  })

  it('retains fractional trackpad distance until it reaches a full row', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [4, 4, 4, 4].map((deltaY) =>
      resolveTerminalTuiMouseWheelReportCount({ deltaY, deltaMode: DOM_DELTA_PIXEL }, 1, state, {
        cellHeight: 16
      })
    )

    expect(reports).toEqual([0, 0, 0, 1])
  })

  it('does not burst-boost rapid trackpad-like pixel deltas', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [0, 16, 32, 48].map((timeStamp) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: 4, deltaMode: DOM_DELTA_PIXEL, timeStamp },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([0, 0, 0, 1])
  })

  it('tracks a decaying trackpad-like momentum tail with linear row distance', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [16, 20, 24, 28, 20, 12, 6, 3].map((deltaY, index) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY, deltaMode: DOM_DELTA_PIXEL, timeStamp: index * 16 },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([1, 1, 1, 2, 1, 1, 0, 1])
  })

  it('drops pending trackpad distance on each direction change', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [16, 20, 24, -16, -20, -24, -18, -10, 6, -4].map((deltaY, index) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY, deltaMode: DOM_DELTA_PIXEL, timeStamp: index * 16 },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0])
  })

  it('emits the full linear distance for a fast trackpad-like flick event', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [16 * 12, 16 * 12, 16 * 12].map((deltaY, index) =>
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY, deltaMode: DOM_DELTA_PIXEL, timeStamp: index * 16 },
        1,
        state,
        { cellHeight: 16 }
      )
    )

    expect(reports).toEqual([12, 12, 12])
  })

  it('resets pending fractional distance when the user changes direction', () => {
    const state = createTerminalTuiMouseWheelDistanceState()

    const reports = [
      resolveTerminalTuiMouseWheelReportCount({ deltaY: 4, deltaMode: DOM_DELTA_PIXEL }, 1, state, {
        cellHeight: 16
      }),
      resolveTerminalTuiMouseWheelReportCount(
        { deltaY: -12, deltaMode: DOM_DELTA_PIXEL },
        1,
        state,
        { cellHeight: 16 }
      )
    ]

    expect(reports).toEqual([0, 0])
  })

  it('multiplies discrete wheel events when mouse reporting is active', () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement())).toBe(true)
  })

  it('leaves normal terminal scrollback alone', () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement(false))).toBe(false)
  })

  it('handles trackpad-like TUI pixel scrolling while mouse reporting is active', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 12,
          deltaMode: DOM_DELTA_PIXEL
        }),
        terminalElement()
      )
    ).toBe(true)
  })

  it('multiplies notched mouse wheel ticks even when Chromium exposes a small pixel delta', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 12,
          deltaMode: DOM_DELTA_PIXEL,
          wheelDeltaY: -120
        }),
        terminalElement()
      )
    ).toBe(true)
  })

  it('multiplies non-pixel wheel deltas as discrete input', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 1,
          deltaMode: DOM_DELTA_LINE
        }),
        terminalElement()
      )
    ).toBe(true)
  })

  it('ignores horizontal shift-wheel events', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          shiftKey: true
        }),
        terminalElement()
      )
    ).toBe(false)
  })

  it('replays discrete TUI wheel ticks as line-mode reports', async () => {
    vi.stubGlobal('WheelEvent', TestWheelEvent)
    const handlers: ((event: WheelEvent) => boolean)[] = []
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events'
      }
    }) as unknown as EventTarget & HTMLElement
    const dispatched: WheelEvent[] = []
    target.addEventListener('wheel', (event) => dispatched.push(event as WheelEvent))
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler)
        },
        element: target,
        rows: 24
      },
      { getTuiMouseWheelMultiplier: () => 1 }
    )
    const event = new TestWheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12
    }) as WheelEvent
    Object.defineProperty(event, 'wheelDeltaY', {
      configurable: true,
      value: -120
    })

    expect(handlers).toHaveLength(1)
    expect(handlers[0]?.(event)).toBe(false)
    await Promise.resolve()

    expect(dispatched).toHaveLength(1)
    expect(dispatched.map((entry) => entry.deltaMode)).toEqual([DOM_DELTA_LINE])
    expect(dispatched.map((entry) => entry.deltaY)).toEqual([1])
    expect(shouldMultiplyTerminalMouseWheel(dispatched[0]!, target)).toBe(false)
  })

  it('replays trackpad-like TUI pixel scrolling with responsive direction reversal', async () => {
    vi.stubGlobal('WheelEvent', TestWheelEvent)
    const handlers: ((event: WheelEvent) => boolean)[] = []
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events'
      }
    }) as unknown as EventTarget & HTMLElement
    const dispatched: WheelEvent[] = []
    target.addEventListener('wheel', (event) => dispatched.push(event as WheelEvent))
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler)
        },
        element: target,
        rows: 24
      },
      { getTuiMouseWheelMultiplier: () => 1 }
    )

    const events = [
      [4, 0],
      [4, 16],
      [4, 32],
      [4, 48],
      [-4, 64],
      [-4, 80],
      [-4, 96],
      [-4, 112]
    ].map(([deltaY, timeStamp]) => {
      const event = new TestWheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: DOM_DELTA_PIXEL,
        deltaY
      }) as WheelEvent
      Object.defineProperty(event, 'timeStamp', {
        configurable: true,
        value: timeStamp
      })
      return event
    })

    for (const event of events) {
      expect(handlers[0]?.(event)).toBe(false)
      await Promise.resolve()
    }

    expect(dispatched.map((entry) => entry.deltaY)).toEqual([1, -1])
  })

  it('replays a fast trackpad-like flick as one full synthetic report batch', async () => {
    vi.stubGlobal('WheelEvent', TestWheelEvent)
    const handlers: ((event: WheelEvent) => boolean)[] = []
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events'
      }
    }) as unknown as EventTarget & HTMLElement
    const dispatched: WheelEvent[] = []
    target.addEventListener('wheel', (event) => dispatched.push(event as WheelEvent))
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler)
        },
        element: target,
        rows: 24
      },
      { getTuiMouseWheelMultiplier: () => 1 }
    )

    const event = new TestWheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 16 * 12
    }) as WheelEvent

    expect(handlers[0]?.(event)).toBe(false)
    await Promise.resolve()

    expect(dispatched.map((entry) => entry.deltaY)).toEqual(Array(12).fill(1))
  })

  it('drains resolved TUI wheel reports without a frame-rate cap', async () => {
    vi.stubGlobal('WheelEvent', TestWheelEvent)
    const handlers: ((event: WheelEvent) => boolean)[] = []
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events'
      }
    }) as unknown as EventTarget & HTMLElement
    const dispatched: WheelEvent[] = []
    target.addEventListener('wheel', (event) => dispatched.push(event as WheelEvent))
    attachTerminalMouseWheelMultiplier(
      {
        attachCustomWheelEventHandler: (handler) => {
          handlers.push(handler)
        },
        element: target,
        rows: 24
      },
      {
        getTuiMouseWheelMultiplier: () => 3
      }
    )
    const firstEvent = new TestWheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12
    }) as WheelEvent
    Object.defineProperty(firstEvent, 'wheelDeltaY', {
      configurable: true,
      value: -120
    })
    Object.defineProperty(firstEvent, 'timeStamp', {
      configurable: true,
      value: 0
    })
    const secondEvent = new TestWheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 12
    }) as WheelEvent
    Object.defineProperty(secondEvent, 'wheelDeltaY', {
      configurable: true,
      value: -120
    })
    Object.defineProperty(secondEvent, 'timeStamp', {
      configurable: true,
      value: 50
    })

    expect(handlers[0]?.(firstEvent)).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(3)

    expect(handlers[0]?.(secondEvent)).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(6)
  })
})
