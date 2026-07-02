import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_TUI_MOUSE_WHEEL_MULTIPLIER,
  attachTerminalMouseWheelMultiplier,
  normalizeTerminalTuiMouseWheelMultiplier,
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

  it('multiplies discrete wheel events when mouse reporting is active', () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement())).toBe(true)
  })

  it('leaves normal terminal scrollback alone', () => {
    expect(shouldMultiplyTerminalMouseWheel(wheelEvent(), terminalElement(false))).toBe(false)
  })

  it('leaves trackpad-like pixel scrolling one-to-one', () => {
    expect(
      shouldMultiplyTerminalMouseWheel(
        wheelEvent({
          deltaY: 12,
          deltaMode: DOM_DELTA_PIXEL
        }),
        terminalElement()
      )
    ).toBe(false)
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
        element: target
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
})
