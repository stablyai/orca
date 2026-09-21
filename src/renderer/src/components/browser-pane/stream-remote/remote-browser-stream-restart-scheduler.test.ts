import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserStreamRestartScheduler } from './remote-browser-stream-restart-scheduler'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RemoteBrowserStreamRestartScheduler', () => {
  it('retries transient failures until it recovers, without spending the whole budget', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    let attempts = 0
    const FAILURES_BEFORE_SUCCESS = 3

    const run = vi.fn(async () => {
      attempts += 1
      return attempts <= FAILURES_BEFORE_SUCCESS
    })

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(31_000)

    expect(attempts).toBe(FAILURES_BEFORE_SUCCESS + 1)
    expect(scheduler.isScheduled).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(attempts).toBe(FAILURES_BEFORE_SUCCESS + 1)
  })

  // The property the pane depends on: retries are finite, and it is told when they run out. An
  // unbounded scheduler leaves a dead stream retrying forever behind a recurring error.
  it('stops after the budget and reports it exactly once', async () => {
    vi.useFakeTimers()
    const onExhausted = vi.fn()
    const scheduler = new RemoteBrowserStreamRestartScheduler(undefined, onExhausted)
    const run = vi.fn(async () => true)

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(run).toHaveBeenCalledTimes(5)
    expect(onExhausted).toHaveBeenCalledTimes(1)
    expect(scheduler.isBudgetExhausted).toBe(true)
    expect(scheduler.isScheduled).toBe(false)

    await vi.advanceTimersByTimeAsync(300_000)
    expect(run).toHaveBeenCalledTimes(5)
  })

  it('reset gives a spent scheduler its budget back so the user can ask again', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler([10, 20])
    const run = vi.fn(async () => true)

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(2)

    scheduler.reset()
    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('keeps retrying when an attempt rejects rather than dropping the cycle', async () => {
    vi.useFakeTimers()
    const onExhausted = vi.fn()
    const scheduler = new RemoteBrowserStreamRestartScheduler([10, 20, 40], onExhausted)
    const run = vi.fn(async () => {
      throw new Error('start failed')
    })

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(run).toHaveBeenCalledTimes(3)
    expect(onExhausted).toHaveBeenCalledTimes(1)
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
    expect(scheduler.isScheduled).toBe(true)

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

  it('queues one replacement chain while the current attempt is in flight', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler([10, 20])
    let resolveAttempt: ((shouldRetry: boolean) => void) | undefined
    const firstRun = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAttempt = resolve
        })
    )
    const replacementRun = vi.fn(async () => false)

    scheduler.schedule(firstRun)
    await vi.advanceTimersByTimeAsync(10)
    scheduler.schedule(replacementRun)

    expect(scheduler.attemptCount).toBe(1)
    resolveAttempt?.(false)
    await vi.advanceTimersByTimeAsync(20)

    expect(firstRun).toHaveBeenCalledTimes(1)
    expect(replacementRun).toHaveBeenCalledTimes(1)
    expect(scheduler.isScheduled).toBe(false)
  })

  it('grows the delay per counted attempt, never by elapsed wall time, and then stops', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const run = vi.fn(async () => true)

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(60_000)
    const observedDelays = setTimeoutSpy.mock.calls.map((call) => call[1])

    // Literal on purpose: asserting against the constant under test makes the ladder self-certifying
    // — verified, a change to 12 flat 1s attempts passed the whole suite. The budget's size and shape
    // are user-visible (how long the pane waits before handing control back), so they get pinned here.
    expect(observedDelays).toEqual([500, 1_000, 2_000, 4_000, 8_000])
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

  it('reset() forgets prior failures so the next drop backs off from the first delay again', async () => {
    vi.useFakeTimers()
    const scheduler = new RemoteBrowserStreamRestartScheduler()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const run = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)

    scheduler.schedule(run)
    await vi.advanceTimersByTimeAsync(1_500)
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
