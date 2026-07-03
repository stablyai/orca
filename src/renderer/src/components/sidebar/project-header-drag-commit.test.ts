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
})
