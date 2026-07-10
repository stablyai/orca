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
import type { SshConnectionState } from '../../../../shared/ssh-types'

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

function makeSshConnectionState(status: SshConnectionState['status']): SshConnectionState {
  return {
    targetId: 'ssh-1',
    status,
    error: null,
    reconnectAttempt: 0
  }
}

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
  it('creates local project groups without contacting the runtime transport', async () => {
    projectGroupsCreate.mockResolvedValue(projectGroup)
    const store = createTestStore()

    await expect(store.getState().createProjectGroup('Platform')).resolves.toEqual({
      ...projectGroup,
      executionHostId: 'local'
    })

    expect(store.getState().projectGroups).toEqual([{ ...projectGroup, executionHostId: 'local' }])
    expect(projectGroupsCreate).toHaveBeenCalledWith({
      name: 'Platform',
      createdFrom: 'manual'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('stamps local fetched folder groups with the local owner', async () => {
    const folderGroup = { ...projectGroup, parentPath: '/workspace/platform' }
    projectGroupsList.mockResolvedValue([folderGroup])
    const store = createTestStore()

    await store.getState().fetchProjectGroups()

    expect(store.getState().projectGroups).toEqual([{ ...folderGroup, executionHostId: 'local' }])
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('stamps runtime-fetched SSH folder groups with the runtime owner', async () => {
    const folderGroup = {
      ...projectGroup,
      parentPath: '/workspace/platform',
      connectionId: 'ssh-1'
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-list-groups',
      ok: true,
      result: { groups: [folderGroup] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchProjectGroups()

    expect(store.getState().projectGroups).toEqual([
      { ...folderGroup, executionHostId: 'runtime:env-1' }
    ])
  })

  it('stamps runtime-fetched folder groups with the focused runtime host', async () => {
    const folderGroup = { ...projectGroup, parentPath: '/workspace/platform' }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-list-groups',
      ok: true,
      result: { groups: [folderGroup] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchProjectGroups()

    expect(store.getState().projectGroups).toEqual([
      { ...folderGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.list',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(projectGroupsList).not.toHaveBeenCalled()
  })

  it('routes folder path status through an explicit runtime owner when provided', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-path-status',
      ok: true,
      result: { status: { path: '/workspace/platform', exists: true } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const folderGroup = { ...projectGroup, parentPath: '/workspace/platform' }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'wrong-env' } as never,
      projectGroups: [folderGroup]
    })

    const request = { scope: 'project-group' as const, projectGroupId: folderGroup.id }

    await expect(
      store.getState().fetchFolderWorkspacePathStatus(request, {
        force: true,
        runtimeEnvironmentId: 'env-1'
      })
    ).resolves.toEqual({ path: '/workspace/platform', exists: true })

    expect(store.getState().getFolderWorkspacePathStatusCacheKey(request)).toBe(
      `environment:wrong-env:project-group:${folderGroup.id}`
    )
    expect(
      store
        .getState()
        .getFolderWorkspacePathStatusCacheKey(request, { runtimeEnvironmentId: 'env-1' })
    ).toBe(`environment:env-1:project-group:${folderGroup.id}`)
    expect(
      store.getState().getFreshFolderWorkspacePathStatus(request, { runtimeEnvironmentId: 'env-1' })
    ).toEqual({ path: '/workspace/platform', exists: true })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'folderWorkspace.getPathStatus',
      params: request,
      timeoutMs: 15_000
    })
  })

  it('routes folder workspace creation through an explicit runtime owner when provided', async () => {
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-workspace-runtime',
      projectGroupId: projectGroup.id,
      name: 'Runtime folder',
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
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create-folder',
      ok: true,
      result: { folderWorkspace },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'wrong-env' } as never })

    await expect(
      store
        .getState()
        .createFolderWorkspace(
          { projectGroupId: projectGroup.id, name: 'Runtime folder' },
          { runtimeEnvironmentId: 'env-1' }
        )
    ).resolves.toEqual(folderWorkspace)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'folderWorkspace.create',
      params: { projectGroupId: projectGroup.id, name: 'Runtime folder' },
      timeoutMs: 15_000
    })
    expect(folderWorkspacesCreate).not.toHaveBeenCalled()
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

  it('caches local folder workspace path status by scope', async () => {
    const folderGroup = { ...projectGroup, parentPath: '/workspace/platform' }
    folderWorkspacesGetPathStatus.mockResolvedValue({
      path: '/workspace/platform',
      exists: false,
      reason: 'missing'
    })
    const store = createTestStore()
    store.setState({ projectGroups: [folderGroup] })

    await expect(
      store.getState().fetchFolderWorkspacePathStatus({
        scope: 'project-group',
        projectGroupId: folderGroup.id
      })
    ).resolves.toEqual({
      path: '/workspace/platform',
      exists: false,
      reason: 'missing'
    })

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey({
      scope: 'project-group',
      projectGroupId: folderGroup.id
    })
    expect(store.getState().folderWorkspacePathStatuses[cacheKey]?.status).toEqual({
      path: '/workspace/platform',
      exists: false,
      reason: 'missing'
    })
    expect(folderWorkspacesGetPathStatus).toHaveBeenCalledTimes(1)
  })

  it('ignores stale folder path status responses after a group path changes', async () => {
    let resolveStatus: (status: { path: string; exists: boolean }) => void = () => {}
    folderWorkspacesGetPathStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        })
    )
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, parentPath: '/workspace/old-platform' }]
    })
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const statusPromise = store.getState().fetchFolderWorkspacePathStatus(request)

    store.setState({
      projectGroups: [{ ...projectGroup, parentPath: '/workspace/new-platform' }]
    })
    resolveStatus({ path: '/workspace/old-platform', exists: true })
    await statusPromise

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey(request)
    expect(store.getState().folderWorkspacePathStatuses[cacheKey]).toBeUndefined()
  })

  it('ignores stale folder path status responses after repo ownership changes', async () => {
    let resolveStatus: (status: { path: string; exists: boolean }) => void = () => {}
    folderWorkspacesGetPathStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve
        })
    )
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, parentPath: '/workspace/platform' }],
      repos: [{ ...remoteRepo, id: 'local-repo', path: '/workspace/platform/api' }]
    })
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const statusPromise = store.getState().fetchFolderWorkspacePathStatus(request)

    store.setState({
      repos: [
        {
          ...remoteRepo,
          id: 'ssh-repo',
          path: '/workspace/platform/api',
          connectionId: 'ssh-1'
        }
      ]
    })
    resolveStatus({ path: '/workspace/platform', exists: true })
    await statusPromise

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey(request)
    expect(store.getState().folderWorkspacePathStatuses[cacheKey]).toBeUndefined()
  })

  it('treats expired folder path status cache entries as unknown', async () => {
    vi.useFakeTimers()
    try {
      const store = createTestStore()
      store.setState({
        projectGroups: [{ ...projectGroup, parentPath: '/workspace/platform' }]
      })
      const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
      await store.getState().fetchFolderWorkspacePathStatus(request)

      expect(store.getState().getFreshFolderWorkspacePathStatus(request)).toEqual({
        path: '/workspace/platform',
        exists: true
      })

      vi.setSystemTime(Date.now() + 10_001)

      expect(store.getState().getFreshFolderWorkspacePathStatus(request)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats current-state mismatched folder path cache entries as unknown', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...projectGroup, parentPath: '/workspace/platform', connectionId: 'ssh-1' }
      ],
      sshConnectionStates: new Map([['ssh-1', makeSshConnectionState('connected')]])
    })
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    await store.getState().fetchFolderWorkspacePathStatus(request)

    expect(store.getState().getFreshFolderWorkspacePathStatus(request)).toEqual({
      path: '/workspace/platform',
      exists: true
    })

    store.setState({
      sshConnectionStates: new Map([['ssh-1', makeSshConnectionState('disconnected')]])
    })

    expect(store.getState().getFreshFolderWorkspacePathStatus(request)).toBeNull()
  })

  it('ignores stale folder path status responses after SSH connection state changes', async () => {
    const resolvers: ((status: { path: string; exists: boolean; reason?: string }) => void)[] = []
    folderWorkspacesGetPathStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...projectGroup, parentPath: '/workspace/platform', connectionId: 'ssh-1' }
      ],
      sshConnectionStates: new Map([['ssh-1', makeSshConnectionState('connected')]])
    })
    const request = { scope: 'project-group' as const, projectGroupId: projectGroup.id }
    const connectedStatusPromise = store.getState().fetchFolderWorkspacePathStatus(request)

    store.setState({
      sshConnectionStates: new Map([['ssh-1', makeSshConnectionState('disconnected')]])
    })
    const disconnectedStatusPromise = store
      .getState()
      .fetchFolderWorkspacePathStatus(request, { force: true })

    resolvers[1]?.({
      path: '/workspace/platform',
      exists: false,
      reason: 'unavailable'
    })
    await disconnectedStatusPromise
    resolvers[0]?.({ path: '/workspace/platform', exists: true })
    await connectedStatusPromise

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey(request)
    expect(store.getState().folderWorkspacePathStatuses[cacheKey]?.status).toEqual({
      path: '/workspace/platform',
      exists: false,
      reason: 'unavailable'
    })
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
    expect(store.getState().projectGroups).toEqual([{ ...projectGroup, executionHostId: 'local' }])
    // Why: the repos slice stamps fetched repos with their owning execution
    // host so multi-host routing never has to guess (multi-host design).
    expect(store.getState().repos).toEqual([{ ...importedRepo, executionHostId: 'local' }])
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
    // Why: the repos slice stamps updated repos with their owning execution
    // host so multi-host routing never has to guess (multi-host design).
    expect(store.getState().repos).toEqual([{ ...movedRepo, executionHostId: 'local' }])
  })

  it('propagates specific folder workspace create failures to callers', async () => {
    folderWorkspacesCreate.mockRejectedValue(new Error('folder_workspace_path_missing:/srv/app'))
    const store = createTestStore()

    await expect(
      store.getState().createFolderWorkspace({
        projectGroupId: projectGroup.id,
        name: 'Broken folder'
      })
    ).rejects.toThrow(
      'Folder not found. Orca cannot find /srv/app. Remove and re-import the folder.'
    )
  })
})
