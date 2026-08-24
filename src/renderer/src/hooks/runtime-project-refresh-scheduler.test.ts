import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRuntimeProjectRefreshScheduler,
  refreshRuntimeProjectWorktrees,
  refreshRuntimeProjectWorktreesAndLineage
} from './runtime-project-refresh-scheduler'

function createPendingRefresh(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve = (): void => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('refreshRuntimeProjectWorktrees', () => {
  it('deduplicates same-host repo IDs and pins the refresh to the event runtime', async () => {
    const fetchWorktrees = vi.fn().mockResolvedValue(true)

    await refreshRuntimeProjectWorktrees(
      'env-1',
      [{ id: 'same-repo' }, { id: 'same-repo' }],
      fetchWorktrees
    )

    expect(fetchWorktrees).toHaveBeenCalledTimes(1)
    expect(fetchWorktrees).toHaveBeenCalledWith('same-repo', {
      executionHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })
  })

  it('runs one final host lineage refresh after a repo failure', async () => {
    const error = new Error('repo refresh failed')
    const fetchWorktrees = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(error)
    const fetchWorktreeLineage = vi.fn().mockResolvedValue(undefined)

    await expect(
      refreshRuntimeProjectWorktreesAndLineage(
        'env-1',
        [{ id: 'repo-1' }, { id: 'repo-2' }],
        fetchWorktrees,
        fetchWorktreeLineage
      )
    ).rejects.toThrow('Failed to refresh 1 runtime project worktree(s): repo-2')

    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktreeLineage).toHaveBeenCalledTimes(1)
    expect(fetchWorktreeLineage).toHaveBeenCalledWith({
      executionHostId: 'runtime:env-1'
    })
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

  it('keeps same-ID repo refreshes isolated across environments', async () => {
    const fetchWorktrees = vi.fn().mockResolvedValue(true)

    await Promise.all([
      refreshRuntimeProjectWorktrees('env-1', [{ id: 'same-repo' }], fetchWorktrees),
      refreshRuntimeProjectWorktrees('env-2', [{ id: 'same-repo' }], fetchWorktrees)
    ])

    expect(fetchWorktrees).toHaveBeenCalledTimes(2)
    expect(fetchWorktrees).toHaveBeenCalledWith('same-repo', {
      executionHostId: 'runtime:env-1',
      suppressRemoteLineageRefresh: true
    })
    expect(fetchWorktrees).toHaveBeenCalledWith('same-repo', {
      executionHostId: 'runtime:env-2',
      suppressRemoteLineageRefresh: true
    })
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

  it('caps cross-host refreshes and admits waiting hosts in FIFO order', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    let activeRefreshes = 0
    let peakActiveRefreshes = 0
    const refresh = vi.fn((environmentId: string) => {
      const next = createPendingRefresh()
      pending.set(environmentId, next)
      activeRefreshes += 1
      peakActiveRefreshes = Math.max(peakActiveRefreshes, activeRefreshes)
      return next.promise.finally(() => {
        activeRefreshes -= 1
      })
    })
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 2
    })

    for (const environmentId of ['env-1', 'env-2', 'env-3', 'env-4', 'env-5']) {
      scheduler.request(environmentId)
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual(['env-1', 'env-2'])

    pending.get('env-1')?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'env-1',
      'env-2',
      'env-3'
    ])

    pending.get('env-2')?.resolve()
    pending.get('env-3')?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'env-1',
      'env-2',
      'env-3',
      'env-4',
      'env-5'
    ])
    expect(peakActiveRefreshes).toBe(2)

    scheduler.stop()
    for (const entry of pending.values()) {
      entry.resolve()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(activeRefreshes).toBe(0)
  })

  it('reserves capacity for the prioritized host', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    const refresh = vi.fn((environmentId: string) => {
      const next = createPendingRefresh()
      pending.set(environmentId, next)
      return next.promise
    })
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 2,
      getPrioritizedEnvironmentId: () => 'active'
    })

    scheduler.request('background-1')
    scheduler.request('background-2')
    scheduler.request('active')
    await vi.advanceTimersByTimeAsync(100)

    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'background-1',
      'active'
    ])

    pending.get('active')?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)

    pending.get('background-1')?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'background-1',
      'active',
      'background-2'
    ])

    scheduler.stop()
    pending.get('background-2')?.resolve()
  })

  it('runs two background hosts concurrently beside the reserved foreground lane', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    const refresh = vi.fn((environmentId: string) => {
      const entry = createPendingRefresh()
      pending.set(environmentId, entry)
      return entry.promise
    })
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      getPrioritizedEnvironmentId: () => 'active'
    })

    // Why: the reserved slot is never lent out, so the default cap must leave two
    // background lanes; at a cap of 2 this serialized discovery to one host at a time.
    scheduler.request('background-1')
    scheduler.request('background-2')
    scheduler.request('background-3')
    await vi.advanceTimersByTimeAsync(100)

    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'background-1',
      'background-2'
    ])

    scheduler.stop()
    pending.get('background-1')?.resolve()
    pending.get('background-2')?.resolve()
  })

  it('still admits the foreground host while both background lanes are busy', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    const refresh = vi.fn((environmentId: string) => {
      const entry = createPendingRefresh()
      pending.set(environmentId, entry)
      return entry.promise
    })
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      getPrioritizedEnvironmentId: () => 'active'
    })

    scheduler.request('background-1')
    scheduler.request('background-2')
    scheduler.request('background-3')
    scheduler.request('active')
    await vi.advanceTimersByTimeAsync(100)

    // Why: the foreground must never queue behind background work, even when every
    // background lane is occupied and more hosts are still waiting.
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'background-1',
      'background-2',
      'active'
    ])

    scheduler.stop()
    pending.forEach((entry) => entry.resolve())
  })

  it('admits a queued host when it becomes prioritized', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    const refresh = vi.fn((environmentId: string) => {
      const next = createPendingRefresh()
      pending.set(environmentId, next)
      return next.promise
    })
    let activeEnvironmentId = 'none'
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 2,
      getPrioritizedEnvironmentId: () => activeEnvironmentId
    })

    scheduler.request('background')
    scheduler.request('next-active')
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual(['background'])

    activeEnvironmentId = 'next-active'
    scheduler.reprioritize()
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'background',
      'next-active'
    ])

    scheduler.stop()
    pending.get('background')?.resolve()
    pending.get('next-active')?.resolve()
  })

  it('admits newly prioritized work before an earlier background waiter', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    const refresh = vi.fn((environmentId: string) => {
      const next = createPendingRefresh()
      pending.set(environmentId, next)
      return next.promise
    })
    let activeEnvironmentId = 'active-1'
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 2,
      getPrioritizedEnvironmentId: () => activeEnvironmentId
    })

    for (const environmentId of [
      'active-1',
      'background-running',
      'background-waiting',
      'active-2'
    ]) {
      scheduler.request(environmentId)
    }
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'active-1',
      'background-running'
    ])

    activeEnvironmentId = 'active-2'
    scheduler.reprioritize()
    pending.get('background-running')?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'active-1',
      'background-running',
      'active-2'
    ])

    scheduler.stop()
    pending.get('active-1')?.resolve()
    pending.get('active-2')?.resolve()
  })

  it('reclassifies the old foreground before admitting more background work', async () => {
    const pending = new Map<string, ReturnType<typeof createPendingRefresh>>()
    const refresh = vi.fn((environmentId: string) => {
      const next = createPendingRefresh()
      pending.set(environmentId, next)
      return next.promise
    })
    let activeEnvironmentId = 'active-1'
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 2,
      getPrioritizedEnvironmentId: () => activeEnvironmentId
    })

    scheduler.request('active-1')
    scheduler.request('background-running')
    scheduler.request('background-waiting')
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'active-1',
      'background-running'
    ])

    activeEnvironmentId = 'active-2'
    scheduler.reprioritize()
    pending.get('background-running')?.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)

    scheduler.request('active-2')
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'active-1',
      'background-running',
      'active-2'
    ])

    scheduler.stop()
    pending.get('active-1')?.resolve()
    pending.get('active-2')?.resolve()
  })

  it('coalesces queued requests and puts an in-flight follow-up behind waiting hosts', async () => {
    const calls: { environmentId: string; pending: ReturnType<typeof createPendingRefresh> }[] = []
    const isEnvironmentDesired = vi.fn(() => true)
    const getPrioritizedEnvironmentId = vi.fn(() => null)
    const refresh = vi.fn((environmentId: string) => {
      const pending = createPendingRefresh()
      calls.push({ environmentId, pending })
      return pending.promise
    })
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 1,
      isEnvironmentDesired,
      getPrioritizedEnvironmentId
    })

    scheduler.request('env-1')
    scheduler.request('env-2')
    scheduler.request('env-2')
    await vi.advanceTimersByTimeAsync(100)
    const desiredChecks = isEnvironmentDesired.mock.calls.length
    const priorityChecks = getPrioritizedEnvironmentId.mock.calls.length
    scheduler.request('env-2')
    scheduler.request('env-2')
    scheduler.request('env-1')
    scheduler.request('env-1')
    expect(isEnvironmentDesired).toHaveBeenCalledTimes(desiredChecks)
    expect(getPrioritizedEnvironmentId).toHaveBeenCalledTimes(priorityChecks)

    calls[0].pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual(['env-1', 'env-2'])

    scheduler.request('env-3')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    calls[1].pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'env-1',
      'env-2',
      'env-3'
    ])

    calls[2].pending.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual([
      'env-1',
      'env-2',
      'env-3',
      'env-1'
    ])

    scheduler.stop()
    calls[3].pending.resolve()
  })

  it('releases capacity after failure and skips hosts removed before admission', async () => {
    const first = createPendingRefresh()
    const third = createPendingRefresh()
    const desired = new Set(['env-1', 'env-2', 'env-3'])
    const onError = vi.fn()
    const refresh = vi.fn(async (environmentId: string) => {
      if (environmentId === 'env-1') {
        await first.promise
        throw new Error('offline')
      }
      await third.promise
    })
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 1,
      isEnvironmentDesired: (environmentId) => desired.has(environmentId),
      onError
    })

    scheduler.request('env-1')
    scheduler.request('env-2')
    scheduler.request('env-3')
    await vi.advanceTimersByTimeAsync(100)
    desired.delete('env-2')
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(onError).toHaveBeenCalledOnce()
    expect(refresh.mock.calls.map(([environmentId]) => environmentId)).toEqual(['env-1', 'env-3'])

    scheduler.stop()
    third.resolve()
  })

  it('does not admit queued or follow-up work after stop', async () => {
    const first = createPendingRefresh()
    const refresh = vi.fn(() => first.promise)
    const scheduler = createRuntimeProjectRefreshScheduler({
      refresh,
      debounceMs: 100,
      minIntervalMs: 1_000,
      maxConcurrentRefreshes: 1
    })

    scheduler.request('env-1')
    scheduler.request('env-2')
    await vi.advanceTimersByTimeAsync(100)
    scheduler.request('env-1')
    scheduler.stop()
    first.resolve()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
