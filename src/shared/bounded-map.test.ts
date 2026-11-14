import { describe, expect, it } from 'vitest'
import { BoundedMap } from './bounded-map'

describe('BoundedMap', () => {
  it('get() marks recently-used so it survives eviction', () => {
    const m = new BoundedMap<string, number>({ maxEntries: 3 })
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    expect(m.get('a')).toBe(1) // 'a' now most-recent
    m.set('d', 4) // evicts oldest, which is now 'b' not 'a'
    expect(m.has('a')).toBe(true)
    expect(m.has('b')).toBe(false)
  })

  it('bounds aggregate retained bytes and evicts to fit', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 100,
      maxBytes: 10,
      sizeOf: (v) => v.length
    })
    m.set('a', 'xxxxx') // 5
    m.set('b', 'yyyyy') // 5 -> total 10 (exactly at cap)
    expect(m.retainedBytes).toBe(10)
    expect(m.size).toBe(2)
    m.set('c', 'z') // 11 > 10 -> evict oldest until <= 10
    expect(m.retainedBytes).toBeLessThanOrEqual(10)
    expect(m.has('a')).toBe(false)
    expect(m.has('c')).toBe(true)
  })

  it('a rejected oversized overwrite leaves the existing value untouched', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 20,
      maxEntryBytes: 4,
      sizeOf: (v) => v.length
    })
    m.set('k', 'old')
    expect(m.set('k', 'muchlonger')).toBe(false)
    expect(m.get('k')).toBe('old')
    expect(m.retainedBytes).toBe(3)
  })

  it('supports touching reads during a full traversal', () => {
    const m = new BoundedMap<string, number>({ maxEntries: 5 })
    m.set('a', 1)
    m.set('b', 2)
    const seen: string[] = []
    for (const k of m.keys()) {
      seen.push(k)
      m.get(k) // reorders the backing map mid-iteration
    }
    expect(seen).toEqual(['a', 'b'])
    expect(m.entries()).toEqual([
      ['a', 1],
      ['b', 2]
    ])
  })
})
