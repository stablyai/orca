import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../project/groups/project-group-types'
import type { Repo } from '../../repository/repo-types'
import {
  filterProjectGroupsWithVisibleContent,
  scopeVisibleFolderWorkspacesByDone,
  sidebarFeedVisibleFolderWorkspaces
} from './sidebar-feed-visible-folders'

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

  it('reports groups emptied by Hide Done only', () => {
    const folders = [
      folder({ id: 'todo', projectGroupId: 'kept', workspaceStatus: 'todo' }),
      folder({ id: 'done', projectGroupId: 'emptied', workspaceStatus: 'completed' })
    ]

    const scope = scopeVisibleFolderWorkspacesByDone(folders, true)
    expect(scope.folders.map((item) => item.id)).toEqual(['todo'])
    expect([...scope.emptiedGroupIds]).toEqual(['emptied'])

    const groups: ProjectGroup[] = [group('kept'), group('emptied'), group('already-empty')]
    const visibleRepos: Pick<Repo, 'projectGroupId'>[] = []
    const filtered = filterProjectGroupsWithVisibleContent({
      groups,
      visibleRepos,
      visibleFolders: scope.folders,
      emptiedGroupIds: scope.emptiedGroupIds
    })
    expect(filtered.map((item) => item.id)).toEqual(['kept', 'already-empty'])
  })

  it('keeps an emptied group when another visible repo belongs to it', () => {
    const scope = scopeVisibleFolderWorkspacesByDone(
      [folder({ id: 'done', projectGroupId: 'kept', workspaceStatus: 'completed' })],
      true
    )
    const filtered = filterProjectGroupsWithVisibleContent({
      groups: [group('kept')],
      visibleRepos: [repo('kept')],
      visibleFolders: scope.folders,
      emptiedGroupIds: scope.emptiedGroupIds
    })
    expect(filtered.map((item) => item.id)).toEqual(['kept'])
  })
})

function group(id: string): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

function repo(projectGroupId: string): Pick<Repo, 'projectGroupId'> {
  return { projectGroupId }
}
