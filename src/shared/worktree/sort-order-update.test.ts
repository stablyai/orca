import { describe, expect, it, vi } from 'vitest'
import { planWorktreeSortOrderUpdates, type WorktreeSortOrderUpdate } from './sort-order-update'

function applyUpdates(
  ranks: Record<string, number | undefined>,
  updates: WorktreeSortOrderUpdate[]
): Record<string, number | undefined> {
  const next = { ...ranks }
  for (const { worktreeId, sortOrder } of updates) {
    next[worktreeId] = sortOrder
  }
  return next
}

function descendsInOrder(ids: string[], ranks: Record<string, number | undefined>): boolean {
  return ids.every(
    (id, index) =>
      Number.isFinite(ranks[id]) && (index === 0 || ranks[ids[index - 1]]! > ranks[id]!)
  )
}

describe('planWorktreeSortOrderUpdates', () => {
  it('skips an order that is already represented by descending ranks', () => {
    const getMeta = vi.fn((id: string) => ({
      sortOrder: id === 'a' ? 300 : id === 'b' ? 200 : 100
    }))

    expect(planWorktreeSortOrderUpdates(['a', 'b', 'c'], getMeta, 1_000)).toEqual([])
  })

  it('re-ranks only the moved row and ignores stale worktree IDs', () => {
    const getMeta = vi.fn((id: string) => {
      if (id === 'stale') {
        return undefined
      }
      return { sortOrder: id === 'a' ? 100 : 200 }
    })

    expect(planWorktreeSortOrderUpdates(['a', 'stale', 'b'], getMeta, 5_000)).toEqual([
      { worktreeId: 'a', sortOrder: 5_000 }
    ])
  })

  it('ranks a duplicate worktree ID only once', () => {
    const getMeta = vi.fn((id: string) => ({ sortOrder: id === 'a' ? 100 : 200 }))

    expect(planWorktreeSortOrderUpdates(['a', 'a', 'b'], getMeta, 5_000)).toEqual([
      { worktreeId: 'a', sortOrder: 5_000 }
    ])
    expect(getMeta).toHaveBeenCalledTimes(2)
  })

  it('initializes missing ranks without manufacturing metadata', () => {
    const getMeta = vi.fn((id: string) => (id === 'known' ? {} : undefined))

    expect(planWorktreeSortOrderUpdates(['known', 'missing'], getMeta, 9_000)).toEqual([
      { worktreeId: 'known', sortOrder: 9_000 }
    ])
  })

  // A Smart-sort save used to re-rank every row, so one save notified every repo on the host.
  it('moves one row to the top without touching the rows that kept their place', () => {
    const ranks: Record<string, number> = { a: 5_000, b: 4_000, c: 3_000, d: 2_000, e: 1_000 }

    expect(
      planWorktreeSortOrderUpdates(
        ['d', 'a', 'b', 'c', 'e'],
        (id) => ({ sortOrder: ranks[id] }),
        9_000
      )
    ).toEqual([{ worktreeId: 'd', sortOrder: 9_000 }])
  })

  it('places a row moved down between its new neighbours', () => {
    const ranks: Record<string, number> = { a: 5_000, b: 4_000, c: 3_000, d: 2_000 }

    expect(
      planWorktreeSortOrderUpdates(['b', 'c', 'a', 'd'], (id) => ({ sortOrder: ranks[id] }), 9_000)
    ).toEqual([{ worktreeId: 'a', sortOrder: 2_500 }])
  })

  it('places a row moved to the bottom below the last kept row', () => {
    const ranks: Record<string, number> = { a: 5_000, b: 4_000, c: 3_000 }

    expect(
      planWorktreeSortOrderUpdates(['b', 'c', 'a'], (id) => ({ sortOrder: ranks[id] }), 9_000)
    ).toEqual([{ worktreeId: 'a', sortOrder: 2_000 }])
  })

  it('re-ranks every row when the gap between kept neighbours is too tight', () => {
    const ranks: Record<string, number> = { a: 3, b: 2, c: 1 }

    expect(
      planWorktreeSortOrderUpdates(['a', 'c', 'b'], (id) => ({ sortOrder: ranks[id] }), 9_000)
    ).toEqual([
      { worktreeId: 'a', sortOrder: 9_000 },
      { worktreeId: 'c', sortOrder: 8_000 },
      { worktreeId: 'b', sortOrder: 7_000 }
    ])
  })

  it('always leaves the saved order strictly descending, touching few rows for small moves', () => {
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const ids = Array.from({ length: 60 }, (_, index) => `w${index}`)
    let ranks: Record<string, number | undefined> = Object.fromEntries(
      ids.map((id, index) => [id, index % 17 === 0 ? undefined : 100_000 - index * 1_000])
    )
    let order = [...ids]
    for (let round = 0; round < 400; round += 1) {
      const moves = round % 50 === 0 ? 60 : 1 + Math.floor(random() * 3)
      for (let move = 0; move < moves; move += 1) {
        const [moved] = order.splice(Math.floor(random() * order.length), 1)
        order.splice(Math.floor(random() * (order.length + 1)), 0, moved)
      }
      const updates = planWorktreeSortOrderUpdates(
        order,
        (id) => ({ sortOrder: ranks[id] }),
        1_000_000 + round
      )
      ranks = applyUpdates(ranks, updates)
      expect(descendsInOrder(order, ranks)).toBe(true)
      // k moved rows re-rank at most k rows, unless a tight gap forced the full re-rank.
      expect(updates.length <= moves || updates.length === order.length).toBe(true)
      expect(updates.every(({ sortOrder }) => Number.isInteger(sortOrder))).toBe(true)
      expect(
        planWorktreeSortOrderUpdates(order, (id) => ({ sortOrder: ranks[id] }), 2_000_000)
      ).toEqual([])
    }
  })
})
