import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDivider } from './pane-divider'
import { queuePanePtyResizeIfHeld } from './pane-pty-resize-hold'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('disposeDivider', () => {
  it('finishes an active resize from a window-level pointerup', () => {
    const dividerListeners = new Map<string, EventListener>()
    const windowListeners = new Map<string, EventListener>()
    const capturedPointerIds = new Set<number>()
    const previousPane = createSizedPaneElement({ width: 100, height: 200 })
    const nextPane = createSizedPaneElement({ width: 300, height: 200 })
    const divider = {
      style: {
        setProperty: vi.fn()
      },
      classList: {
        add: vi.fn(),
        remove: vi.fn()
      },
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        dividerListeners.set(event, listener)
      }),
      removeEventListener: vi.fn((event: string, listener: EventListener) => {
        if (dividerListeners.get(event) === listener) {
          dividerListeners.delete(event)
        }
      }),
      setPointerCapture: vi.fn((pointerId: number) => {
        capturedPointerIds.add(pointerId)
      }),
      hasPointerCapture: vi.fn((pointerId: number) => capturedPointerIds.has(pointerId)),
      releasePointerCapture: vi.fn((pointerId: number) => {
        capturedPointerIds.delete(pointerId)
      }),
      previousElementSibling: previousPane,
      nextElementSibling: nextPane
    } as unknown as HTMLElement
    const refitPanesUnder = vi.fn()
    const onLayoutChanged = vi.fn()
    const onDividerRatiosCommitted = vi.fn(() => expect(onLayoutChanged).toHaveBeenCalled())
    vi.stubGlobal('document', {
      createElement: vi.fn(() => divider)
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        windowListeners.set(event, listener)
      }),
      removeEventListener: vi.fn((event: string, listener: EventListener) => {
        if (windowListeners.get(event) === listener) {
          windowListeners.delete(event)
        }
      })
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 7)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    createDivider(true, {}, { refitPanesUnder, onLayoutChanged, onDividerRatiosCommitted })
    dividerListeners.get('pointerdown')?.(
      createPointerEvent({ pointerId: 9, clientX: 100, clientY: 0 })
    )
    windowListeners.get('pointermove')?.(
      createPointerEvent({ pointerId: 9, clientX: 180, clientY: 0 })
    )

    const windowPointerUp = windowListeners.get('pointerup')
    expect(windowPointerUp).toBeTypeOf('function')
    windowPointerUp?.(createPointerEvent({ pointerId: 9, clientX: 180, clientY: 0 }))

    expect(previousPane.style.flex).toBe('180 1 0%')
    expect(nextPane.style.flex).toBe('220 1 0%')
    expect(refitPanesUnder).toHaveBeenCalledWith(previousPane)
    expect(refitPanesUnder).toHaveBeenCalledWith(nextPane)
    expect(onLayoutChanged).toHaveBeenCalledOnce()
    expect(onDividerRatiosCommitted).toHaveBeenCalledOnce()
    expect(divider.classList.remove).toHaveBeenCalledWith('is-dragging')
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(windowListeners.has('pointermove')).toBe(false)
    expect(windowListeners.has('pointerup')).toBe(false)
  })

  it('restores original flex styles when an active resize is cancelled', () => {
    const dividerListeners = new Map<string, EventListener>()
    const windowListeners = new Map<string, EventListener>()
    const capturedPointerIds = new Set<number>()
    const queuedFrames: FrameRequestCallback[] = []
    const previousPane = createSizedPaneElement({ width: 100, height: 200 })
    const nextPane = createSizedPaneElement({ width: 300, height: 200 })
    previousPane.style.flex = '2 1 0%'
    nextPane.style.flex = '3 1 0%'
    const divider = {
      style: {
        setProperty: vi.fn()
      },
      classList: {
        add: vi.fn(),
        remove: vi.fn()
      },
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        dividerListeners.set(event, listener)
      }),
      removeEventListener: vi.fn(),
      setPointerCapture: vi.fn((pointerId: number) => {
        capturedPointerIds.add(pointerId)
      }),
      hasPointerCapture: vi.fn((pointerId: number) => capturedPointerIds.has(pointerId)),
      releasePointerCapture: vi.fn((pointerId: number) => {
        capturedPointerIds.delete(pointerId)
      }),
      previousElementSibling: previousPane,
      nextElementSibling: nextPane
    } as unknown as HTMLElement
    const refitPanesUnder = vi.fn()
    const onLayoutChanged = vi.fn()
    const onDividerRatiosCommitted = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn(() => divider)
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        windowListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        queuedFrames.push(callback)
        return queuedFrames.length
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    createDivider(true, {}, { refitPanesUnder, onLayoutChanged, onDividerRatiosCommitted })
    dividerListeners.get('pointerdown')?.(
      createPointerEvent({ pointerId: 9, clientX: 100, clientY: 0 })
    )
    windowListeners.get('pointermove')?.(
      createPointerEvent({ pointerId: 9, clientX: 180, clientY: 0 })
    )
    queuedFrames[0]?.(16)

    expect(previousPane.style.flex).toBe('180 1 0%')
    expect(nextPane.style.flex).toBe('220 1 0%')

    windowListeners.get('pointercancel')?.(createPointerEvent({ pointerId: 9 }))

    expect(previousPane.style.flex).toBe('2 1 0%')
    expect(nextPane.style.flex).toBe('3 1 0%')
    expect(refitPanesUnder).toHaveBeenCalledWith(previousPane)
    expect(refitPanesUnder).toHaveBeenCalledWith(nextPane)
    expect(onLayoutChanged).not.toHaveBeenCalled()
    expect(onDividerRatiosCommitted).not.toHaveBeenCalled()
  })

  it('drops held PTY resize updates when an active resize is cancelled', () => {
    const dividerListeners = new Map<string, EventListener>()
    const windowListeners = new Map<string, EventListener>()
    const capturedPointerIds = new Set<number>()
    const previousPane = createSizedPaneElement(
      { width: 100, height: 200 },
      { classNames: ['pane'] }
    )
    const nextPane = createSizedPaneElement({ width: 300, height: 200 }, { classNames: ['pane'] })
    const divider = {
      style: {
        setProperty: vi.fn()
      },
      classList: {
        add: vi.fn(),
        remove: vi.fn()
      },
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        dividerListeners.set(event, listener)
      }),
      removeEventListener: vi.fn(),
      setPointerCapture: vi.fn((pointerId: number) => {
        capturedPointerIds.add(pointerId)
      }),
      hasPointerCapture: vi.fn((pointerId: number) => capturedPointerIds.has(pointerId)),
      releasePointerCapture: vi.fn((pointerId: number) => {
        capturedPointerIds.delete(pointerId)
      }),
      previousElementSibling: previousPane,
      nextElementSibling: nextPane
    } as unknown as HTMLElement
    vi.stubGlobal('document', {
      createElement: vi.fn(() => divider)
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        windowListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 7)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    createDivider(true, {}, { refitPanesUnder: vi.fn(), onLayoutChanged: vi.fn() })
    dividerListeners.get('pointerdown')?.(
      createPointerEvent({ pointerId: 9, clientX: 100, clientY: 0 })
    )

    expect(queuePanePtyResizeIfHeld(previousPane, 140, 30)).toBe(true)
    expect(queuePanePtyResizeIfHeld(nextPane, 80, 30)).toBe(true)

    windowListeners.get('pointermove')?.(
      createPointerEvent({ pointerId: 9, clientX: 180, clientY: 0 })
    )
    windowListeners.get('pointercancel')?.(createPointerEvent({ pointerId: 9 }))

    expect(previousPane.dispatchEvent).not.toHaveBeenCalled()
    expect(nextPane.dispatchEvent).not.toHaveBeenCalled()
    expect(queuePanePtyResizeIfHeld(previousPane, 140, 30)).toBe(false)
    expect(queuePanePtyResizeIfHeld(nextPane, 80, 30)).toBe(false)
  })
})

function createPointerEvent(args: Partial<PointerEvent>): PointerEvent {
  return {
    preventDefault: vi.fn(),
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    ...args
  } as unknown as PointerEvent
}

function createSizedPaneElement(
  rect: {
    width: number
    height: number
  },
  options?: {
    classNames?: string[]
  }
): HTMLElement & {
  dispatchEvent: ReturnType<typeof vi.fn>
  style: Record<string, string>
} {
  const classNames = new Set(options?.classNames ?? [])
  return {
    style: {},
    classList: {
      contains: vi.fn((className: string) => classNames.has(className))
    },
    dispatchEvent: vi.fn(() => true),
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      right: rect.width,
      bottom: rect.height,
      width: rect.width,
      height: rect.height
    })),
    querySelectorAll: vi.fn(() => [])
  } as unknown as HTMLElement & {
    dispatchEvent: ReturnType<typeof vi.fn>
    style: Record<string, string>
  }
}
