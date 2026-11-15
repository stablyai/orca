import { describe, expect, it } from 'vitest'
import { planWorktreeSortOrderUpdates } from './sort-order-update'

describe('planWorktreeSortOrderUpdates', () => {
  it('re-ranks only a row moved between kept neighbours', () => {
    const ranks: Record<string, number> = { a: 5_000, b: 4_000, c: 3_000, d: 2_000 }

    expect(
      planWorktreeSortOrderUpdates(['b', 'c', 'a', 'd'], (id) => ({ sortOrder: ranks[id] }), 9_000)
    ).toEqual([{ worktreeId: 'a', sortOrder: 2_500 }])
  })
})
