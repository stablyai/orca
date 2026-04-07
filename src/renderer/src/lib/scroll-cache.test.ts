import { describe, expect, it, beforeEach } from 'vitest'
import { setWithLRU, scrollTopCache } from './scroll-cache'

beforeEach(() => {
  scrollTopCache.clear()
})

describe('setWithLRU', () => {
  it('inserts a new entry into the map', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1)
    expect(map.get('a')).toBe(1)
    expect(map.size).toBe(1)
  })

  it('updates an existing entry', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1)
    setWithLRU(map, 'a', 2)
    expect(map.get('a')).toBe(2)
    expect(map.size).toBe(1)
  })

  it('evicts the oldest entry when exceeding the default limit', () => {
    const map = new Map<string, number>()
    for (let i = 0; i <= 20; i++) {
      setWithLRU(map, `key-${i}`, i)
    }
    // 21 inserts with default limit of 20 → oldest (key-0) evicted
    expect(map.size).toBe(20)
    expect(map.has('key-0')).toBe(false)
    expect(map.has('key-1')).toBe(true)
    expect(map.has('key-20')).toBe(true)
  })

  it('evicts the oldest entry when exceeding a custom limit', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 3)
    setWithLRU(map, 'b', 2, 3)
    setWithLRU(map, 'c', 3, 3)
    setWithLRU(map, 'd', 4, 3)
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(false)
    expect(map.get('d')).toBe(4)
  })

  it('refreshes insertion order when updating an existing key', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 3)
    setWithLRU(map, 'b', 2, 3)
    setWithLRU(map, 'c', 3, 3)
    // Touch 'a' to move it to the end
    setWithLRU(map, 'a', 10, 3)
    // Now 'b' is the oldest — inserting 'd' should evict 'b', not 'a'
    setWithLRU(map, 'd', 4, 3)
    expect(map.has('a')).toBe(true)
    expect(map.has('b')).toBe(false)
    expect(map.has('c')).toBe(true)
    expect(map.has('d')).toBe(true)
    expect(map.get('a')).toBe(10)
  })

  it('does not evict when at exactly the limit', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 3)
    setWithLRU(map, 'b', 2, 3)
    setWithLRU(map, 'c', 3, 3)
    expect(map.size).toBe(3)
    expect(map.has('a')).toBe(true)
  })

  it('works with a limit of 1', () => {
    const map = new Map<string, number>()
    setWithLRU(map, 'a', 1, 1)
    expect(map.size).toBe(1)
    setWithLRU(map, 'b', 2, 1)
    expect(map.size).toBe(1)
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(true)
  })

  it('evicts only one entry per insert even when far over limit', () => {
    const map = new Map<string, number>()
    // Pre-fill with 5 entries
    for (let i = 0; i < 5; i++) {
      map.set(`key-${i}`, i)
    }
    // Insert with a limit of 3 — only evicts one, leaving 5 entries
    // (LRU eviction is per-insert, not bulk)
    setWithLRU(map, 'new', 99, 3)
    expect(map.size).toBe(5)
    expect(map.has('key-0')).toBe(false)
    expect(map.has('new')).toBe(true)
  })
})

describe('scrollTopCache', () => {
  it('is an empty Map on import', () => {
    expect(scrollTopCache).toBeInstanceOf(Map)
    expect(scrollTopCache.size).toBe(0)
  })

  it('works with setWithLRU for mode-scoped keys', () => {
    setWithLRU(scrollTopCache, '/path/to/file.ts', 100)
    setWithLRU(scrollTopCache, '/path/to/file.ts:preview', 200)
    setWithLRU(scrollTopCache, '/path/to/file.ts:rich', 300)
    expect(scrollTopCache.get('/path/to/file.ts')).toBe(100)
    expect(scrollTopCache.get('/path/to/file.ts:preview')).toBe(200)
    expect(scrollTopCache.get('/path/to/file.ts:rich')).toBe(300)
    expect(scrollTopCache.size).toBe(3)
  })
})
