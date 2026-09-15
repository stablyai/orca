import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '../../github/cache-model'
import {
  CACHE_EVICTION_MAX_AGE,
  MAX_CACHE_ENTRIES,
  TEAM_CACHE_TTL,
  evictStaleEntries,
  isFresh
} from './linear-cache'

const NOW = new Date('2026-01-01T00:00:00Z').getTime()
const entry = (ageMs: number): CacheEntry<string> => ({ data: 'x', fetchedAt: NOW - ageMs })

describe('evictStaleEntries adversarial', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  it('evicts exactly at the horizon and keeps one ms under it', () => {
    const out = evictStaleEntries({
      at: entry(CACHE_EVICTION_MAX_AGE),
      under: entry(CACHE_EVICTION_MAX_AGE - 1)
    })
    expect(Object.keys(out).sort()).toEqual(['under'])
  })

  it('never evicts anything a TEAM_CACHE_TTL read would still call fresh', () => {
    for (const age of [0, 1, TEAM_CACHE_TTL - 2, TEAM_CACHE_TTL - 1]) {
      const cache = { k: entry(age) }
      expect(isFresh(cache.k, TEAM_CACHE_TTL)).toBe(true)
      expect(evictStaleEntries(cache)).toHaveProperty('k')
    }
  })

  it('drops malformed fetchedAt (undefined / NaN / null)', () => {
    const cache = {
      undef: { data: 'x' } as unknown as CacheEntry<string>,
      nan: { data: 'x', fetchedAt: Number.NaN } as CacheEntry<string>,
      nul: { data: 'x', fetchedAt: null } as unknown as CacheEntry<string>,
      ok: entry(0)
    }
    expect(Object.keys(evictStaleEntries(cache))).toEqual(['ok'])
  })

  it('keeps entries stamped in the future (clock stepped backwards)', () => {
    expect(evictStaleEntries({ future: entry(-60 * 60_000) })).toHaveProperty('future')
  })

  it('returns a NEW object (not identity) when everything is age-evicted', () => {
    const cache = { old: entry(CACHE_EVICTION_MAX_AGE + 1) }
    const out = evictStaleEntries(cache)
    expect(Object.is(out, cache)).toBe(false)
    expect(out).toEqual({})
  })

  it('preserves identity at exactly MAX_CACHE_ENTRIES with all entries live', () => {
    const cache: Record<string, CacheEntry<string>> = {}
    for (let i = 0; i < MAX_CACHE_ENTRIES; i += 1) {
      cache[`k${i}`] = entry(i)
    }
    expect(Object.is(evictStaleEntries(cache), cache)).toBe(true)
  })

  it('preserves identity on the empty cache', () => {
    const cache: Record<string, CacheEntry<string>> = {}
    expect(Object.is(evictStaleEntries(cache), cache)).toBe(true)
  })

  it('age pass never loses a newer entry the count-cap-only policy would have kept', () => {
    const cache: Record<string, CacheEntry<string>> = {}
    for (let i = 0; i < MAX_CACHE_ENTRIES + 50; i += 1) {
      cache[`k${i}`] = entry(i * 1000) // k0 newest
    }
    const countCapOnly = Object.keys(cache)
      .sort((a, b) => cache[b].fetchedAt - cache[a].fetchedAt)
      .slice(0, MAX_CACHE_ENTRIES)
    const pruned = evictStaleEntries(cache)
    for (const key of Object.keys(pruned)) {
      expect(countCapOnly).toContain(key)
    }
    expect(Object.keys(pruned)).toHaveLength(MAX_CACHE_ENTRIES)
  })

  it('does not mutate the input cache', () => {
    const cache = { a: entry(0), b: entry(CACHE_EVICTION_MAX_AGE + 1) }
    const before = { ...cache }
    evictStaleEntries(cache)
    expect(cache).toEqual(before)
  })

  it('honours an explicit maxAgeMs override', () => {
    const out = evictStaleEntries({ a: entry(0), b: entry(5_000) }, MAX_CACHE_ENTRIES, 1_000)
    expect(Object.keys(out)).toEqual(['a'])
  })

  it('count cap still keeps the newest when all entries are within the horizon', () => {
    const cache: Record<string, CacheEntry<string>> = {}
    for (let i = 0; i < MAX_CACHE_ENTRIES + 1; i += 1) {
      cache[`k${i}`] = entry(i)
    }
    const pruned = evictStaleEntries(cache)
    expect(Object.keys(pruned)).toHaveLength(MAX_CACHE_ENTRIES)
    expect(pruned).toHaveProperty('k0')
    expect(pruned).not.toHaveProperty(`k${MAX_CACHE_ENTRIES}`)
  })
})
