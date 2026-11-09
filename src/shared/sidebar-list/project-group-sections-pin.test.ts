import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import { createProjectGroup } from '../project-groups'
import type { ProjectGroup } from '../project-group-types'
import type { ProjectSectionEntry, ProjectSectionRepo } from '../project-section-grouping'
import { orderProjectSections, type ActivityItem } from '../project-section-order'
import type { Repo } from '../repo-types'
import { NO_WORKSPACE_ROW_FILTERS } from '../workspace-view/workspace-row-filters'
import type { Worktree } from '../worktree/types'
import { ALL_GROUP_KEY } from './group-keys'
import type { HostSectionRow } from './host-section-rows'
import { isProjectHeaderRowPinned, type GroupHeaderRow } from './row-types'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import {
  buildSidebarFeedRows,
  type SidebarFeedCatalog,
  type SidebarFeedView
} from './sidebar-feed-rows'
import { buildWorkspaceRows } from './workspace-rows'

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#111111',
    addedAt: 0,
    ...overrides
  }
}

function makeWorktree(repoId: string, lastActivityAt: number): Worktree {
  return {
    id: `${repoId}::/${repoId}`,
    repoId,
    path: `/${repoId}`,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: repoId,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt
  }
}

function headerOutline(rows: readonly HostSectionRow[]): string[] {
  return rows.flatMap((row) =>
    row.type === 'header' && row.key !== ALL_GROUP_KEY
      ? [`${row.label ?? row.key}@${String(row.projectGroupDepth ?? 0)}`]
      : []
  )
}

function feedFor(
  repos: Repo[],
  projectGroups: ProjectGroup[],
  worktrees: Worktree[],
  projectOrderBy: 'manual' | 'recent',
  projectGrouping: SidebarFeedCatalog['projectGrouping'] = { projects: [], projectHostSetups: [] },
  visibleWorkspaceHostIds:
    | readonly ('local' | `ssh:${string}` | `runtime:${string}`)[]
    | null = null
): HostSectionRow[] {
  const workspaces = buildWorkspaceRows({
    worktrees,
    folderWorkspaces: [],
    repos,
    lineageById: {}
  })
  const domains: SidebarFeedDomains = {
    workspaces,
    activity: new Map(),
    review: new Map(),
    creations: new Map(),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null
  }
  const catalog: SidebarFeedCatalog = {
    repos,
    projectGroups,
    projectGrouping
  }
  const view: SidebarFeedView = {
    groupBy: 'repo',
    sortBy: 'recent',
    projectOrderBy,
    collapsedGroups: new Set(),
    filters: NO_WORKSPACE_ROW_FILTERS,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds,
    workspaceStatuses: [],
    pinnedDisplayPolicy: 'single-location',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    hostLabelOverrides: new Map(),
    localHostLabel: 'This computer'
  }
  return buildSidebarFeedRows(domains, catalog, view).sectionRows
}

