// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePetPointerInteraction } from './usePetPointerInteraction'

type HandlerName = keyof ReturnType<typeof usePetPointerInteraction>['handlers']

function fakeTarget(): {
  setPointerCapture: (id: number) => void
  hasPointerCapture: (id: number) => boolean
  releasePointerCapture: (id: number) => void
} {
  const captured = new Set<number>()
  return {
    setPointerCapture: (id) => void captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => void captured.delete(id)
  }
}

function setup() {
  const moveTo = vi.fn()
  const target = fakeTarget()
  const { result } = renderHook(() => usePetPointerInteraction({ x: 0, y: 0 }, moveTo))

  const event = (props: {
    clientX?: number
    clientY?: number
    pointerId?: number
    button?: number
  }) =>
    ({
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      currentTarget: target,
      preventDefault: () => {},
      ...props
    }) as unknown as Parameters<
      ReturnType<typeof usePetPointerInteraction>['handlers']['onPointerDown']
    >[0]

  const fire = (name: HandlerName, props: Parameters<typeof event>[0] = {}): void => {
    act(() => result.current.handlers[name](event(props)))
  }

  return { result, moveTo, fire, event }
}

describe('usePetPointerInteraction', () => {
  it('starts a drag and bumps the restart generation on a primary grab', () => {
    const { result, fire } = setup()
    fire('onPointerDown', { clientX: 50, clientY: 50 })
    expect(result.current.dragging).toBe(true)
    expect(result.current.dragAnimation).toBe(null)
    expect(result.current.dragGeneration).toBe(1)
  })

  it('runs toward the horizontal drag direction past the 4px deadzone', () => {
    const { result, fire, moveTo } = setup()
    fire('onPointerDown', { clientX: 50, clientY: 50 })
    fire('onPointerMove', { clientX: 58, clientY: 50 })
    expect(result.current.dragAnimation).toBe('running-right')
    expect(moveTo).toHaveBeenLastCalledWith({ x: 8, y: 0 })
    fire('onPointerMove', { clientX: 40, clientY: 50 })
    expect(result.current.dragAnimation).toBe('running-left')
  })

  it('ignores sub-deadzone jitter and keeps the last direction on vertical moves', () => {
    const { result, fire } = setup()
    fire('onPointerDown', { clientX: 50, clientY: 50 })
    fire('onPointerMove', { clientX: 52, clientY: 52 })
    expect(result.current.dragAnimation).toBe(null)
    fire('onPointerMove', { clientX: 58, clientY: 52 })
    expect(result.current.dragAnimation).toBe('running-right')
    fire('onPointerMove', { clientX: 58, clientY: 100 })
    expect(result.current.dragAnimation).toBe('running-right')
  })

  it('accumulates horizontal travel across a slow diagonal drag', () => {
    // Regression: the baseline advances only on an accepted direction, so a
    // sequence of sub-4px diagonal moves still crosses the threshold instead of
    // resetting each time and never triggering.
    const { result, fire } = setup()
    fire('onPointerDown', { clientX: 50, clientY: 50 })
    fire('onPointerMove', { clientX: 53, clientY: 55 })
    expect(result.current.dragAnimation).toBe(null)
    fire('onPointerMove', { clientX: 56, clientY: 60 })
    expect(result.current.dragAnimation).toBe('running-right')
  })

  it('keeps the latest horizontal direction when two moves land in one commit', () => {
    // Regression: the direction lives in a ref, not the state closure, so a
    // vertical move batched right after a horizontal one cannot resurrect the
    // stale prior direction.
    const { result } = renderHook(() => usePetPointerInteraction({ x: 0, y: 0 }, vi.fn()))
    const target = fakeTarget()
    const ev = (clientX: number, clientY: number) =>
      ({
        button: 0,
        pointerId: 1,
        clientX,
        clientY,
        currentTarget: target,
        preventDefault: () => {}
      }) as never

    act(() => result.current.handlers.onPointerDown(ev(50, 50)))
    act(() => {
      result.current.handlers.onPointerMove(ev(40, 50)) // left
      result.current.handlers.onPointerMove(ev(40, 90)) // vertical from the new sample
    })
    expect(result.current.dragAnimation).toBe('running-left')
  })

  it('scopes the drag to the owning pointer and ignores a second touch', () => {
    const { result, fire, moveTo } = setup()
    fire('onPointerDown', { clientX: 50, clientY: 50, pointerId: 1 })
    // A second pointer must not hijack the drag or mint a new restart.
    fire('onPointerDown', { clientX: 50, clientY: 50, pointerId: 2 })
    expect(result.current.dragGeneration).toBe(1)
    fire('onPointerMove', { clientX: 90, clientY: 50, pointerId: 2 })
    expect(moveTo).not.toHaveBeenCalled()
    // Releasing the non-owning pointer leaves the drag alive.
    fire('onPointerUp', { pointerId: 2 })
    expect(result.current.dragging).toBe(true)
    // The owning pointer ends it.
    fire('onPointerUp', { pointerId: 1 })
    expect(result.current.dragging).toBe(false)
    expect(result.current.dragAnimation).toBe(null)
  })

  it('ends the drag when pointer capture is lost', () => {
    const { result, fire } = setup()
    fire('onPointerDown', { clientX: 50, clientY: 50 })
    fire('onLostPointerCapture', { pointerId: 1 })
    expect(result.current.dragging).toBe(false)
    expect(result.current.dragAnimation).toBe(null)
  })
})
