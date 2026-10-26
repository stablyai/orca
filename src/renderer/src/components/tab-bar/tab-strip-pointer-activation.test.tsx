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
    // Start dnd-kit on pointerdown while deferring activation until release.
    expect(dragListener).toHaveBeenCalledTimes(1)
    expect(onActivate).not.toHaveBeenCalled()

    firePointer('pointerup', 12, 11)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('suppresses activation when the pointer travels past the drag threshold', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    firePointer('pointerup', 10 + TAB_DRAG_ACTIVATION_DISTANCE_PX + 5, 10)

    expect(onActivate).not.toHaveBeenCalled()
  })

  it('activates a stationary click after a single stale over-threshold move', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    // A stale/coalesced first move cannot override the actual release position.
    firePointer('pointermove', 200, 200)
    firePointer('pointerup', 11, 11)

    expect(onActivate).toHaveBeenCalledTimes(1)
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

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10, 2), dragListener))
    firePointer('pointerup', 10, 10)
    expect(onActivate).not.toHaveBeenCalled()
    expect(dragListener).not.toHaveBeenCalled()

    rerender({ disabled: true })
    act(() => result.current.onPointerDown(pointerDownEvent(10, 10), dragListener))
    firePointer('pointerup', 10, 10)
    expect(onActivate).not.toHaveBeenCalled()
    expect(dragListener).not.toHaveBeenCalled()
  })

  it('activates a click that lands after a prior drag gesture (regression #6395)', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    firePointer('pointermove', 300, 10)
    firePointer('pointerup', 300, 10)
    expect(onActivate).not.toHaveBeenCalled()

    act(() => result.current.onPointerDown(pointerDownEvent(400, 10)))
    firePointer('pointerup', 400, 10)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('flushes a pending press on window focus', () => {
    const onActivate = vi.fn()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    act(() => window.dispatchEvent(new Event('focus')))
    firePointer('pointerup', 10, 10)

    expect(onActivate).not.toHaveBeenCalled()
  })

  // A press leaving an in-page guest restores embedder focus itself; do not mistake that handoff for an app switch.
  it('still activates when the press is what pulled focus back from a guest', () => {
    const onActivate = vi.fn()
    const guest = document.createElement('webview')
    document.body.append(guest)
    guest.tabIndex = -1
    guest.focus()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    act(() => window.dispatchEvent(new Event('focus')))
    firePointer('pointerup', 11, 11)

    expect(onActivate).toHaveBeenCalledTimes(1)
    guest.remove()
  })

  // Forgive only the initial guest handoff; a later real app switch must cancel the press.
  it('flushes a press that outlives the guest handoff it started with', () => {
    const onActivate = vi.fn()
    const guest = document.createElement('webview')
    document.body.append(guest)
    guest.tabIndex = -1
    guest.focus()
    const { result } = renderHook(() => useTabStripPointerActivation({ onActivate }))

    act(() => result.current.onPointerDown(pointerDownEvent(10, 10)))
    act(() => window.dispatchEvent(new Event('focus')))
    act(() => window.dispatchEvent(new Event('focus')))
    firePointer('pointerup', 11, 11)

    expect(onActivate).not.toHaveBeenCalled()
    guest.remove()
  })
})
