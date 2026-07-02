// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { commitGroupHeaderDragDrop } from './group-header-drag-commit'
import type { GroupHeaderDragSession } from './group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

function makeGroup(id: string, tabOrder: number): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeSession(groupId: string, siblingGroupIds: readonly string[]): GroupHeaderDragSession {
  return {
    groupId,
    parentGroupId: null,
    siblingGroupIds,
    pointerId: 1,
    headerRects: [],
    handleEl: document.createElement('div'),
    startX: 0,
    startY: 0,
    latestPointerY: 0,
    promoted: true
  }
}

describe('commitGroupHeaderDragDrop', () => {
  it('commits a new interpolated tabOrder when a group moves to the front', () => {
    const onCommitGroupOrder = vi.fn()
    const groups = [makeGroup('a', 0), makeGroup('b', 1), makeGroup('c', 2)]
    const groupsById = new Map(groups.map((g) => [g.id, g]))
    commitGroupHeaderDragDrop({
      session: makeSession('c', ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      groupsById,
      onCommitGroupOrder
    })
    // Siblings after removing 'c' are [a(0), b(1)]; insert at 0 -> below a -> -1
    expect(onCommitGroupOrder).toHaveBeenCalledWith('c', -1)
  })

  it('does not commit when the drop index equals the source index', () => {
    const onCommitGroupOrder = vi.fn()
    const groups = [makeGroup('a', 0), makeGroup('b', 1)]
    const groupsById = new Map(groups.map((g) => [g.id, g]))
    commitGroupHeaderDragDrop({
      session: makeSession('a', ['a', 'b']),
      sidebarDropIndex: 0,
      groupsById,
      onCommitGroupOrder
    })
    expect(onCommitGroupOrder).not.toHaveBeenCalled()
  })
})
