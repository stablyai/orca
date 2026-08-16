import { describe, expect, it, vi } from 'vitest'
import { planWorktreeSortOrderUpdates } from './sort-order-update'

describe('planWorktreeSortOrderUpdates', () => {
  it('skips an order that is already represented by descending ranks', () => {
    const getMeta = vi.fn((id: string) => ({
      sortOrder: id === 'a' ? 300 : id === 'b' ? 200 : 100
    }))

    expect(planWorktreeSortOrderUpdates(['a', 'b', 'c'], getMeta, 1_000)).toEqual([])
  })

  it('re-ranks changed order and ignores stale worktree IDs', () => {
    const getMeta = vi.fn((id: string) => {
      if (id === 'stale') {
        return undefined
      }
      return { sortOrder: id === 'a' ? 100 : 200 }
    })

    expect(planWorktreeSortOrderUpdates(['a', 'stale', 'b'], getMeta, 5_000)).toEqual([
      { worktreeId: 'a', sortOrder: 5_000 },
      { worktreeId: 'b', sortOrder: 4_000 }
    ])
  })

  it('ranks a duplicate worktree ID only once', () => {
    const getMeta = vi.fn((id: string) => ({ sortOrder: id === 'a' ? 100 : 200 }))

    expect(planWorktreeSortOrderUpdates(['a', 'a', 'b'], getMeta, 5_000)).toEqual([
      { worktreeId: 'a', sortOrder: 5_000 },
      { worktreeId: 'b', sortOrder: 4_000 }
    ])
    expect(getMeta).toHaveBeenCalledTimes(2)
  })

  it('initializes missing ranks without manufacturing metadata', () => {
    const getMeta = vi.fn((id: string) => (id === 'known' ? {} : undefined))

    expect(planWorktreeSortOrderUpdates(['known', 'missing'], getMeta, 9_000)).toEqual([
      { worktreeId: 'known', sortOrder: 9_000 }
    ])
  })
})
