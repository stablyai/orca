import { describe, expect, it } from 'vitest'
import { createBoundedGenerationMap } from './bounded-generation-map'

describe('createBoundedGenerationMap', () => {
  it('advances a key to a strictly larger generation', () => {
    const map = createBoundedGenerationMap(4)
    expect(map.get('a')).toBe(0)
    map.advance('a')
    const first = map.get('a')
    map.advance('a')
    expect(map.get('a')).toBeGreaterThan(first)
  })

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

  it('reset clears generations, sequence and the evicted floor', () => {
    const map = createBoundedGenerationMap(1)
    map.advance('a')
    map.advance('b')
    map.reset()
    expect(map.get('a')).toBe(0)
    expect(map.get('b')).toBe(0)
    map.advance('a')
    expect(map.get('a')).toBe(1)
  })
})
