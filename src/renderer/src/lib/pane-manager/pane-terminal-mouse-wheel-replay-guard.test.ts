// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalMouseWheelMultiplier } from './pane-terminal-mouse-wheel'

// #20983: replayed TUI wheel reports must never carry coordinates xterm would
// encode as NaN into the PTY.

function attachReplay(): {
  element: HTMLElement
  handler: (event: WheelEvent) => boolean
  dispatched: WheelEvent[]
} {
  const element = document.createElement('div')
  element.className = 'enable-mouse-events'
  document.body.appendChild(element)
  const dispatched: WheelEvent[] = []
  element.addEventListener('wheel', (event) => dispatched.push(event))
  let handler: ((event: WheelEvent) => boolean) | null = null
  attachTerminalMouseWheelMultiplier({
    attachCustomWheelEventHandler: (next) => {
      handler = next
    },
    element,
    modes: { mouseTrackingMode: 'any' },
    rows: 24
  })
  if (!handler) {
    throw new Error('wheel handler was not attached')
  }
  return { element, handler, dispatched }
}

function lineTick(clientX = 10): WheelEvent {
  const event = new WheelEvent('wheel', { deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: 1 })
  Object.defineProperty(event, 'clientX', { value: clientX })
  Object.defineProperty(event, 'clientY', { value: 10 })
  return event
}

function pixelTick(deltaY: number): WheelEvent {
  const event = lineTick()
  Object.defineProperty(event, 'deltaMode', { value: WheelEvent.DOM_DELTA_PIXEL })
  Object.defineProperty(event, 'deltaY', { value: deltaY })
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('TUI wheel replay guard', () => {
  it('drops replayed reports whose pointer coordinates are not finite', async () => {
    const { handler, dispatched } = attachReplay()

    expect(handler(lineTick(Number.NaN))).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(0)

    expect(handler(lineTick())).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(1)
  })

  it('drops replayed reports once the terminal element is detached', async () => {
    const { element, handler, dispatched } = attachReplay()

    expect(handler(lineTick())).toBe(false)
    element.remove()
    await Promise.resolve()
    expect(dispatched).toHaveLength(0)

    document.body.appendChild(element)
    expect(handler(lineTick())).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(1)
  })

  it('queues no reports for a wheel delta that is not finite', async () => {
    const { element, handler, dispatched } = attachReplay()
    const dispatchEvent = element.dispatchEvent.bind(element)
    // Why: bound the drain loop so a regression fails instead of hanging.
    vi.spyOn(element, 'dispatchEvent').mockImplementation((event) => {
      if (dispatched.length >= 100) {
        throw new Error('unbounded wheel report replay')
      }
      return dispatchEvent(event)
    })

    for (const deltaY of [Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(handler(pixelTick(deltaY))).toBe(false)
      await Promise.resolve()
      expect(dispatched).toHaveLength(0)
    }

    // The carried trackpad remainder must stay finite: 32px at 16px rows is 2 reports.
    expect(handler(pixelTick(32))).toBe(false)
    await Promise.resolve()
    expect(dispatched).toHaveLength(2)
  })
})
