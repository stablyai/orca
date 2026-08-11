import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore } from './store-test-helpers'

const folderWorkspacesCreate = vi.fn()
const folderWorkspacesUpdate = vi.fn()
const folderWorkspacesDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()

function makeFolderWorkspace(linkedTask: FolderWorkspace['linkedTask'] = null): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Refund fix',
    folderPath: '/workspace/platform',
    linkedTask,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      pty: { kill: vi.fn() },
      folderWorkspaces: {
        create: folderWorkspacesCreate,
        update: folderWorkspacesUpdate,
        delete: folderWorkspacesDelete
      },
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

describe('local folder workspace mutations', () => {
  it('creates, updates, and deletes a folder workspace', async () => {
    const linkedTask: FolderWorkspace['linkedTask'] = {
      provider: 'linear',
      type: 'issue',
      number: 0,
      title: 'Refund fix',
      url: 'https://linear.app/acme/issue/ENG-123',
      linearIdentifier: 'ENG-123'
    }
    const folderWorkspace = makeFolderWorkspace(linkedTask)
    folderWorkspacesCreate.mockResolvedValue(folderWorkspace)
    folderWorkspacesUpdate.mockResolvedValue({ ...folderWorkspace, comment: 'Ready' })
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()

    await expect(
      store.getState().createFolderWorkspace({
        projectGroupId: folderWorkspace.projectGroupId,
        name: folderWorkspace.name,
        linkedTask
      })
    ).resolves.toEqual({ ...folderWorkspace, executionHostId: 'local' })
    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Ready' })
    ).resolves.toBe(true)
    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(folderWorkspacesCreate).toHaveBeenCalledWith({
      projectGroupId: folderWorkspace.projectGroupId,
      name: folderWorkspace.name,
      linkedTask
    })
    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { comment: 'Ready' },
      executionHostId: 'local'
    })
    expect(folderWorkspacesDelete).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      executionHostId: 'local'
    })
    expect(store.getState().folderWorkspaces).toEqual([])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('purges renderer session state after deletion', async () => {
    const folderWorkspace = makeFolderWorkspace()
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      folderWorkspaces: [folderWorkspace],
      activeWorktreeId: workspaceKey,
      activeWorkspaceKey: workspaceKey,
      activeTabId: 'terminal-tab-1',
      activeBrowserTabId: 'browser-tab-1',
      activeTabType: 'browser',
      tabsByWorktree: {
        [workspaceKey]: [
          {
            id: 'terminal-tab-1',
            worktreeId: workspaceKey,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'pty-1'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'terminal-tab-1': {
          root: { type: 'leaf', leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      },
      browserTabsByWorktree: {
        [workspaceKey]: [
          {
            id: 'browser-tab-1',
            worktreeId: workspaceKey,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'browser-tab-1': [
          {
            id: 'page-1',
            workspaceId: 'browser-tab-1',
            worktreeId: workspaceKey,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      openFiles: [
        {
          id: 'file-1',
          worktreeId: workspaceKey,
          filePath: '/workspace/platform/notes.md',
          relativePath: 'notes.md',
          language: 'markdown',
          isDirty: true,
          isPreview: false,
          mode: 'edit'
        }
      ],
      editorDrafts: { 'file-1': 'draft' },
      activeFileIdByWorktree: { [workspaceKey]: 'file-1' },
      activeTabTypeByWorktree: { [workspaceKey]: 'browser' },
      activeBrowserTabIdByWorktree: { [workspaceKey]: 'browser-tab-1' },
      lastVisitedAtByWorktreeId: { [workspaceKey]: 10 }
    })

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    const state = store.getState()
    expect(state.folderWorkspaces).toEqual([])
    expect(state.activeWorktreeId).toBeNull()
    expect(state.activeWorkspaceKey).toBeNull()
    expect(state.tabsByWorktree[workspaceKey]).toBeUndefined()
    expect(state.terminalLayoutsByTabId['terminal-tab-1']).toBeUndefined()
    expect(state.browserTabsByWorktree[workspaceKey]).toBeUndefined()
    expect(state.browserPagesByWorkspace['browser-tab-1']).toBeUndefined()
    expect(state.openFiles).toEqual([])
    expect(state.editorDrafts).toEqual({})
    expect(state.activeFileIdByWorktree[workspaceKey]).toBeUndefined()
    expect(state.activeBrowserTabIdByWorktree[workspaceKey]).toBeUndefined()
    expect(state.lastVisitedAtByWorktreeId[workspaceKey]).toBeUndefined()
  })

  it('propagates specific folder workspace create failures', async () => {
    folderWorkspacesCreate.mockRejectedValue(new Error('folder_workspace_path_missing:/srv/app'))
    const store = createTestStore()

    await expect(
      store.getState().createFolderWorkspace({
        projectGroupId: 'group-1',
        name: 'Broken folder'
      })
    ).rejects.toThrow(
      'Folder not found. Orca cannot find /srv/app. Remove and re-import the folder.'
    )
  })
})
