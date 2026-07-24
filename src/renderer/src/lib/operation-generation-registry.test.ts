import { describe, expect, it } from 'vitest'
import { OperationGenerationRegistry } from './operation-generation-registry'

const BOUNDS = {
  maxEntries: 2,
  maxKeyBytes: 4,
  maxTotalKeyBytes: 6
}

describe('OperationGenerationRegistry', () => {
  it('keeps a stable token until the owner advances', () => {
    const generations = new OperationGenerationRegistry(BOUNDS)
    const initial = generations.get('a')

    expect(generations.get('a')).toBe(initial)
    expect(generations.advance('a')).not.toBe(initial)
  })

  it('bounds retained owners and invalidates an evicted capture', () => {
    const generations = new OperationGenerationRegistry(BOUNDS)
    const evicted = generations.get('a')
    generations.get('bb')
    generations.get('ccc')

    expect(generations.evidence()).toEqual({ entries: 2, keyBytes: 5 })
    expect(generations.get('a')).not.toBe(evicted)
    expect(generations.evidence().entries).toBe(2)
  })

  it('bounds aggregate retained key bytes', () => {
    const generations = new OperationGenerationRegistry({
      maxEntries: 3,
      maxKeyBytes: 4,
      maxTotalKeyBytes: 3
    })
    const evicted = generations.get('aa')
    generations.get('b')
    generations.get('cc')

    expect(generations.evidence()).toEqual({ entries: 2, keyBytes: 3 })
    expect(generations.get('aa')).not.toBe(evicted)
  })

  it('fails closed for a key that cannot be retained', () => {
    const generations = new OperationGenerationRegistry(BOUNDS)
    const first = generations.get('oversized')

    expect(generations.get('oversized')).not.toBe(first)
    expect(generations.evidence()).toEqual({ entries: 0, keyBytes: 0 })
  })

  it('invalidates a capture when its owner is explicitly forgotten', () => {
    const generations = new OperationGenerationRegistry(BOUNDS)
    const captured = generations.get('a')
    generations.delete('a')

    expect(generations.get('a')).not.toBe(captured)
  })
})
