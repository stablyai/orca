import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  NestedRepoScanResult,
  Repo,
  ProjectGroup,
  FolderWorkspace
} from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
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
      {
        ...folderGroup,
        executionHostId: 'runtime:env-1',
        runtimeSourceExecutionHostId: 'ssh:ssh-1'
      }
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
      {
        ...folderGroup,
        executionHostId: 'runtime:env-1',
        runtimeSourceExecutionHostId: 'local'
      }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.list',
      params: { ownerQualified: true },
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
    const folderGroup = {
      ...projectGroup,
      parentPath: '/workspace/platform',
      executionHostId: 'runtime:env-1' as const,
      runtimeSourceExecutionHostId: 'local' as const
    }
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'wrong-env' } as never,
      projectGroups: [folderGroup]
    })

    const request = {
      scope: 'project-group' as const,
      projectGroupId: folderGroup.id,
      executionHostId: 'local' as const
    }

    await expect(
      store.getState().fetchFolderWorkspacePathStatus(request, {
        force: true,
        runtimeEnvironmentId: 'env-1'
      })
    ).resolves.toEqual({ path: '/workspace/platform', exists: true })

    expect(store.getState().getFolderWorkspacePathStatusCacheKey(request)).toBe(
      `environment:wrong-env:project-group:local:${folderGroup.id}`
    )
    expect(
      store
        .getState()
        .getFolderWorkspacePathStatusCacheKey(request, { runtimeEnvironmentId: 'env-1' })
    ).toBe(`environment:env-1:project-group:local:${folderGroup.id}`)
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

  it('isolates same-ID local and SSH path-status cache entries by source owner', async () => {
    const localGroup = {
      ...projectGroup,
      parentPath: '/local/platform',
      connectionId: null,
      executionHostId: 'local' as const
    }
    const sshGroup = {
      ...projectGroup,
      parentPath: '/remote/platform',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1' as const
    }
    folderWorkspacesGetPathStatus.mockImplementation(async (request) => ({
      path: request.executionHostId === 'local' ? localGroup.parentPath : sshGroup.parentPath,
      exists: request.executionHostId === 'local'
    }))
    const store = createTestStore()
    store.setState({ projectGroups: [localGroup, sshGroup] })
    const localRequest = {
      scope: 'project-group' as const,
      projectGroupId: projectGroup.id,
      executionHostId: 'local' as const
    }
    const sshRequest = {
      scope: 'project-group' as const,
      projectGroupId: projectGroup.id,
      executionHostId: 'ssh:ssh-1' as const
    }

    await store.getState().fetchFolderWorkspacePathStatus(localRequest)
    await store.getState().fetchFolderWorkspacePathStatus(sshRequest)

    expect(store.getState().getFolderWorkspacePathStatusCacheKey(localRequest)).not.toBe(
      store.getState().getFolderWorkspacePathStatusCacheKey(sshRequest)
    )
    expect(store.getState().getFreshFolderWorkspacePathStatus(localRequest)).toEqual({
      path: '/local/platform',
      exists: true
    })
    expect(store.getState().getFreshFolderWorkspacePathStatus(sshRequest)).toEqual({
      path: '/remote/platform',
      exists: false
    })
  })

  it('isolates paired-runtime same-source requests by outer transport', async () => {
    const request = {
      scope: 'project-group' as const,
      projectGroupId: projectGroup.id,
      executionHostId: 'local' as const
    }
    runtimeEnvironmentCall.mockImplementation(async (call: RuntimeEnvironmentCallRequest) => {
      const selector = (call as RuntimeEnvironmentCallRequest & { selector: string }).selector
      return {
        id: `status-${selector}`,
        ok: true,
        result: { status: { path: `/${selector}/platform`, exists: selector === 'env-1' } },
        _meta: { runtimeId: `runtime-${selector}` }
      }
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          ...projectGroup,
          parentPath: '/env-1/platform',
          executionHostId: 'runtime:env-1',
          runtimeSourceExecutionHostId: 'local'
        },
        {
          ...projectGroup,
          parentPath: '/env-2/platform',
          executionHostId: 'runtime:env-2',
          runtimeSourceExecutionHostId: 'local'
        }
      ]
    })
    const envOne = { runtimeEnvironmentId: 'env-1' }
    const envTwo = { runtimeEnvironmentId: 'env-2' }

    await store.getState().fetchFolderWorkspacePathStatus(request, envOne)
    await store.getState().fetchFolderWorkspacePathStatus(request, envTwo)

    expect(store.getState().getFreshFolderWorkspacePathStatus(request, envOne)).toEqual({
      path: '/env-1/platform',
      exists: true
    })
    expect(store.getState().getFreshFolderWorkspacePathStatus(request, envTwo)).toEqual({
      path: '/env-2/platform',
      exists: false
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        params: request
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-2',
        params: request
      })
    )
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
    ).resolves.toEqual({
      ...folderWorkspace,
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'local'
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'folderWorkspace.create',
      params: { projectGroupId: projectGroup.id, name: 'Runtime folder' },
      timeoutMs: 15_000
    })
    expect(folderWorkspacesCreate).not.toHaveBeenCalled()
  })

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
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-ambient' } as never })

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        runtimeEnvironmentId: 'env-selected'
      })
    ).resolves.toEqual({
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
      selector: 'env-selected',
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
      order: 3,
      executionHostId: 'local'
    })
    // Why: the repos slice stamps updated repos with their owning execution
    // host so multi-host routing never has to guess (multi-host design).
    expect(store.getState().repos).toEqual([{ ...movedRepo, executionHostId: 'local' }])
  })
})
