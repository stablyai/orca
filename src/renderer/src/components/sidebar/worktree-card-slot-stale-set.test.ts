import { describe, expect, it } from 'vitest'
import { createStaleSlotSet } from './worktree-card-slot-stale-set'

function staleIn(set: ReturnType<typeof createStaleSlotSet>, start: number, end: number) {
  const found: number[] = []
  const visited = set.forEachStale(start, end, (index) => found.push(index))
  return { found, visited }
}

describe('createStaleSlotSet', () => {
  it.each([100, 1000, 10_000])(
    'finds one stale descendant among %i without scanning the range',
    (descendants) => {
      // Parent at 0, descendants at 1..n: the shape a mounted parent card reads.
      const set = createStaleSlotSet(descendants + 1)
      set.markAll()
      for (let i = 0; i <= descendants; i++) {
        set.clear(i)
      }
      const changed = Math.floor(descendants / 2)
      set.mark(changed)
      const { found, visited } = staleIn(set, 1, descendants + 1)
      expect(found).toEqual([changed])
      // Two boundary paths plus the path to the stale leaf: O(log N), not O(N).
      expect(visited).toBeLessThanOrEqual(6 * Math.ceil(Math.log2(descendants + 1)) + 4)
    }
  )

  it('visits O(log N) nodes for a fully fresh range even when slots elsewhere are stale', () => {
    const set = createStaleSlotSet(10_000)
    set.markAll()
    for (let i = 2000; i < 9000; i++) {
      set.clear(i)
    }
    const { found, visited } = staleIn(set, 2000, 9000)
    expect(found).toEqual([])
    expect(visited).toBeLessThanOrEqual(6 * 14 + 4)
  })

  it('matches a brute-force scan for random marks and ranges', () => {
    let seed = 7
    const random = (limit: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % limit
    }
    for (const length of [1, 2, 3, 17, 64, 100]) {
      const set = createStaleSlotSet(length)
      const truth = Array.from({ length }, () => true)
      set.markAll()
      for (let step = 0; step < 200; step++) {
        const index = random(length)
        if (random(2) === 0) {
          set.mark(index)
          truth[index] = true
        } else {
          set.clear(index)
          truth[index] = false
        }
        const start = random(length + 1)
        const end = start + random(length - start + 1)
        const expected = truth
          .map((stale, i) => (stale ? i : -1))
          .filter((i) => i >= start && i < end)
        expect(staleIn(set, start, end).found).toEqual(expected)
      }
      set.markAll()
      expect(staleIn(set, 0, length).found).toEqual(Array.from({ length }, (_, i) => i))
    }
  })
})
