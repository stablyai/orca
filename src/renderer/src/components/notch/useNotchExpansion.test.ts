// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotchExpansion } from './useNotchExpansion'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const at = (x: number, y: number): { clientX: number; clientY: number } => ({
  clientX: x,
  clientY: y
})

describe('useNotchExpansion', () => {
  it('opens after the hover dwell, not immediately', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(false, setExpanded))

    act(() => result.current.onPointerEnter(at(10, 10)))
    expect(setExpanded).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(150))
    expect(setExpanded).toHaveBeenCalledWith(true)
  })

  it('does not open when the pointer only passes across the bar', () => {
    // Why: crossing the notch on the way somewhere else must not open a panel behind the cursor.
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(false, setExpanded))

    act(() => result.current.onPointerEnter(at(10, 10)))
    act(() => void vi.advanceTimersByTime(100))
    act(() => result.current.onPointerMove(at(60, 10)))
    act(() => void vi.advanceTimersByTime(100))

    expect(setExpanded).not.toHaveBeenCalled()
  })

  it('ignores jitter under the movement gate', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(false, setExpanded))

    act(() => result.current.onPointerEnter(at(10, 10)))
    act(() => void vi.advanceTimersByTime(100))
    act(() => result.current.onPointerMove(at(13, 12)))
    act(() => void vi.advanceTimersByTime(60))

    expect(setExpanded).toHaveBeenCalledWith(true)
  })

  it('opens immediately on click', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(false, setExpanded))

    act(() => result.current.onClick())

    expect(setExpanded).toHaveBeenCalledWith(true)
  })

  it('closes on a second click', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(true, setExpanded))

    act(() => result.current.onClick())

    expect(setExpanded).toHaveBeenCalledWith(false)
  })

  it('waits before closing so clipping the edge does not dismiss the panel', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(true, setExpanded))

    act(() => result.current.onPointerLeave())
    act(() => void vi.advanceTimersByTime(400))
    expect(setExpanded).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(100))
    expect(setExpanded).toHaveBeenCalledWith(false)
  })

  it('cancels a pending close when the pointer returns', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(true, setExpanded))

    act(() => result.current.onPointerLeave())
    act(() => void vi.advanceTimersByTime(300))
    act(() => result.current.onPointerEnter(at(10, 10)))
    act(() => void vi.advanceTimersByTime(400))

    expect(setExpanded).not.toHaveBeenCalledWith(false)
  })

  it('cancels a pending open when the pointer leaves first', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(false, setExpanded))

    act(() => result.current.onPointerEnter(at(10, 10)))
    act(() => void vi.advanceTimersByTime(100))
    act(() => result.current.onPointerLeave())
    act(() => void vi.advanceTimersByTime(200))

    expect(setExpanded).not.toHaveBeenCalledWith(true)
  })

  it('does not re-request opening while already expanded', () => {
    const setExpanded = vi.fn()
    const { result } = renderHook(() => useNotchExpansion(true, setExpanded))

    act(() => result.current.onPointerEnter(at(10, 10)))
    act(() => void vi.advanceTimersByTime(300))

    expect(setExpanded).not.toHaveBeenCalled()
  })

  it('drops pending timers on unmount', () => {
    const setExpanded = vi.fn()
    const { result, unmount } = renderHook(() => useNotchExpansion(false, setExpanded))

    act(() => result.current.onPointerEnter(at(10, 10)))
    unmount()
    act(() => void vi.advanceTimersByTime(500))

    expect(setExpanded).not.toHaveBeenCalled()
  })
})
