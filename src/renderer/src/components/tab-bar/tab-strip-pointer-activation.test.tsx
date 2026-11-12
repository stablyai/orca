// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
