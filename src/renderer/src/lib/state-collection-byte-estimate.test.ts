import { describe, expect, it } from 'vitest'
import { estimateStateCollectionKB } from './state-collection-byte-estimate'

describe('estimateStateCollectionKB', () => {
  it('survives cycles and self references', () => {
    const cyclic: Record<string, unknown> = { name: 'x'.repeat(2048) }
    cyclic.self = cyclic
    const result = estimateStateCollectionKB({ cyclic }, 4)
    expect(result.cyclic).toBeGreaterThan(1)
    expect(Number.isFinite(result.cyclic)).toBe(true)
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
