import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyCachedGitStatusLineStats,
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCache,
  clearGitStatusLineStatsCacheKey,
  GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS,
  reuseOrRecomputeGitStatusLineStats,
  storeGitStatusLineStats
} from './git-status-line-stats-cache'

const cachedEntries = [
  {
    path: 'src/a.ts',
    status: 'modified',
    area: 'unstaged',
    added: 3,
    removed: 2
  }
]

describe('git status line stats cache', () => {
  beforeEach(() => {
    clearGitStatusLineStatsCache()
  })

  it('reuses counts only for an exact head and status-entry identity', () => {
    storeGitStatusLineStats({ cacheKey: 'native\0/repo', head: 'head-1', entries: cachedEntries })
    const matchingEntries = [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }]

    expect(
      applyCachedGitStatusLineStats({
        cacheKey: 'native\0/repo',
        head: 'head-1',
        entries: matchingEntries
      })
    ).toBe(true)
    expect(matchingEntries).toEqual(cachedEntries)

    expect(
      applyCachedGitStatusLineStats({
        cacheKey: 'native\0/repo',
        head: 'head-2',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }]
      })
    ).toBe(false)
  })

  it('invalidates a matching status identity at the bounded age', () => {
    storeGitStatusLineStats({
      cacheKey: 'native\0/repo',
      head: 'head-1',
      entries: cachedEntries,
      now: 1_000
    })

    expect(
      applyCachedGitStatusLineStats({
        cacheKey: 'native\0/repo',
        head: 'head-1',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }],
        now: 1_000 + GIT_STATUS_LINE_STATS_CACHE_MAX_AGE_MS
      })
    ).toBe(false)
  })

  it('isolates execution-host keys and supports mutation invalidation', () => {
    storeGitStatusLineStats({
      cacheKey: 'wsl:ubuntu\0/repo',
      head: 'head-1',
      entries: cachedEntries
    })

    expect(
      applyCachedGitStatusLineStats({
        cacheKey: 'wsl:debian\0/repo',
        head: 'head-1',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }]
      })
    ).toBe(false)

    clearGitStatusLineStatsCacheKey('wsl:ubuntu\0/repo')
    expect(
      applyCachedGitStatusLineStats({
        cacheKey: 'wsl:ubuntu\0/repo',
        head: 'head-1',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }]
      })
    ).toBe(false)
  })

  it('lets an earlier recompute store after a later reuse-only read began', () => {
    const recomputeWrite = beginGitStatusLineStatsCacheWrite('native\0/repo')
    // A hinted safety read begins later, reuses, and never stores; it must not
    // starve the older recompute's store.
    beginGitStatusLineStatsCacheWrite('native\0/repo')
    storeGitStatusLineStats({
      cacheKey: 'native\0/repo',
      head: 'head-1',
      entries: cachedEntries,
      writeToken: recomputeWrite
    })

    const entries: { path: string; status: string; area: string; added?: number }[] = [
      { path: 'src/a.ts', status: 'modified', area: 'unstaged' }
    ]
    expect(
      applyCachedGitStatusLineStats({ cacheKey: 'native\0/repo', head: 'head-1', entries })
    ).toBe(true)
    expect(entries[0]?.added).toBe(3)
  })

  it('keeps a prior good snapshot reusable when an overlapping recompute is aborted', async () => {
    // A completed scan stored healthy counts.
    storeGitStatusLineStats({ cacheKey: 'native\0/repo', head: 'head-1', entries: cachedEntries })

    // A later scan begins and recomputes but is aborted before it can store.
    const abortedWrite = beginGitStatusLineStatsCacheWrite('native\0/repo')
    let aborted = false
    await expect(
      reuseOrRecomputeGitStatusLineStats({
        cacheKey: 'native\0/repo',
        head: 'head-1',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }],
        writeToken: abortedWrite,
        reuse: false,
        isAborted: () => aborted,
        recompute: async () => {
          aborted = true
          return true
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' })

    // The aborted pass persisted nothing, so it must not evict the healthy
    // snapshot — a following safety read still reuses the stored counts.
    const entries: { path: string; status: string; area: string; added?: number }[] = [
      { path: 'src/a.ts', status: 'modified', area: 'unstaged' }
    ]
    expect(
      applyCachedGitStatusLineStats({ cacheKey: 'native\0/repo', head: 'head-1', entries })
    ).toBe(true)
    expect(entries[0]?.added).toBe(3)
  })

  it('rejects a reuse-only read that is already aborted', async () => {
    storeGitStatusLineStats({ cacheKey: 'native\0/repo', head: 'head-1', entries: cachedEntries })
    const writeToken = beginGitStatusLineStatsCacheWrite('native\0/repo')
    await expect(
      reuseOrRecomputeGitStatusLineStats({
        cacheKey: 'native\0/repo',
        head: 'head-1',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }],
        writeToken,
        reuse: true,
        isAborted: () => true,
        recompute: async () => true
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects stale cache writes and writes started before invalidation', () => {
    const olderWrite = beginGitStatusLineStatsCacheWrite('native\0/repo')
    const latestWrite = beginGitStatusLineStatsCacheWrite('native\0/repo')
    storeGitStatusLineStats({
      cacheKey: 'native\0/repo',
      head: 'head-1',
      entries: [{ ...cachedEntries[0], added: 8 }],
      writeToken: latestWrite
    })
    storeGitStatusLineStats({
      cacheKey: 'native\0/repo',
      head: 'head-1',
      entries: cachedEntries,
      writeToken: olderWrite
    })
    const entries: { path: string; status: string; area: string; added?: number }[] = [
      { path: 'src/a.ts', status: 'modified', area: 'unstaged' }
    ]

    expect(
      applyCachedGitStatusLineStats({ cacheKey: 'native\0/repo', head: 'head-1', entries })
    ).toBe(true)
    expect(entries[0]?.added).toBe(8)

    const invalidatedWrite = beginGitStatusLineStatsCacheWrite('native\0/other')
    clearGitStatusLineStatsCache()
    storeGitStatusLineStats({
      cacheKey: 'native\0/other',
      head: 'head-1',
      entries: cachedEntries,
      writeToken: invalidatedWrite
    })
    expect(
      applyCachedGitStatusLineStats({
        cacheKey: 'native\0/other',
        head: 'head-1',
        entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }]
      })
    ).toBe(false)
  })
})
