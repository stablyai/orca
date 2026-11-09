import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserStreamRestartScheduler } from './remote-browser-stream-restart-scheduler'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RemoteBrowserStreamRestartScheduler', () => {
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
})
