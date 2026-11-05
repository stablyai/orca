import { describe, expect, it } from 'vitest'

import {
  buildManualOrderUpdatesForVisibleGroups,
  moveWorktreeIdsWithinGroup
} from './worktree-manual-order'
import { buildSparseManualOrderUpdates } from './worktree-manual-order-ranks'

describe('buildSparseManualOrderUpdates durable migration', () => {
  it('materializes filtered rows when the first drag creates Manual order', () => {
    const result = buildSparseManualOrderUpdates({
      orderedIds: ['a', 'c', 'b'],
      movedIds: ['b'],
      allWorktreeIds: ['a', 'b', 'hidden', 'c'],
      rankByWorktreeId: new Map([
        ['a', 4000],
        ['b', 3000],
        ['c', 1000]
      ]),
      now: 10_000
    })

    expect([...result.keys()]).toEqual(['a', 'c', 'hidden', 'b'])
    expect([...result.values()].map((update) => update.manualOrder)).toEqual([
      10_000, 9000, 8000, 7000
    ])
  })

  it('preserves hidden rows when dense ranks require a full reindex', () => {
    const result = buildSparseManualOrderUpdates({
      orderedIds: ['a', 'c', 'b'],
      movedIds: ['c'],
      allWorktreeIds: ['a', 'hidden', 'b', 'c'],
      rankByWorktreeId: new Map([
        ['a', 3],
        ['hidden', 2.5],
        ['b', 2],
        ['c', 1]
      ]),
      now: 10_000
    })

    expect([...result.keys()]).toEqual(['a', 'hidden', 'c', 'b'])
  })
})

describe('moveWorktreeIdsWithinGroup', () => {
  it('moves a very large selected batch without overflowing argument limits', () => {
    const ids = Array.from({ length: 130_000 }, (_, index) => `wt-${index}`)

    const result = moveWorktreeIdsWithinGroup(ids, ids, 0)

    expect(result).toHaveLength(ids.length)
    expect(result[0]).toBe('wt-0')
    expect(result.at(-1)).toBe('wt-129999')
  })
})

describe('buildManualOrderUpdatesForVisibleGroups', () => {
  it('reorders a very large visible group without overflowing argument limits', () => {
    const ids = Array.from({ length: 130_000 }, (_, index) => `wt-${index}`)
    const rankByWorktreeId = new Map(
      ids.map((id, index) => [id, (ids.length - index) * 1000] as const)
    )

    const result = buildManualOrderUpdatesForVisibleGroups({
      groups: [{ key: 'all', worktreeIds: ids }],
      sourceGroupKey: 'all',
      draggedIds: ['wt-0'],
      dropIndex: ids.length,
      allWorktreeIds: ids,
      now: 10_000,
      rankByWorktreeId
    })

    expect(result.changed).toBe(true)
    expect(result.orderedIds).toHaveLength(ids.length)
    expect(result.orderedIds[0]).toBe('wt-1')
    expect(result.orderedIds.at(-1)).toBe('wt-0')
    expect(Array.from(result.updates)).toEqual([['wt-0', { manualOrder: 0 }]])
  })
})
