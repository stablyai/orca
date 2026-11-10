import { describe, expect, it, vi } from 'vitest'
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

  it('never reports success for an entry it did not retain', () => {
    const onEvict = vi.fn()
    // An entry ceiling above total once admitted then evicted the same key while set returned true.
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 3,
      maxEntryBytes: 5,
      sizeOf: (v) => v.length,
      onEvict
    })
    m.set('s1', 'x')
    m.set('s2', 'y')
    expect(m.set('big', 'xxxx')).toBe(false)
    expect(m.has('big')).toBe(false)
    expect(m.has('s1')).toBe(true)
    expect(m.has('s2')).toBe(true)
    expect(onEvict).not.toHaveBeenCalled()
    expect(m.retainedBytes).toBe(2)
  })

  it('fails closed on an unmeasurable weight instead of poisoning the ledger', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 10,
      sizeOf: (v) => (v === 'bad' ? Number.NaN : v.length)
    })
    expect(m.set('ok', 'abc')).toBe(true)
    expect(m.set('nan', 'bad')).toBe(false)
    expect(m.set('neg', 'x')).toBe(true)
    expect(m.retainedBytes).toBe(4)
    expect(Number.isFinite(m.retainedBytes)).toBe(true)
    // ceiling still armed after the rejected weight
    expect(m.set('huge', 'zzzzzzzzzzzz')).toBe(false)
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

  it('an overflow-rejected overwrite keeps the prior value and leaves no orphaned weight', () => {
    const weights = new Map<string, number>([
      ['a', Number.MAX_SAFE_INTEGER - 1],
      ['b', 1]
    ])
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: Number.MAX_SAFE_INTEGER,
      sizeOf: (_v, k) => weights.get(k) ?? 0
    })
    m.set('a', 'A')
    m.set('b', 'B')
    weights.set('b', 3) // next weight for 'b' exceeds the remaining headroom
    expect(m.set('b', 'B2')).toBe(false)
    expect(m.has('b')).toBe(true) // rejection must not displace the prior value
    expect(m.peek('b')).toBe('B')
    expect(m.retainedBytes).toBe(Number.MAX_SAFE_INTEGER)
    // the rejected key must not strand a weight: deleting everything returns the ledger to zero
    weights.set('b', 1)
    m.delete('a')
    m.delete('b')
    expect(m.retainedBytes).toBe(0)
    expect(m.size).toBe(0)
  })

  it('rejects the entry when sizeOf throws instead of propagating', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 4,
      maxBytes: 50,
      sizeOf: (v) => {
        if (v === 'boom') {
          throw new Error('measure failed')
        }
        return v.length
      }
    })
    expect(m.set('ok', 'abc')).toBe(true)
    expect(() => m.set('bad', 'boom')).not.toThrow()
    expect(m.set('bad', 'boom')).toBe(false)
    expect(m.has('bad')).toBe(false)
    expect(m.retainedBytes).toBe(3)
  })

  it('runs every disposal even when one onEvict throws', () => {
    const disposed: string[] = []
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 2,
      sizeOf: (v) => v.length,
      onEvict: (_v, k) => {
        disposed.push(k)
        if (k === 'a') {
          throw new Error('dispose failed')
        }
      }
    })
    m.set('a', 'x')
    m.set('b', 'y')
    expect(() => m.set('c', 'zz')).toThrow('dispose failed')
    expect(disposed).toEqual(['a', 'b']) // 'b' still disposed despite the earlier throw
    expect(m.retainedBytes).toBeLessThanOrEqual(2)
  })
})
