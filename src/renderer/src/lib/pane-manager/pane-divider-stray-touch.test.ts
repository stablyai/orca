import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDivider } from './pane-divider'

type PaneElement = HTMLElement & { style: Record<string, string> }

type DividerDragHarness = {
  divider: HTMLElement
  dividerListeners: Map<string, EventListener>
  windowListeners: Map<string, EventListener>
  previousPane: PaneElement
  nextPane: PaneElement
  onLayoutChanged: ReturnType<typeof vi.fn>
  flushAnimationFrames: () => void
}

function createPaneElement(width: number): PaneElement {
  return {
    style: {},
    classList: { contains: vi.fn(() => false) },
    dispatchEvent: vi.fn(() => true),
    getBoundingClientRect: vi.fn(() => ({
      left: 0,
      top: 0,
      right: width,
      bottom: 200,
      width,
      height: 200
    })),
    querySelectorAll: vi.fn(() => [])
  } as unknown as PaneElement
}

function createPointerEvent(args: Partial<PointerEvent>): PointerEvent {
  return {
    preventDefault: vi.fn(),
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    ...args
  } as unknown as PointerEvent
}

function createDividerDragHarness(): DividerDragHarness {
  const dividerListeners = new Map<string, EventListener>()
  const windowListeners = new Map<string, EventListener>()
  const capturedPointerIds = new Set<number>()
  const animationFrames = new Map<number, FrameRequestCallback>()
  const previousPane = createPaneElement(100)
  const nextPane = createPaneElement(300)
  const divider = {
    style: { setProperty: vi.fn() },
    classList: { add: vi.fn(), remove: vi.fn() },
    addEventListener: vi.fn((event: string, listener: EventListener) => {
      dividerListeners.set(event, listener)
    }),
    removeEventListener: vi.fn((event: string, listener: EventListener) => {
      if (dividerListeners.get(event) === listener) {
        dividerListeners.delete(event)
      }
    }),
    setPointerCapture: vi.fn((pointerId: number) => capturedPointerIds.add(pointerId)),
    hasPointerCapture: vi.fn((pointerId: number) => capturedPointerIds.has(pointerId)),
    releasePointerCapture: vi.fn((pointerId: number) => capturedPointerIds.delete(pointerId)),
    previousElementSibling: previousPane,
    nextElementSibling: nextPane
  } as unknown as HTMLElement
  vi.stubGlobal('document', { createElement: vi.fn(() => divider) })
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
  let nextFrameId = 0
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      nextFrameId += 1
      animationFrames.set(nextFrameId, callback)
      return nextFrameId
    })
  )
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((frameId: number) => animationFrames.delete(frameId))
  )
  const onLayoutChanged = vi.fn()
  createDivider(true, {}, { refitPanesUnder: vi.fn(), onLayoutChanged })

  return {
    divider,
    dividerListeners,
    windowListeners,
    previousPane,
    nextPane,
    onLayoutChanged,
    flushAnimationFrames: () => {
      for (const [frameId, callback] of animationFrames) {
        animationFrames.delete(frameId)
        callback(16)
      }
    }
  }
}

// Each pointer type has its own primary pointer, so a finger on a touchscreen
// arrives with isPrimary true while a mouse drag is already in flight.
const STRAY_TOUCH = { pointerId: 42, pointerType: 'touch', isPrimary: true } as const

function startMouseDrag(harness: DividerDragHarness): void {
  harness.dividerListeners.get('pointerdown')?.(
    createPointerEvent({ pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: 100 })
  )
  harness.windowListeners.get('pointermove')?.(
    createPointerEvent({ pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: 180 })
  )
  harness.flushAnimationFrames()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('divider drag pointer-type isolation', () => {
  it('ignores stray touch motion during an active mouse drag', () => {
    const harness = createDividerDragHarness()
    startMouseDrag(harness)
    expect(harness.previousPane.style.flex).toBe('180 1 0%')

    harness.windowListeners.get('pointermove')?.(
      createPointerEvent({ ...STRAY_TOUCH, clientX: 320 })
    )
    harness.flushAnimationFrames()

    expect(harness.previousPane.style.flex).toBe('180 1 0%')
    expect(harness.nextPane.style.flex).toBe('220 1 0%')
  })

  it('does not commit the layout when a stray touch lifts mid mouse drag', () => {
    const harness = createDividerDragHarness()
    startMouseDrag(harness)

    harness.windowListeners.get('pointerup')?.(createPointerEvent({ ...STRAY_TOUCH, clientX: 320 }))

    expect(harness.onLayoutChanged).not.toHaveBeenCalled()
    expect(harness.divider.classList.remove).not.toHaveBeenCalledWith('is-dragging')
    expect(harness.windowListeners.has('pointermove')).toBe(true)

    harness.windowListeners.get('pointerup')?.(
      createPointerEvent({ pointerId: 9, pointerType: 'mouse', isPrimary: true, clientX: 180 })
    )

    expect(harness.previousPane.style.flex).toBe('180 1 0%')
    expect(harness.onLayoutChanged).toHaveBeenCalledTimes(1)
  })

  it('does not revert the layout when a stray touch is cancelled mid mouse drag', () => {
    const harness = createDividerDragHarness()
    harness.previousPane.style.flex = '2 1 0%'
    harness.nextPane.style.flex = '3 1 0%'
    startMouseDrag(harness)

    harness.windowListeners.get('pointercancel')?.(
      createPointerEvent({ ...STRAY_TOUCH, clientX: 320 })
    )

    expect(harness.previousPane.style.flex).toBe('180 1 0%')
    expect(harness.windowListeners.has('pointermove')).toBe(true)
  })

  it('still continues a mouse drag from a primary pen pointer (WSLg relay)', () => {
    const harness = createDividerDragHarness()
    harness.dividerListeners.get('pointerdown')?.(
      createPointerEvent({ pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 100 })
    )
    harness.windowListeners.get('pointermove')?.(
      createPointerEvent({ pointerId: 19, pointerType: 'pen', isPrimary: true, clientX: 180 })
    )
    harness.windowListeners.get('pointerup')?.(
      createPointerEvent({ pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: 180 })
    )

    expect(harness.previousPane.style.flex).toBe('180 1 0%')
    expect(harness.nextPane.style.flex).toBe('220 1 0%')
    expect(harness.onLayoutChanged).toHaveBeenCalledTimes(1)
  })

  it('drives a touch-started drag from its own pointerId', () => {
    const harness = createDividerDragHarness()
    const touchDrag = { pointerId: 7, pointerType: 'touch', isPrimary: true } as const
    harness.dividerListeners.get('pointerdown')?.(
      createPointerEvent({ ...touchDrag, clientX: 100 })
    )
    harness.windowListeners.get('pointermove')?.(createPointerEvent({ ...touchDrag, clientX: 180 }))
    harness.flushAnimationFrames()
    harness.windowListeners.get('pointerup')?.(createPointerEvent({ ...touchDrag, clientX: 180 }))

    expect(harness.previousPane.style.flex).toBe('180 1 0%')
    expect(harness.nextPane.style.flex).toBe('220 1 0%')
    expect(harness.onLayoutChanged).toHaveBeenCalledTimes(1)
  })
})
