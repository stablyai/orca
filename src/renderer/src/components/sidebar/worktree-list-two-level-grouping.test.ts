import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getGroupKeysForWorktree } from './worktree-list/grouping/worktree-group-keys'
import {
  project,
  projectHostSetups,
  remoteRepo,
  remoteWorktree,
  repo,
  worktree,
  repoMap
} from './worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import type { WorktreeGroupBy, WorktreeGroupBySecondary } from './worktree-list/grouping/row-types'

function buildNestedRows(
  groupBy: WorktreeGroupBy,
  groupBySecondary: WorktreeGroupBySecondary,
  worktrees: Worktree[],
  repos: Map<string, Repo>,
  collapsedGroups: Set<string> = new Set<string>(),
  projectGroups: readonly ProjectGroup[] = [],
  folderWorkspaces: readonly FolderWorkspace[] = [],
  emptySecondaryStatusSourceGroupKey: string | null = null,
  workspaceStatuses?: readonly WorkspaceStatusDefinition[]
) {
  return buildRows(
    groupBy,
    worktrees,
    repos,
    null,
    collapsedGroups,
    undefined,
    workspaceStatuses,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    projectGroups,
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    folderWorkspaces,
    undefined,
    undefined,
    undefined,
    {
      secondary: groupBySecondary,
      emptySecondaryStatusSourceGroupKey
    }
  )
}

function buildStatusProjectRows(
  worktrees: Worktree[],
  repos: Map<string, Repo>,
  collapsedGroups: Set<string> = new Set<string>(),
  projectGroups: readonly ProjectGroup[] = []
) {
  return buildNestedRows(
    'workspace-status',
    'repo',
    worktrees,
    repos,
    collapsedGroups,
    projectGroups
  )
}

describe('status then project grouping', () => {
  it('nests project headers and worktrees beneath their status lane', () => {
    const secondRepo: Repo = {
      ...repo,
      id: 'repo-2',
      path: '/tmp/web',
      displayName: 'web'
    }
    const secondWorktree: Worktree = {
      ...worktree,
      id: 'wt-2',
      repoId: secondRepo.id,
      path: '/tmp/web-feature',
      displayName: 'web feature'
    }

    const rows = buildStatusProjectRows(
      [worktree, secondWorktree],
      new Map([
        [repo.id, repo],
        [secondRepo.id, secondRepo]
      ])
    )

    expect(rows[0]).toMatchObject({
      type: 'header',
      groupKind: 'workspace-status',
      key: 'workspace-status:in-progress',
      count: 2
    })
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'header',
        groupKind: 'repo',
        key: 'workspace-status:in-progress/repo:repo-1',
        projectGroupDepth: 1,
        count: 1
      })
    )
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'item',
        sectionKey: 'workspace-status:in-progress/repo:repo-1',
        groupDepth: 1,
        worktree: expect.objectContaining({ id: worktree.id })
      })
    )
  })

  it('preserves the Project Group hierarchy inside each status lane', () => {
    const projectGroup: ProjectGroup = {
      id: 'group-platform',
      name: 'Platform',
      parentPath: '/tmp',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = { ...repo, projectGroupId: projectGroup.id }
    const groupedRepoMap = new Map([[groupedRepo.id, groupedRepo]])

    const rows = buildStatusProjectRows([worktree], groupedRepoMap, new Set(), [projectGroup])

    expect(rows.filter((row) => row.type === 'header')).toMatchObject([
      { key: 'workspace-status:in-progress' },
      {
        key: 'workspace-status:in-progress/project-group:group-platform',
        groupKind: 'project-group',
        projectGroupDepth: 1
      },
      {
        key: 'workspace-status:in-progress/repo:repo-1',
        groupKind: 'repo',
        projectGroupDepth: 2
      }
    ])
    expect(
      getGroupKeysForWorktree(
        'workspace-status',
        worktree,
        groupedRepoMap,
        null,
        undefined,
        undefined,
        [projectGroup],
        undefined,
        'repo'
      )
    ).toEqual([
      'workspace-status:in-progress',
      'workspace-status:in-progress/project-group:group-platform',
      'workspace-status:in-progress/repo:repo-1'
    ])
  })

  it('collapses the same project independently in each status lane', () => {
    const reviewWorktree: Worktree = {
      ...worktree,
      id: 'wt-review',
      path: '/tmp/orca-review',
      workspaceStatus: 'in-review'
    }
    const collapsedProjectKey = 'workspace-status:in-progress/repo:repo-1'
    const reviewProjectKey = 'workspace-status:in-review/repo:repo-1'

    const rows = buildStatusProjectRows(
      [worktree, reviewWorktree],
      repoMap,
      new Set([collapsedProjectKey])
    )

    expect(rows).toContainEqual(
      expect.objectContaining({ type: 'header', key: collapsedProjectKey })
    )
    expect(rows).toContainEqual(expect.objectContaining({ type: 'header', key: reviewProjectKey }))
    expect(rows.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
      'wt-review'
    ])
  })

  it('returns both collapse keys when revealing a nested worktree', () => {
    expect(
      getGroupKeysForWorktree(
        'workspace-status',
        worktree,
        repoMap,
        null,
        undefined,
        undefined,
        [],
        undefined,
        'repo'
      )
    ).toEqual(['workspace-status:in-progress', 'workspace-status:in-progress/repo:repo-1'])
  })
})

