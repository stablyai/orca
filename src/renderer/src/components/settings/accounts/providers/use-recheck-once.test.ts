// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useRecheckOnce } from './use-recheck-once'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('fires once after the delay even when the caller re-renders meanwhile', () => {
  vi.useFakeTimers()
  const recheck = vi.fn(() => true)
  const { rerender } = renderHook(({ n }) => useRecheckOnce(n >= 0, 8_000, recheck), {
    initialProps: { n: 0 }
  })
  vi.advanceTimersByTime(2_000)
  rerender({ n: 1 })
  rerender({ n: 2 })
  vi.advanceTimersByTime(6_000)
  expect(recheck).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(60_000)
  expect(recheck).toHaveBeenCalledTimes(1)
})

it('tries again a second later when the recheck could not run yet', () => {
  vi.useFakeTimers()
  const recheck = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
  renderHook(() => useRecheckOnce(true, 8_000, recheck))
  vi.advanceTimersByTime(8_000)
  vi.advanceTimersByTime(1_000)
  expect(recheck).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(10_000)
  expect(recheck).toHaveBeenCalledTimes(2)
})

it('cancels when the wait ends first, and arms again for the next wait', () => {
  vi.useFakeTimers()
  const recheck = vi.fn(() => true)
  const { rerender } = renderHook(({ waiting }) => useRecheckOnce(waiting, 8_000, recheck), {
    initialProps: { waiting: true }
  })
  vi.advanceTimersByTime(4_000)
  rerender({ waiting: false })
  vi.advanceTimersByTime(10_000)
  expect(recheck).not.toHaveBeenCalled()

  rerender({ waiting: true })
  vi.advanceTimersByTime(8_000)
  expect(recheck).toHaveBeenCalledTimes(1)
  rerender({ waiting: false })
  rerender({ waiting: true })
  vi.advanceTimersByTime(8_000)
  expect(recheck).toHaveBeenCalledTimes(2)
})

it('stops on unmount', () => {
  vi.useFakeTimers()
  const recheck = vi.fn(() => true)
  const { unmount } = renderHook(() => useRecheckOnce(true, 8_000, recheck))
  unmount()
  vi.advanceTimersByTime(10_000)
  expect(recheck).not.toHaveBeenCalled()
})
