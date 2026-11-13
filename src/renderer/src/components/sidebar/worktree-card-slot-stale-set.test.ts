import { describe, expect, it } from 'vitest'
import { createStaleSlotSet } from './worktree-card-slot-stale-set'

function staleIn(set: ReturnType<typeof createStaleSlotSet>, start: number, end: number) {
  const found: number[] = []
  set.forEachStale(start, end, (index) => found.push(index))
  return found
}

describe('createStaleSlotSet', () => {
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
        expect(staleIn(set, start, end)).toEqual(expected)
      }
      set.markAll()
      expect(staleIn(set, 0, length)).toEqual(Array.from({ length }, (_, i) => i))
    }
  })
})
