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
  sidebarProjectGroupHeaderIds: readonly string[]
): ProjectGroupHeaderDragSession {
  return {
    groupId,
    bucketKey: 'root',
    sidebarProjectGroupHeaderIds,
    pointerId: 1,
    headerRects: [],
    handleEl: document.createElement('div'),
    startX: 0,
    startY: 0,
    latestPointerY: 0,
    promoted: true
  }
}

describe('commitProjectGroupHeaderDragDrop', () => {
  it('commits dense tabOrder updates for the affected Project Group siblings', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const groups = [
      group('a', { tabOrder: 0 }),
      group('b', { tabOrder: 10 }),
      group('c', { tabOrder: 20 })
    ]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('c', ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      projectGroupById,
      onCommitProjectGroupTabOrder
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2]
    ])
  })

  it('computes order only from the captured sibling bucket', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const root = group('root')
    const siblingA = group('sibling-a', { parentGroupId: root.id, tabOrder: 0 })
    const siblingB = group('sibling-b', { parentGroupId: root.id, tabOrder: 10 })
    const otherParentGroup = group('other-parent-group', { tabOrder: -100 })
    const projectGroupById = new Map(
      [root, siblingA, siblingB, otherParentGroup].map((entry) => [entry.id, entry])
    )

    commitProjectGroupHeaderDragDrop({
      session: makeSession('sibling-b', ['sibling-a', 'sibling-b']),
      sidebarDropIndex: 0,
      projectGroupById,
      onCommitProjectGroupTabOrder
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([
      ['sibling-b', 0],
      ['sibling-a', 1]
    ])
  })

  it('does not commit when the drop keeps the group in the same slot', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const groups = [group('a'), group('b'), group('c')]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('b', ['a', 'b', 'c']),
      sidebarDropIndex: 2,
      projectGroupById,
      onCommitProjectGroupTabOrder
    })

    expect(onCommitProjectGroupTabOrder).not.toHaveBeenCalled()
  })

  it('does not commit when a stale session no longer contains the dragged group', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const groups = [group('a'), group('b'), group('c')]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))

    commitProjectGroupHeaderDragDrop({
      session: makeSession('c', ['a', 'b']),
      sidebarDropIndex: 0,
      projectGroupById,
      onCommitProjectGroupTabOrder
    })

    expect(onCommitProjectGroupTabOrder).not.toHaveBeenCalled()
  })
})
