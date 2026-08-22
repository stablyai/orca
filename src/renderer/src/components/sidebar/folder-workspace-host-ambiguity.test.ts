import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  findFolderWorkspaceProjectGroup,
  getFolderWorkspaceHostIdFromGroups
} from './folder-workspace-host-id'

const OWNER_HOST_ID = 'runtime:owner' as const
const FOCUSED_HOST_ID = 'runtime:focused' as const

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-same-id',
    projectGroupId: 'group-same-id',
    name: 'Folder workspace',
    folderPath: '/workspace/folder',
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

function projectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-same-id',
    name: 'Folder group',
    parentPath: '/workspace',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('ambiguous folder workspace host resolution', () => {
  it('does not invent a group owner when same-id groups disagree across hosts', () => {
    const workspace = folderWorkspace({ connectionId: 'legacy-target' })
    const groups = [
      projectGroup({ executionHostId: 'local' }),
      projectGroup({ executionHostId: OWNER_HOST_ID })
    ]

    expect(getFolderWorkspaceHostIdFromGroups(workspace, groups, FOCUSED_HOST_ID)).toBe(
      'ssh:legacy-target'
    )
  })

  it('does not treat one owned and one legacy same-id group as unanimous', () => {
    const workspace = folderWorkspace()
    const groups = [
      projectGroup({ executionHostId: OWNER_HOST_ID }),
      projectGroup({ executionHostId: undefined })
    ]

    expect(getFolderWorkspaceHostIdFromGroups(workspace, groups, 'local')).toBe('local')
    expect(findFolderWorkspaceProjectGroup(workspace, groups, 'local')).toBe(groups[1])
  })
})
