import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getGroupKeysForWorktree } from './worktree-list/grouping/worktree-group-keys'
import { repo, worktree, repoMap } from './worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

describe('project groups', () => {
  it('renders nested Project Groups before repos assigned to their leaf group', () => {
    const rootGroup: ProjectGroup = {
      id: 'group-root',
      name: 'Services',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const childGroup: ProjectGroup = {
      ...rootGroup,
      id: 'group-payments',
      name: 'payments',
      parentPath: '/monorepo/services/payments',
      parentGroupId: rootGroup.id,
      tabOrder: 1
    }
    const groupedRepo: Repo = {
      ...repo,
      id: 'repo-payments-api',
      displayName: 'api',
      projectGroupId: childGroup.id,
      projectGroupOrder: 0
    }
    const groupedWorktree: Worktree = {
      ...worktree,
      id: 'wt-payments-api',
      repoId: groupedRepo.id
    }

    const rows = buildRows(
      'repo',
      [groupedWorktree],
      new Map([[groupedRepo.id, groupedRepo]]),
      null,
      new Set(),
      new Map([[groupedRepo.id, 0]]),
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [rootGroup, childGroup]
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-root',
      'project-group:group-payments',
      'repo:repo-payments-api'
    ])
    expect(rows.filter((row) => row.type === 'header').map((row) => row.projectGroupDepth)).toEqual(
      [0, 1, 2]
    )
    expect(rows.find((row) => row.type === 'item')).toMatchObject({
      type: 'item',
      groupDepth: 2
    })
  })

  it('renders folder workspaces under their owning folder-backed Project Group', () => {
    const group: ProjectGroup = {
      id: 'group-root',
      name: 'Platform',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: group.id,
      name: 'Refund fix',
      folderPath: '/monorepo',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [group],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project-group:group-root',
        count: 1
      },
      {
        type: 'folder-workspace',
        folderWorkspace: { id: 'folder-workspace-1' },
        projectGroup: { id: 'group-root' },
        groupDepth: 1
      }
    ])
  })

  it('preserves nested Project Group depth for folder workspace rows', () => {
    const rootGroup: ProjectGroup = {
      id: 'group-root',
      name: 'Platform',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const childGroup: ProjectGroup = {
      id: 'group-shared',
      name: 'packages/shared',
      parentPath: '/monorepo/packages/shared',
      parentGroupId: rootGroup.id,
      createdFrom: 'folder-scan',
      tabOrder: 1,
      isCollapsed: false,
      color: null,
      createdAt: 2,
      updatedAt: 2
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-nested',
      projectGroupId: childGroup.id,
      name: 'Shared package work',
      folderPath: '/monorepo/packages/shared',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 3,
      updatedAt: 3
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [rootGroup, childGroup],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project-group:group-root',
        projectGroupDepth: 0
      },
      {
        type: 'header',
        key: 'project-group:group-shared',
        projectGroupDepth: 1
      },
      {
        type: 'folder-workspace',
        folderWorkspace: { id: 'folder-workspace-nested' },
        groupDepth: 2
      }
    ])
  })

  it('does not render folder workspaces under non-folder Project Groups', () => {
    const group: ProjectGroup = {
      id: 'group-manual',
      name: 'Manual',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: group.id,
      name: 'Hidden',
      folderPath: '/monorepo',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 10,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      [group],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [folderWorkspace]
    )

    expect(rows).toMatchObject([
      {
        type: 'header',
        key: 'project-group:group-manual',
        count: 0
      }
    ])
    expect(rows.some((row) => row.type === 'folder-workspace')).toBe(false)
  })

  it('renders imported repos under nested Project Groups before worktree rows load', () => {
    const rootGroup: ProjectGroup = {
      id: 'group-root',
      name: 'Root',
      parentPath: '/monorepo',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const platformGroup: ProjectGroup = {
      ...rootGroup,
      id: 'group-platform',
      name: 'Platform',
      parentGroupId: rootGroup.id,
      tabOrder: 1
    }
    const servicesGroup: ProjectGroup = {
      ...rootGroup,
      id: 'group-services',
      name: 'Services',
      parentGroupId: platformGroup.id,
      tabOrder: 2
    }
    const serviceA: Repo = {
      ...repo,
      id: 'repo-service-a',
      displayName: 'service-a',
      projectGroupId: servicesGroup.id,
      projectGroupOrder: 0
    }
    const serviceB: Repo = {
      ...repo,
      id: 'repo-service-b',
      displayName: 'service-b',
      projectGroupId: servicesGroup.id,
      projectGroupOrder: 1
    }

    const rows = buildRows(
      'repo',
      [],
      new Map([
        [serviceA.id, serviceA],
        [serviceB.id, serviceB]
      ]),
      null,
      new Set(),
      new Map([
        [serviceA.id, 0],
        [serviceB.id, 1]
      ]),
      undefined,
      'manual',
      undefined,
      undefined,
      false,
      undefined,
      [rootGroup, platformGroup, servicesGroup],
      new Set([serviceA.id, serviceB.id])
    )

    expect(rows.filter((row) => row.type === 'header').map((row) => row.key)).toEqual([
      'project-group:group-root',
      'project-group:group-platform',
      'project-group:group-services',
      'repo:repo-service-a',
      'repo:repo-service-b'
    ])
    expect(rows.filter((row) => row.type === 'header').map((row) => row.projectGroupDepth)).toEqual(
      [0, 1, 2, 3, 3]
    )
  })

  it('returns both parent Project Group and repo keys for grouped repo reveals', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }
    const group: ProjectGroup = {
      id: 'group-1',
      name: 'Platform',
      parentPath: '/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    expect(
      getGroupKeysForWorktree(
        'repo',
        worktree,
        new Map([[groupedRepo.id, groupedRepo]]),
        null,
        undefined,
        undefined,
        [group]
      )
    ).toEqual(['project-group:group-1', 'repo:repo-1'])
  })

  it('returns only the repo key for missing Project Group metadata reveals', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'missing-group' }
    const loadedGroup: ProjectGroup = {
      id: 'loaded-group',
      name: 'Loaded',
      parentPath: '/loaded',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }

    expect(
      getGroupKeysForWorktree(
        'repo',
        worktree,
        new Map([[groupedRepo.id, groupedRepo]]),
        null,
        undefined,
        undefined,
        [loadedGroup]
      )
    ).toEqual(['repo:repo-1'])
  })

  it('returns only the repo key for ungrouped repo reveals', () => {
    expect(getGroupKeysForWorktree('repo', worktree, repoMap, null)).toEqual(['repo:repo-1'])
  })
})
