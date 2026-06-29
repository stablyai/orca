// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import type { Repo } from '../../../../shared/types'

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
  sidebarRepoHeaderIds: readonly string[]
): ProjectHeaderDragSession {
  return {
    repoId,
    bucketKey: 'ungrouped',
    sidebarRepoHeaderIds,
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
      usesProjectGroupOrdering: false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder: vi.fn()
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['c', 'a', 'b'])
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
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith('c', 'group-1', -1)
  })

  it('moves a project into a different group when the target bucket differs', () => {
    const onCommitProjectGroupOrder = vi.fn()
    const repos = [
      makeRepo('a', { projectGroupId: 'group-1', projectGroupOrder: 0 }),
      makeRepo('b', { projectGroupId: 'group-2', projectGroupOrder: 0 }),
      makeRepo('c', { projectGroupId: 'group-1', projectGroupOrder: 1 })
    ]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession('c', ['c']), // c dragged out of group-1
      sidebarDropIndex: 1,
      targetBucketKey: 'group:group-2',
      sidebarRepoHeaderIdsByBucketAll: new Map([
        ['group:group-1', ['a', 'c']],
        ['group:group-2', ['b']]
      ]),
      orderedRepoIds: ['a', 'b', 'c'],
      repoById,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith('c', 'group-2', expect.any(Number))
  })

  it('ungroups a project when the target bucket is ungrouped', () => {
    const onCommitProjectGroupOrder = vi.fn()
    const repos = [
      makeRepo('a', { projectGroupId: 'group-1', projectGroupOrder: 0 }),
      makeRepo('u', { projectGroupId: null, projectGroupOrder: 0 })
    ]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession('a', ['a']),
      sidebarDropIndex: 1,
      targetBucketKey: 'ungrouped',
      sidebarRepoHeaderIdsByBucketAll: new Map([
        ['group:group-1', ['a']],
        ['ungrouped', ['u']]
      ]),
      orderedRepoIds: ['a', 'u'],
      repoById,
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith('a', null, expect.any(Number))
  })
})