describe('project and project-group pinning order', () => {
  it('orders flat project sections with pinned projects first in both manual and recent modes, including multi-host repoIds', () => {
    const repoA: ProjectSectionRepo = {
      id: 'repo-a',
      displayName: 'Alpha',
      path: '/alpha',
      addedAt: 100
    }
    const repoBLocal: ProjectSectionRepo = {
      id: 'repo-b-local',
      displayName: 'Beta',
      path: '/beta',
      addedAt: 10
    }
    const repoBRemote: ProjectSectionRepo = {
      id: 'repo-b-remote',
      displayName: 'Beta',
      path: '/srv/beta',
      addedAt: 10,
      isPinned: true
    }
    const repoC: ProjectSectionRepo = {
      id: 'repo-c',
      displayName: 'Gamma',
      path: '/gamma',
      addedAt: 50,
      isPinned: true
    }
    const repoMap = new Map<string, ProjectSectionRepo>([
      [repoA.id, repoA],
      [repoBLocal.id, repoBLocal],
      [repoBRemote.id, repoBRemote],
      [repoC.id, repoC]
    ])
    const makeSections = () =>
      new Map<string, ProjectSectionEntry<ActivityItem, ProjectSectionRepo>>([
        [
          'project:alpha',
          {
            label: 'Alpha',
            items: [{ lastActivityAt: 9_000 }],
            repo: repoA,
            repoIds: new Set([repoA.id])
          }
        ],
        [
          'project:beta',
          {
            label: 'Beta',
            items: [{ lastActivityAt: 100 }],
            repo: repoBLocal,
            repoIds: new Set([repoBLocal.id, repoBRemote.id])
          }
        ],
        [
          'project:gamma',
          {
            label: 'Gamma',
            items: [{ lastActivityAt: 500 }],
            repo: repoC,
            repoIds: new Set([repoC.id])
          }
        ]
      ])
    const repoOrder = new Map<string, number>([
      ['repo-a', 0],
      ['repo-b-local', 1],
      ['repo-b-remote', 2],
      ['repo-c', 3]
    ])

    expect(
      orderProjectSections(makeSections(), repoMap, repoOrder, 'manual').map(([key]) => key)
    ).toEqual(['project:beta', 'project:gamma', 'project:alpha'])

    expect(
      orderProjectSections(makeSections(), repoMap, repoOrder, 'recent').map(([key]) => key)
    ).toEqual(['project:gamma', 'project:beta', 'project:alpha'])
  })

  it('orders pinned root groups, subgroups, grouped projects, subgroup projects, and ungrouped projects first in manual and recent modes', () => {
    const groupUnpinned: ProjectGroup = {
      ...createProjectGroup({ name: 'Group Unpinned', createdFrom: 'manual', tabOrder: 0 }),
      id: 'g-unpinned',
      isPinned: false
    }
    const groupPinned: ProjectGroup = {
      ...createProjectGroup({ name: 'Group Pinned', createdFrom: 'manual', tabOrder: 5 }),
      id: 'g-pinned',
      isPinned: true
    }
    const groupPinnedRanked: ProjectGroup = {
      ...createProjectGroup({ name: 'Group Pinned Ranked', createdFrom: 'manual', tabOrder: 6 }),
      id: 'g-pinned-ranked',
      rootProjectOrder: 5,
      isPinned: true
    }
    const subUnpinned: ProjectGroup = {
      ...createProjectGroup({
        name: 'Sub Unpinned',
        parentGroupId: 'g-pinned',
        createdFrom: 'manual',
        tabOrder: 0
      }),
      id: 'sub-unpinned',
      isPinned: false
    }
    const subPinned: ProjectGroup = {
      ...createProjectGroup({
        name: 'Sub Pinned',
        parentGroupId: 'g-pinned',
        createdFrom: 'manual',
        tabOrder: 3
      }),
      id: 'sub-pinned',
      isPinned: true
    }

    const repos: Repo[] = [
      makeRepo('grp-unpinned-repo', {
        displayName: 'GrpUnpinnedRepo',
        projectGroupId: 'g-pinned',
        projectGroupOrder: 0,
        isPinned: false
      }),
      makeRepo('grp-pinned-repo', {
        displayName: 'GrpPinnedRepo',
        projectGroupId: 'g-pinned',
        projectGroupOrder: 10,
        isPinned: true
      }),
      makeRepo('sub-unpinned-repo', {
        displayName: 'SubUnpinnedRepo',
        projectGroupId: 'sub-pinned',
        projectGroupOrder: 0,
        isPinned: false
      }),
      makeRepo('sub-pinned-repo', {
        displayName: 'SubPinnedRepo',
        projectGroupId: 'sub-pinned',
        projectGroupOrder: 10,
        isPinned: true
      }),
      makeRepo('root-unpinned-repo', {
        displayName: 'RootUnpinnedRepo',
        projectGroupId: null,
        projectGroupOrder: 0,
        isPinned: false
      }),
      makeRepo('root-pinned-repo', {
        displayName: 'RootPinnedRepo',
        projectGroupId: null,
        projectGroupOrder: 10,
        isPinned: true
      })
    ]

    // Give every unpinned repo MORE recent activity than its pinned sibling to prove pin wins in 'recent' too
    const worktrees: Worktree[] = [
      makeWorktree('grp-unpinned-repo', 9_000),
      makeWorktree('grp-pinned-repo', 100),
      makeWorktree('sub-unpinned-repo', 8_000),
      makeWorktree('sub-pinned-repo', 200),
      makeWorktree('root-unpinned-repo', 7_000),
      makeWorktree('root-pinned-repo', 300)
    ]

    const expectedOutline = [
      'Group Pinned@0',
      'Sub Pinned@1',
      'SubPinnedRepo@2',
      'SubUnpinnedRepo@2',
      'GrpPinnedRepo@1',
      'Sub Unpinned@1',
      'GrpUnpinnedRepo@1',
      'Group Pinned Ranked@0',
      'RootPinnedRepo@0',
      'Group Unpinned@0',
      'RootUnpinnedRepo@0'
    ]

    expect(
      headerOutline(
        feedFor(
          repos,
          [groupUnpinned, groupPinned, groupPinnedRanked, subUnpinned, subPinned],
          worktrees,
          'manual'
        )
      )
    ).toEqual(expectedOutline)

    expect(
      headerOutline(
        feedFor(
          repos,
          [groupUnpinned, groupPinned, groupPinnedRanked, subUnpinned, subPinned],
          worktrees,
          'recent'
        )
      )
    ).toEqual(expectedOutline)
  })

  it('interleaves subgroups and projects by manual rank within each pin tier inside a group', () => {
    const parent: ProjectGroup = {
      ...createProjectGroup({ name: 'Parent', createdFrom: 'manual', tabOrder: 0 }),
      id: 'parent'
    }
    const pinnedTopSub: ProjectGroup = {
      ...createProjectGroup({
        name: 'PinnedTopSub',
        parentGroupId: 'parent',
        createdFrom: 'manual',
        tabOrder: -1
      }),
      id: 'sub-pinned-top',
      isPinned: true
    }
    const pinnedAfterRepoSub: ProjectGroup = {
      ...createProjectGroup({
        name: 'PinnedAfterRepoSub',
        parentGroupId: 'parent',
        createdFrom: 'manual',
        tabOrder: 1
      }),
      id: 'sub-pinned-after',
      isPinned: true
    }
    const middleSub: ProjectGroup = {
      ...createProjectGroup({
        name: 'MiddleSub',
        parentGroupId: 'parent',
        createdFrom: 'manual',
        tabOrder: 1
      }),
      id: 'sub-middle',
      isPinned: false
    }

    const repos: Repo[] = [
      makeRepo('pinned-repo', {
        displayName: 'PinnedRepo',
        projectGroupId: 'parent',
        projectGroupOrder: 0,
        isPinned: true
      }),
      makeRepo('p1', {
        displayName: 'P1',
        projectGroupId: 'parent',
        projectGroupOrder: 0,
        isPinned: false
      }),
      makeRepo('p2', {
        displayName: 'P2',
        projectGroupId: 'parent',
        projectGroupOrder: 2,
        isPinned: false
      }),
      makeRepo('middle-child', {
        displayName: 'MiddleChild',
        projectGroupId: 'sub-middle',
        projectGroupOrder: 0,
        isPinned: false
      })
    ]
    const worktrees: Worktree[] = [
      makeWorktree('pinned-repo', 100),
      makeWorktree('p1', 1_000),
      makeWorktree('p2', 9_000),
      makeWorktree('middle-child', 500)
    ]

    expect(
      headerOutline(
        feedFor(repos, [parent, pinnedTopSub, pinnedAfterRepoSub, middleSub], worktrees, 'manual')
      )
    ).toEqual([
      'Parent@0',
      'PinnedTopSub@1',
      'PinnedRepo@1',
      'PinnedAfterRepoSub@1',
      'P1@1',
      'MiddleSub@1',
      'MiddleChild@2',
      'P2@1'
    ])

    expect(
      headerOutline(
        feedFor(repos, [parent, pinnedTopSub, pinnedAfterRepoSub, middleSub], worktrees, 'recent')
      )
    ).toEqual([
      'Parent@0',
      'PinnedTopSub@1',
      'PinnedAfterRepoSub@1',
      'PinnedRepo@1',
      'MiddleSub@1',
      'MiddleChild@2',
      'P2@1',
      'P1@1'
    ])
  })

  it('preserves existing manual layout when legacy grouped projects omit projectGroupOrder alongside a subgroup', () => {
    const parent: ProjectGroup = {
      ...createProjectGroup({ name: 'Parent', createdFrom: 'manual', tabOrder: 0 }),
      id: 'parent',
      isPinned: false
    }
    const legacySub: ProjectGroup = {
      ...createProjectGroup({
        name: 'LegacySub',
        parentGroupId: 'parent',
        createdFrom: 'manual',
        tabOrder: 1
      }),
      id: 'legacy-sub',
      isPinned: false
    }
    const repos: Repo[] = [
      makeRepo('repo-a', {
        displayName: 'RepoA',
        projectGroupId: 'parent',
        isPinned: false
      }),
      makeRepo('repo-b', {
        displayName: 'RepoB',
        projectGroupId: 'parent',
        isPinned: false
      })
    ]
    const worktrees: Worktree[] = [makeWorktree('repo-a', 100), makeWorktree('repo-b', 200)]

    expect(headerOutline(feedFor(repos, [parent, legacySub], worktrees, 'manual'))).toEqual([
      'Parent@0',
      'RepoA@1',
      'RepoB@1',
      'LegacySub@1'
    ])
  })

  it('detects pinned state across single-host and multi-host project header rows', () => {
    const unpinnedRepo = makeRepo('r1', { isPinned: false })
    const pinnedTwin = makeRepo('r1', { executionHostId: 'ssh:builder', isPinned: true })
    const multiHostRow: GroupHeaderRow = {
      type: 'header',
      key: 'project:r1',
      label: 'r1',
      count: 2,
      icon: { kind: 'project' },
      repo: unpinnedRepo,
      hostRepos: new Map([
        ['local', unpinnedRepo],
        ['ssh:builder', pinnedTwin]
      ])
    }
    expect(isProjectHeaderRowPinned(multiHostRow)).toBe(true)
    expect(
      isProjectHeaderRowPinned({
        ...multiHostRow,
        hostRepos: new Map([['local', unpinnedRepo]])
      })
    ).toBe(false)
  })

  it('preserves pin state and all backing target repos across localizeProjectHeader and single-worktree ProjectGrouping twins', () => {
    const sharedLocal = makeRepo('shared-alpha', {
      displayName: 'SharedAlpha',
      executionHostId: 'local',
      isPinned: true
    })
    const sharedBuilder = makeRepo('shared-alpha', {
      displayName: 'SharedAlpha',
      path: '/srv/shared-alpha',
      connectionId: 'builder',
      isPinned: false
    })
    const sharedStaging = makeRepo('shared-alpha', {
      displayName: 'SharedAlpha',
      path: '/stg/shared-alpha',
      connectionId: 'staging',
      isPinned: false
    })
    const linkedLocal = makeRepo('linked-local', {
      displayName: 'LinkedBeta',
      executionHostId: 'local',
      isPinned: false
    })
    const linkedRemote = makeRepo('linked-remote', {
      displayName: 'LinkedBeta',
      path: '/srv/linked',
      connectionId: 'builder',
      isPinned: true
    })
    const unpinnedGamma = makeRepo('gamma', {
      displayName: 'Gamma',
      executionHostId: 'local',
      isPinned: false
    })

    const sectionRows = feedFor(
      [unpinnedGamma, sharedLocal, sharedBuilder, sharedStaging, linkedLocal, linkedRemote],
      [],
      [
        makeWorktree('gamma', 9_000),
        { ...makeWorktree('shared-alpha', 100), hostId: 'local' },
        { ...makeWorktree('shared-alpha', 200), id: 'shared-b', hostId: 'ssh:builder' },
        { ...makeWorktree('shared-alpha', 300), id: 'shared-s', hostId: 'ssh:staging' },
        makeWorktree('linked-local', 50)
      ],
      'recent',
      {
        projects: [{ id: 'proj-linked', displayName: 'LinkedBeta' }],
        projectHostSetups: [
          {
            id: 'setup-1',
            projectId: 'proj-linked',
            hostId: 'local',
            repoId: 'linked-local',
            path: '/linked-local',
            displayName: 'LinkedBeta',
            setupMethod: 'imported-existing-folder'
          },
          {
            id: 'setup-2',
            projectId: 'proj-linked',
            hostId: 'ssh:builder',
            repoId: 'linked-remote',
            path: '/srv/linked',
            displayName: 'LinkedBeta',
            setupMethod: 'imported-existing-folder'
          }
        ]
      },
      ['local', 'ssh:builder', 'ssh:staging']
    )

    const localHeaders = sectionRows.filter(
      (row): row is GroupHeaderRow =>
        row.type === 'header' && row.key !== ALL_GROUP_KEY && (row.hostId ?? 'local') === 'local'
    )
    // Both SharedAlpha (pinned on local, overwritten in repoMap by ssh:staging) and LinkedBeta (pinned on ssh:builder with 0 worktrees) must beat unpinned Gamma!
    expect(localHeaders.map((row) => row.label)).toEqual(['SharedAlpha', 'LinkedBeta', 'Gamma'])

    const sharedHeaders = sectionRows.filter(
      (row): row is GroupHeaderRow => row.type === 'header' && row.label === 'SharedAlpha'
    )
    expect(sharedHeaders).toHaveLength(3)
    for (const header of sharedHeaders) {
      expect(header.hostRepos).toBeUndefined()
      expect(isProjectHeaderRowPinned(header)).toBe(true)
      expect(header.pinTargetRepos).toEqual([sharedLocal, sharedBuilder, sharedStaging])
    }

    const linkedHeader = localHeaders.find((row) => row.label === 'LinkedBeta')!
    expect(linkedHeader.hostRepos).toBeUndefined()
    expect(isProjectHeaderRowPinned(linkedHeader)).toBe(true)
    expect(linkedHeader.pinTargetRepos).toEqual([linkedLocal, linkedRemote])
  })
})
