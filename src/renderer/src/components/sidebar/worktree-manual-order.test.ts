import { describe, expect, it } from 'vitest'
import { buildWorktreeDragPreviewOffsets } from './worktree-drag-preview-offsets'
import {
  buildManualOrderUpdatesForGroupDrop,
  buildManualOrderUpdatesForVisibleGroups,
  expandDraggedWorktreeIdsForVisibleLineage,
  moveWorktreeIdsWithinGroup,
  shouldWriteManualOrderForGroupDrop
} from './worktree-manual-order'

describe('expandDraggedWorktreeIdsForVisibleLineage', () => {
  it('expands an expanded lineage parent to its visible descendants for reordering', () => {
    expect(
      expandDraggedWorktreeIdsForVisibleLineage(
        [
          { worktreeId: 'parent', depth: 0 },
          { worktreeId: 'child', depth: 1 },
          { worktreeId: 'grandchild', depth: 2 },
          { worktreeId: 'sibling', depth: 0 }
        ],
        ['parent']
      )
    ).toEqual(['parent', 'child', 'grandchild'])
  })

  it('keeps unrelated selected rows in visual order', () => {
    expect(
      expandDraggedWorktreeIdsForVisibleLineage(
        [
          { worktreeId: 'a', depth: 0 },
          { worktreeId: 'parent', depth: 0 },
          { worktreeId: 'child', depth: 1 },
          { worktreeId: 'z', depth: 0 }
        ],
        ['z', 'parent']
      )
    ).toEqual(['parent', 'child', 'z'])
  })
})

