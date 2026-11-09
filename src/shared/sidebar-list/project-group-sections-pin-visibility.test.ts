import { describe, expect, it } from 'vitest'
import { cloneDefaultWorkspaceStatuses } from '../workspace/status/workspace-statuses'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host/execution-host'
import type { ProjectGroup } from '../project/groups/project-group-types'
import type { Repo } from '../repository/repo-types'
import type { Worktree } from '../worktree/types'
import type { WorktreeLineage } from '../worktree/lineage-types'
import { planSidebarRows } from './sidebar-row-plan'
import { getPinnedWorktreeDisplayPolicy, type GroupHeaderRow } from './row-types'

function makeGroup(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
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
    executionHostId: 'local',
    ...overrides
  }
}

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

function makeWorktree(id: string, repoId: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId,
    path: `/wt/${id}`,
    head: 'main',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    hostId: 'local',
    ...overrides
  }
}

function renderRepoPlanHeaders(args: {
  worktrees: Worktree[]
  repos: Repo[]
  pinCatalogRepos: Repo[]
  projectGroups: ProjectGroup[]
  lineageById?: Record<string, WorktreeLineage>
  nestLineage?: boolean
}): GroupHeaderRow[] {
  const rows = planSidebarRows({
    groupBy: 'repo',
    sortBy: 'smart',
    worktrees: args.worktrees,
    repoMap: new Map(args.repos.map((repo) => [repo.id, repo])),
    repos: args.repos,
    pinCatalogRepos: args.pinCatalogRepos,
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: args.lineageById ?? {},
    worktreeMap: new Map(args.worktrees.map((wt) => [wt.id, wt])),
    nestLineage: args.nestLineage ?? false,
    projectGroups: args.projectGroups,
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [],
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    pinnedDisplayPolicy: getPinnedWorktreeDisplayPolicy(),
    filterRepoIds: []
  }).render(new Set())
  return rows.filter(
    (row): row is GroupHeaderRow => row.type === 'header' && row.repo !== undefined
  )
}

describe('project-group pinned visibility and lineage isolation', () => {
  it('retains pinned twin repo membership from pinCatalogRepos when filtered repos omit that host', () => {
    const g1 = makeGroup('g1')
    const pinnedTwin = makeRepo('repo-twin', {
      path: '/remote/twin',
      projectGroupId: 'g1',
      projectGroupOrder: 1,
      executionHostId: 'ssh:remote',
      isPinned: true
    })
    const localTwin = makeRepo('repo-twin', {
      path: '/local/twin',
      projectGroupId: 'g1',
      projectGroupOrder: 1,
      executionHostId: 'local',
      isPinned: false
    })
    const unpinnedBefore = makeRepo('repo-unpinned', {
      projectGroupId: 'g1',
      projectGroupOrder: 0,
      isPinned: false
    })
    const wtLocal = makeWorktree('wt-local', 'repo-twin', { hostId: 'local' })
    const wtUnpinned = makeWorktree('wt-unpinned', 'repo-unpinned', { hostId: 'local' })

    const repoHeaders = renderRepoPlanHeaders({
      worktrees: [wtUnpinned, wtLocal],
      repos: [unpinnedBefore, localTwin],
      pinCatalogRepos: [unpinnedBefore, localTwin, pinnedTwin],
      projectGroups: [g1]
    })

    expect(repoHeaders.map((row) => row.repo!.id)).toEqual(['repo-twin', 'repo-unpinned'])
    expect(repoHeaders[0]?.pinTargetRepos?.some((repo) => repo.isPinned === true)).toBe(true)
  })

  it('does not mark an unpinned group project pinned when a relocated lineage child belongs to another pinned repo', () => {
    const g1 = makeGroup('g1')
    const unpinnedBefore = makeRepo('repo-before', {
      projectGroupId: 'g1',
      projectGroupOrder: 0,
      isPinned: false
    })
    const unpinnedA = makeRepo('repo-a', {
      projectGroupId: 'g1',
      projectGroupOrder: 1,
      isPinned: false
    })
    const pinnedB = makeRepo('repo-b', {
      projectGroupId: 'g1',
      projectGroupOrder: 2,
      isPinned: true
    })
    const wtBefore = makeWorktree('wt-before', 'repo-before')
    const wtA = makeWorktree('wt-a', 'repo-a')
    const wtBChild = makeWorktree('wt-b-child', 'repo-b')

    const repoHeaders = renderRepoPlanHeaders({
      worktrees: [wtBefore, wtA, wtBChild],
      repos: [unpinnedBefore, unpinnedA, pinnedB],
      pinCatalogRepos: [unpinnedBefore, unpinnedA, pinnedB],
      projectGroups: [g1],
      lineageById: {
        'wt-b-child': {
          worktreeId: 'wt-b-child',
          worktreeInstanceId: 'inst-b-child',
          parentWorktreeId: 'wt-a',
          parentWorktreeInstanceId: 'inst-a',
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: 1
        }
      },
      nestLineage: true
    })

    expect(repoHeaders.map((row) => row.repo!.id)).toEqual(['repo-b', 'repo-before', 'repo-a'])
  })
})
