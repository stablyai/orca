// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installWindowVisibilityTimeoutPoller } from './window-visibility-timeout-poller'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('installWindowVisibilityTimeoutPoller', () => {
  it('runs immediately and schedules after completion', async () => {
    const run = vi.fn().mockResolvedValue(undefined)
    const cleanup = installWindowVisibilityTimeoutPoller({ run, getDelayMs: () => 3000 })
    expect(run).toHaveBeenCalledOnce()
    await flush()
    await vi.advanceTimersByTimeAsync(2999)
    expect(run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    cleanup()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses hidden work and refreshes once when visible again', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const run = vi.fn().mockResolvedValue(undefined)
    const cleanup = installWindowVisibilityTimeoutPoller({ run, getDelayMs: () => 3000 })
    await vi.advanceTimersByTimeAsync(9000)
    expect(run).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(run).toHaveBeenCalledOnce()
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.getTimerCount()).toBe(0)
    cleanup()
  })

  it('does not overlap in-flight focus reads', async () => {
    let resolveRun: (() => void) | undefined
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve
        })
    )
    const cleanup = installWindowVisibilityTimeoutPoller({ run, getDelayMs: () => 3000 })
    window.dispatchEvent(new Event('focus'))
    expect(run).toHaveBeenCalledOnce()
    resolveRun?.()
    await flush()
    expect(vi.getTimerCount()).toBe(1)
    cleanup()
  })

  it('stops after a null delay and responds to visibility return without focus bursts', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const run = vi.fn().mockResolvedValue(undefined)
    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => null,
      cooldownMs: 10_000
    })
    await flush()
    expect(vi.getTimerCount()).toBe(0)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(run).toHaveBeenCalledOnce()
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(10_000)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(run).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    cleanup()
  })

  it('waits for stale data when a fresh window returns before its next poll', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    const run = vi.fn().mockResolvedValue(undefined)
    const cleanup = installWindowVisibilityTimeoutPoller({
      run,
      getDelayMs: () => 60_000,
      cooldownMs: 10_000
    })
    await flush()
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(30_000)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(run).toHaveBeenCalledTimes(2)
    cleanup()
  })

  it('picks up a settled null delay after pending finishes', async () => {
    let delay: number | null = 60_000
    const run = vi.fn().mockResolvedValue(undefined)
    const cleanup = installWindowVisibilityTimeoutPoller({ run, getDelayMs: () => delay })
    await flush()
    delay = null
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    cleanup()
  })

  it('keeps retrying rejected and synchronously throwing reads', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => {
        throw new Error('offline')
      })
      .mockResolvedValue(undefined)
    const cleanup = installWindowVisibilityTimeoutPoller({ run, getDelayMs: () => 3000 })
    await vi.advanceTimersByTimeAsync(6000)
    expect(run).toHaveBeenCalledTimes(3)
    cleanup()
  })
})
