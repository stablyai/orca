import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '../../github/cache-model'
import {
  CACHE_EVICTION_MAX_AGE,
  CACHE_TTL,
  MAX_CACHE_ENTRIES,
  TEAM_CACHE_TTL,
  evictStaleEntries,
  isFresh
} from './linear-cache'

const NOW = new Date('2026-01-01T00:00:00Z').getTime()

function entry(ageMs: number): CacheEntry<string> {
  return { data: 'payload', fetchedAt: NOW - ageMs }
}

describe('evictStaleEntries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops entries older than the eviction horizon and keeps newer ones', () => {
    const pruned = evictStaleEntries({
      recent: entry(1_000),
      ancient: entry(CACHE_EVICTION_MAX_AGE + 1_000)
    })
    expect(Object.keys(pruned)).toEqual(['recent'])
  })

  it('keeps entries a team read would still accept as fresh', () => {
    const midAge = entry(TEAM_CACHE_TTL - 60_000)
    expect(isFresh(midAge, TEAM_CACHE_TTL)).toBe(true)
    expect(isFresh(midAge)).toBe(false) // stale for the default read TTL, still worth retaining
    expect(evictStaleEntries({ midAge })).toHaveProperty('midAge')
  })

  it('still enforces the count cap after age eviction, dropping oldest first', () => {
    const cache: Record<string, CacheEntry<string>> = {}
    for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i += 1) {
      cache[`key-${i}`] = entry(i) // key-0 newest, higher index older
    }
    cache.ancient = entry(CACHE_EVICTION_MAX_AGE + 1_000)

    const pruned = evictStaleEntries(cache)

    expect(Object.keys(pruned)).toHaveLength(MAX_CACHE_ENTRIES)
    expect(pruned).not.toHaveProperty('ancient')
    expect(pruned).toHaveProperty('key-0')
    expect(pruned).not.toHaveProperty(`key-${MAX_CACHE_ENTRIES + 9}`)
  })

  it('returns the same reference when nothing is evicted', () => {
    const cache = { recent: entry(CACHE_TTL + 1_000) }
    expect(evictStaleEntries(cache)).toBe(cache)
  })
})
