import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribePromptCacheCountdownClock } from './prompt-cache-countdown-clock'

describe('subscribePromptCacheCountdownClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses one interval for all prompt-cache countdown subscribers', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribePromptCacheCountdownClock(first)
    const unsubscribeSecond = subscribePromptCacheCountdownClock(second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    unsubscribeFirst()
    vi.advanceTimersByTime(1_000)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3)
    unsubscribeSecond()
    vi.advanceTimersByTime(1_000)

    expect(second).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
