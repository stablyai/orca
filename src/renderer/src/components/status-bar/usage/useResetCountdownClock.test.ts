// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useResetCountdownClock } from './useResetCountdownClock'

const START = 1_000_000_000
const MIN = 60_000
const RESET_AT = START + 26 * 60 * MIN + 40 * MIN

describe('useResetCountdownClock planned wakes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes on a planned instant that arrives before the label boundary', () => {
    const { result } = renderHook(() => useResetCountdownClock([RESET_AT], () => [START + 5 * MIN]))

    act(() => {
      vi.advanceTimersByTime(5 * MIN)
    })
    expect(result.current).toBe(START + 5 * MIN)
  })

  it('reschedules when the planner names a new instant without the reset moving', () => {
    let plannedAt = START + 50 * MIN
    const { result, rerender } = renderHook(() =>
      useResetCountdownClock([RESET_AT], () => [plannedAt])
    )

    plannedAt = START + 5 * MIN
    rerender()

    act(() => {
      vi.advanceTimersByTime(5 * MIN)
    })
    expect(result.current).toBe(START + 5 * MIN)
  })
})
