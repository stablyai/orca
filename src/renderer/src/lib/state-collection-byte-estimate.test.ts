import { describe, expect, it, vi } from 'vitest'
import { estimateStateCollectionMemoryKB } from './state-collection-byte-estimate'

function onHeapKB(state: Record<string, unknown>, key: string): number {
  return estimateStateCollectionMemoryKB(state, 32).counts[`onHeap.${key}`] ?? 0
}

describe('estimateStateCollectionMemoryKB', () => {
  it('ranks a value-fat slice above an entry-long slice', () => {
    const fat = { a: 'x'.repeat(200_000), b: 'y'.repeat(200_000) }
    const long = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]))
    const estimate = estimateStateCollectionMemoryKB({ fat, long }, 2)

    expect(Object.keys(estimate.counts)).toEqual(['onHeap.fat', 'onHeap.long'])
    expect(estimate.counts['onHeap.fat']).toBeGreaterThan(
      (estimate.counts['onHeap.long'] ?? 0) * 10
    )
  })

  it('extrapolates uniform arrays instead of measuring every element', () => {
    const entry = (): { name: string } => ({ name: 'worktree-name-of-typical-length' })
    const small = onHeapKB({ slice: Array.from({ length: 100 }, entry) }, 'slice')
    const large = onHeapKB({ slice: Array.from({ length: 10_000 }, entry) }, 'slice')

    expect(large).toBeGreaterThan(small * 80)
    expect(large).toBeLessThan(small * 120)
  })

  it('extrapolates plain objects past the sample window', () => {
    const value = (): string => 'v'.repeat(64)
    const small = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`k${index}`, value()])
    )
    const huge = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [`k${index}`, value()])
    )

    expect(onHeapKB({ slice: huge }, 'slice')).toBeGreaterThan(
      onHeapKB({ slice: small }, 'slice') * 8
    )
  })

  it('bounds plain-object key inspection per slice', () => {
    const slice = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`k${index}`, index])
    )
    const hasOwn = vi.spyOn(Object, 'hasOwn')

    expect(onHeapKB({ slice }, 'slice')).toBeGreaterThan(0)
    expect(hasOwn).toHaveBeenCalledTimes(4097)
  })

  it('emits budget metadata before slice detail', () => {
    const slice = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [`k${index}`, { payload: 'x'.repeat(2048) }])
    )
    const estimate = estimateStateCollectionMemoryKB({ slice }, 4)

    expect(Object.keys(estimate.counts).slice(0, 2)).toEqual(['__budgetHitSlices', 'onHeap.slice'])
    expect(estimate.counts['onHeap.slice']).toBeGreaterThan(10_000)
  })

  it('separates typed-array backing stores from on-heap estimates', () => {
    const buffer = new ArrayBuffer(256_000)
    const estimate = estimateStateCollectionMemoryKB(
      { slice: [new Uint8Array(buffer), new Uint32Array(buffer)] },
      4
    )

    expect(estimate.heuristicExternalKB).toBe(250)
    expect(estimate.heuristicOnHeapKB).toBeLessThan(2)
    expect(estimate.counts).toEqual({})
  })

  it('survives cycles and pathological nesting', () => {
    const cyclic: Record<string, unknown> = { name: 'x'.repeat(2048) }
    cyclic.self = cyclic
    let deep: Record<string, unknown> = { leaf: true }
    for (let index = 0; index < 10_000; index += 1) {
      deep = { child: deep }
    }

    expect(onHeapKB({ cyclic }, 'cyclic')).toBeGreaterThan(1)
    expect(() => estimateStateCollectionMemoryKB({ deep }, 4)).not.toThrow()
  })

  it('caps detail at the limit while totals include all slices', () => {
    const estimate = estimateStateCollectionMemoryKB(
      {
        big: 'x'.repeat(300_000),
        medium: 'x'.repeat(100_000),
        smaller: 'x'.repeat(50_000),
        tiny: 'x'
      },
      2
    )

    expect(Object.keys(estimate.counts)).toEqual(['onHeap.big', 'onHeap.medium'])
    expect(estimate.heuristicOnHeapKB).toBeGreaterThan(
      (estimate.counts['onHeap.big'] ?? 0) + (estimate.counts['onHeap.medium'] ?? 0)
    )
  })

  it('skips a throwing slice and returns zeroes for non-object state', () => {
    const state = { healthy: 'x'.repeat(10_000) }
    Object.defineProperty(state, 'poisoned', {
      enumerable: true,
      get: () => {
        throw new Error('boom')
      }
    })

    expect(Object.keys(estimateStateCollectionMemoryKB(state, 8).counts)).toContain(
      'onHeap.healthy'
    )
    expect(estimateStateCollectionMemoryKB(null, 8)).toEqual({
      counts: {},
      heuristicOnHeapKB: 0,
      heuristicExternalKB: 0
    })
  })
})
