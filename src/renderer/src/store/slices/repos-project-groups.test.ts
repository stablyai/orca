import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  NestedRepoScanResult,
  Repo,
  ProjectGroup,
  FolderWorkspace
} from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

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
const projectGroupsList = vi.fn()
const projectGroupsCreate = vi.fn()
const projectGroupsDelete = vi.fn()
const projectGroupsMoveProject = vi.fn()
const projectGroupsImportNested = vi.fn()
const projectGroupsScanNested = vi.fn()
const projectGroupsCancelNestedScan = vi.fn()
const projectGroupsOnNestedScanProgress = vi.fn()
const folderWorkspacesList = vi.fn()
const folderWorkspacesCreate = vi.fn()
const folderWorkspacesUpdate = vi.fn()
const folderWorkspacesDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
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
        list: reposList
      },
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
        create: folderWorkspacesCreate,
        update: folderWorkspacesUpdate,
        delete: folderWorkspacesDelete
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group store routing', () => {
  it('creates local project groups without contacting the runtime transport', async () => {
    projectGroupsCreate.mockResolvedValue(projectGroup)
    const store = createTestStore()

    await expect(store.getState().createProjectGroup('Platform')).resolves.toEqual(projectGroup)

    expect(store.getState().projectGroups).toEqual([projectGroup])
    expect(projectGroupsCreate).toHaveBeenCalledWith({
      name: 'Platform',
      createdFrom: 'manual'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('creates, updates, and deletes local folder workspaces', async () => {
    const linkedTask: FolderWorkspace['linkedTask'] = {
      provider: 'linear',
      type: 'issue',
      number: 0,
      title: 'Refund fix',
      url: 'https://linear.app/acme/issue/ENG-123',
      linearIdentifier: 'ENG-123'
    }
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: projectGroup.id,
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
    folderWorkspacesCreate.mockResolvedValue(folderWorkspace)
    folderWorkspacesUpdate.mockResolvedValue({ ...folderWorkspace, comment: 'Ready' })
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()

    await expect(
      store.getState().createFolderWorkspace({
        projectGroupId: projectGroup.id,
        name: 'Refund fix',
        linkedTask
      })
    ).resolves.toEqual(folderWorkspace)
    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Ready' })
    ).resolves.toBe(true)
    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(folderWorkspacesCreate).toHaveBeenCalledWith({
      projectGroupId: projectGroup.id,
      name: 'Refund fix',
      linkedTask
    })
    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { comment: 'Ready' }
    })
    expect(folderWorkspacesDelete).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id
    })
    expect(store.getState().folderWorkspaces).toEqual([])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
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

  it('refreshes local repos and groups after importing nested repos', async () => {
    const importedRepo: Repo = {
      ...remoteRepo,
      id: 'local-imported',
      path: '/platform/api',
      projectGroupId: projectGroup.id,
      projectGroupOrder: 0
    }
    const result = {
      group: projectGroup,
      repos: [{ path: importedRepo.path, projectId: importedRepo.id, status: 'imported' as const }],
      importedCount: 1,
      alreadyKnownCount: 0,
      failedCount: 0
    }
    projectGroupsImportNested.mockResolvedValue(result)
    projectGroupsList.mockResolvedValue([projectGroup])
    folderWorkspacesList.mockResolvedValue([])
    reposList.mockResolvedValue([importedRepo])
    const store = createTestStore()

    await expect(
      store.getState().importNestedRepos({
        parentPath: '/platform',
        groupName: 'Platform',
        projectPaths: [importedRepo.path],
        mode: 'group'
      })
    ).resolves.toEqual(result)

    expect(projectGroupsImportNested).toHaveBeenCalledWith({
      parentPath: '/platform',
      groupName: 'Platform',
      projectPaths: [importedRepo.path],
      mode: 'group'
    })
    expect(projectGroupsList).toHaveBeenCalled()
    expect(folderWorkspacesList).toHaveBeenCalled()
    expect(reposList).toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([projectGroup])
    expect(store.getState().repos).toEqual([importedRepo])
  })

  it('routes local nested scan progress by scanId and unsubscribes after completion', async () => {
    const unsubscribe = vi.fn()
    const progressCallback = vi.fn()
    const matchingScan = {
      selectedPath: '/platform',
      selectedPathKind: 'non_git_folder' as const,
      repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 10,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    }
    projectGroupsOnNestedScanProgress.mockImplementation(
      (listener: (data: { scanId: string; scan: NestedRepoScanResult }) => void) => {
        listener({ scanId: 'other-scan', scan: { ...matchingScan, repos: [] } })
        listener({ scanId: 'scan-1', scan: matchingScan })
        return unsubscribe
      }
    )
    projectGroupsScanNested.mockResolvedValue(matchingScan)
    const store = createTestStore()

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        scanId: 'scan-1',
        onProgress: progressCallback
      })
    ).resolves.toEqual(matchingScan)

    expect(progressCallback).toHaveBeenCalledTimes(1)
    expect(progressCallback).toHaveBeenCalledWith(matchingScan)
    expect(projectGroupsScanNested).toHaveBeenCalledWith({
      path: '/platform',
      connectionId: undefined,
      scanId: 'scan-1'
    })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes local nested scan progress when the scan rejects', async () => {
    const unsubscribe = vi.fn()
    projectGroupsOnNestedScanProgress.mockReturnValue(unsubscribe)
    projectGroupsScanNested.mockRejectedValue(new Error('scan failed'))
    const store = createTestStore()

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        scanId: 'scan-1',
        onProgress: vi.fn()
      })
    ).resolves.toBeNull()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('cancels local nested scans through the preload API', async () => {
    projectGroupsCancelNestedScan.mockResolvedValue(true)
    const store = createTestStore()

    await expect(store.getState().cancelNestedRepoScan('scan-1')).resolves.toBe(true)

    expect(projectGroupsCancelNestedScan).toHaveBeenCalledWith({ scanId: 'scan-1' })
  })

  it('does not send cancelNestedRepoScan to a runtime environment transport', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(store.getState().cancelNestedRepoScan('scan-1')).resolves.toBe(false)

    expect(projectGroupsCancelNestedScan).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('normalizes older runtime nested scan results and keeps the RPC bounded', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-scan',
      ok: true,
      result: {
        selectedPath: '/platform',
        selectedPathKind: 'non_git_folder',
        repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
        truncated: true,
        timedOut: false,
        durationMs: 10,
        maxDepth: 3
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(store.getState().scanNestedRepos('/platform')).resolves.toEqual({
      selectedPath: '/platform',
      selectedPathKind: 'non_git_folder',
      repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
      truncated: true,
      timedOut: false,
      stopped: false,
      durationMs: 10,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.scanNested',
      params: { path: '/platform' },
      timeoutMs: 20_000
    })
  })

  it('moves local repos to a group using the preload projectId contract', async () => {
    const movedRepo = { ...remoteRepo, projectGroupId: projectGroup.id, projectGroupOrder: 3 }
    projectGroupsMoveProject.mockResolvedValue(movedRepo)
    const store = createTestStore()
    store.setState({ repos: [remoteRepo], projectGroups: [projectGroup] })

    await expect(
      store.getState().moveProjectToGroup(remoteRepo.id, projectGroup.id, 3)
    ).resolves.toBe(true)

    expect(projectGroupsMoveProject).toHaveBeenCalledWith({
      projectId: remoteRepo.id,
      groupId: projectGroup.id,
      order: 3
    })
    expect(store.getState().repos).toEqual([movedRepo])
  })

  it('removes local project group subtrees from renderer state after delete', async () => {
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'child',
      parentGroupId: projectGroup.id
    }
    const siblingGroup: ProjectGroup = {
      ...projectGroup,
      id: 'sibling',
      name: 'Tools',
      tabOrder: 1
    }
    const childWorkspace: FolderWorkspace = {
      id: 'folder-workspace-1',
      projectGroupId: childGroup.id,
      name: 'Shared cleanup',
      folderPath: '/workspace/platform/shared',
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
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup, childGroup, siblingGroup],
      folderWorkspaces: [childWorkspace],
      repos: [
        { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id },
        { ...remoteRepo, id: 'nested', projectGroupId: childGroup.id },
        { ...remoteRepo, id: 'sibling', projectGroupId: siblingGroup.id }
      ]
    })

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(true)

    expect(store.getState().projectGroups.map((group) => group.id)).toEqual([siblingGroup.id])
    expect(store.getState().folderWorkspaces).toEqual([])
    expect(store.getState().repos).toMatchObject([
      { id: 'direct', projectGroupId: null },
      { id: 'nested', projectGroupId: null },
      { id: 'sibling', projectGroupId: siblingGroup.id }
    ])
  })

  it('uses the remote delete response shape before mutating local state', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: false },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const groupedRepo = { ...remoteRepo, projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [projectGroup],
      repos: [groupedRepo]
    })

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(false)

    expect(store.getState().projectGroups).toEqual([projectGroup])
    expect(store.getState().repos).toEqual([groupedRepo])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: projectGroup.id },
      timeoutMs: 15_000
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
  })
})
