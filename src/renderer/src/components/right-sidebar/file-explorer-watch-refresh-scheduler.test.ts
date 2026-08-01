import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileExplorerWatchRefreshScheduler } from './file-explorer-watch-refresh-scheduler'
import type { FileExplorerTreeRefreshOutcome } from './file-explorer-types'

const TRAILING_MS = 150
const MAX_WAIT_MS = 500

function createDeferred(): {
  promise: Promise<FileExplorerTreeRefreshOutcome>
  resolve: (outcome?: FileExplorerTreeRefreshOutcome) => void
} {
  let resolve!: (outcome?: FileExplorerTreeRefreshOutcome) => void
  const promise = new Promise<FileExplorerTreeRefreshOutcome>((res) => {
    resolve = (outcome = 'refreshed') => res(outcome)
  })
  return { promise, resolve }
}

function setup(
  overrides: Partial<Parameters<typeof createFileExplorerWatchRefreshScheduler>[0]> = {}
) {
  const { refreshTree: treeImpl, refreshDir: dirImpl, ...rest } = overrides
  const refreshTree = vi.fn(
    treeImpl ?? (async (): Promise<FileExplorerTreeRefreshOutcome> => 'refreshed')
  )
  const refreshDir = vi.fn(dirImpl ?? (async (_dirPath: string) => {}))
  const scheduler = createFileExplorerWatchRefreshScheduler({
    refreshTree,
    refreshDir,
    isCoveredByFullRefresh: () => false,
    dirConcurrency: 4,
    ...rest
  })
  return { refreshTree, refreshDir, scheduler }
}

describe('createFileExplorerWatchRefreshScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces a burst of full-refresh requests into one tree refresh', async () => {
    const { refreshTree, scheduler } = setup()

    for (let index = 0; index < 20; index++) {
      scheduler.requestFullRefresh()
    }
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshTree).toHaveBeenCalledTimes(1)
  })

  it('flushes at the max wait even when requests keep arriving inside the trailing window', async () => {
    const { refreshTree, scheduler } = setup()

    scheduler.requestFullRefresh()
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(100)
      scheduler.requestFullRefresh()
    }
    expect(refreshTree).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 400)

    expect(refreshTree).toHaveBeenCalledTimes(1)
  })

  it('dedupes dir refreshes that differ only in path spelling', async () => {
    const { refreshDir, scheduler } = setup()

    // Spellings only the runtime-path normalizer folds: Windows separators and a
    // trailing slash. Raw-string keying would issue three reads of one dir.
    scheduler.requestDirRefresh('C:/repo/src/')
    scheduler.requestDirRefresh('C:\\repo\\src')
    scheduler.requestDirRefresh('C:/repo/src')
    scheduler.requestDirRefresh('/repo/docs/')
    scheduler.requestDirRefresh('/repo/docs')
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshDir).toHaveBeenCalledTimes(2)
    expect(refreshDir.mock.calls.map(([dirPath]) => dirPath)).toEqual(['C:/repo/src', '/repo/docs'])
  })

  it('still refreshes a pending dir that a full refresh does not cover', async () => {
    // Regression guard: dirCache keys are a strict superset of expanded dirs, so
    // a full refresh must not subsume pending dir refreshes.
    const { refreshTree, refreshDir, scheduler } = setup()

    scheduler.requestDirRefresh('/repo/collapsed')
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(refreshDir).toHaveBeenCalledTimes(1)
    expect(refreshDir).toHaveBeenCalledWith('/repo/collapsed')
  })

  it('skips a pending dir the full refresh already re-read', async () => {
    const { refreshTree, refreshDir, scheduler } = setup({
      isCoveredByFullRefresh: (dirPath) => dirPath === '/repo/src'
    })

    scheduler.requestDirRefresh('/repo/src')
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('re-issues covered dir refreshes when the tree refresh was superseded', async () => {
    // Regression guard: refreshTree bails without re-reading the expanded dirs when its root
    // load is superseded. Nothing marks an expanded dir stale, so dropping these would leave
    // them stale until a manual refresh — collapse/re-expand does not heal it.
    const gate = createDeferred()
    const { refreshDir, scheduler } = setup({
      refreshTree: () => gate.promise,
      isCoveredByFullRefresh: (dirPath) => dirPath === '/repo/src'
    })

    scheduler.requestDirRefresh('/repo/src')
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    gate.resolve('superseded')
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshDir).toHaveBeenCalledTimes(1)
    expect(refreshDir).toHaveBeenCalledWith('/repo/src')
  })

  it('drops pending dir refreshes when the tree refresh could not read the root', async () => {
    // Regression guard: a failed root read means the transport is down, so re-issuing buys one
    // dead timeout per dir and holds inFlight open, blocking every later refresh.
    const gate = createDeferred()
    const { refreshDir, scheduler } = setup({
      refreshTree: () => gate.promise,
      isCoveredByFullRefresh: () => false
    })

    scheduler.requestDirRefresh('/repo/src')
    scheduler.requestDirRefresh('/repo/docs')
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    gate.resolve('root-unreadable')
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)

    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('refreshes a covered dir when no full refresh is pending', async () => {
    const { refreshTree, refreshDir, scheduler } = setup({
      isCoveredByFullRefresh: () => true
    })

    scheduler.requestDirRefresh('/repo/src')
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshTree).not.toHaveBeenCalled()
    expect(refreshDir).toHaveBeenCalledTimes(1)
  })

  it('does not start a second run while the first is still in flight', async () => {
    const gate = createDeferred()
    const { refreshTree, scheduler } = setup({ refreshTree: () => gate.promise })

    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)
    expect(refreshTree).toHaveBeenCalledTimes(1)

    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    expect(refreshTree).toHaveBeenCalledTimes(1)

    gate.resolve()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshTree).toHaveBeenCalledTimes(2)
  })

  it('flushes a dir request that arrived during an in-flight run', async () => {
    const gate = createDeferred()
    const { refreshDir, scheduler } = setup({ refreshTree: () => gate.promise })

    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    scheduler.requestDirRefresh('/repo/late')
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    expect(refreshDir).not.toHaveBeenCalled()

    gate.resolve()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshDir).toHaveBeenCalledTimes(1)
    expect(refreshDir).toHaveBeenCalledWith('/repo/late')
  })

  it('never runs more dir refreshes at once than dirConcurrency', async () => {
    let inFlight = 0
    let peakInFlight = 0
    const refreshDir = vi.fn(async (_dirPath: string) => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight--
    })
    const { scheduler } = setup({ refreshDir, dirConcurrency: 4 })

    for (let index = 0; index < 20; index++) {
      scheduler.requestDirRefresh(`/repo/d${index}`)
    }
    await vi.advanceTimersByTimeAsync(TRAILING_MS + 20 * 10)

    expect(refreshDir).toHaveBeenCalledTimes(20)
    expect(peakInFlight).toBeLessThanOrEqual(4)
  })

  it('cancels a pending flush', async () => {
    const { refreshTree, refreshDir, scheduler } = setup()

    scheduler.requestFullRefresh()
    scheduler.requestDirRefresh('/repo/src')
    scheduler.cancel()
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)

    expect(refreshTree).not.toHaveBeenCalled()
    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('stops refreshing queued dirs when cancelled mid-run', async () => {
    // Regression guard: refreshDir is bound to a live ref that React reassigns
    // before the effect cleanup runs, so a queued path surviving cancel() would
    // be read against the NEXT worktree's binding.
    const gate = createDeferred()
    const refreshDir = vi.fn(async (dirPath: string) => {
      if (dirPath === '/repo/d0') {
        await gate.promise
      }
    })
    const { scheduler } = setup({ refreshDir, dirConcurrency: 1 })

    for (let index = 0; index < 4; index++) {
      scheduler.requestDirRefresh(`/repo/d${index}`)
    }
    await vi.advanceTimersByTimeAsync(TRAILING_MS)
    expect(refreshDir).toHaveBeenCalledTimes(1)

    scheduler.cancel()
    gate.resolve()
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)

    expect(refreshDir).toHaveBeenCalledTimes(1)
  })

  it('still refreshes a dir first expanded while the tree refresh was in flight', async () => {
    const gate = createDeferred()
    const expanded = new Set<string>()
    const { refreshDir, scheduler } = setup({
      refreshTree: () => gate.promise,
      isCoveredByFullRefresh: (dirPath) => expanded.has(dirPath)
    })

    scheduler.requestDirRefresh('/repo/late')
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    // refreshTree already ran against the old expanded set, so this dir was
    // never re-read and its pending refresh must survive.
    expanded.add('/repo/late')
    gate.resolve()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(refreshDir).toHaveBeenCalledTimes(1)
    expect(refreshDir).toHaveBeenCalledWith('/repo/late')
  })

  it('drops a dir queued during an in-flight run when cancel lands first', async () => {
    const gate = createDeferred()
    const { refreshTree, refreshDir, scheduler } = setup({ refreshTree: () => gate.promise })

    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)
    scheduler.requestDirRefresh('/repo/src')
    scheduler.cancel()

    gate.resolve()
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)

    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(refreshDir).not.toHaveBeenCalled()
  })

  it('uses the injected timer functions', async () => {
    const schedule = vi.fn((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
    const clear = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer)
    })
    const { refreshTree, scheduler } = setup({ schedule, clear })

    scheduler.requestFullRefresh()
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(schedule).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(refreshTree).toHaveBeenCalledTimes(1)
  })

  it('keeps a full refresh ahead of the dir refreshes it does not cover', async () => {
    const order: string[] = []
    const { scheduler } = setup({
      refreshTree: async (): Promise<FileExplorerTreeRefreshOutcome> => {
        order.push('tree')
        return 'refreshed'
      },
      refreshDir: async (dirPath) => {
        order.push(dirPath)
      }
    })

    scheduler.requestDirRefresh('/repo/collapsed')
    scheduler.requestFullRefresh()
    await vi.advanceTimersByTimeAsync(TRAILING_MS)

    expect(order).toEqual(['tree', '/repo/collapsed'])
  })

  // Why: local workspaces pass a zero window because the main process already coalesced the burst
  // on the same 150/500 timings. Stacking a second debounce there only doubled paint latency.
  describe('zero window (local transport)', () => {
    const zeroWindow = { trailingMs: 0, maxWaitMs: 0 }

    it('flushes on the next tick instead of waiting out a trailing window', async () => {
      const { refreshTree, scheduler } = setup(zeroWindow)

      scheduler.requestFullRefresh()
      await vi.advanceTimersByTimeAsync(0)

      expect(refreshTree).toHaveBeenCalledTimes(1)
    })

    it('still coalesces one payload burst into a single refresh', async () => {
      const { refreshTree, refreshDir, scheduler } = setup(zeroWindow)

      for (let index = 0; index < 20; index++) {
        scheduler.requestFullRefresh()
        scheduler.requestDirRefresh('/repo/src')
      }
      await vi.advanceTimersByTimeAsync(0)

      expect(refreshTree).toHaveBeenCalledTimes(1)
      expect(refreshDir).toHaveBeenCalledTimes(1)
      expect(refreshDir).toHaveBeenCalledWith('/repo/src')
    })

    it('does not start a second run while one is in flight', async () => {
      const deferred = createDeferred()
      const { refreshTree, scheduler } = setup({
        ...zeroWindow,
        refreshTree: () => deferred.promise
      })

      scheduler.requestFullRefresh()
      await vi.advanceTimersByTimeAsync(0)
      scheduler.requestFullRefresh()
      await vi.advanceTimersByTimeAsync(0)

      expect(refreshTree).toHaveBeenCalledTimes(1)

      deferred.resolve()
      await vi.advanceTimersByTimeAsync(0)

      expect(refreshTree).toHaveBeenCalledTimes(2)
    })
  })
})
