import { describe, expect, it } from 'vitest'
import { readPublishedSortOrders } from './worktree-sort-order-patch'

describe('readPublishedSortOrders', () => {
  it('reads valid entries and treats an absent field as an older host', () => {
    expect(readPublishedSortOrders([{ worktreeId: 'repo::/a', sortOrder: 5 }])).toEqual([
      { worktreeId: 'repo::/a', sortOrder: 5 }
    ])
    expect(readPublishedSortOrders(undefined)).toBeNull()
  })

  it('falls back to a refetch when any entry is malformed', () => {
    expect(
      readPublishedSortOrders([
        { worktreeId: 'repo::/a', sortOrder: 5 },
        { worktreeId: 'repo::/b', sortOrder: Number.NaN }
      ])
    ).toBeNull()
    expect(readPublishedSortOrders([{ worktreeId: 7, sortOrder: 5 }])).toBeNull()
  })
})
