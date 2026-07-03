// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TAB_DRAG_ACTIVATION_DISTANCE_PX } from '../tab-group/useTabDragSplit'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'

function pointerDownEvent(clientX: number, clientY: number, button = 0): React.PointerEvent {
  return { button, clientX, clientY } as unknown as React.PointerEvent
}

function firePointer(type: string, clientX: number, clientY: number): void {
  act(() => {
    window.dispatchEvent(new PointerEvent(type, { clientX, clientY, bubbles: true }))
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useTabStripPointerActivation', () => {
  it('activates on a release that never crossed the drag threshold (a click)', () => {
    const onActivate = vi.fn()
    const dragListener = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10), dragListener))
    // Why: the dnd-kit gesture must start on pointerdown even though activation
    // is deferred.
    expect(dragListener).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()

    // Release within the threshold -> click -> activate.
    firePointer('pointerup', 12, 11)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('suppresses activation when the pointer travels past the drag threshold', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    firePointer('pointermove', 10 + TAB_DRAG_ACTIVATION_DISTANCE_PX + 5, 10)
    firePointer('pointerup', 300, 40)

    expect(onActivate).not.toHaveBeenCalled()
  })

  it('stays a drag even if the pointer returns near the start before release', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    // Cross the threshold, then come back over the origin and release.
    firePointer('pointermove', 200, 200)
    firePointer('pointerup', 11, 11)

    expect(onActivate).not.toHaveBeenCalled()
  })

  it('does not activate when the press is cancelled', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    firePointer('pointercancel', 10, 10)
    firePointer('pointerup', 10, 10)

    expect(onActivate).not.toHaveBeenCalled()
  })

  it('ignores non-left buttons and disabled presses', () => {
    const onActivate = vi.fn()
    const dragListener = vi.fn()
    const { result, rerender } = renderHook(
      ({ disabled }: { disabled: boolean }) =>
        useTabStripPointerActivation({ onActivate, disabled }),
      { initialProps: { disabled: false } }
    )

    // Right-click: ignored.
    act(() => result.current.onPointerDown(pointerDownEvent(10, 10, 2), dragListener))
    firePointer('pointerup', 10, 10)
    expect(onActivate).not.toHaveBeenCalled()
    expect(dragListener).not.toHaveBeenCalled()

    // Disabled: ignored.
    rerender({ disabled: true })
    act(() => result.current.onPointerDown(pointerDownEvent(10, 10), dragListener))
    firePointer('pointerup', 10, 10)
    expect(onActivate).not.toHaveBeenCalled()
    expect(dragListener).not.toHaveBeenCalled()
  })

  it('activates a click that lands after a prior drag gesture (regression #6395)', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    // First gesture: a drag (reorder). No activation.
    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    firePointer('pointermove', 300, 10)
    firePointer('pointerup', 300, 10)
    expect(onActivate).not.toHaveBeenCalled()

    // Second gesture: a plain click. Must activate.
    act(() => result.current.onPointerDown(pointerDownEvent(400, 10)))
    firePointer('pointerup', 400, 10)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })
})
