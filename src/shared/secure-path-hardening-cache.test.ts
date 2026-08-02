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
