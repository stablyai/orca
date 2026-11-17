import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project/groups/project-group-types'

import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { useAppStore } from '@/store/index'

import * as metadata from '@/runtime/files/metadata/runtime-file-metadata-client'
import { openTabBarEntry } from './tab-create-entry-action'

const initialState = useAppStore.getInitialState()

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-local',
    projectGroupId: 'group-local',
    name: 'Local folder',
    folderPath: '/Users/me/folder',
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

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-local',
    name: 'Local group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('getTabEntryAllowAbsolutePaths', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useAppStore.setState(initialState, true)
  })

  it('opens existing HTML as source in a local folder workspace', async () => {
    const folder = makeFolderWorkspace()
    const worktreeId = folderWorkspaceKey(folder.id)
    useAppStore.setState({
      folderWorkspaces: [folder],
      projectGroups: [makeProjectGroup()],
      repos: []
    })
    vi.spyOn(metadata, 'statRuntimePath').mockResolvedValue({
      size: 1,
      isDirectory: false,
      mtime: 1
    })

    await openTabBarEntry({
      query: 'report.html',
      worktreeId,
      groupId: 'group-local',
      fileList: { files: ['report.html'], loading: false, loadError: null }
    })

    expect(useAppStore.getState().openFiles).toEqual([
      expect.objectContaining({
        filePath: '/Users/me/folder/report.html',
        relativePath: 'report.html',
        worktreeId,
        language: 'html',
        mode: 'edit'
      })
    ])
    expect(useAppStore.getState().browserTabsByWorktree[worktreeId] ?? []).toHaveLength(0)
  })
})
