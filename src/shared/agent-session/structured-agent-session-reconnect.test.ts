import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReconnectScheduler,
  RECONNECT_STABLE_STREAM_MS
} from './structured-agent-session-reconnect'

describe('stream reconnect backoff', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function scheduler() {
    const reconnect = vi.fn()
    const retry = createReconnectScheduler({ shouldStop: () => false, reconnect })
    /** Run one reconnect cycle and report how long it waited. */
    const cycle = (): number => {
      const start = Date.now()
      retry.schedule()
      vi.advanceTimersToNextTimer()
      return Date.now() - start
    }
    return { retry, cycle }
  }

  // #39926: a host that ends a stream right after its first frames must not cause a 750 ms storm.
  it('keeps growing the wait for a stream that ends right after delivering', () => {
    const { retry, cycle } = scheduler()
    retry.noteDelivered()
    expect(cycle()).toBe(750)
    retry.noteDelivered()
    expect(cycle()).toBe(1_500)
    retry.noteDelivered()
    expect(cycle()).toBe(3_000)
  })

  it('retries soon again after a stream that stayed up', () => {
    const { retry, cycle } = scheduler()
    expect(cycle()).toBe(750)
    expect(cycle()).toBe(1_500)
    retry.noteDelivered()
    vi.advanceTimersByTime(RECONNECT_STABLE_STREAM_MS)
    expect(cycle()).toBe(750)
  })
})
