// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { commitProjectGroupHeaderDragDrop } from './project-group-header-drag-commit'
import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import type { ProjectGroup, Repo } from '../../../../shared/types'

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
  orderedRootSlots: ProjectGroupHeaderDragSession['orderedRootSlots'] = null
): ProjectGroupHeaderDragSession {
  return {
    groupId,
    bucketKey: 'root',
    sidebarProjectGroupHeaderIds,
    orderedRootSlots,
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
      repoById: new Map(),
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder: vi.fn()
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
      repoById: new Map(),
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder: vi.fn()
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
      repoById: new Map(),
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder: vi.fn()
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
      repoById: new Map(),
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder: vi.fn()
    })

    expect(onCommitProjectGroupTabOrder).not.toHaveBeenCalled()
  })

  it('renumbers root groups and ungrouped projects together after a root drop', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupOrder = vi.fn()
    const groups = [group('group-a', { tabOrder: 0 }), group('group-b', { tabOrder: 1 })]
    const repos: Repo[] = [
      {
        id: 'repo-x',
        path: '/x',
        displayName: 'x',
        badgeColor: '#000',
        addedAt: 0,
        projectGroupId: null,
        projectGroupOrder: 2
      } as Repo
    ]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const orderedRootSlots = [
      { kind: 'project-group' as const, id: 'group-a' },
      { kind: 'project-group' as const, id: 'group-b' },
      { kind: 'repo' as const, id: 'repo-x' }
    ]

    commitProjectGroupHeaderDragDrop({
      session: makeSession(
        'group-b',
        orderedRootSlots.map((slot) =>
          slot.kind === 'project-group' ? `project-group:${slot.id}` : `repo:${slot.id}`
        ),
        orderedRootSlots
      ),
      // Drop group-b before group-a → [group-b, group-a, repo-x]
      sidebarDropIndex: 0,
      projectGroupById,
      repoById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([
      ['group-b', 0],
      ['group-a', 1]
    ])
    // Why: repo-x stays at index 2 so its projectGroupOrder is already dense.
    expect(onCommitProjectGroupOrder).not.toHaveBeenCalled()
  })

  it('writes projectGroupOrder when a root group drop changes an ungrouped slot index', () => {
    const onCommitProjectGroupTabOrder = vi.fn()
    const onCommitProjectGroupOrder = vi.fn()
    const groups = [group('group-a', { tabOrder: 0 }), group('group-b', { tabOrder: 1 })]
    const repos: Repo[] = [
      {
        id: 'repo-x',
        path: '/x',
        displayName: 'x',
        badgeColor: '#000',
        addedAt: 0,
        projectGroupId: null,
        projectGroupOrder: 2
      } as Repo
    ]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const orderedRootSlots = [
      { kind: 'project-group' as const, id: 'group-a' },
      { kind: 'project-group' as const, id: 'group-b' },
      { kind: 'repo' as const, id: 'repo-x' }
    ]

    commitProjectGroupHeaderDragDrop({
      session: makeSession(
        'group-a',
        orderedRootSlots.map((slot) =>
          slot.kind === 'project-group' ? `project-group:${slot.id}` : `repo:${slot.id}`
        ),
        orderedRootSlots
      ),
      // Drop group-a after repo-x → [group-b, repo-x, group-a]
      sidebarDropIndex: 3,
      projectGroupById,
      repoById,
      onCommitProjectGroupTabOrder,
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([
      ['group-b', 0],
      ['group-a', 2]
    ])
    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith('repo-x', null, 1)
  })
})
