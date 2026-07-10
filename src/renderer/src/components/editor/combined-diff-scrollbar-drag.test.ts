import { describe, expect, it, vi } from 'vitest'
import { beginCombinedDiffScrollbarDrag } from './combined-diff-scrollbar-drag'

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

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  dispatch(type: string, event: Event = {} as Event): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      listener(event)
    }
  }
}

class FakeTrack extends FakeEventTarget {
  private readonly capturedPointerIds = new Set<number>()

  setPointerCapture(pointerId: number): void {
    this.capturedPointerIds.add(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointerIds.delete(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointerIds.has(pointerId)
  }
}

describe('combined diff scrollbar drag', () => {
  it('removes active window listeners when cleanup runs before pointerup', () => {
    const ownerWindow = new FakeEventTarget()
    const track = new FakeTrack()
    const onPointerMove = vi.fn()
    const onEnd = vi.fn()

    const cleanup = beginCombinedDiffScrollbarDrag({
      track: track as unknown as HTMLElement,
      pointerId: 7,
      onPointerMove,
      onEnd,
      ownerWindow: ownerWindow as unknown as Window
    })

    expect(ownerWindow.listenerCount('pointermove')).toBe(1)
    expect(ownerWindow.listenerCount('pointerup')).toBe(1)
    expect(ownerWindow.listenerCount('pointercancel')).toBe(1)
    expect(track.listenerCount('lostpointercapture')).toBe(1)
    expect(track.hasPointerCapture(7)).toBe(true)

    cleanup()
    cleanup()

    expect(ownerWindow.listenerCount('pointermove')).toBe(0)
    expect(ownerWindow.listenerCount('pointerup')).toBe(0)
    expect(ownerWindow.listenerCount('pointercancel')).toBe(0)
    expect(track.listenerCount('lostpointercapture')).toBe(0)
    expect(track.hasPointerCapture(7)).toBe(false)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('cleans up when pointerup arrives normally', () => {
    const ownerWindow = new FakeEventTarget()
    const track = new FakeTrack()
    const onPointerMove = vi.fn()

    beginCombinedDiffScrollbarDrag({
      track: track as unknown as HTMLElement,
      pointerId: 11,
      onPointerMove,
      ownerWindow: ownerWindow as unknown as Window
    })

    ownerWindow.dispatch('pointermove', { clientY: 10 } as PointerEvent)
    ownerWindow.dispatch('pointerup')

    expect(onPointerMove).toHaveBeenCalledTimes(1)
    expect(ownerWindow.listenerCount('pointermove')).toBe(0)
    expect(ownerWindow.listenerCount('pointerup')).toBe(0)
    expect(ownerWindow.listenerCount('pointercancel')).toBe(0)
    expect(track.listenerCount('lostpointercapture')).toBe(0)
    expect(track.hasPointerCapture(11)).toBe(false)
  })
})
