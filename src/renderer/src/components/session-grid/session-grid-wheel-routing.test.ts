// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionGridWheelTarget } from '../../../../shared/session-grid-types'
import { installSessionGridWheelRouting } from './session-grid-wheel-routing'

const cleanups: (() => void)[] = []
function setup(initial: SessionGridWheelTarget = 'focus') {
  const container = document.createElement('div')
  const control = document.createElement('button')
  container.append(control)
  document.body.append(container)
  function terminal() {
    const element = document.createElement('div')
    element.className = 'xterm'
    const input = document.createElement('textarea')
    input.className = 'xterm-helper-textarea'
    element.append(input)
    container.append(element)
    const delivered = vi.fn()
    element.addEventListener('wheel', (event) => delivered(event.defaultPrevented, event))
    return { element, input, delivered }
  }
  const a = terminal()
  const b = terminal()
  let mode = initial
  const grid = vi.fn()
  const reset = vi.fn()
  cleanups.push(
    installSessionGridWheelRouting({
      container,
      getWheelTarget: () => mode,
      onGridWheel: grid,
      onGestureReset: reset
    })
  )
  return {
    container,
    control,
    a,
    b,
    grid,
    reset,
    mode: (value: SessionGridWheelTarget) => {
      mode = value
    }
  }
}

function wheel(target: Element, init: Partial<WheelEvent> = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 })
  Object.defineProperties(
    event,
    Object.fromEntries(
      Object.entries({ shiftKey: false, clientX: 20, clientY: 20, ...init }).map(([key, value]) => [
        key,
        { value }
      ])
    )
  )
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('grid wheel ownership', () => {
  for (const mode of ['focus', 'terminal', 'grid'] as const) {
    for (const focused of [false, true]) {
      for (const shiftKey of [false, true]) {
        it(`${mode}, focused=${focused}, Shift=${shiftKey}`, () => {
          const view = setup(mode)
          if (focused) {
            view.a.input.focus()
          } else {
            view.b.input.focus()
          }
          const active = document.activeElement
          const goesToTerminal = (mode === 'terminal' || (mode === 'focus' && focused)) !== shiftKey
          const event = wheel(view.a.element, { shiftKey })
          expect(view.grid).toHaveBeenCalledTimes(goesToTerminal ? 0 : 1)
          expect(view.a.delivered).toHaveBeenCalledTimes(goesToTerminal ? 1 : 0)
          expect(view.b.delivered).not.toHaveBeenCalled()
          expect(document.activeElement).toBe(active)
          expect(event.defaultPrevented).toBe(true)
          if (goesToTerminal) {
            const [cancelledBeforeXterm, delivered] = view.a.delivered.mock.calls[0]!
            expect(cancelledBeforeXterm).toBe(false)
            expect(delivered.shiftKey).toBeFalsy()
          }
        })
      }
    }
    it(`${mode}: gaps always scroll grid with or without Shift`, () => {
      const view = setup(mode)
      view.a.input.focus()
      wheel(view.container)
      wheel(view.container, { shiftKey: true })
      expect(view.grid).toHaveBeenCalledTimes(2)
      expect(view.a.delivered).not.toHaveBeenCalled()
    })
  }

  it('follows real focus immediately, including blur to a header control', () => {
    const view = setup()
    wheel(view.a.element)
    view.a.input.focus()
    wheel(view.a.element)
    view.control.focus()
    wheel(view.a.element)
    view.b.input.focus()
    wheel(view.a.element)
    wheel(view.b.element, { clientX: 40 })
    expect(view.grid).toHaveBeenCalledTimes(3)
    expect(view.a.delivered).toHaveBeenCalledOnce()
    expect(view.b.delivered).toHaveBeenCalledOnce()
  })

  it('window blur releases Focus even if activeElement remains the terminal', () => {
    const view = setup()
    view.a.input.focus()
    wheel(view.a.element)
    vi.mocked(document.hasFocus).mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    wheel(view.a.element)
    expect(view.grid).toHaveBeenCalledOnce()
    expect(view.a.delivered).toHaveBeenCalledOnce()
  })

  it('keeps the grid gesture when content slides under a stationary pointer', () => {
    const view = setup('terminal')
    wheel(view.container)
    vi.advanceTimersByTime(16)
    wheel(view.a.element)
    expect(view.grid).toHaveBeenCalledTimes(2)
    expect(view.a.delivered).not.toHaveBeenCalled()
    vi.advanceTimersByTime(151)
    wheel(view.a.element)
    expect(view.a.delivered).toHaveBeenCalledOnce()
  })

  it('physical pointer movement to another zone overrides the gesture', () => {
    const view = setup('terminal')
    wheel(view.container)
    wheel(view.a.element, { clientX: 30 })
    wheel(view.b.element, { clientX: 40 })
    expect(view.grid).toHaveBeenCalledOnce()
    expect(view.a.delivered).toHaveBeenCalledOnce()
    expect(view.b.delivered).toHaveBeenCalledOnce()
  })

  it('each discrete notch reevaluates the surface', () => {
    const view = setup('terminal')
    wheel(view.container, { deltaMode: 1 })
    wheel(view.a.element, { deltaMode: 1 })
    expect(view.grid).toHaveBeenCalledOnce()
    expect(view.a.delivered).toHaveBeenCalledOnce()
  })

  it('mode and Shift override a latched destination immediately', () => {
    const view = setup('grid')
    wheel(view.a.element)
    view.mode('terminal')
    wheel(view.a.element)
    wheel(view.a.element, { shiftKey: true })
    view.mode('focus')
    wheel(view.a.element, { shiftKey: true })
    expect(view.grid).toHaveBeenCalledTimes(2)
    expect(view.a.delivered).toHaveBeenCalledTimes(2)
  })

  it('drops remaining movement when the owning terminal disappears', () => {
    const view = setup('terminal')
    wheel(view.a.element)
    view.a.element.remove()
    wheel(view.b.element)
    expect(view.b.delivered).not.toHaveBeenCalled()
    expect(view.grid).not.toHaveBeenCalled()
    vi.advanceTimersByTime(151)
    wheel(view.b.element)
    expect(view.b.delivered).toHaveBeenCalledOnce()
  })

  it('preserves Shift replay distance, units, legacy axes and timing', () => {
    const view = setup('grid')
    wheel(view.a.element, {
      shiftKey: true,
      deltaY: 0,
      deltaX: -12,
      deltaMode: 1,
      timeStamp: 1234,
      wheelDeltaX: 120,
      wheelDeltaY: 0
    } as Partial<WheelEvent>)
    const delivered = view.a.delivered.mock.calls[0]![1] as WheelEvent & {
      wheelDeltaY: number
      wheelDeltaX: number
    }
    expect(delivered.deltaY).toBe(-12)
    expect(delivered.deltaX).toBe(0)
    expect(delivered.deltaMode).toBe(1)
    expect(delivered.timeStamp).toBe(1234)
    expect(delivered.wheelDeltaY).toBe(120)
    expect(delivered.wheelDeltaX).toBe(0)
  })

  it('removes all routing on disposal', () => {
    const view = setup('grid')
    cleanups.splice(0).forEach((dispose) => dispose())
    const event = wheel(view.a.element)
    expect(view.grid).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
