import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyCachedGitStatusLineStats,
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCache,
  readCachedGitBranchLineTotal,
  reuseOrRecomputeGitStatusLineStats,
  storeGitStatusLineStats
} from './git-status-line-stats-cache'
import type { GitBranchLineTotal } from './git-status-types'

const CACHE_KEY = 'native\0/repo'
const MERGE_BASE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4'
const OTHER_MERGE_BASE = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'
const TOTAL: GitBranchLineTotal = { added: 12, removed: 3, mergeBase: MERGE_BASE }

function entries(added?: number): { path: string; status: string; area: string; added?: number }[] {
  return [{ path: 'src/a.ts', status: 'modified', area: 'unstaged', ...(added ? { added } : {}) }]
}

function seedSnapshot(branchLineTotal?: GitBranchLineTotal): void {
  storeGitStatusLineStats({
    cacheKey: CACHE_KEY,
    head: 'head-1',
    entries: entries(3),
    ...(branchLineTotal ? { branchLineTotal } : {})
  })
}

describe('branch line total inside the status line-stats cache', () => {
  beforeEach(() => {
    clearGitStatusLineStatsCache()
  })

  it('costs nothing when the caller did not ask for a total', async () => {
    const recompute = vi.fn(async () => true)

    const result = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: false,
      isAborted: () => false,
      recompute
    })

    expect(result).toEqual({})
    expect(recompute).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached total on a line-stats reuse hit without re-running the diff', async () => {
    seedSnapshot(TOTAL)
    const compute = vi.fn(async () => TOTAL)
    const recompute = vi.fn(async () => true)

    const result = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: true,
      isAborted: () => false,
      recompute,
      branchLineTotal: { mergeBase: MERGE_BASE, compute }
    })

    expect(result).toEqual({ branchLineTotal: TOTAL })
    expect(compute).not.toHaveBeenCalled()
    expect(recompute).not.toHaveBeenCalled()
  })

  it('recomputes and backfills when the snapshot has no total for this fork point', async () => {
    seedSnapshot({ added: 99, removed: 99, mergeBase: OTHER_MERGE_BASE })
    const compute = vi.fn(async () => TOTAL)

    const first = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: true,
      isAborted: () => false,
      recompute: async () => true,
      branchLineTotal: { mergeBase: MERGE_BASE, compute }
    })
    const second = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: true,
      isAborted: () => false,
      recompute: async () => true,
      branchLineTotal: { mergeBase: MERGE_BASE, compute }
    })

    expect(first).toEqual({ branchLineTotal: TOTAL })
    expect(second).toEqual({ branchLineTotal: TOTAL })
    expect(compute).toHaveBeenCalledTimes(1)
    expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toEqual(
      TOTAL
    )
  })

  it('never serves a cached total that was measured against another fork point', () => {
    seedSnapshot(TOTAL)

    expect(
      readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: OTHER_MERGE_BASE })
    ).toBeUndefined()
  })

  it('starts the ranged diff before waiting on the per-area numstat', async () => {
    const order: string[] = []
    let releaseRecompute = (): void => {}
    const recomputeGate = new Promise<void>((resolve) => {
      releaseRecompute = resolve
    })

    const pending = reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: false,
      isAborted: () => false,
      recompute: async () => {
        order.push('recompute')
        await recomputeGate
        return true
      },
      branchLineTotal: {
        mergeBase: MERGE_BASE,
        compute: async () => {
          order.push('compute')
          return TOTAL
        }
      }
    })
    releaseRecompute()

    expect(await pending).toEqual({ branchLineTotal: TOTAL })
    expect(order).toEqual(['compute', 'recompute'])
  })

  it('keeps the exact total when the per-area numstat pass failed', async () => {
    const result = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: false,
      isAborted: () => false,
      recompute: async () => false,
      branchLineTotal: { mergeBase: MERGE_BASE, compute: async () => TOTAL }
    })

    expect(result).toEqual({ branchLineTotal: TOTAL })
    // The incomplete pass stays uncacheable, so nothing was pinned for reuse.
    expect(
      applyCachedGitStatusLineStats({ cacheKey: CACHE_KEY, head: 'head-1', entries: entries() })
    ).toBe(false)
  })

  it('omits the field entirely when the total could not be known exact', async () => {
    const result = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries: entries(4),
      writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
      reuse: false,
      isAborted: () => false,
      recompute: async () => true,
      branchLineTotal: { mergeBase: MERGE_BASE, compute: async () => undefined }
    })

    expect(result).toEqual({})
    expect('branchLineTotal' in result).toBe(false)
    expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toBe(
      undefined
    )
  })

  it('rejects instead of returning a partial total when the pass aborts mid-diff', async () => {
    let aborted = false

    await expect(
      reuseOrRecomputeGitStatusLineStats({
        cacheKey: CACHE_KEY,
        head: 'head-1',
        entries: entries(),
        writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
        reuse: false,
        isAborted: () => aborted,
        recompute: async () => true,
        branchLineTotal: {
          mergeBase: MERGE_BASE,
          compute: async () => {
            aborted = true
            const error = new Error('The operation was aborted.')
            error.name = 'AbortError'
            throw error
          }
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toBe(
      undefined
    )
  })

  it('rejects a reuse hit whose backfill compute is aborted', async () => {
    seedSnapshot()
    let aborted = false

    await expect(
      reuseOrRecomputeGitStatusLineStats({
        cacheKey: CACHE_KEY,
        head: 'head-1',
        entries: entries(),
        writeToken: beginGitStatusLineStatsCacheWrite(CACHE_KEY),
        reuse: true,
        isAborted: () => aborted,
        recompute: async () => true,
        branchLineTotal: {
          mergeBase: MERGE_BASE,
          compute: async () => {
            aborted = true
            return TOTAL
          }
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
