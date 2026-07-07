import { describe, it, expect } from 'vitest'
import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  setBoundedScopeCacheEntry
} from './native-chat-composer-scope-cache'

describe('setBoundedScopeCacheEntry', () => {
  it('bounds the cache with LRU eviction, keeping re-set keys', () => {
    const cache = new Map<string, number>()
    setBoundedScopeCacheEntry(cache, 'keep', 1)

    const total = NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX + 20
    for (let i = 0; i < total; i += 1) {
      setBoundedScopeCacheEntry(cache, `scope-${i}`, i)
      if (i % 10 === 0) {
        setBoundedScopeCacheEntry(cache, 'keep', 1)
      }
    }

    expect(cache.size).toBe(NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX)
    expect(cache.has('scope-0')).toBe(false) // oldest untouched entry evicted
    expect(cache.has('keep')).toBe(true) // periodically re-set → retained
    expect(cache.has(`scope-${total - 1}`)).toBe(true) // most recent retained
  })

  it('moves a re-set key to most-recent and updates its value', () => {
    const cache = new Map<string, number>()
    setBoundedScopeCacheEntry(cache, 'a', 1)
    setBoundedScopeCacheEntry(cache, 'b', 2)
    setBoundedScopeCacheEntry(cache, 'a', 3)

    expect([...cache.keys()]).toEqual(['b', 'a'])
    expect(cache.get('a')).toBe(3)
  })
})
