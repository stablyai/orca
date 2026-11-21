import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import { sidebarFeedVisibleFolderWorkspaces } from './sidebar-feed-visible-folders'

function folder(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/tmp/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function visibleFolders(folders: FolderWorkspace[], hideDoneWorkspaces: boolean): string[] {
  return sidebarFeedVisibleFolderWorkspaces({
    folderWorkspaces: folders,
    projectGroups: [],
    visibleHostIdSet: null,
    defaultHostId: 'local',
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    hideDoneWorkspaces
  }).map((workspace) => workspace.id)
}

describe('sidebarFeedVisibleFolderWorkspaces', () => {
  it('keeps folder workspaces visible until Hide Done is on', () => {
    const folders = [
      folder({ id: 'todo', workspaceStatus: 'todo' }),
      folder({ id: 'done', workspaceStatus: 'completed' })
    ]

    expect(visibleFolders(folders, false)).toEqual(['todo', 'done'])
    expect(visibleFolders(folders, true)).toEqual(['todo'])
  })
})
