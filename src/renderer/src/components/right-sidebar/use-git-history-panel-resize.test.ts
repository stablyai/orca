// @vitest-environment happy-dom

import type { PointerEvent } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGitHistoryPanelResize } from './use-git-history-panel-resize'
type ResizePointerDownEvent = PointerEvent<HTMLDivElement>

function pointerDownEvent(
  pointerId: number,
  clientY: number,
  setPointerCapture: (pointerId: number) => void
): ResizePointerDownEvent {
  return {
    pointerId,
    clientY,
    preventDefault: vi.fn(),
    currentTarget: { setPointerCapture }
  } as unknown as ResizePointerDownEvent
}

function dispatchPointerEvent(
  type: 'pointermove' | 'pointerup' | 'pointercancel',
  pointerId: number,
  clientY = 0
): void {
  const event = new Event(type)
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientY: { value: clientY }
  })
  act(() => {
    window.dispatchEvent(event)
  })
}

afterEach(() => {
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

describe('useGitHistoryPanelResize', () => {
  it('keeps the active drag owned by its initiating pointer', () => {
    document.body.style.cursor = 'crosshair'
    document.body.style.userSelect = 'text'
    const setPointerCapture = vi.fn()
    const { result } = renderHook(() => useGitHistoryPanelResize(false))

    act(() => {
      result.current.onResizePointerDown(pointerDownEvent(1, 200, setPointerCapture))
    })
    act(() => {
      result.current.onResizePointerDown(pointerDownEvent(2, 100, setPointerCapture))
    })

    expect(setPointerCapture).toHaveBeenCalledTimes(1)
    expect(setPointerCapture).toHaveBeenCalledWith(1)
    dispatchPointerEvent('pointermove', 2, 0)
    expect(result.current.panelHeight).toBe(256)

    dispatchPointerEvent('pointerup', 2)
    dispatchPointerEvent('pointercancel', 2)
    expect(document.body.style.cursor).toBe('row-resize')
    expect(document.body.style.userSelect).toBe('none')

    dispatchPointerEvent('pointermove', 1, 150)
    expect(result.current.panelHeight).toBe(306)
    dispatchPointerEvent('pointerup', 1)
    expect(document.body.style.cursor).toBe('crosshair')
    expect(document.body.style.userSelect).toBe('text')
  })
})
