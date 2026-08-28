// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { usePetPointerInteraction } from './usePetPointerInteraction'

type Handlers = ReturnType<typeof usePetPointerInteraction>['handlers']

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

function setup(origin: () => { x: number; y: number }) {
  const moveTo = vi.fn()
  const target = fakeTarget()
  const { result } = renderHook(() => usePetPointerInteraction(origin, moveTo, 'screen'))
  const fire = (
    name: keyof Handlers,
    props: { screenX?: number; screenY?: number; clientX?: number; clientY?: number } = {}
  ): void => {
    act(() =>
      result.current.handlers[name]({
        button: 0,
        pointerId: 1,
        screenX: 0,
        screenY: 0,
        clientX: 0,
        clientY: 0,
        currentTarget: target,
        preventDefault: () => {},
        ...props
      } as unknown as Parameters<Handlers['onPointerDown']>[0])
    )
  }
  return { result, moveTo, fire }
}

describe('usePetPointerInteraction in screen space', () => {
  it('reports desktop coordinates, so a window moving under the cursor still tracks it', () => {
    // The detached pet window moves itself: clientX stays put while screenX advances.
    const { moveTo, fire } = setup(() => ({ x: 800, y: 400 }))
    fire('onPointerDown', { screenX: 850, screenY: 430, clientX: 50, clientY: 30 })
    fire('onPointerMove', { screenX: 900, screenY: 500, clientX: 50, clientY: 30 })
    expect(moveTo).toHaveBeenLastCalledWith({ x: 850, y: 470 })
  })

  it('turns horizontal desktop travel into a running direction', () => {
    const { result, fire } = setup(() => ({ x: 0, y: 0 }))
    fire('onPointerDown', { screenX: 100, screenY: 100 })
    fire('onPointerMove', { screenX: 120, screenY: 100 })
    expect(result.current.dragAnimation).toBe('running-right')
    fire('onPointerMove', { screenX: 90, screenY: 100 })
    expect(result.current.dragAnimation).toBe('running-left')
  })

  it('re-reads the origin getter per grab, so a window moved since the last drag does not jump', () => {
    let origin = { x: 0, y: 0 }
    const { moveTo, fire } = setup(() => origin)
    fire('onPointerDown', { screenX: 10, screenY: 10 })
    fire('onPointerUp', { screenX: 10, screenY: 10 })

    origin = { x: 500, y: 500 }
    fire('onPointerDown', { screenX: 510, screenY: 510 })
    fire('onPointerMove', { screenX: 511, screenY: 511 })
    expect(moveTo).toHaveBeenLastCalledWith({ x: 501, y: 501 })
  })
})
