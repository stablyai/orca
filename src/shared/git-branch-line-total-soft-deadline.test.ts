import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS } from './git-branch-line-total'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCache,
  readCachedGitBranchLineTotal,
  reuseOrRecomputeGitStatusLineStats,
  storeGitStatusLineStats,
  clearGitStatusLineStatsCacheKey
} from './git-status-line-stats-cache'

import type { GitBranchLineTotal } from './git-status-types'
const MERGE_BASE = 'a'.repeat(40)
const CACHE_KEY = 'native\0/repo'
const entries = [{ path: 'a.txt', area: 'unstaged', status: 'M', added: 1, removed: 0 }]
const TOTAL: GitBranchLineTotal = { added: 5, removed: 5, mergeBase: MERGE_BASE }

async function runPass(
  diffDelayMs: number,
  options: {
    total?: GitBranchLineTotal | null
    reuse?: boolean
    isAborted?: () => boolean
  } = {}
) {
  const cacheKey = CACHE_KEY
  const started = Date.now()
  const result = await reuseOrRecomputeGitStatusLineStats({
    cacheKey,
    head: 'head-1',
    entries,
    writeToken: beginGitStatusLineStatsCacheWrite(cacheKey),
    reuse: options.reuse === true,
    isAborted: options.isAborted ?? (() => false),
    recompute: async () => true,
    branchLineTotal: {
      mergeBase: MERGE_BASE,
      compute: () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve(options.total === undefined ? TOTAL : options.total),
            diffDelayMs
          )
        )
    }
  })
  return {
    elapsed: Date.now() - started,
    total: result.branchLineTotal,
    unavailable: result.branchLineTotalUnavailable
  }
}

describe('branch line total never blocks the status response', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearGitStatusLineStatsCache()
  })

  afterEach(() => {
    clearGitStatusLineStatsCache()
    vi.useRealTimers()
  })

  it('returns fast when the ranged diff is slow, then publishes it on the next pass', async () => {
    const slowPass = runPass(3000)
    await vi.advanceTimersByTimeAsync(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    const slow = await slowPass
    expect(slow.total).toBeUndefined()
    expect(slow.elapsed).toBe(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)

    // Let the first diff backfill before a second pass retires its write token.
    await vi.advanceTimersByTimeAsync(3000 - GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toEqual({
      added: 5,
      removed: 5,
      mergeBase: MERGE_BASE
    })
    const nextPass = runPass(3000)
    await vi.advanceTimersByTimeAsync(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    const next = await nextPass
    expect(next.total).toEqual({ added: 5, removed: 5, mergeBase: MERGE_BASE })
  })

  it('still returns the total inline when the diff is fast', async () => {
    const fastPass = runPass(10)
    await vi.advanceTimersByTimeAsync(10)
    const fast = await fastPass
    expect(fast.total).toEqual({ added: 5, removed: 5, mergeBase: MERGE_BASE })
    expect(fast.elapsed).toBe(10)
  })

  it('late unavailability removes an exact cached total and republishes its marker on reuse', async () => {
    storeGitStatusLineStats({
      cacheKey: CACHE_KEY,
      head: 'head-1',
      entries,
      branchLineTotal: TOTAL
    })
    const pending = runPass(3000, { total: null })
    await vi.advanceTimersByTimeAsync(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    expect(await pending).toMatchObject({ total: TOTAL, unavailable: undefined })

    await vi.advanceTimersByTimeAsync(3000 - GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toBeNull()
    expect(await runPass(3000, { reuse: true })).toMatchObject({
      total: undefined,
      unavailable: MERGE_BASE,
      elapsed: 0
    })
  })

  it('backfills late unavailability from a reuse pass with no cached total', async () => {
    storeGitStatusLineStats({ cacheKey: CACHE_KEY, head: 'head-1', entries })
    const pending = runPass(3000, { total: null, reuse: true })
    await vi.advanceTimersByTimeAsync(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    expect(await pending).toMatchObject({ total: undefined, unavailable: undefined })
    await vi.advanceTimersByTimeAsync(3000 - GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
    expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toBeNull()
  })

  it.each([
    { late: TOTAL, newer: null },
    { late: null, newer: TOTAL }
  ])(
    'keeps the newest reuse-only total outcome when an older diff resolves late: %j',
    async ({ late, newer }) => {
      storeGitStatusLineStats({ cacheKey: CACHE_KEY, head: 'head-1', entries })
      const pending = runPass(3000, { total: late, reuse: true })
      await vi.advanceTimersByTimeAsync(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
      expect((await pending).total).toBeUndefined()

      const next = runPass(0, { total: newer, reuse: true })
      await vi.advanceTimersByTimeAsync(0)
      await next
      await vi.advanceTimersByTimeAsync(3000 - GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
      expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toEqual(
        newer
      )
    }
  )

  it.each(['newer-store', 'key-invalidation', 'global-invalidation', 'abort'] as const)(
    'does not let late unavailability overwrite a newer exact total after %s',
    async (interruption) => {
      let aborted = false
      storeGitStatusLineStats({
        cacheKey: CACHE_KEY,
        head: 'head-1',
        entries,
        branchLineTotal: TOTAL
      })
      const pending = runPass(3000, { total: null, isAborted: () => aborted })
      await vi.advanceTimersByTimeAsync(GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
      expect((await pending).total).toEqual(TOTAL)

      if (interruption === 'key-invalidation') {
        clearGitStatusLineStatsCacheKey(CACHE_KEY)
      } else if (interruption === 'global-invalidation') {
        clearGitStatusLineStatsCache()
      } else if (interruption === 'abort') {
        aborted = true
      }
      const recovered = { ...TOTAL, added: 9 }
      if (interruption !== 'abort') {
        storeGitStatusLineStats({
          cacheKey: CACHE_KEY,
          head: 'head-1',
          entries,
          branchLineTotal: recovered
        })
      }
      await vi.advanceTimersByTimeAsync(3000 - GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS)
      expect(readCachedGitBranchLineTotal({ cacheKey: CACHE_KEY, mergeBase: MERGE_BASE })).toEqual(
        interruption === 'abort' ? TOTAL : recovered
      )
    }
  )
})