describe('moveWorktreeIdsWithinGroup', () => {
  it('moves a worktree down using the original drop index', () => {
    expect(moveWorktreeIdsWithinGroup(['a', 'b', 'c', 'd'], ['b'], 4)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('moves a worktree up', () => {
    expect(moveWorktreeIdsWithinGroup(['a', 'b', 'c'], ['c'], 0)).toEqual(['c', 'a', 'b'])
  })

  it('preserves selected order for multi-drag batches', () => {
    expect(moveWorktreeIdsWithinGroup(['a', 'b', 'c', 'd'], ['c', 'b'], 4)).toEqual([
      'a',
      'd',
      'b',
      'c'
    ])
  })

  it('moves a very large selected batch without overflowing argument limits', () => {
    const ids = Array.from({ length: 130_000 }, (_, index) => `wt-${index}`)

    const result = moveWorktreeIdsWithinGroup(ids, ids, 0)

    expect(result).toHaveLength(ids.length)
    expect(result[0]).toBe('wt-0')
    expect(result.at(-1)).toBe('wt-129999')
  })
})

describe('buildWorktreeDragPreviewOffsets', () => {
  it('slides intervening rows up while dragging a row down', () => {
    const offsets = buildWorktreeDragPreviewOffsets({
      groupIds: ['a', 'b', 'c', 'd'],
      draggedIds: ['b'],
      dropIndex: 4,
      rects: [
        { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 50 },
        { worktreeId: 'b', groupIndex: 1, top: 56, bottom: 106 },
        { worktreeId: 'c', groupIndex: 2, top: 112, bottom: 162 },
        { worktreeId: 'd', groupIndex: 3, top: 168, bottom: 218 }
      ]
    })

    expect(Array.from(offsets)).toEqual([
      ['c', -56],
      ['d', -56]
    ])
  })

  it('slides intervening rows down while dragging a row up', () => {
    const offsets = buildWorktreeDragPreviewOffsets({
      groupIds: ['a', 'b', 'c'],
      draggedIds: ['c'],
      dropIndex: 0,
      rects: [
        { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 40 },
        { worktreeId: 'b', groupIndex: 1, top: 46, bottom: 86 },
        { worktreeId: 'c', groupIndex: 2, top: 92, bottom: 132 }
      ]
    })

    expect(Array.from(offsets)).toEqual([
      ['a', 46],
      ['b', 46]
    ])
  })

  it('returns no preview offsets for a no-op hover', () => {
    const offsets = buildWorktreeDragPreviewOffsets({
      groupIds: ['a', 'b'],
      draggedIds: ['a'],
      dropIndex: 1,
      rects: [
        { worktreeId: 'a', groupIndex: 0, top: 0, bottom: 40 },
        { worktreeId: 'b', groupIndex: 1, top: 46, bottom: 86 }
      ]
    })

    expect(offsets.size).toBe(0)
  })

  it('uses the dragged unit height when previewing variable-height rows', () => {
    const offsets = buildWorktreeDragPreviewOffsets({
      groupIds: ['parent', 'sibling'],
      draggedIds: ['parent'],
      dropIndex: 2,
      rects: [
        { worktreeId: 'parent', groupIndex: 0, top: 0, bottom: 300 },
        { worktreeId: 'sibling', groupIndex: 1, top: 308, bottom: 408 }
      ]
    })

    expect(Array.from(offsets)).toEqual([['sibling', -308]])
  })

  it('uses the dragged unit height when previewing a short row above a tall row', () => {
    const offsets = buildWorktreeDragPreviewOffsets({
      groupIds: ['parent', 'sibling'],
      draggedIds: ['sibling'],
      dropIndex: 0,
      rects: [
        { worktreeId: 'parent', groupIndex: 0, top: 0, bottom: 300 },
        { worktreeId: 'sibling', groupIndex: 1, top: 308, bottom: 408 }
      ]
    })

    expect(Array.from(offsets)).toEqual([['parent', 108]])
  })
})

describe('buildManualOrderUpdatesForVisibleGroups', () => {
  it('updates every visible workspace order while only moving the source group', () => {
    const result = buildManualOrderUpdatesForVisibleGroups({
      groups: [
        { key: 'workspace-status:todo', worktreeIds: ['todo-a', 'todo-b'] },
        { key: 'workspace-status:done', worktreeIds: ['done-a', 'done-b'] }
      ],
      sourceGroupKey: 'workspace-status:todo',
      draggedIds: ['todo-b'],
      dropIndex: 0,
      now: 10_000
    })

    expect(result.changed).toBe(true)
    expect(result.orderedIds).toEqual(['todo-b', 'todo-a', 'done-a', 'done-b'])
    expect(Array.from(result.updates)).toEqual([
      ['todo-b', { manualOrder: 10_000 }],
      ['todo-a', { manualOrder: 9000 }],
      ['done-a', { manualOrder: 8000 }],
      ['done-b', { manualOrder: 7000 }]
    ])
  })

  it('returns no updates for a no-op drop', () => {
    const result = buildManualOrderUpdatesForVisibleGroups({
      groups: [{ key: 'repo:one', worktreeIds: ['a', 'b'] }],
      sourceGroupKey: 'repo:one',
      draggedIds: ['a'],
      dropIndex: 1,
      now: 10_000
    })

    expect(result.changed).toBe(false)
    expect(result.updates.size).toBe(0)
  })

  it('only updates moved rows when current ranks leave room', () => {
    const result = buildManualOrderUpdatesForVisibleGroups({
      groups: [{ key: 'repo:one', worktreeIds: ['a', 'b', 'c', 'd'] }],
      sourceGroupKey: 'repo:one',
      draggedIds: ['b'],
      dropIndex: 4,
      now: 10_000,
      rankByWorktreeId: new Map([
        ['a', 4000],
        ['b', 3000],
        ['c', 2000],
        ['d', 1000]
      ])
    })

    expect(result.orderedIds).toEqual(['a', 'c', 'd', 'b'])
    expect(Array.from(result.updates)).toEqual([['b', { manualOrder: 0 }]])
  })

  it('moves an expanded lineage cluster as one ranked unit', () => {
    const result = buildManualOrderUpdatesForVisibleGroups({
      groups: [{ key: 'all', worktreeIds: ['parent', 'child', 'other'] }],
      sourceGroupKey: 'all',
      draggedIds: ['parent', 'child'],
      dropIndex: 3,
      now: 10_000,
      rankByWorktreeId: new Map([
        ['parent', 3000],
        ['child', 2000],
        ['other', 1000]
      ])
    })

    expect(result.orderedIds).toEqual(['other', 'parent', 'child'])
    expect(Array.from(result.updates)).toEqual([
      ['parent', { manualOrder: 0 }],
      ['child', { manualOrder: -1000 }]
    ])
  })

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

describe('buildManualOrderUpdatesForGroupDrop', () => {
  it('moves a selected batch across groups and stamps visible manual order', () => {
    const result = buildManualOrderUpdatesForGroupDrop({
      groups: [
        { key: 'todo', worktreeIds: ['todo-a', 'todo-b'] },
        { key: 'doing', worktreeIds: ['doing-a', 'doing-b'] }
      ],
      targetGroupKey: 'doing',
      draggedIds: ['todo-b'],
      dropIndex: 1,
      now: 10_000
    })

    expect(result.changed).toBe(true)
    expect(result.orderedIds).toEqual(['todo-a', 'doing-a', 'todo-b', 'doing-b'])
    expect(Array.from(result.updates)).toEqual([
      ['todo-a', { manualOrder: 10_000 }],
      ['doing-a', { manualOrder: 9000 }],
      ['todo-b', { manualOrder: 8000 }],
      ['doing-b', { manualOrder: 7000 }]
    ])
  })

  it('keeps visual order for multi-select batches spanning groups', () => {
    const result = buildManualOrderUpdatesForGroupDrop({
      groups: [
        { key: 'todo', worktreeIds: ['a', 'b'] },
        { key: 'doing', worktreeIds: ['c', 'd'] }
      ],
      targetGroupKey: 'doing',
      draggedIds: ['d', 'b'],
      dropIndex: 0,
      now: 10_000
    })

    expect(result.orderedIds).toEqual(['a', 'b', 'd', 'c'])
  })

  it('returns no updates for a no-op same-group drop', () => {
    const result = buildManualOrderUpdatesForGroupDrop({
      groups: [{ key: 'doing', worktreeIds: ['a', 'b'] }],
      targetGroupKey: 'doing',
      draggedIds: ['a'],
      dropIndex: 1,
      now: 10_000
    })

    expect(result.changed).toBe(false)
    expect(result.updates.size).toBe(0)
  })

  it('uses sparse moved-row ranks for cross-lane manual drops', () => {
    const result = buildManualOrderUpdatesForGroupDrop({
      groups: [
        { key: 'todo', worktreeIds: ['todo-a', 'todo-b'] },
        { key: 'doing', worktreeIds: ['doing-a', 'doing-b'] }
      ],
      targetGroupKey: 'doing',
      draggedIds: ['todo-b'],
      dropIndex: 1,
      now: 10_000,
      rankByWorktreeId: new Map([
        ['todo-a', 4000],
        ['todo-b', 3000],
        ['doing-a', 2000],
        ['doing-b', 1000]
      ])
    })

    expect(result.orderedIds).toEqual(['todo-a', 'doing-a', 'todo-b', 'doing-b'])
    expect(Array.from(result.updates)).toEqual([['todo-b', { manualOrder: 1500 }]])
  })
})

describe('shouldWriteManualOrderForGroupDrop', () => {
  it('writes order for any lane drop while Manual sort is active', () => {
    expect(
      shouldWriteManualOrderForGroupDrop({
        sortBy: 'manual',
        sourceGroupKeys: ['todo'],
        targetGroupKey: 'doing'
      })
    ).toBe(true)
  })

  it('writes order for same-lane drops outside Manual sort', () => {
    expect(
      shouldWriteManualOrderForGroupDrop({
        sortBy: 'recent',
        sourceGroupKeys: ['doing', 'doing'],
        targetGroupKey: 'doing'
      })
    ).toBe(true)
  })

  it('keeps cross-lane drops status-only outside Manual sort', () => {
    expect(
      shouldWriteManualOrderForGroupDrop({
        sortBy: 'recent',
        sourceGroupKeys: ['todo', 'doing'],
        targetGroupKey: 'doing'
      })
    ).toBe(false)
  })
})
