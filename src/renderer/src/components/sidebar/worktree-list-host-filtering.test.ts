import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import {
  filterFolderWorkspacesForVisibleHosts,
  filterProjectGroupsForVisibleHosts,
  getFolderPathStatusRouteOptionsForRows,
  getFolderWorkspaceExecutionHostIdForRows,
  getProjectGroupExecutionHostIdForRows,
  getRuntimeEnvironmentIdForFolderPathStatusHost
} from './worktree-list-host-filtering'

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Runtime group',
    parentPath: '/srv/app',
    connectionId: null,
    executionHostId: null,
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

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Runtime folder',
    folderPath: '/srv/app/task',
    connectionId: null,
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

describe('WorktreeList host filtering ownership', () => {
  it('uses runtime execution host stamps before SSH/default fallbacks for project groups', () => {
    expect(
      getProjectGroupExecutionHostIdForRows(
        group({ connectionId: 'ssh-builder', executionHostId: 'runtime:env-1' }),
        'local'
      )
    ).toBe('runtime:env-1')
  })

  it('uses the project group runtime owner for folder workspaces in that group', () => {
    expect(
      getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace: folderWorkspace({ connectionId: 'ssh-builder' }),
        projectGroup: group({ connectionId: 'ssh-builder', executionHostId: 'runtime:env-1' }),
        defaultHostId: 'local'
      })
    ).toBe('runtime:env-1')
  })

  it('keeps explicit runtime group ownership when the focused runtime is the same host', () => {
    expect(
      getFolderWorkspaceExecutionHostIdForRows({
        folderWorkspace: folderWorkspace({ connectionId: 'ssh-builder' }),
        projectGroup: group({ connectionId: 'ssh-builder', executionHostId: 'runtime:env-1' }),
        defaultHostId: 'runtime:env-1'
      })
    ).toBe('runtime:env-1')
  })

  it('extracts runtime route ids for folder path status requests', () => {
    expect(getRuntimeEnvironmentIdForFolderPathStatusHost('runtime:env-1')).toBe('env-1')
    expect(getRuntimeEnvironmentIdForFolderPathStatusHost('ssh:ssh-builder')).toBeNull()
    expect(getRuntimeEnvironmentIdForFolderPathStatusHost('local')).toBeNull()
  })

  it('routes project-group path status through the owning runtime', () => {
    const runtimeGroup = group({ executionHostId: 'runtime:env-1' })
    expect(
      getFolderPathStatusRouteOptionsForRows({
        projectGroup: runtimeGroup
      })
    ).toEqual({ runtimeEnvironmentId: 'env-1' })
  })

  it('routes folder-workspace path status through its project group runtime owner', () => {
    const runtimeGroup = group({ executionHostId: 'runtime:env-1' })
    const workspace = folderWorkspace({ connectionId: 'ssh-builder' })
    expect(
      getFolderPathStatusRouteOptionsForRows({
        projectGroup: runtimeGroup,
        folderWorkspace: workspace
      })
    ).toEqual({ runtimeEnvironmentId: 'env-1' })
  })

  it('forces local path status routing for local project groups while a runtime is focused', () => {
    const localGroup = group()
    expect(
      getFolderPathStatusRouteOptionsForRows({
        projectGroup: localGroup
      })
    ).toEqual({ runtimeEnvironmentId: null })
  })

  it('forces local path status routing for SSH-owned project groups while a runtime is focused', () => {
    const sshGroup = group({ connectionId: 'ssh-builder' })
    expect(
      getFolderPathStatusRouteOptionsForRows({
        projectGroup: sshGroup
      })
    ).toEqual({ runtimeEnvironmentId: null })
  })

  it('routes same-ID rows from the concrete row instead of an ID-only lookup', () => {
    const localGroup = group({ id: 'shared', executionHostId: 'local' })
    const runtimeGroup = group({ id: 'shared', executionHostId: 'runtime:env-1' })

    expect(getFolderPathStatusRouteOptionsForRows({ projectGroup: localGroup })).toEqual({
      runtimeEnvironmentId: null
    })
    expect(getFolderPathStatusRouteOptionsForRows({ projectGroup: runtimeGroup })).toEqual({
      runtimeEnvironmentId: 'env-1'
    })
  })

  it('filters local, direct SSH, and paired runtime rows by transport owner', () => {
    const localGroup = group({ id: 'local', executionHostId: 'local' })
    const sshGroup = group({
      id: 'ssh',
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })
    const pairedGroup = group({
      id: 'paired',
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'ssh:builder'
    })
    const groups = [localGroup, sshGroup, pairedGroup]

    expect(filterProjectGroupsForVisibleHosts(groups, new Set(['local']), 'local')).toEqual([
      localGroup
    ])
    expect(filterProjectGroupsForVisibleHosts(groups, new Set(['ssh:builder']), 'local')).toEqual([
      sshGroup
    ])
    expect(filterProjectGroupsForVisibleHosts(groups, new Set(['runtime:env-1']), 'local')).toEqual(
      [pairedGroup]
    )
  })

  it('keeps same-ID paired folders matched to their concrete physical group', () => {
    const localGroup = group({
      id: 'shared',
      name: 'Local',
      connectionId: null,
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'local'
    })
    const sshGroup = group({
      id: 'shared',
      name: 'SSH',
      connectionId: 'builder',
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'ssh:builder'
    })
    const localFolder = folderWorkspace({
      id: 'shared-folder',
      projectGroupId: 'shared',
      name: 'Local folder',
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'local'
    })
    const sshFolder = folderWorkspace({
      id: 'shared-folder',
      projectGroupId: 'shared',
      name: 'SSH folder',
      connectionId: 'builder',
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'ssh:builder'
    })

    expect(
      filterFolderWorkspacesForVisibleHosts(
        [sshFolder, localFolder],
        [sshGroup, localGroup],
        new Set(['runtime:env-1']),
        'local'
      )
    ).toEqual([sshFolder, localFolder])
  })
})
