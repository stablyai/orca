import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import { buildRows } from './worktree-list-groups'
import {
  buildSidebarProjectGroupOwnerIndex,
  getFolderWorkspaceRowKey,
  getReorderableSidebarProjectGroupsById
} from './worktree-list-project-group-owner'

const RUNTIME_HOST = 'runtime:env-1' as const

function group(name: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'shared-group',
    name,
    parentPath: `/${name}`,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function folder(name: string, overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: 'shared-group',
    name,
    folderPath: `/${name}/task`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function repo(name: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `${name}-repo`,
    path: `/${name}/repo`,
    displayName: name,
    badgeColor: '#000000',
    addedAt: 1,
    projectGroupId: 'shared-group',
    ...overrides
  }
}

function buildProjectRows(
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[],
  folderWorkspaces: readonly FolderWorkspace[]
) {
  return buildRows(
    'repo',
    [],
    new Map(repos.map((entry) => [entry.id, entry])),
    null,
    new Set(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    projectGroups,
    new Set(repos.map((entry) => entry.id)),
    undefined,
    undefined,
    undefined,
    undefined,
    folderWorkspaces
  )
}

describe('sidebar project-group owner identity', () => {
  it.each([
    ['forward', false],
    ['reverse', true]
  ])('pairs same-runtime local and SSH rows in %s catalog order', (_label, reverse) => {
    const localGroup = group('local', {
      connectionId: null,
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'local'
    })
    const sshGroup = group('ssh', {
      connectionId: 'builder',
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'ssh:builder',
      tabOrder: 1
    })
    const localFolder = folder('local-folder', {
      connectionId: null,
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'local'
    })
    const sshFolder = folder('ssh-folder', {
      connectionId: 'builder',
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'ssh:builder'
    })
    const localRepo = repo('local-repo', {
      connectionId: null,
      executionHostId: RUNTIME_HOST
    })
    const sshRepo = repo('ssh-repo', {
      connectionId: 'builder',
      executionHostId: RUNTIME_HOST
    })
    const projectGroups = reverse ? [sshGroup, localGroup] : [localGroup, sshGroup]
    const folderWorkspaces = reverse ? [sshFolder, localFolder] : [localFolder, sshFolder]
    const rows = buildProjectRows(projectGroups, [localRepo, sshRepo], folderWorkspaces)

    expect(
      rows.flatMap((row) => {
        if (row.type === 'header' && row.projectGroup) {
          return [[row.type, row.label, row.key]]
        }
        if (row.type === 'header' && row.repo) {
          return [[row.type, row.repo.displayName]]
        }
        if (row.type === 'folder-workspace') {
          return [[row.type, row.folderWorkspace.name, row.projectGroup.name, row.key]]
        }
        return []
      })
    ).toEqual([
      ['header', 'local', expect.stringContaining('project-group:shared-group:owner:')],
      [
        'folder-workspace',
        'local-folder',
        'local',
        expect.stringContaining('folder-workspace:shared-folder:owner:')
      ],
      ['header', 'local-repo'],
      ['header', 'ssh', expect.stringContaining('project-group:shared-group:owner:')],
      [
        'folder-workspace',
        'ssh-folder',
        'ssh',
        expect.stringContaining('folder-workspace:shared-folder:owner:')
      ],
      ['header', 'ssh-repo']
    ])
  })

  it('keeps owner-qualified keys stable across catalog order', () => {
    const local = group('local', {
      connectionId: null,
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'local'
    })
    const ssh = group('ssh', {
      connectionId: 'builder',
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'ssh:builder'
    })
    const forward = buildSidebarProjectGroupOwnerIndex([local, ssh])
    const reverse = buildSidebarProjectGroupOwnerIndex([ssh, local])

    expect(forward.getHeaderKey(local)).toBe(reverse.getHeaderKey(local))
    expect(forward.getHeaderKey(ssh)).toBe(reverse.getHeaderKey(ssh))
    expect(forward.getHeaderKey(local)).not.toBe(forward.getHeaderKey(ssh))
  })

  it('preserves legacy keys and drag behavior only for unambiguous IDs', () => {
    const unique = group('unique', { id: 'unique-group' })
    const local = group('local', {
      connectionId: null,
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'local'
    })
    const ssh = group('ssh', {
      connectionId: 'builder',
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'ssh:builder'
    })
    const child = group('child', {
      id: 'unique-child',
      parentGroupId: local.id,
      connectionId: null,
      executionHostId: RUNTIME_HOST,
      runtimeSourceExecutionHostId: 'local'
    })
    const ownerIndex = buildSidebarProjectGroupOwnerIndex([unique, local, ssh, child])
    const reorderable = getReorderableSidebarProjectGroupsById(ownerIndex)

    expect(ownerIndex.getHeaderKey(unique)).toBe('project-group:unique-group')
    expect(reorderable.get(unique.id)).toBe(unique)
    expect(reorderable.has(local.id)).toBe(false)
    expect(reorderable.has(child.id)).toBe(false)
    expect(
      getFolderWorkspaceRowKey(
        folder('unique-folder', {
          id: 'unique-folder',
          projectGroupId: unique.id
        }),
        unique,
        new Set(),
        ownerIndex
      )
    ).toBe('folder-workspace:unique-folder')
  })

  it('fails closed for contradictory and exact duplicate owner metadata', () => {
    const invalid = group('invalid', {
      executionHostId: 'local',
      connectionId: 'builder'
    })
    const first = group('first', { id: 'duplicate-owner' })
    const second = group('second', { id: 'duplicate-owner' })
    const ownerIndex = buildSidebarProjectGroupOwnerIndex([invalid, first, second])

    expect(ownerIndex.groups).toEqual([])
    expect(ownerIndex.findRepoProjectGroup(repo('unsafe'))).toBeNull()
  })
})
