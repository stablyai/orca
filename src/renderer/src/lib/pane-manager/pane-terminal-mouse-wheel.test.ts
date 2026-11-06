import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalMouseWheelMultiplier } from './pane-terminal-mouse-wheel'

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

describe('terminal mouse wheel multiplier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('discards pending replay when mouse reporting turns off before drain', async () => {
    vi.stubGlobal('WheelEvent', TestWheelEvent)
    const handlers: ((event: WheelEvent) => boolean)[] = []
    const target = Object.assign(new EventTarget(), {
      classList: {
        contains: (className: string) => className === 'enable-mouse-events'
      }
    }) as unknown as EventTarget & HTMLElement
    const dispatched: WheelEvent[] = []
    target.addEventListener('wheel', (event) => dispatched.push(event as WheelEvent))
    const terminal = {
      attachCustomWheelEventHandler: (handler: (event: WheelEvent) => boolean) => {
        handlers.push(handler)
      },
      element: target,
      modes: { mouseTrackingMode: 'any' as 'any' | 'none' },
      rows: 24
    }
    attachTerminalMouseWheelMultiplier(terminal)

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

    expect(handlers[0]?.(event)).toBe(false)
    terminal.modes.mouseTrackingMode = 'none'
    await Promise.resolve()

    expect(dispatched).toHaveLength(0)
  })
})
