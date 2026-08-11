import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore } from './store-test-helpers'

vi.mock('@/components/terminal-pane/terminal-parked-watcher-registry', () => ({
  capturedPanesByTabId: new Map(),
  disposeParkedTerminalWatchersForPtyIds: vi.fn(),
  disposeRemovedWorktreeParkedTerminalWatchers: vi.fn(),
  retireParkedTerminalTab: vi.fn()
}))

const folderWorkspacesDelete = vi.fn()
const folderWorkspacesList = vi.fn()

const rootGroup: ProjectGroup = {
  id: 'root-group',
  name: 'Root',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  executionHostId: 'local'
}

function makeFolderWorkspace(
  id: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id,
    projectGroupId: rootGroup.id,
    name: id,
    folderPath: `/workspace/${id}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  folderWorkspacesDelete.mockResolvedValue(true)
  folderWorkspacesList.mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        delete: folderWorkspacesDelete,
        list: folderWorkspacesList
      }
    }
  })
})

describe('folder workspace editor content removal', () => {
  it('removes a restored local editor and its legacy preview from a same-key sibling', async () => {
    const runtimeHostId = toRuntimeExecutionHostId('env-restored-sibling')
    const localOwner = makeFolderWorkspace('restored-content-shared')
    const sibling = makeFolderWorkspace(localOwner.id, { executionHostId: runtimeHostId })
    const workspaceKey = folderWorkspaceKey(localOwner.id)
    const sourceId = '/workspace/restored-content-shared/local.md'
    const previewId = `markdown-preview::${sourceId}`
    const siblingFile = {
      id: 'runtime-sibling-file',
      filePath: '/runtime/sibling.ts',
      relativePath: 'sibling.ts',
      worktreeId: workspaceKey,
      language: 'typescript',
      isDirty: false,
      mode: 'edit',
      runtimeEnvironmentId: 'env-restored-sibling',
      workspaceExecutionHostId: runtimeHostId
    }
    const store = createTestStore()
    store.setState({ projectGroups: [rootGroup], folderWorkspaces: [localOwner, sibling] })
    store.getState().hydrateEditorSession({
      openFilesByWorktree: {
        [workspaceKey]: [
          {
            filePath: sourceId,
            relativePath: 'local.md',
            worktreeId: workspaceKey,
            language: 'markdown',
            workspaceExecutionHostId: 'local'
          }
        ]
      }
    } as never)
    const restoredSource = store.getState().openFiles.find((file) => file.filePath === sourceId)
    expect(restoredSource?.workspaceExecutionHostId).toBe('local')
    const preview = {
      id: previewId,
      filePath: sourceId,
      relativePath: 'local.md',
      worktreeId: workspaceKey,
      language: 'markdown',
      isDirty: false,
      mode: 'markdown-preview',
      markdownPreviewSourceFileId: restoredSource?.id
    }
    const groupId = 'restored-content-group'
    const unifiedTabs = [restoredSource!.id, previewId, siblingFile.id].map((id) => ({
      id,
      entityId: id,
      groupId,
      worktreeId: workspaceKey,
      contentType: 'editor'
    }))
    store.setState((state) => ({
      openFiles: [...state.openFiles, preview, siblingFile] as never,
      unifiedTabsByWorktree: { [workspaceKey]: unifiedTabs as never },
      groupsByWorktree: {
        [workspaceKey]: [
          {
            id: groupId,
            worktreeId: workspaceKey,
            activeTabId: siblingFile.id,
            tabOrder: unifiedTabs.map((tab) => tab.id),
            recentTabIds: unifiedTabs.map((tab) => tab.id)
          }
        ]
      },
      layoutByWorktree: { [workspaceKey]: { type: 'leaf', groupId } },
      activeGroupIdByWorktree: { [workspaceKey]: groupId }
    }))

    await expect(
      store.getState().deleteFolderWorkspace(localOwner.id, { hostId: 'local' })
    ).resolves.toBe(true)

    expect(store.getState().folderWorkspaces).toEqual([sibling])
    expect(store.getState().openFiles).toEqual([siblingFile])
    expect(store.getState().unifiedTabsByWorktree[workspaceKey]).toEqual([unifiedTabs[2]])
  })
})
