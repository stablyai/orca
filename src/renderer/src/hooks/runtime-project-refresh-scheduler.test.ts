import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntimeProjectRefreshScheduler,
  refreshRuntimeProjectWorktrees,
  refreshRuntimeProjectWorktreesAndLineage
} from './runtime-project-refresh-scheduler'

describe('refreshRuntimeProjectWorktrees', () => {
  it('limits a large catalog to the bounded worktree refresh lane', async () => {
    let active = 0
    let peak = 0
    const fetchWorktrees = vi.fn(
      async (_repoId: string, _options: { executionHostId: string }): Promise<void> => {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        active -= 1
      }
    )

    await refreshRuntimeProjectWorktrees(
      'env-1',
      Array.from({ length: 12 }, (_, index) => ({ id: `repo-${index}` })),
      fetchWorktrees
    )

    expect(fetchWorktrees).toHaveBeenCalledTimes(12)
    expect(peak).toBe(5)
  })

  it('retains both repo and final lineage failures', async () => {
    const repoError = new Error('repo refresh failed')
    const lineageError = new Error('lineage refresh failed')
    const fetchWorktrees = vi.fn().mockRejectedValue(repoError)
    const fetchWorktreeLineage = vi.fn().mockRejectedValue(lineageError)

    const rejection = await refreshRuntimeProjectWorktreesAndLineage(
      'env-1',
      [{ id: 'repo-1' }],
      fetchWorktrees,
      fetchWorktreeLineage
    ).catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: 'Failed to refresh 1 runtime project worktree(s): repo-1',
        errors: [repoError]
      }),
      lineageError
    ])
  })
})

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
