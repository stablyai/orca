import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDivider, createDividerFlexFrameScheduler, disposeDivider } from './pane-divider'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createDividerFlexFrameScheduler', () => {
  it('coalesces repeated drag updates into one flex write per animation frame', () => {
    const apply = vi.fn()
    const queuedFrames: FrameRequestCallback[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback)
      return queuedFrames.length
    })
    const cancelFrame = vi.fn()
    const scheduler = createDividerFlexFrameScheduler({ apply, requestFrame, cancelFrame })

    scheduler.schedule(120, 280)
    scheduler.schedule(140, 260)
    scheduler.schedule(160, 240)

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()

    queuedFrames[0]?.(16)

    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenLastCalledWith(160, 240)
    expect(cancelFrame).not.toHaveBeenCalled()
  })

  it('flushes the latest drag update before final pane refit', () => {
    const apply = vi.fn()
    const requestFrame = vi.fn(() => 7)
    const cancelFrame = vi.fn()
    const scheduler = createDividerFlexFrameScheduler({ apply, requestFrame, cancelFrame })

    scheduler.schedule(120, 280)
    scheduler.schedule(180, 220)
    scheduler.flush()

    expect(cancelFrame).toHaveBeenCalledWith(7)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(180, 220)
  })
})

describe('disposeDivider', () => {
  it('removes divider-local drag listeners and releases active pointer capture', () => {
    const listeners = new Map<string, EventListener>()
    const divider = {
      style: {
        setProperty: vi.fn()
      },
      classList: {
        add: vi.fn(),
        remove: vi.fn()
      },
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        listeners.set(event, listener)
      }),
      removeEventListener: vi.fn((event: string, listener: EventListener) => {
        if (listeners.get(event) === listener) {
          listeners.delete(event)
        }
      }),
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      previousElementSibling: null,
      nextElementSibling: null
    } as unknown as HTMLElement
    vi.stubGlobal('document', {
      createElement: vi.fn(() => divider)
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const created = createDivider(true, {}, { refitPanesUnder: vi.fn() })
    const pointerDown = listeners.get('pointerdown')
    expect(pointerDown).toBeTypeOf('function')

    pointerDown?.({
      preventDefault: vi.fn(),
      pointerId: 7,
      clientX: 10
    } as unknown as PointerEvent)
    disposeDivider(created)

    expect(divider.removeEventListener).toHaveBeenCalledWith('pointerdown', pointerDown)
    expect(divider.removeEventListener).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(divider.removeEventListener).toHaveBeenCalledWith('pointerup', expect.any(Function))
    expect(divider.removeEventListener).toHaveBeenCalledWith('dblclick', expect.any(Function))
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7)
    expect(divider.classList.remove).toHaveBeenCalledWith('is-dragging')
  })
})
