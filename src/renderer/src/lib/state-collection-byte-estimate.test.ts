import { describe, expect, it, vi } from 'vitest'
import { estimateStateCollectionKB } from './state-collection-byte-estimate'

function kbOf(state: Record<string, unknown>, key: string): number {
  return estimateStateCollectionKB(state, 32)[key] ?? 0
}

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

  it('extrapolates uniform arrays instead of measuring every element', () => {
    const entry = (): { name: string } => ({ name: 'worktree-name-of-typical-length' })
    const small = kbOf({ slice: Array.from({ length: 100 }, entry) }, 'slice')
    const large = kbOf({ slice: Array.from({ length: 10_000 }, entry) }, 'slice')

    expect(large).toBeGreaterThan(small * 80)
    expect(large).toBeLessThan(small * 120)
  })

  it('extrapolates plain objects past the sample window', () => {
    const value = (): string => 'v'.repeat(64)
    const small = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, value()]))
    const huge = Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, value()]))

    const smallKB = kbOf({ slice: small }, 'slice')
    const hugeKB = kbOf({ slice: huge }, 'slice')
    expect(hugeKB).toBeGreaterThan(smallKB * 8)
    expect(hugeKB).toBeLessThan(smallKB * 12)
  })

  it('bounds plain-object key inspection per slice', () => {
    const slice = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, i]))
    const hasOwn = vi.spyOn(Object, 'hasOwn')

    expect(kbOf({ slice }, 'slice')).toBeGreaterThan(0)
    expect(hasOwn).toHaveBeenCalledTimes(4097)
    hasOwn.mockRestore()
  })

  it('reserves bounded descent for fat values after a saturated object scan', () => {
    const slice = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, i) => [`k${i}`, { payload: 'x'.repeat(2048) }])
    )

    const result = estimateStateCollectionKB({ slice }, 4)
    expect(result.slice).toBeGreaterThan(10_000)
    expect(result.__budgetHitSlices).toBe(1)
  })

  it('extrapolates Map and Set entries by size', () => {
    const mapKB = kbOf(
      { slice: new Map(Array.from({ length: 2_000 }, (_, i) => [`key${i}`, 'v'.repeat(128)])) },
      'slice'
    )
    const setKB = kbOf(
      { slice: new Set(Array.from({ length: 2_000 }, (_, i) => `member-${i}-${'v'.repeat(128)}`)) },
      'slice'
    )
    // 2000 entries x ~128 chars ≈ >250KB either way; well above rounding noise.
    expect(mapKB).toBeGreaterThan(250)
    expect(setKB).toBeGreaterThan(250)
  })

  it('counts typed-array backing stores by byteLength', () => {
    expect(kbOf({ slice: [new Uint32Array(64_000)] }, 'slice')).toBeGreaterThan(200)
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

  it('caps output at the limit, largest first, dropping sub-KB slices', () => {
    const state = {
      big: 'x'.repeat(300_000),
      medium: 'x'.repeat(100_000),
      smaller: 'x'.repeat(50_000),
      tiny: 'x',
      count: 7
    }
    const result = estimateStateCollectionKB(state, 2)
    expect(Object.keys(result)).toEqual(['big', 'medium', '__totalKB'])
    expect(result.big).toBeGreaterThan(result.medium)
  })

  it('reports the all-slices total beyond the top limit', () => {
    const state = {
      a: 'x'.repeat(100_000),
      b: 'x'.repeat(100_000),
      c: 'x'.repeat(100_000)
    }
    const result = estimateStateCollectionKB(state, 1)
    expect(result.__totalKB).toBeGreaterThan((result.a ?? 0) * 2.5)
  })

  it('includes raw bytes from slices that round below one KB', () => {
    expect(
      estimateStateCollectionKB({ a: 'x'.repeat(200), b: 'x'.repeat(200), c: 'x'.repeat(200) }, 4)
    ).toEqual({ __totalKB: 1 })
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

  it('returns empty for non-object state', () => {
    expect(estimateStateCollectionKB(null, 8)).toEqual({})
    expect(estimateStateCollectionKB('text', 8)).toEqual({})
  })
})
