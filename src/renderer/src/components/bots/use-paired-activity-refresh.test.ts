// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePairedActivityRefresh } from './use-paired-activity-refresh'

describe('usePairedActivityRefresh', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps re-reading, backing off, while the bot has paired hand-overs, whatever the last read showed', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    renderHook(() => usePairedActivityRefresh(true, refresh))
    // An offline or empty read changes nothing here: the timer follows the registration.
    vi.advanceTimersByTime(15_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000 + 120_000)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('does nothing for a bot with none', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    renderHook(() => usePairedActivityRefresh(false, refresh))
    vi.advanceTimersByTime(600_000)
    expect(refresh).not.toHaveBeenCalled()
  })
})
