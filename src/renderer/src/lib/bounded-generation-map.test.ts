import { describe, expect, it } from 'vitest'
import { createBoundedGenerationMap } from './bounded-generation-map'

describe('createBoundedGenerationMap', () => {
  it('keeps insertion order for eviction when a key is re-advanced', () => {
    const map = createBoundedGenerationMap(2)
    map.advance('a')
    map.advance('b')
    map.advance('a')
    map.advance('c')
    // 'a' keeps its first-inserted slot, so it is evicted despite being re-advanced.
    expect(map.get('b')).toBe(2)
    expect(map.get('a')).toBe(3)
    expect(map.get('c')).toBe(4)
  })

  it('reads an evicted key as the highest evicted generation', () => {
    const map = createBoundedGenerationMap(1)
    map.advance('a')
    map.advance('a')
    map.advance('b')
    expect(map.get('a')).toBe(2)
    expect(map.get('never-seen')).toBe(2)
  })
})
