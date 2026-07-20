import { describe, expect, it, vi } from 'vitest'
import { beginImageViewerPan } from './image-viewer-dom-pan'

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListener>>()

  addEventListener(type: string, listener: EventListener): void {
    let listeners = this.listeners.get(type)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(type, listeners)
    }
    listeners.add(listener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string, event: Event = {} as Event): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      listener(event)
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

class FakeSurface extends FakeEventTarget {
  readonly capturedPointerIds = new Set<number>()
  scrollLeft = 120
  scrollTop = 80

  setPointerCapture(pointerId: number): void {
    this.capturedPointerIds.add(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointerIds.has(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointerIds.delete(pointerId)
  }
}

function pointerEvent(pointerId: number, clientX = 0, clientY = 0): PointerEvent {
  return {
    pointerId,
    clientX,
    clientY,
    preventDefault: vi.fn()
  } as unknown as PointerEvent
}

function createGesture() {
  const surface = new FakeSurface()
  const ownerWindow = new FakeEventTarget()
  const onDraggingChange = vi.fn()
  const onEnd = vi.fn()
  const cleanup = beginImageViewerPan({
    surface: surface as unknown as HTMLDivElement,
    pointerId: 7,
    trigger: 'space-left',
    startPointer: { x: 50, y: 50 },
    onDraggingChange,
    onEnd,
    ownerWindow: ownerWindow as unknown as Window
  })

  return { cleanup, onDraggingChange, onEnd, ownerWindow, surface }
}

describe('image viewer DOM pan', () => {
  it('captures the pointer and pans only after the threshold is crossed', () => {
    const { onDraggingChange, onEnd, ownerWindow, surface } = createGesture()

    expect(surface.capturedPointerIds.has(7)).toBe(true)
    expect(onDraggingChange).toHaveBeenCalledTimes(1)
    expect(onDraggingChange).toHaveBeenCalledWith(true)

    ownerWindow.dispatch('pointermove', pointerEvent(7, 52, 52))
    expect({ left: surface.scrollLeft, top: surface.scrollTop }).toEqual({ left: 120, top: 80 })

    const move = pointerEvent(7, 70, 30)
    ownerWindow.dispatch('pointermove', move)
    expect({ left: surface.scrollLeft, top: surface.scrollTop }).toEqual({ left: 100, top: 100 })
    expect(move.preventDefault).toHaveBeenCalledTimes(1)

    ownerWindow.dispatch('pointerup', pointerEvent(8))
    expect(onEnd).not.toHaveBeenCalled()
    ownerWindow.dispatch('pointerup', pointerEvent(7))

    expect(surface.capturedPointerIds.has(7)).toBe(false)
    expect(onDraggingChange).toHaveBeenCalledTimes(2)
    expect(onDraggingChange).toHaveBeenLastCalledWith(false)
    expect(onEnd).toHaveBeenCalledWith({
      didDrag: true,
      reason: 'pointerup',
      trigger: 'space-left'
    })
    expect(ownerWindow.listenerCount('pointermove')).toBe(0)
  })

  it.each([
    ['pointercancel', 'pointercancel'],
    ['blur', 'blur'],
    ['lostpointercapture', 'lostpointercapture']
  ] as const)('cleans up on %s', (eventType, reason) => {
    const { onEnd, ownerWindow, surface } = createGesture()

    if (eventType === 'lostpointercapture') {
      surface.dispatch(eventType, pointerEvent(7))
    } else if (eventType === 'blur') {
      ownerWindow.dispatch(eventType)
    } else {
      ownerWindow.dispatch(eventType, pointerEvent(7))
    }

    expect(surface.capturedPointerIds.has(7)).toBe(false)
    expect(onEnd).toHaveBeenCalledWith({ didDrag: false, reason, trigger: 'space-left' })
    expect(ownerWindow.listenerCount('pointermove')).toBe(0)
    expect(surface.listenerCount('lostpointercapture')).toBe(0)
  })

  it('supports idempotent manual cleanup', () => {
    const { cleanup, onEnd, surface } = createGesture()

    cleanup()
    cleanup()

    expect(surface.capturedPointerIds.has(7)).toBe(false)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledWith({
      didDrag: false,
      reason: 'manual',
      trigger: 'space-left'
    })
  })
})
