import { describe, expect, it, vi } from 'vitest'
import { BoundedMap } from './bounded-map'

describe('BoundedMap', () => {
  it('rejects an invalid maxEntries', () => {
    expect(() => new BoundedMap<string, number>({ maxEntries: 0 })).toThrow(RangeError)
    expect(() => new BoundedMap<string, number>({ maxEntries: 4, maxBytes: 10 })).toThrow(/sizeOf/)
  })

  it('evicts the least-recently-used entry past the count ceiling', () => {
    const evicted: string[] = []
    const m = new BoundedMap<string, number>({ maxEntries: 3, onEvict: (_v, k) => evicted.push(k) })
    m.set('a', 1)
    m.set('b', 2)
    m.set('c', 3)
    expect(m.size).toBe(3)
    m.set('d', 4) // count+1 -> evict oldest 'a'
    expect(m.size).toBe(3)
    expect(evicted).toEqual(['a'])
    expect(m.has('a')).toBe(false)
    expect([...m.keys()]).toEqual(['b', 'c', 'd'])
  })

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

  it('rejects a single value larger than maxBytes without wiping the map', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 4,
      sizeOf: (v) => v.length
    })
    expect(m.set('a', 'ok')).toBe(true)
    expect(m.set('big', 'toolong')).toBe(false)
    expect(m.has('a')).toBe(true)
    expect(m.has('big')).toBe(false)
  })

  it('updates retained bytes on overwrite and delete', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 100,
      sizeOf: (v) => v.length
    })
    m.set('a', 'xxx') // 3
    m.set('a', 'x') // overwrite -> 1
    expect(m.retainedBytes).toBe(1)
    m.delete('a')
    expect(m.retainedBytes).toBe(0)
    expect(m.size).toBe(0)
  })

  it('maxEntryBytes rejects an oversized single entry independent of the aggregate', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 100,
      maxEntryBytes: 4,
      sizeOf: (v) => v.length
    })
    expect(m.set('a', 'ok')).toBe(true)
    expect(m.set('b', 'toolong')).toBe(false) // 7 > maxEntryBytes 4, though aggregate has room
    expect(m.has('a')).toBe(true)
    expect(m.retainedBytes).toBe(2)
  })

  it('never reports success for an entry it did not retain', () => {
    const onEvict = vi.fn()
    // maxEntryBytes above maxBytes previously admitted an entry, then evicted it (and everything
    // else) to satisfy the aggregate — set() returned true for a key the map no longer held.
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

  it('rejects invalid ceilings at construction', () => {
    const sizeOf = (v: string): number => v.length
    expect(
      () => new BoundedMap<string, string>({ maxEntries: 2, maxBytes: Number.NaN, sizeOf })
    ).toThrow(RangeError)
    expect(() => new BoundedMap<string, string>({ maxEntries: 2, maxBytes: -1, sizeOf })).toThrow(
      RangeError
    )
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

  it('peek() reads without changing eviction order', () => {
    const m = new BoundedMap<string, number>({ maxEntries: 2 })
    m.set('a', 1)
    m.set('b', 2)
    expect(m.peek('a')).toBe(1) // does NOT mark 'a' recently used
    m.set('c', 3)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
  })

  it('stores an undefined value as a present key', () => {
    const m = new BoundedMap<string, number | undefined>({ maxEntries: 2 })
    expect(m.set('u', undefined)).toBe(true)
    expect(m.has('u')).toBe(true)
    expect(m.get('u')).toBeUndefined()
    expect(m.keys()).toEqual(['u'])
  })

  it('keeps the byte ledger exact at the safe-integer boundary', () => {
    const m = new BoundedMap<string, number>({
      maxEntries: 10,
      maxBytes: Number.MAX_SAFE_INTEGER,
      sizeOf: (v) => v
    })
    expect(m.set('a', Number.MAX_SAFE_INTEGER)).toBe(true)
    // would overflow the aggregate past MAX_SAFE_INTEGER -> rejected, ledger untouched
    expect(m.set('b', 1)).toBe(false)
    expect(m.retainedBytes).toBe(Number.MAX_SAFE_INTEGER)
    m.delete('a')
    expect(m.retainedBytes).toBe(0)
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

  it('rejects fractional and unsafe weights and ceilings', () => {
    const sizeOf = (v: number): number => v
    expect(() => new BoundedMap<string, number>({ maxEntries: 2, maxBytes: 1.5, sizeOf })).toThrow(
      RangeError
    )
    const m = new BoundedMap<string, number>({ maxEntries: 4, maxBytes: 100, sizeOf })
    expect(m.set('frac', 0.5)).toBe(false)
    expect(m.set('inf', Number.POSITIVE_INFINITY)).toBe(false)
    expect(m.retainedBytes).toBe(0)
  })

  it('protects a just-admitted NaN key from eviction', () => {
    const m = new BoundedMap<number, string>({
      maxEntries: 2,
      maxBytes: 6,
      sizeOf: (v) => v.length
    })
    m.set(1, 'aa')
    m.set(2, 'bb')
    expect(m.set(Number.NaN, 'cc')).toBe(true)
    expect(m.has(Number.NaN)).toBe(true)
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

  it('stays within bounds even when onEvict throws', () => {
    const m = new BoundedMap<string, string>({
      maxEntries: 10,
      maxBytes: 3,
      sizeOf: (v) => v.length,
      onEvict: () => {
        throw new Error('dispose failed')
      }
    })
    m.set('a', 'x')
    m.set('b', 'y')
    m.set('c', 'z')
    expect(() => m.set('d', 'w')).toThrow('dispose failed')
    // bounds restored before disposal ran, so the throw cannot strand the map over capacity
    expect(m.retainedBytes).toBeLessThanOrEqual(3)
    expect(m.size).toBeLessThanOrEqual(3)
  })

  it('reports failure when a reentrant onEvict evicts the just-admitted key', () => {
    let reentered = false
    const m: BoundedMap<string, string> = new BoundedMap<string, string>({
      maxEntries: 1,
      onEvict: () => {
        if (reentered) {
          return
        }
        reentered = true
        m.set('x', 'x') // nested set evicts the outer call's entry
      }
    })
    m.set('a', 'a')
    const admitted = m.set('c', 'c')
    // set() must never claim success for a key the map no longer holds
    expect(admitted).toBe(m.has('c'))
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

  it('does not fire onEvict on explicit delete/clear', () => {
    const onEvict = vi.fn()
    const m = new BoundedMap<string, number>({ maxEntries: 5, onEvict })
    m.set('a', 1)
    m.delete('a')
    m.set('b', 2)
    m.clear()
    expect(onEvict).not.toHaveBeenCalled()
  })
})
