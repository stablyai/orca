import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { folderWorkspaceRemovalSessionState } from './folder-workspace-removal-session.test-fixture'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { NestedRepoScanResult, ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { SshConnectionState } from '../../../../shared/ssh-types'

const recoveryNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: recoveryNotice
}))

const LOCAL_OWNER = { runtimeEnvironmentId: null }

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
  recoveryNotice.mockReset()
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
    const statusPromise = store.getState().fetchFolderWorkspacePathStatus(request, LOCAL_OWNER)

    store.setState({
      projectGroups: [{ ...projectGroup, parentPath: '/workspace/new-platform' }]
    })
    resolveStatus({ path: '/workspace/old-platform', exists: true })
    await statusPromise

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey(request, LOCAL_OWNER)
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
    const statusPromise = store.getState().fetchFolderWorkspacePathStatus(request, LOCAL_OWNER)

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

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey(request, LOCAL_OWNER)
    expect(store.getState().folderWorkspacePathStatuses[cacheKey]).toBeUndefined()
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
    const connectedStatusPromise = store
      .getState()
      .fetchFolderWorkspacePathStatus(request, LOCAL_OWNER)

    store.setState({
      sshConnectionStates: new Map([['ssh-1', makeSshConnectionState('disconnected')]])
    })
    const disconnectedStatusPromise = store
      .getState()
      .fetchFolderWorkspacePathStatus(request, { force: true, ...LOCAL_OWNER })

    resolvers[1]?.({
      path: '/workspace/platform',
      exists: false,
      reason: 'unavailable'
    })
    await disconnectedStatusPromise
    resolvers[0]?.({ path: '/workspace/platform', exists: true })
    await connectedStatusPromise

    const cacheKey = store.getState().getFolderWorkspacePathStatusCacheKey(request, LOCAL_OWNER)
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
    store.setState(folderWorkspaceRemovalSessionState(folderWorkspace))

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
    await vi.waitFor(() => expect(recoveryNotice).toHaveBeenCalledTimes(1))
    expect(recoveryNotice).toHaveBeenCalledWith(
      [
        {
          fileId: 'file-1',
          filePath: '/workspace/platform/notes.md',
          content: 'draft'
        }
      ],
      workspaceKey,
      expect.any(Number)
    )
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
        ...LOCAL_OWNER,
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
})
