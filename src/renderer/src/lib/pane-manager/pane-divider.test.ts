import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDivider, createDividerFlexFrameScheduler, disposeDivider } from './pane-divider'
import { queuePanePtyResizeIfHeld } from './pane-pty-resize-hold'

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
  it('does not start divider drag state without resizeable pane siblings', () => {
    const dividerListeners = new Map<string, EventListener>()
    const onDragActiveChange = vi.fn()
    const preventDefault = vi.fn()
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
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
      previousElementSibling: null,
      nextElementSibling: null
    } as unknown as HTMLElement
    vi.stubGlobal('document', {
      createElement: vi.fn(() => divider)
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    createDivider(true, {}, { refitPanesUnder: vi.fn(), onDragActiveChange })
    dividerListeners.get('pointerdown')?.(
      createPointerEvent({ pointerId: 7, clientX: 10, preventDefault })
    )

    expect(preventDefault).toHaveBeenCalled()
    expect(divider.setPointerCapture).not.toHaveBeenCalled()
    expect(divider.classList.add).not.toHaveBeenCalled()
    expect(onDragActiveChange).not.toHaveBeenCalled()
    expect(window.addEventListener).not.toHaveBeenCalled()
  })

  it('does not start divider drag state when sibling panes have no measurable size', () => {
    const dividerListeners = new Map<string, EventListener>()
    const onDragActiveChange = vi.fn()
    const previousPane = createSizedPaneElement({ width: 0, height: 200 })
    const nextPane = createSizedPaneElement({ width: 0, height: 200 })
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
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
      previousElementSibling: previousPane,
      nextElementSibling: nextPane
    } as unknown as HTMLElement
    vi.stubGlobal('document', {
      createElement: vi.fn(() => divider)
    })
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    createDivider(true, {}, { refitPanesUnder: vi.fn(), onDragActiveChange })
    dividerListeners.get('pointerdown')?.(createPointerEvent({ pointerId: 7, clientX: 10 }))

    expect(divider.setPointerCapture).not.toHaveBeenCalled()
    expect(divider.classList.add).not.toHaveBeenCalled()
    expect(onDragActiveChange).not.toHaveBeenCalled()
    expect(window.addEventListener).not.toHaveBeenCalled()
    expect(previousPane.style.flex).toBeUndefined()
    expect(nextPane.style.flex).toBeUndefined()
  })

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

    createDivider(true, {}, { refitPanesUnder, onLayoutChanged })
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
    expect(onLayoutChanged).toHaveBeenCalledTimes(1)
    expect(divider.classList.remove).toHaveBeenCalledWith('is-dragging')
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(9)
    expect(windowListeners.has('pointermove')).toBe(false)
    expect(windowListeners.has('pointerup')).toBe(false)
  })

  it('continues a resize when motion arrives from a different primary pointer (WSLg pen relay)', () => {
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

    createDivider(true, {}, { refitPanesUnder, onLayoutChanged })
    // WSLg's RDP relay presses/releases as `mouse` but streams motion as a
    // `pen` pointer with a different pointerId; both are the primary pointer.
    dividerListeners.get('pointerdown')?.(
      createPointerEvent({ pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 100 })
    )
    windowListeners.get('pointermove')?.(
      createPointerEvent({ pointerId: 19, pointerType: 'pen', isPrimary: true, clientX: 180 })
    )
    windowListeners.get('pointerup')?.(
      createPointerEvent({ pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 180 })
    )

    expect(previousPane.style.flex).toBe('180 1 0%')
    expect(nextPane.style.flex).toBe('220 1 0%')
    expect(onLayoutChanged).toHaveBeenCalledTimes(1)
    expect(divider.classList.remove).toHaveBeenCalledWith('is-dragging')
    expect(windowListeners.has('pointermove')).toBe(false)
  })

  it('keeps flex bases nonnegative when panes are smaller than combined minimums', () => {
    const dividerListeners = new Map<string, EventListener>()
    const windowListeners = new Map<string, EventListener>()
    const capturedPointerIds = new Set<number>()
    const previousPane = createSizedPaneElement({ width: 30, height: 200 })
    const nextPane = createSizedPaneElement({ width: 40, height: 200 })
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
      createPointerEvent({ pointerId: 9, clientX: 0, clientY: 0 })
    )
    windowListeners.get('pointermove')?.(
      createPointerEvent({ pointerId: 9, clientX: 200, clientY: 0 })
    )
    windowListeners.get('pointerup')?.(createPointerEvent({ pointerId: 9, clientX: 200 }))

    expect(previousPane.style.flex).toBe('35 1 0%')
    expect(nextPane.style.flex).toBe('35 1 0%')
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

    createDivider(true, {}, { refitPanesUnder, onLayoutChanged })
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

  it('removes divider-local drag listeners and releases active pointer capture', () => {
    const listeners = new Map<string, EventListener>()
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
      previousElementSibling: previousPane,
      nextElementSibling: nextPane
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
