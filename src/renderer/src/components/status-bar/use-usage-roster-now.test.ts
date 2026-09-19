// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useUsageRosterNow } from './use-usage-roster-now'

const START = 1_000_000_000
const MIN = 60_000

describe('useUsageRosterNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not tick every minute without updatedAt metadata', () => {
    const { result } = renderHook(() => useUsageRosterNow([null], [null]))
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(10 * MIN)
    })
    expect(result.current).toBe(START)
  })

  it('advances every minute for Updated labels when no reset is counting down', () => {
    const { result } = renderHook(() => useUsageRosterNow([null], [START - 30_000]))
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(MIN)
    })
    expect(result.current).toBe(START + MIN)
  })

  it('still wakes just after the next reset-label boundary', () => {
    const resetAt = START + 90 * MIN + 30_000
    const { result } = renderHook(() => useUsageRosterNow([resetAt], []))
    expect(result.current).toBe(START)

    act(() => {
      vi.advanceTimersByTime(30_000 + 1)
    })
    expect(result.current).toBe(START + 30_000 + 1)
  })
})
