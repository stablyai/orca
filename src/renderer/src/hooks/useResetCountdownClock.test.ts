// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useResetCountdownClock } from './useResetCountdownClock'

const START = 1_000_000_000
const MIN = 60_000

describe('useResetCountdownClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances `now` just after the next label boundary', () => {
    // 90m 30s away -> the minute label flips in 30s.
    const resetAt = START + 90 * MIN + 30_000
    const { result } = renderHook(() => useResetCountdownClock([resetAt]))
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(30_000 + 1)
    })
    // Woke exactly once, at the boundary — not every second.
    expect(result.current).toBe(START + 30_000 + 1)
  })

  it('wakes on a planned instant that arrives before the label boundary', () => {
    // The label is an hour out, but the planner names something 5m away.
    const resetAt = START + 26 * 60 * MIN + 40 * MIN
    const { result } = renderHook(() => useResetCountdownClock([resetAt], () => [START + 5 * MIN]))

    act(() => {
      vi.advanceTimersByTime(5 * MIN)
    })
    expect(result.current).toBe(START + 5 * MIN)
  })

  it('reschedules when the planner names a new instant without the reset moving', () => {
    // A usage refresh can change what pace projects while resetsAt holds still;
    // the timeout already in flight must not survive that.
    const resetAt = START + 26 * 60 * MIN + 40 * MIN
    let plannedAt = START + 50 * MIN
    const { result, rerender } = renderHook(() =>
      useResetCountdownClock([resetAt], () => [plannedAt])
    )

    plannedAt = START + 5 * MIN
    rerender()

    act(() => {
      vi.advanceTimersByTime(5 * MIN)
    })
    expect(result.current).toBe(START + 5 * MIN)
  })

  it('ignores planned instants that have already passed', () => {
    const { result } = renderHook(() =>
      useResetCountdownClock([START - 1000], () => [START - 5 * MIN, null])
    )

    act(() => {
      vi.advanceTimersByTime(10 * MIN)
    })
    expect(result.current).toBe(START)
  })

  it('does not schedule a tick when there is no future reset', () => {
    const { result } = renderHook(() => useResetCountdownClock([START - 1000]))
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(10 * MIN)
    })
    // Nothing to count down -> `now` stays put (no wasted wakeups).
    expect(result.current).toBe(START)
  })
})
