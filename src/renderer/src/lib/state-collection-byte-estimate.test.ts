import { describe, expect, it } from 'vitest'
import { estimateStateCollectionKB } from './state-collection-byte-estimate'

describe('estimateStateCollectionKB', () => {
  it('ranks a value-fat slice above an entry-long slice', () => {
    // The 97b9e86d OOM signature: counts said the many-entry slice was biggest.
    const fat = { a: 'x'.repeat(200_000), b: 'y'.repeat(200_000) }
    const long = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]))

    const result = estimateStateCollectionKB({ fat, long }, 2)
    const keys = Object.keys(result)
    expect(keys[0]).toBe('fat')
    expect(result.fat).toBeGreaterThan((result.long ?? 0) * 10)
  })

  it('reserves bounded descent for fat values after a saturated object scan', () => {
    const slice = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`k${i}`, { payload: 'x'.repeat(2048) }])
    )

    const result = estimateStateCollectionKB({ slice }, 4)
    expect(result.slice).toBeGreaterThan(10_000)
    expect(result.__budgetHitSlices).toBe(1)
  })

  it('survives cycles and self references', () => {
    const cyclic: Record<string, unknown> = { name: 'x'.repeat(2048) }
    cyclic.self = cyclic
    const result = estimateStateCollectionKB({ cyclic }, 4)
    expect(result.cyclic).toBeGreaterThan(1)
    expect(Number.isFinite(result.cyclic)).toBe(true)
  })

  it('returns bounded work on pathological nesting', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 10_000; i += 1) {
      deep = { child: deep }
    }
    const wide = { slice: Array.from({ length: 100 }, () => ({ deep })) }
    expect(() => estimateStateCollectionKB(wide, 4)).not.toThrow()
  })

  it('skips a slice whose read throws without sinking the census', () => {
    const state = { healthy: 'x'.repeat(10_000) }
    Object.defineProperty(state, 'poisoned', {
      enumerable: true,
      get: () => {
        throw new Error('boom')
      }
    })
    expect(Object.keys(estimateStateCollectionKB(state, 8))).toEqual(['healthy', '__totalKB'])
  })
})
