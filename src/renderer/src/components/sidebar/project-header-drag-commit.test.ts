// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

import { commitProjectHeaderDragDrop } from './project-header-drag-commit'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import {
  getProjectHeaderDragBucketKey,
  getSidebarOrderedRepoHeaderRowsByBucket,
  getSidebarOrderedRepoHeaderIdsByBucket
} from './project-header-drop'
import { planSidebarRows } from '../../../../shared/sidebar-list/sidebar-row-plan'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { RepoHeaderRow } from './project-header-drop'
import type { Repo } from '../../../../shared/repo-types'
import { worktree } from './worktree-list-groups-test-fixtures'

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

function header(repo: Repo): RepoHeaderRow {
  return {
    type: 'header',
    key: JSON.stringify([repo.executionHostId, repo.connectionId, repo.id]),
    count: 0,
    icon: { kind: 'project' },
    repo
  }
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

    commitProjectHeaderDragDrop({
      session: makeSession(makeRepo('same'), ['b', 'same', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['b', 'same', 'c', 'same'],
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
    const sshTwin = makeRepo('c', { projectGroupId: 'group-1', connectionId: 'ssh-1' })

    commitProjectHeaderDragDrop({
      session: makeSession(sshTwin, ['a', 'b', 'c']),
      sidebarDropIndex: 0,
      orderedRepoIds: ['a', 'b', 'c'],
      liveRepos: [...repos, sshTwin],
      currentRepoHeaderRowsByBucket: new Map([
        ['group:group-1', [repos[0], repos[1], sshTwin].map(header)]
      ]),
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
      liveRepos: [...repos, { ...dragged, projectGroupId: 'group-2' }],
      usesProjectGroupOrdering: true,
      onCommitRepoOrder: vi.fn(),
      onCommitProjectGroupOrder
    })

    expect(onCommitProjectGroupOrder).not.toHaveBeenCalled()
  })
})

it('ranks a remote row against siblings from its own group rather than id-keyed twins', () => {
  const dragged = makeRepo('a', {
    executionHostId: 'runtime:remote',
    projectGroupId: 'remote',
    projectGroupOrder: 0
  })
  const sibling = makeRepo('b', {
    executionHostId: 'runtime:remote',
    projectGroupId: 'remote',
    projectGroupOrder: 10
  })
  const twin = makeRepo('b', {
    executionHostId: 'local',
    projectGroupId: 'local',
    projectGroupOrder: 100
  })
  const commit = vi.fn()
  commitProjectHeaderDragDrop({
    session: makeSession(dragged, ['a', 'b']),
    sidebarDropIndex: 2,
    orderedRepoIds: ['a', 'b'],
    liveRepos: [dragged, sibling, twin],
    currentRepoHeaderRowsByBucket: new Map([['group:remote', [dragged, sibling].map(header)]]),
    usesProjectGroupOrdering: true,
    onCommitRepoOrder: vi.fn(),
    onCommitProjectGroupOrder: commit
  })
  expect(commit).toHaveBeenCalledWith(dragged, 'remote', 11)
})

it('ranks after the visible unpinned sibling even when a same-host twin is pinned', () => {
  const dragged = makeRepo('a', {
    kind: 'folder',
    executionHostId: 'runtime:remote',
    projectGroupId: 'g',
    projectGroupOrder: 0
  })
  const remoteB = makeRepo('b', {
    kind: 'folder',
    executionHostId: 'runtime:remote',
    projectGroupId: 'g',
    projectGroupOrder: 10
  })
  const localB = makeRepo('b', {
    kind: 'folder',
    executionHostId: 'local',
    projectGroupId: 'g',
    projectGroupOrder: 100
  })
  const repos = [dragged, remoteB, localB]
  const group: ProjectGroup = {
    id: 'g',
    name: 'G',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
  const projection = projectHostSetupProjectionFromRepos(repos)
  const rows = planSidebarRows({
    groupBy: 'repo',
    worktrees: repos.map((repo) => ({
      ...worktree,
      id: `${repo.id}::/w`,
      repoId: repo.id,
      hostId: repo.executionHostId ?? 'local',
      path: '/w',
      branch: 'main',
      name: repo.id,
      isPinned: false
    })),
    repoMap: new Map([
      ['a', dragged],
      ['b', localB]
    ]),
    repoOfWorktree: (worktree) =>
      repos.find((repo) => repo.id === worktree.repoId && repo.executionHostId === worktree.hostId),
    prGroupOf: () => 'in-progress',
    repoOrder: new Map([
      ['a', 0],
      ['b', 1]
    ]),
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(),
    nestLineage: false,
    projectGroups: [group],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    projectGrouping: {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      personalProjectOrder: {
        projects: { '["runtime:remote","runtime:remote","repo:b"]': { pinned: true } },
        settledOperations: []
      }
    },
    folderWorkspaces: [],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set())
  const bucketKey = JSON.stringify(['group:g', false])
  const buckets = getSidebarOrderedRepoHeaderIdsByBucket(rows)
  const visibleUnpinned = rows.flatMap((row) =>
    row.type === 'header' && row.repo && !row.projectPinned ? [row.repo] : []
  )
  expect(visibleUnpinned).toEqual([dragged, localB])
  const commit = vi.fn()
  commitProjectHeaderDragDrop({
    session: {
      ...makeSession(dragged, ['a', 'b']),
      bucketKey,
      membershipBucketKey: 'group:g',
      fixedPinTier: true
    },
    sidebarDropIndex: 2,
    orderedRepoIds: ['a', 'b', 'b'],
    liveRepos: repos,
    currentBuckets: buckets,
    currentRepoHeaderRowsByBucket: getSidebarOrderedRepoHeaderRowsByBucket(rows),
    usesProjectGroupOrdering: true,
    onCommitRepoOrder: vi.fn(),
    onCommitProjectGroupOrder: commit
  })
  expect(commit).toHaveBeenCalledWith(dragged, 'g', 101)
})
