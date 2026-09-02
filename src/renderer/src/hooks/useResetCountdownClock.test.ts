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
