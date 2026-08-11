import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from './types'
import { normalizeFolderWorkspaces } from './folder-workspaces'

function folderGroup(): ProjectGroup {
  return {
    id: 'folder-group',
    name: 'Folder group',
    parentPath: '/workspace/folder-group',
    connectionId: 'ssh-owner',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('normalizeFolderWorkspaces', () => {
  it('preserves omitted ownership while keeping explicit null local', () => {
    const workspaces = normalizeFolderWorkspaces(
      [
        {
          id: 'legacy',
          projectGroupId: 'folder-group',
          name: 'Legacy',
          folderPath: '/workspace/folder-group'
        },
        {
          id: 'local',
          projectGroupId: 'folder-group',
          name: 'Local',
          folderPath: '/workspace/folder-group',
          connectionId: null
        }
      ],
      [folderGroup()]
    )

    expect(workspaces.find((workspace) => workspace.id === 'legacy')).not.toHaveProperty(
      'connectionId'
    )
    expect(workspaces.find((workspace) => workspace.id === 'local')).toHaveProperty(
      'connectionId',
      null
    )
  })
})
