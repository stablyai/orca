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
