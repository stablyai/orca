import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  filterFolderWorkspacesForVisibleHosts,
  getFolderPathStatusRouteOptionsForRows,
  getFolderWorkspaceExecutionHostIdForRows,
  getProjectGroupExecutionHostIdForRows,
  getRuntimeEnvironmentIdForFolderPathStatusHost
} from './host-filtering'

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
        request: { scope: 'project-group', projectGroupId: runtimeGroup.id },
        projectGroup: runtimeGroup
      })
    ).toEqual({ runtimeEnvironmentId: 'env-1' })
  })

  it('routes folder-workspace path status through its project group runtime owner', () => {
    const runtimeGroup = group({ executionHostId: 'runtime:env-1' })
    const workspace = folderWorkspace({ connectionId: 'ssh-builder' })
    expect(
      getFolderPathStatusRouteOptionsForRows({
        request: { scope: 'folder-workspace', folderWorkspaceId: workspace.id },
        projectGroup: runtimeGroup,
        folderWorkspace: workspace
      })
    ).toEqual({ runtimeEnvironmentId: 'env-1' })
  })

  it('forces local path status routing for local project groups while a runtime is focused', () => {
    const localGroup = group()
    expect(
      getFolderPathStatusRouteOptionsForRows({
        request: { scope: 'project-group', projectGroupId: localGroup.id },
        projectGroup: localGroup
      })
    ).toEqual({ runtimeEnvironmentId: null })
  })

  it('forces local path status routing for SSH-owned project groups while a runtime is focused', () => {
    const sshGroup = group({ connectionId: 'ssh-builder' })
    expect(
      getFolderPathStatusRouteOptionsForRows({
        request: { scope: 'project-group', projectGroupId: sshGroup.id },
        projectGroup: sshGroup
      })
    ).toEqual({ runtimeEnvironmentId: null })
  })

  it('routes identical folder ids from each concrete host row', () => {
    const request = { scope: 'folder-workspace' as const, folderWorkspaceId: 'folder-1' }
    const localGroup = group({ executionHostId: 'local' })
    const runtimeGroup = group({ executionHostId: 'runtime:env-1' })

    expect(
      getFolderPathStatusRouteOptionsForRows({
        request,
        projectGroup: localGroup,
        folderWorkspace: folderWorkspace({ executionHostId: 'local' })
      })
    ).toEqual({ runtimeEnvironmentId: null })
    expect(
      getFolderPathStatusRouteOptionsForRows({
        request,
        projectGroup: runtimeGroup,
        folderWorkspace: folderWorkspace({ executionHostId: 'runtime:env-1' })
      })
    ).toEqual({ runtimeEnvironmentId: 'env-1' })
  })

  it('filters mixed same-id groups independently of catalog order', () => {
    const workspace = folderWorkspace()
    const legacyGroup = group()
    const runtimeGroup = group({ executionHostId: 'runtime:env-1' })

    for (const groups of [
      [legacyGroup, runtimeGroup],
      [runtimeGroup, legacyGroup]
    ]) {
      expect(
        filterFolderWorkspacesForVisibleHosts([workspace], groups, new Set(['local']), 'local')
      ).toEqual([workspace])
      expect(
        filterFolderWorkspacesForVisibleHosts(
          [workspace],
          groups,
          new Set(['runtime:env-1']),
          'local'
        )
      ).toEqual([])
    }
  })
})
