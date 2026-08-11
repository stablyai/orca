import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../shared/types'
import {
  findFolderWorkspacePathStatusProjectGroup,
  getFolderWorkspacePathStatusRequest,
  getProjectGroupPathStatusRequest,
  resolveRepoPathStatusSourceHostId
} from './folder-workspace-path-status-request'

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
    parentPath: '/workspace',
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

function folder(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/workspace/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('folder workspace path-status requests', () => {
  it('qualifies same-ID direct project groups by physical owner', () => {
    expect(getProjectGroupPathStatusRequest(group({ id: 'shared', connectionId: null }))).toEqual({
      scope: 'project-group',
      projectGroupId: 'shared',
      executionHostId: 'local'
    })
    expect(
      getProjectGroupPathStatusRequest(group({ id: 'shared', connectionId: 'builder' }))
    ).toEqual({
      scope: 'project-group',
      projectGroupId: 'shared',
      executionHostId: 'ssh:builder'
    })
  })

  it('sends a projected runtime row source instead of its outer transport', () => {
    expect(
      getProjectGroupPathStatusRequest(
        group({
          executionHostId: 'runtime:hub',
          runtimeSourceExecutionHostId: 'ssh:builder',
          connectionId: 'builder'
        })
      )
    ).toEqual({
      scope: 'project-group',
      projectGroupId: 'group-1',
      executionHostId: 'ssh:builder'
    })
  })

  it('keeps an explicit-local folder authoritative over its SSH group', () => {
    expect(
      getFolderWorkspacePathStatusRequest(
        folder({ connectionId: null }),
        group({ connectionId: 'builder' })
      )
    ).toEqual({
      scope: 'folder-workspace',
      folderWorkspaceId: 'folder-1',
      executionHostId: 'local'
    })
  })

  it('selects same-transport groups using runtime source provenance', () => {
    const localGroup = group({
      id: 'shared',
      executionHostId: 'runtime:hub',
      runtimeSourceExecutionHostId: 'local'
    })
    const sshGroup = group({
      id: 'shared',
      executionHostId: 'runtime:hub',
      runtimeSourceExecutionHostId: 'ssh:builder'
    })
    const sshFolder = folder({
      projectGroupId: 'shared',
      executionHostId: 'runtime:hub',
      runtimeSourceExecutionHostId: 'ssh:builder'
    })

    expect(findFolderWorkspacePathStatusProjectGroup(sshFolder, [localGroup, sshGroup])).toBe(
      sshGroup
    )
    expect(getFolderWorkspacePathStatusRequest(sshFolder, sshGroup)).toEqual({
      scope: 'folder-workspace',
      folderWorkspaceId: 'folder-1',
      executionHostId: 'ssh:builder'
    })
  })

  it('omits a selector when projected source evidence conflicts', () => {
    expect(
      getProjectGroupPathStatusRequest(
        group({
          executionHostId: 'runtime:hub',
          runtimeSourceExecutionHostId: 'local',
          connectionId: 'builder'
        })
      )
    ).toEqual({ scope: 'project-group', projectGroupId: 'group-1' })
  })

  it('resolves paired repo physical owners and rejects contradictions', () => {
    const repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000000',
      addedAt: 1,
      executionHostId: 'runtime:hub'
    } satisfies Repo

    expect(resolveRepoPathStatusSourceHostId({ ...repo, connectionId: null })).toBe('local')
    expect(resolveRepoPathStatusSourceHostId({ ...repo, connectionId: 'builder' })).toBe(
      'ssh:builder'
    )
    expect(
      resolveRepoPathStatusSourceHostId({
        ...repo,
        executionHostId: 'local',
        connectionId: 'builder'
      })
    ).toBeNull()
  })
})