describe('arbitrary two-level grouping', () => {
  it.each([
    ['workspace-status', 'repo', 'workspace-status:in-progress', 'repo:repo-1'],
    ['workspace-status', 'pr-status', 'workspace-status:in-progress', 'pr:in-progress'],
    ['pr-status', 'workspace-status', 'pr:in-progress', 'workspace-status:in-progress'],
    ['pr-status', 'repo', 'pr:in-progress', 'repo:repo-1'],
    ['repo', 'workspace-status', 'repo:repo-1', 'workspace-status:in-progress'],
    ['repo', 'pr-status', 'repo:repo-1', 'pr:in-progress']
  ] as const)(
    'renders %s then %s with a qualified child key',
    (primary, secondary, primaryKey, secondaryKey) => {
      const rows = buildNestedRows(primary, secondary, [worktree], repoMap)

      expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
        primaryKey,
        `${primaryKey}/${secondaryKey}`
      ])
      expect(rows.find((row) => row.type === 'item')).toMatchObject({
        type: 'item',
        sectionKey: `${primaryKey}/${secondaryKey}`,
        groupDepth: 1,
        ...(primary === 'repo' || secondary === 'repo' ? { projectGrouped: true } : {})
      })
    }
  )

  it('groups statuses independently beneath a Project', () => {
    const reviewWorktree: Worktree = {
      ...worktree,
      id: 'wt-review',
      path: '/tmp/orca-review',
      workspaceStatus: 'in-review'
    }
    const inProgressKey = 'repo:repo-1/workspace-status:in-progress'
    const reviewKey = 'repo:repo-1/workspace-status:in-review'
    const rows = buildNestedRows(
      'repo',
      'workspace-status',
      [worktree, reviewWorktree],
      repoMap,
      new Set([inProgressKey])
    )

    expect(rows.filter((row) => row.type === 'header')).toMatchObject([
      { key: 'repo:repo-1', groupKind: 'repo', projectGroupDepth: 0 },
      {
        key: inProgressKey,
        groupKind: 'workspace-status',
        projectGroupDepth: 1,
        workspaceStatus: 'in-progress'
      },
      {
        key: reviewKey,
        groupKind: 'workspace-status',
        projectGroupDepth: 1,
        workspaceStatus: 'in-review'
      }
    ])
    expect(rows.filter((row) => row.type === 'item').map((row) => row.worktree.id)).toEqual([
      'wt-review'
    ])
    expect(
      getGroupKeysForWorktree(
        'repo',
        reviewWorktree,
        repoMap,
        null,
        undefined,
        undefined,
        [],
        undefined,
        'workspace-status'
      )
    ).toEqual(['repo:repo-1', reviewKey])
  })

  it('preserves Project Group structure above Project then Status', () => {
    const projectGroup: ProjectGroup = {
      id: 'group-platform',
      name: 'Platform',
      parentPath: '/tmp',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupedRepo: Repo = { ...repo, projectGroupId: projectGroup.id }
    const groupedRepoMap = new Map([[groupedRepo.id, groupedRepo]])
    const rows = buildNestedRows(
      'repo',
      'workspace-status',
      [worktree],
      groupedRepoMap,
      new Set(),
      [projectGroup]
    )

    expect(rows.filter((row) => row.type === 'header')).toMatchObject([
      { key: 'project-group:group-platform', projectGroupDepth: 0 },
      { key: 'repo:repo-1', projectGroupDepth: 1 },
      { key: 'repo:repo-1/workspace-status:in-progress', projectGroupDepth: 2 }
    ])
    expect(
      getGroupKeysForWorktree(
        'repo',
        worktree,
        groupedRepoMap,
        null,
        undefined,
        undefined,
        [projectGroup],
        undefined,
        'workspace-status'
      )
    ).toEqual([
      'project-group:group-platform',
      'repo:repo-1',
      'repo:repo-1/workspace-status:in-progress'
    ])
  })

  it('keeps local and SSH worktrees under one Project with independent Status lanes', () => {
    const grouping = { projects: [project], projectHostSetups }
    const repos = new Map([
      [repo.id, repo],
      [remoteRepo.id, remoteRepo]
    ])

    expect(
      getGroupKeysForWorktree(
        'repo',
        { ...worktree, workspaceStatus: 'todo' },
        repos,
        null,
        undefined,
        undefined,
        [],
        grouping,
        'workspace-status'
      )
    ).toEqual([
      'project:github:stablyai/orca',
      'project:github:stablyai/orca/workspace-status:todo'
    ])
    expect(
      getGroupKeysForWorktree(
        'repo',
        { ...remoteWorktree, workspaceStatus: 'completed' },
        repos,
        null,
        undefined,
        undefined,
        [],
        grouping,
        'workspace-status'
      )
    ).toEqual([
      'project:github:stablyai/orca',
      'project:github:stablyai/orca/workspace-status:completed'
    ])
  })

  it('shows empty secondary Status lanes only below the dragged Project', () => {
    const secondRepo: Repo = {
      ...repo,
      id: 'repo-2',
      path: '/tmp/web',
      displayName: 'web'
    }
    const sourceWorktree: Worktree = {
      ...worktree,
      workspaceStatus: 'todo'
    }
    const otherWorktree: Worktree = {
      ...worktree,
      id: 'wt-2',
      repoId: secondRepo.id,
      path: '/tmp/web-feature',
      workspaceStatus: 'in-progress'
    }
    const statuses: WorkspaceStatusDefinition[] = [
      { id: 'todo', label: 'To do' },
      { id: 'qa / blocked', label: 'QA / blocked' },
      { id: 'in-progress', label: 'In progress' },
      { id: 'completed', label: 'Done' }
    ]
    const sourceGroupKey = 'repo:repo-1/workspace-status:todo'
    const rows = buildNestedRows(
      'repo',
      'workspace-status',
      [sourceWorktree, otherWorktree],
      new Map([
        [repo.id, repo],
        [secondRepo.id, secondRepo]
      ]),
      new Set(),
      [],
      [],
      sourceGroupKey,
      statuses
    )

    expect(
      rows
        .filter((row) => row.type === 'header')
        .filter((row) => row.key.startsWith('repo:repo-1/workspace-status:'))
        .map((row) => ({ key: row.key, count: row.count }))
    ).toEqual([
      { key: sourceGroupKey, count: 1 },
      { key: 'repo:repo-1/workspace-status:qa%20%2F%20blocked', count: 0 },
      { key: 'repo:repo-1/workspace-status:in-progress', count: 0 },
      { key: 'repo:repo-1/workspace-status:completed', count: 0 }
    ])
    expect(
      rows
        .filter((row) => row.type === 'header')
        .filter((row) => row.key.startsWith('repo:repo-2/workspace-status:'))
        .map((row) => row.key)
    ).toEqual(['repo:repo-2/workspace-status:in-progress'])
  })

  it('keeps empty secondary Status lanes hidden when no worktree drag is active', () => {
    const statuses: WorkspaceStatusDefinition[] = [
      { id: 'todo', label: 'To do' },
      { id: 'in-progress', label: 'In progress' },
      { id: 'completed', label: 'Done' }
    ]
    const rows = buildNestedRows(
      'repo',
      'workspace-status',
      [{ ...worktree, workspaceStatus: 'todo' }],
      repoMap,
      new Set(),
      [],
      [],
      null,
      statuses
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'repo:repo-1',
      'repo:repo-1/workspace-status:todo'
    ])
  })

  it('shows empty Status targets when Status is secondary to PR', () => {
    const statuses: WorkspaceStatusDefinition[] = [
      { id: 'todo', label: 'To do' },
      { id: 'in-progress', label: 'In progress' },
      { id: 'completed', label: 'Done' }
    ]
    const rows = buildNestedRows(
      'pr-status',
      'workspace-status',
      [{ ...worktree, workspaceStatus: 'todo' }],
      repoMap,
      new Set(),
      [],
      [],
      'pr:in-progress/workspace-status:todo',
      statuses
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'pr:in-progress',
      'pr:in-progress/workspace-status:todo',
      'pr:in-progress/workspace-status:in-progress',
      'pr:in-progress/workspace-status:completed'
    ])
  })

  it('groups folder workspaces by Status within their Project Group', () => {
    const projectGroup: ProjectGroup = {
      id: 'group-platform',
      name: 'Platform',
      parentPath: '/tmp',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-review',
      projectGroupId: projectGroup.id,
      name: 'Review folder',
      folderPath: '/tmp/review-folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      workspaceStatus: 'in-review',
      sortOrder: 1,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    const rows = buildNestedRows(
      'repo',
      'workspace-status',
      [],
      new Map(),
      new Set(),
      [projectGroup],
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'project-group:group-platform' },
      {
        type: 'header',
        key: 'project-group:group-platform/workspace-status:in-review',
        workspaceStatus: 'in-review',
        projectGroupDepth: 1
      },
      {
        type: 'folder-workspace',
        folderWorkspace: { id: 'folder-review' },
        groupDepth: 1,
        projectGrouped: true
      }
    ])
  })
})
