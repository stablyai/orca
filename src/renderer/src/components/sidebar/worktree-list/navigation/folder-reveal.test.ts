import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'

import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getFolderWorkspaceRevealGroupKeys } from './folder-reveal'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/group-keys'

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-child',
    name: 'Refund workflow',
    folderPath: '/workspace/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup>): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 1,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('worktree list folder reveal', () => {
  it('follows the parents the sidebar draws when same-id group copies disagree (#30045)', () => {
    const localChild = makeProjectGroup({ id: 'group-child', executionHostId: 'local' })
    const remoteRoot = makeProjectGroup({ id: 'remote-root', executionHostId: 'runtime:other' })
    const remoteChild = makeProjectGroup({
      id: localChild.id,
      parentGroupId: remoteRoot.id,
      executionHostId: 'runtime:other'
    })
    const folderWorkspace = makeFolderWorkspace({ executionHostId: 'local' })

    expect(
      getFolderWorkspaceRevealGroupKeys(
        folderWorkspaceKey(folderWorkspace.id),
        [folderWorkspace],
        [localChild, remoteRoot, remoteChild],
        { executionHostId: 'local', defaultHostId: 'local' }
      )
    ).toEqual([
      getProjectGroupHeaderKey(remoteRoot.id),
      getProjectGroupHeaderKey(localChild.id),
      'host:local'
    ])
  })
})

describe('reveal keys under non-repo grouping', () => {
  const group = makeProjectGroup({ id: 'group-child', connectionId: 'target-1' })
  const folderWorkspace = makeFolderWorkspace({ workspaceStatus: 'in-progress' })
  const workspaceKey = folderWorkspaceKey(folderWorkspace.id)

  it('returns the status lane key so a collapsed lane can be expanded', () => {
    const keys = getFolderWorkspaceRevealGroupKeys(workspaceKey, [folderWorkspace], [group], {
      groupBy: 'workspace-status',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })
    expect(keys).toContain('workspace-status:in-progress')
  })

  it('returns the host key so a collapsed host can be expanded too', () => {
    const keys = getFolderWorkspaceRevealGroupKeys(workspaceKey, [folderWorkspace], [group], {
      groupBy: 'workspace-status',
      workspaceStatuses: [],
      defaultHostId: 'local'
    })
    expect(keys).toContain('host:ssh:target-1')
  })
})
