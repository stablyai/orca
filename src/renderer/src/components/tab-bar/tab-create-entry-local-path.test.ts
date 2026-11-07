import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import * as metadata from '@/runtime/files/metadata/runtime-file-metadata-client'
import { openTabBarEntry } from './tab-create-entry-action'

const initialState = useAppStore.getInitialState()
const localWorktreeId = 'repo-local::/Users/me/repo'

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: '/Users/me/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

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

  it.each(['report.html', 'notes.txt'])(
    'refuses opening %s if its workspace changes hosts during the file check',
    async (name) => {
      const worktree = makeWorktree({
        id: localWorktreeId,
        repoId: 'repo-local',
        path: '/Users/me/repo',
        hostId: 'local'
      })
      useAppStore.setState({
        repos: [makeRepo({ id: 'repo-local', executionHostId: 'local' })],
        worktreesByRepo: { 'repo-local': [worktree] },
        runtimeEnvironmentCatalogHydrated: true
      })
      vi.spyOn(metadata, 'statRuntimePath').mockImplementationOnce(async () => {
        useAppStore.setState({
          repos: [makeRepo({ id: 'repo-local', executionHostId: 'runtime:hub-a' })],
          worktreesByRepo: {
            'repo-local': [
              { ...worktree, hostId: 'runtime:hub-a', runtimeOwnerEnvironmentId: 'hub-a' }
            ]
          }
        })
        return { size: 1, isDirectory: false, mtime: 1 }
      })
      await expect(
        openTabBarEntry({
          query: name,
          worktreeId: localWorktreeId,
          groupId: 'group-local',
          fileList: { files: [name], loading: false, loadError: null }
        })
      ).rejects.toThrow("Couldn't verify which host owns this file")
      expect(useAppStore.getState().browserTabsByWorktree[localWorktreeId] ?? []).toHaveLength(0)
      expect(useAppStore.getState().openFiles).toHaveLength(0)
    }
  )

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
