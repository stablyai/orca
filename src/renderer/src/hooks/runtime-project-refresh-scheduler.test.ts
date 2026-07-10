import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeProjectRefreshScheduler } from './runtime-project-refresh-scheduler'

describe('createRuntimeProjectRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst of remote repo events into one refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000
    })

    scheduler.request('env-1')
    scheduler.request('env-1')
    scheduler.request('env-1')

    await vi.advanceTimersByTimeAsync(99)
    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith('env-1')

    scheduler.stop()
  })

  it('throttles repeated bursts after the first refresh', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000
    })

    scheduler.request('env-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh).toHaveBeenCalledTimes(1)

    scheduler.request('env-1')
    scheduler.request('env-1')
    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(2)

    scheduler.stop()
  })

  it('waits for an in-flight refresh before running a pending follow-up', async () => {
    let finishRefresh = (): void => {
      throw new Error('Expected refresh promise resolver to be set')
    }
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve
        })
    )
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000
    })

    scheduler.request('env-1')
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh).toHaveBeenCalledTimes(1)

    scheduler.request('env-1')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    finishRefresh()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh).toHaveBeenCalledTimes(2)

    scheduler.stop()
  })

  it('clears pending timers on stop', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined)
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000
    })

    scheduler.request('env-1')
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(refresh).not.toHaveBeenCalled()
  })
})
