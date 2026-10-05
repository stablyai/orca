import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeadlineDebouncer } from './deadline-debouncer'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('quiet-time and maximum-wait deadlines', () => {
  it('allocates one timer for a burst and waits for the latest quiet deadline', () => {
    const callback = vi.fn()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const debouncer = createDeadlineDebouncer(callback, 150, 1_000)
    for (let index = 0; index < 100; index++) {
      debouncer.schedule()
    }
    expect(timers).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    debouncer.schedule()
    vi.advanceTimersByTime(149)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('fires throughout continuous updates and preserves a deferred, overdue write', () => {
    let allowed = false
    const callback = vi.fn(() => (allowed ? undefined : (false as const)))
    const debouncer = createDeadlineDebouncer(callback, 150, 1_000)
    for (let index = 0; index < 10; index++) {
      debouncer.schedule()
      vi.advanceTimersByTime(100)
    }
    expect(callback).toHaveBeenCalledTimes(1)
    expect(debouncer.isScheduled).toBe(false)
    vi.advanceTimersByTime(5_000)
    allowed = true
    debouncer.schedule()
    vi.advanceTimersByTime(0)
    expect(callback).toHaveBeenCalledTimes(2)
  })

  it('keeps a reentrant schedule and cancels an owed deadline on disposal', () => {
    const callback = vi.fn(() => {
      if (callback.mock.calls.length === 1) {
        debouncer.schedule()
      }
    })
    const debouncer = createDeadlineDebouncer(callback, 150, 1_000)
    debouncer.schedule()
    vi.advanceTimersByTime(150)
    expect(debouncer.isScheduled).toBe(true)
    vi.advanceTimersByTime(150)
    expect(callback).toHaveBeenCalledTimes(2)
    debouncer.schedule()
    debouncer.cancel()
    vi.advanceTimersByTime(2_000)
    expect(callback).toHaveBeenCalledTimes(2)
  })
})
