// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeSession(
  groupId: string,
  sidebarProjectGroupHeaderIds: readonly string[],
  overrides: Partial<ProjectGroupHeaderDragSession> = {}
): ProjectGroupHeaderDragSession {
  return {
    groupId,
    bucketKey: 'root',
    sourceParentGroupId: null,
    sidebarProjectGroupHeaderIds,
    sidebarProjectGroupHeaderIdsByBucket: new Map([['root', sidebarProjectGroupHeaderIds]]),
    reparentIndex: { subtreeIds: new Set([groupId]), validate: () => null },
    pointerId: 1,
    headerRects: [],
    handleEl: document.createElement('div'),
    startX: 0,
    startY: 0,
    latestPointerY: 0,
    promoted: true,
    ...overrides
  }
}

describe('commitProjectGroupHeaderDragDrop', () => {
  it('commits dense tabOrder updates for the affected Project Group siblings', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const groups = [
      group('a', { tabOrder: 0 }),
      group('b', { tabOrder: 10 }),
      group('c', { tabOrder: 20 })
    ]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('c', ['a', 'b', 'c']),
      dropTarget: { kind: 'reorder', bucketKey: 'root', dropIndex: 0, dropIndicatorY: 0 },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2]
    ])
    expect(onCommitProjectGroupReparent).not.toHaveBeenCalled()
  })

  it('computes order only from the captured sibling bucket', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const root = group('root')
    const siblingA = group('sibling-a', { parentGroupId: root.id, tabOrder: 0 })
    const siblingB = group('sibling-b', { parentGroupId: root.id, tabOrder: 10 })
    const otherParentGroup = group('other-parent-group', { tabOrder: -100 })
    const projectGroupById = new Map(
      [root, siblingA, siblingB, otherParentGroup].map((entry) => [entry.id, entry])
    )

    commitProjectGroupHeaderDragDrop({
      session: makeSession('sibling-b', ['sibling-a', 'sibling-b'], {
        bucketKey: `parent:${root.id}`,
        sourceParentGroupId: root.id
      }),
      dropTarget: {
        kind: 'reorder',
        bucketKey: `parent:${root.id}`,
        dropIndex: 0,
        dropIndicatorY: 0
      },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([
      ['sibling-b', 0],
      ['sibling-a', 1]
    ])
    expect(onCommitProjectGroupReparent).not.toHaveBeenCalled()
  })

  it('does not commit when the drop keeps the group in the same slot', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const groups = [group('a'), group('b'), group('c')]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('b', ['a', 'b', 'c']),
      dropTarget: { kind: 'reorder', bucketKey: 'root', dropIndex: 2, dropIndicatorY: 0 },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupTabOrder).not.toHaveBeenCalled()
    expect(onCommitProjectGroupReparent).not.toHaveBeenCalled()
  })

  it('does not commit when a stale session no longer contains the dragged group', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const groups = [group('a'), group('b'), group('c')]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('c', ['a', 'b']),
      dropTarget: { kind: 'reorder', bucketKey: 'root', dropIndex: 0, dropIndicatorY: 0 },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupTabOrder).not.toHaveBeenCalled()
    expect(onCommitProjectGroupReparent).not.toHaveBeenCalled()
  })

  it('reparents a nest drop after the target group children', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const target = group('target')
    const child = group('child', { parentGroupId: target.id, tabOrder: 4 })
    const dragged = group('dragged', { tabOrder: 1 })
    const projectGroupById = new Map([target, child, dragged].map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('dragged', ['target', 'dragged']),
      dropTarget: { kind: 'nest', targetGroupId: 'target' },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupReparent.mock.calls).toEqual([['dragged', 'target', 5]])
    expect(onCommitProjectGroupTabOrder).not.toHaveBeenCalled()
  })

  it('reparents a childless nest drop at tabOrder zero', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const target = group('target')
    const dragged = group('dragged', { tabOrder: 3 })
    const projectGroupById = new Map([target, dragged].map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('dragged', ['target', 'dragged']),
      dropTarget: { kind: 'nest', targetGroupId: 'target' },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupReparent.mock.calls).toEqual([['dragged', 'target', 0]])
  })

  it('reparents a cross-bucket reorder and renumbers the displaced target siblings', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const parent = group('parent')
    const nestedA = group('nested-a', { parentGroupId: parent.id, tabOrder: 0 })
    const nestedB = group('nested-b', { parentGroupId: parent.id, tabOrder: 1 })
    const dragged = group('dragged', { tabOrder: 5 })
    const projectGroupById = new Map(
      [parent, nestedA, nestedB, dragged].map((entry) => [entry.id, entry])
    )

    commitProjectGroupHeaderDragDrop({
      session: makeSession('dragged', ['parent', 'dragged'], {
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['parent', 'dragged']],
          [`parent:${parent.id}`, ['nested-a', 'nested-b']]
        ])
      }),
      dropTarget: {
        kind: 'reorder',
        bucketKey: `parent:${parent.id}`,
        dropIndex: 1,
        dropIndicatorY: 0
      },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupReparent.mock.calls).toEqual([['dragged', 'parent', 1]])
    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([['nested-b', 2]])
  })

  it('un-nests a cross-bucket reorder into the root bucket', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupReparent = vi.fn()
    const parent = group('parent', { tabOrder: 0 })
    const dragged = group('dragged', { parentGroupId: parent.id, tabOrder: 0 })
    const other = group('other', { tabOrder: 1 })
    const projectGroupById = new Map([parent, dragged, other].map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('dragged', ['dragged'], {
        bucketKey: `parent:${parent.id}`,
        sourceParentGroupId: parent.id,
        sidebarProjectGroupHeaderIdsByBucket: new Map([
          ['root', ['parent', 'other']],
          [`parent:${parent.id}`, ['dragged']]
        ])
      }),
      dropTarget: { kind: 'reorder', bucketKey: 'root', dropIndex: 1, dropIndicatorY: 0 },
      projectGroupById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupReparent
    })

    expect(onCommitProjectGroupReparent.mock.calls).toEqual([['dragged', null, 1]])
    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([['other', 2]])
  })
})
