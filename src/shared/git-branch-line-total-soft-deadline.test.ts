import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_BRANCH_LINE_TOTAL_SOFT_DEADLINE_MS } from './git-branch-line-total'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCache,
  readCachedGitBranchLineTotal,
  reuseOrRecomputeGitStatusLineStats
} from './git-status-line-stats-cache'

const MERGE_BASE = 'a'.repeat(40)
const CACHE_KEY = 'native\0/repo'
const entries = [{ path: 'a.txt', area: 'unstaged', status: 'M', added: 1, removed: 0 }]

async function runPass(diffDelayMs: number): Promise<{ elapsed: number; total: unknown }> {
  const cacheKey = CACHE_KEY
  const started = Date.now()
  const result = await reuseOrRecomputeGitStatusLineStats({
    cacheKey,
    head: 'head-1',
    entries,
    writeToken: beginGitStatusLineStatsCacheWrite(cacheKey),
    reuse: false,
    isAborted: () => false,
    recompute: async () => true,
    branchLineTotal: {
      mergeBase: MERGE_BASE,
      compute: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ added: 5, removed: 5, mergeBase: MERGE_BASE }), diffDelayMs)
        )
    }
  })
  return { elapsed: Date.now() - started, total: result.branchLineTotal }
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
})
