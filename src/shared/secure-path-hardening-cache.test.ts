import { describe, expect, it } from 'vitest'
import { SecurePathHardeningCache } from './secure-path-hardening-cache'

describe('SecurePathHardeningCache', () => {
  it('accepts a UTF-8 key at the exact per-key boundary', () => {
    const cache = new SecurePathHardeningCache<number>({
      maxEntries: 2,
      maxKeyBytes: 6,
      maxTotalKeyBytes: 6
    })

    expect(cache.set('界界', 1)).toBe(true)
    expect(cache.get('界界')).toBe(1)
    expect(cache.state()).toMatchObject({ entries: 1, keyBytes: 6 })
  })

  it('rejects one byte beyond the per-key boundary without evicting retained state', () => {
    const cache = new SecurePathHardeningCache<number>({
      maxEntries: 2,
      maxKeyBytes: 6,
      maxTotalKeyBytes: 12
    })
    cache.set('kept', 1)

    expect(cache.set('1234567', 2)).toBe(false)
    expect(cache.state().paths).toEqual(['kept'])
  })

  it('evicts the least-recently-used entry at the count boundary', () => {
    const cache = new SecurePathHardeningCache<number>({
      maxEntries: 2,
      maxKeyBytes: 32,
      maxTotalKeyBytes: 64
    })
    cache.set('old', 1)
    cache.set('hot', 2)
    expect(cache.get('old')).toBe(1)

    cache.set('new', 3)

    expect(cache.state().paths).toEqual(['old', 'new'])
    expect(cache.get('hot')).toBeUndefined()
  })

  it('stays disabled when no entries are allowed', () => {
    // A non-positive ceiling means "do not cache", not "cache one" — the underlying map has no
    // zero-capacity mode, so the wrapper has to short-circuit.
    for (const maxEntries of [0, -5]) {
      const cache = new SecurePathHardeningCache<number>({
        maxEntries,
        maxKeyBytes: 32,
        maxTotalKeyBytes: 64
      })

      expect(cache.set('path', 1)).toBe(false)
      expect(cache.get('path')).toBeUndefined()
      expect(cache.state()).toEqual({ entries: 0, keyBytes: 0, paths: [] })
    }
  })

  it('rejects a key over the aggregate ceiling even when the per-key ceiling is looser', () => {
    const cache = new SecurePathHardeningCache<number>({
      maxEntries: 5,
      maxKeyBytes: 1_000,
      maxTotalKeyBytes: 10
    })

    expect(cache.set('x'.repeat(11), 1)).toBe(false)
    expect(cache.state().entries).toBe(0)
  })

  it('evicts LRU entries until aggregate UTF-8 key bytes fit', () => {
    const cache = new SecurePathHardeningCache<number>({
      maxEntries: 10,
      maxKeyBytes: 12,
      maxTotalKeyBytes: 12
    })
    cache.set('aaaa', 1)
    cache.set('bbbb', 2)

    expect(cache.set('界界', 3)).toBe(true)
    expect(cache.state()).toEqual({
      entries: 2,
      keyBytes: 10,
      paths: ['bbbb', '界界']
    })
  })
})
