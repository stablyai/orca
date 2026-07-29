// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { ProjectGroup, Repo } from '../../../../shared/types'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

function makeSession(
  repoId: string,
  sidebarRepoHeaderIds: readonly string[],
  orderedRootSlots: ProjectHeaderDragSession['orderedRootSlots'] = null
): ProjectHeaderDragSession {
  return {
    repoId,
    bucketKey: 'ungrouped',
    sidebarRepoHeaderIds,
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

describe('commitProjectHeaderDragDrop', () => {
  it('commits whole-repo reordering when project groups are absent', () => {
    const onCommitRepoOrder = vi.fn()
    const repos = [makeRepo('a'), makeRepo('b'), makeRepo('c')]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession('c', ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['a', 'b', 'c'],
      repoById,
      projectGroupById: new Map(),
      usesProjectGroupOrdering: false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder: vi.fn(),
      onCommitProjectGroupTabOrder: vi.fn()
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['c', 'a', 'b'])
  })

  it('moves a merged paired-host header upward as one stable block', () => {
    const onCommitRepoOrder = vi.fn()
    const repos = [makeRepo('b'), makeRepo('same'), makeRepo('c')]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession('same', ['b', 'same', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['b', 'same', 'c', 'same'],
      repoById,
      projectGroupById: new Map(),
      usesProjectGroupOrdering: false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder: vi.fn(),
      onCommitProjectGroupTabOrder: vi.fn()
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['same', 'same', 'b', 'c'])
  })

  it('does not reorder host occurrences when a merged header stays in place', () => {
    const onCommitRepoOrder = vi.fn()
    const repos = [makeRepo('b'), makeRepo('same'), makeRepo('c')]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession('same', ['b', 'same', 'c']),
      sidebarDropIndex: 2,
      orderedRepoIds: ['b', 'same', 'c', 'same'],
      repoById,
      projectGroupById: new Map(),
      usesProjectGroupOrdering: false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder: vi.fn(),
      onCommitProjectGroupTabOrder: vi.fn()
    })

    expect(onCommitRepoOrder).not.toHaveBeenCalled()
  })

  it('commits projectGroupOrder when project groups are present', () => {
    const onCommitProjectGroupOrder = vi.fn()
    const repos = [
      makeRepo('a', { projectGroupId: 'group-1' }),
      makeRepo('b', { projectGroupId: 'group-1' }),
      makeRepo('c', { projectGroupId: 'group-1' })
    ]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession('c', ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['a', 'b', 'c'],
      repoById,
      projectGroupById: new Map(),
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onCommitProjectGroupTabOrder: vi.fn()
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith('c', 'group-1', -1)
  })

  it('renumbers root groups and ungrouped projects when dropping an ungrouped repo', () => {
    const onCommitProjectGroupOrder = vi.fn()
    const onCommitProjectGroupTabOrder = vi.fn()
    const groups: ProjectGroup[] = [
      {
        id: 'group-a',
        name: 'A',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'group-b',
        name: 'B',
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 1,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const repos = [
      makeRepo('repo-x', { projectGroupId: null, projectGroupOrder: 2 }),
      makeRepo('repo-y', { projectGroupId: null, projectGroupOrder: 3 })
    ]
    const projectGroupById = new Map(groups.map((entry) => [entry.id, entry]))
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const orderedRootSlots = [
      { kind: 'project-group' as const, id: 'group-a' },
      { kind: 'project-group' as const, id: 'group-b' },
      { kind: 'repo' as const, id: 'repo-x' },
      { kind: 'repo' as const, id: 'repo-y' }
    ]

    commitProjectHeaderDragDrop({
      session: makeSession(
        'repo-y',
        orderedRootSlots.map((slot) =>
          slot.kind === 'project-group' ? `project-group:${slot.id}` : `repo:${slot.id}`
        ),
        orderedRootSlots
      ),
      // Drop repo-y between the two groups → [group-a, repo-y, group-b, repo-x]
      sidebarDropIndex: 1,
      orderedRepoIds: ['repo-x', 'repo-y'],
      repoById,
      projectGroupById,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder,
      onCommitProjectGroupTabOrder
    })

    expect(onCommitProjectGroupTabOrder.mock.calls).toEqual([['group-b', 2]])
    expect(onCommitProjectGroupOrder.mock.calls).toEqual([
      ['repo-y', null, 1],
      ['repo-x', null, 3]
    ])
  })
})
