import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'

import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()

const reposRemove = vi.fn()

const ptyKill = vi.fn()

const projectGroupsList = vi.fn()

const projectGroupsCreate = vi.fn()

const projectGroupsDelete = vi.fn()

const projectGroupsMoveProject = vi.fn()

const projectGroupsImportNested = vi.fn()

const projectGroupsScanNested = vi.fn()

const projectGroupsCancelNestedScan = vi.fn()

const projectGroupsOnNestedScanProgress = vi.fn()

const folderWorkspacesList = vi.fn()

const folderWorkspacesGetPathStatus = vi.fn()

const folderWorkspacesCreate = vi.fn()

const folderWorkspacesUpdate = vi.fn()

const folderWorkspacesDelete = vi.fn()

const runtimeEnvironmentCall = vi.fn()

const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  reposRemove.mockReset()
  reposRemove.mockResolvedValue(undefined)
  ptyKill.mockReset()
  projectGroupsList.mockReset()
  projectGroupsCreate.mockReset()
  projectGroupsDelete.mockReset()
  projectGroupsMoveProject.mockReset()
  projectGroupsImportNested.mockReset()
  projectGroupsScanNested.mockReset()
  projectGroupsCancelNestedScan.mockReset()
  projectGroupsOnNestedScanProgress.mockReset()
  projectGroupsOnNestedScanProgress.mockReturnValue(vi.fn())
  folderWorkspacesList.mockReset()
  folderWorkspacesGetPathStatus.mockReset()
  folderWorkspacesGetPathStatus.mockResolvedValue({ path: '/workspace/platform', exists: true })
  folderWorkspacesCreate.mockReset()
  folderWorkspacesUpdate.mockReset()
  folderWorkspacesDelete.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList,
        remove: reposRemove
      },
      pty: { kill: ptyKill },
      browser: { unregisterGuest: vi.fn(async () => {}) },
      projectGroups: {
        list: projectGroupsList,
        create: projectGroupsCreate,
        delete: projectGroupsDelete,
        moveProject: projectGroupsMoveProject,
        scanNested: projectGroupsScanNested,
        cancelNestedScan: projectGroupsCancelNestedScan,
        onNestedScanProgress: projectGroupsOnNestedScanProgress,
        importNested: projectGroupsImportNested
      },
      folderWorkspaces: {
        list: folderWorkspacesList,
        getPathStatus: folderWorkspacesGetPathStatus,
        create: folderWorkspacesCreate,
        update: folderWorkspacesUpdate,
        delete: folderWorkspacesDelete
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group store routing', () => {
  it('blocks Jira folder creation on runtimes without durable linked context support', async () => {
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-old')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== 'worktree.linked-work-item-context.v1'
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    const store = createTestStore()

    await expect(
      store.getState().createFolderWorkspace(
        {
          projectGroupId: projectGroup.id,
          name: 'Jira folder',
          linkedTask: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'ORCA-123 Link Jira',
            url: 'https://company.atlassian.net/browse/ORCA-123',
            jiraIdentifier: 'ORCA-123'
          }
        },
        { runtimeEnvironmentId: 'env-1' }
      )
    ).rejects.toThrow('Update the remote runtime to link Jira')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(folderWorkspacesCreate).not.toHaveBeenCalled()
  })

  it('purges renderer session state when deleting a local folder workspace', async () => {
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: projectGroup.id,
      name: 'Refund fix',
      folderPath: '/workspace/platform',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
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
})
