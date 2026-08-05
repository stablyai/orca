import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserStreamRestartScheduler } from './remote-browser-stream-restart-scheduler'

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteBrowserStreamRestartScheduler', () => {
  it('keeps retrying with bounded backoff after repeated transient failures until success', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    let attempts = 0
    const FAILURES_BEFORE_SUCCESS = 5

    const run = vi.fn(async () => {
      attempts += 1
      if (attempts <= FAILURES_BEFORE_SUCCESS) {
        return true // transient failure: keep retrying
      }
      return false // succeeded: stop this retry chain
    })

    scheduler.schedule(run)
    // Sum of the 6 backoff steps needed to reach the 6th (successful) attempt: 500+1000+2000+4000+8000+15000.
    await vi.advanceTimersByTimeAsync(31_000)

    expect(attempts).toBe(FAILURES_BEFORE_SUCCESS + 1)
    expect(scheduler.isScheduled).toBe(false)

    // No further attempts fire once the chain has stopped.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(FAILURES_BEFORE_SUCCESS + 1)
  })

  // Why: clearTimeout cannot recall an attempt already dispatched into an await. Pre-fix, a cancel()
  // during that window was a no-op and the resolving attempt re-armed a "cancelled" scheduler.
  it('does not re-arm when cancelled while an attempt is already in flight', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    let resolveAttempt: ((shouldRetry: boolean) => void) | undefined
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAttempt = resolve
        })
    )

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(500)
    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.isScheduled).toBe(false) // timer fired; the attempt is now awaiting

    scheduler.cancel()
    resolveAttempt?.(true) // the in-flight attempt reports a transient failure after the cancel
    await vi.advanceTimersByTimeAsync(0)

    expect(scheduler.isScheduled).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('still retries normally when an in-flight attempt resolves without an intervening cancel', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    let resolveAttempt: ((shouldRetry: boolean) => void) | undefined
    const run = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAttempt = resolve
        })
    )

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(500)
    resolveAttempt?.(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(scheduler.isScheduled).toBe(true)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('grows the delay per counted attempt and caps it, never by elapsed wall time', () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const run = vi.fn(async () => true)

    const observedDelays: number[] = []
    for (let i = 0; i < 9; i++) {
      scheduler.schedule(run)
      const call = setTimeoutSpy.mock.calls.at(-1)
      observedDelays.push(call?.[1] as number)
      vi.advanceTimersByTime(observedDelays[i])
    }

    expect(observedDelays).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000])
  })

  it('does not double-schedule while a restart is already pending', () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const run = vi.fn(async () => true)

    scheduler.schedule(run)
    expect(scheduler.attemptCount).toBe(1)
    scheduler.schedule(run) // no-op: already scheduled
    expect(scheduler.attemptCount).toBe(1)
    expect(scheduler.isScheduled).toBe(true)
  })

  it('stops the retry chain and clears the timer when run resolves false (e.g. superseded or success)', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const run = vi.fn(async () => false)

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(500)

    expect(run).toHaveBeenCalledTimes(1)
    expect(scheduler.isScheduled).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reset() forgets prior failures so the next drop backs off from the first delay again', () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const run = vi.fn(async () => true)

    scheduler.schedule(run)
    vi.advanceTimersByTime(500)
    scheduler.schedule(run)
    vi.advanceTimersByTime(1000)
    expect(scheduler.attemptCount).toBe(2)

    // A confirmed-live stream ("ready") resets the counter.
    scheduler.reset()
    expect(scheduler.attemptCount).toBe(0)

    scheduler.schedule(run)
    const call = setTimeoutSpy.mock.calls.at(-1)
    expect(call?.[1]).toBe(500)
  })

  it('cancel() clears a pending timer and resets the attempt count', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const run = vi.fn(async () => true)

    scheduler.schedule(run)
    expect(scheduler.isScheduled).toBe(true)
    scheduler.cancel()

    expect(scheduler.isScheduled).toBe(false)
    expect(scheduler.attemptCount).toBe(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).not.toHaveBeenCalled()
  })
})
