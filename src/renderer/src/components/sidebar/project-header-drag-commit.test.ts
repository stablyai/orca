// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import { getProjectHeaderDragBucketKey } from './project-header-drop'
import type { Repo } from '../../../../shared/repo-types'

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
  repo: Repo,
  sidebarRepoHeaderIds: readonly string[]
): ProjectHeaderDragSession {
  return {
    repo,
    bucketKey: getProjectHeaderDragBucketKey(repo),
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
  it('moves a merged paired-host header upward as one stable block', () => {
    const onCommitRepoOrder = vi.fn()
    const repos = [makeRepo('b'), makeRepo('same'), makeRepo('c')]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))

    commitProjectHeaderDragDrop({
      session: makeSession(makeRepo('same'), ['b', 'same', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['b', 'same', 'c', 'same'],
      repoById,
      liveRepos: repos,
      usesProjectGroupOrdering: false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder: vi.fn()
    })

    expect(onCommitRepoOrder).toHaveBeenCalledWith(['same', 'same', 'b', 'c'])
  })

  it('commits projectGroupOrder for the dragged row, not the id-keyed twin on another host', () => {
    const onCommitProjectGroupOrder = vi.fn()
    const repos = [
      makeRepo('a', { projectGroupId: 'group-1' }),
      makeRepo('b', { projectGroupId: 'group-1' }),
      makeRepo('c', { projectGroupId: 'group-1', executionHostId: 'local' })
    ]
    const repoById = new Map(repos.map((repo) => [repo.id, repo]))
    const sshTwin = makeRepo('c', { projectGroupId: 'group-1', connectionId: 'ssh-1' })

    commitProjectHeaderDragDrop({
      session: makeSession(sshTwin, ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['a', 'b', 'c'],
      repoById,
      liveRepos: [...repos, sshTwin],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupOrder).toHaveBeenCalledWith(sshTwin, 'group-1', -1)
  })

  it('drops nothing when the dragged row changed group during the drag', () => {
    const onCommitProjectGroupOrder = vi.fn()
    const repos = [
      makeRepo('a', { projectGroupId: 'group-1' }),
      makeRepo('b', { projectGroupId: 'group-1' })
    ]
    const dragged = makeRepo('c', { projectGroupId: 'group-1' })

    commitProjectHeaderDragDrop({
      session: makeSession(dragged, ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['a', 'b', 'c'],
      repoById: new Map([...repos, dragged].map((repo) => [repo.id, repo])),
      liveRepos: [...repos, { ...dragged, projectGroupId: 'group-2' }],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupOrder).not.toHaveBeenCalled()
  })
})
