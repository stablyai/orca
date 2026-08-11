import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
  FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
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

const reposRemove = vi.fn()
const projectGroupsDelete = vi.fn()
const projectGroupsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposRemove.mockReset()
  reposRemove.mockResolvedValue(undefined)
  projectGroupsDelete.mockReset()
  projectGroupsList.mockReset()
  projectGroupsList.mockResolvedValue([])
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove },
      projectGroups: { delete: projectGroupsDelete, list: projectGroupsList },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group deletion store routing', () => {
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

    expect(projectGroupsDelete).toHaveBeenCalledWith({
      groupId: projectGroup.id,
      executionHostId: 'local'
    })
    expect(store.getState().projectGroups.map((group) => group.id)).toEqual([siblingGroup.id])
    expect(store.getState().folderWorkspaces).toEqual([])
    expect(store.getState().repos).toMatchObject([
      { id: 'direct', projectGroupId: null },
      { id: 'nested', projectGroupId: null },
      { id: 'sibling', projectGroupId: siblingGroup.id }
    ])
  })

  it('finishes deleting captured descendants after a concurrent catalog omission', async () => {
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'catalog-race-child',
      parentGroupId: projectGroup.id
    }
    const workspace: FolderWorkspace = {
      id: 'catalog-race-folder',
      projectGroupId: childGroup.id,
      name: 'Catalog race folder',
      folderPath: '/workspace/catalog-race',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const tab = makeTab({ id: 'catalog-race-tab', worktreeId: workspaceKey })
    let resolveDelete: ((deleted: boolean) => void) | undefined
    projectGroupsDelete.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveDelete = resolve
      })
    )
    const store = createTestStore()
    const shutdownWorktreeBrowsers = vi.fn().mockResolvedValue(undefined)
    const shutdownWorktreeTerminals = vi.fn().mockResolvedValue(undefined)
    store.setState({
      projectGroups: [projectGroup, childGroup],
      folderWorkspaces: [workspace],
      repos: [{ ...remoteRepo, projectGroupId: childGroup.id }],
      tabsByWorktree: { [workspaceKey]: [tab] },
      shutdownWorktreeBrowsers,
      shutdownWorktreeTerminals
    })

    const deletion = store.getState().deleteProjectGroup(projectGroup.id)
    await vi.waitFor(() => expect(projectGroupsDelete).toHaveBeenCalledOnce())
    await store.getState().fetchProjectGroups({ runtimeEnvironmentId: null })
    expect(store.getState().projectGroups).toEqual([])
    expect(store.getState().folderWorkspaces).toEqual([workspace])

    resolveDelete?.(true)
    await expect(deletion).resolves.toBe(true)

    expect(store.getState().folderWorkspaces).toEqual([])
    expect(store.getState().repos).toMatchObject([{ projectGroupId: null }])
    expect(store.getState().tabsByWorktree[workspaceKey]).toBeUndefined()
    expect(shutdownWorktreeBrowsers).toHaveBeenCalledWith(workspaceKey)
    expect(shutdownWorktreeTerminals).toHaveBeenCalledWith(
      workspaceKey,
      expect.objectContaining({
        shutdownReason: 'remove-worktree',
        backendOwnsPtyTeardown: true,
        isCurrent: expect.any(Function)
      })
    )
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
      projectGroups: [{ ...projectGroup, executionHostId: 'runtime:env-1' }],
      repos: [groupedRepo]
    })

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(false)

    expect(store.getState().projectGroups).toEqual([
      { ...projectGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().repos).toEqual([groupedRepo])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: projectGroup.id, executionHostId: 'local' },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
  })

  it('deletes a unique group through an owner-unqualified runtime with backend teardown', async () => {
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-remote')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'runtime:env-1' }]
    })

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.delete',
      params: { groupId: projectGroup.id },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined
    })
    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([])
  })

  it('refuses to delete a group with open terminals through a legacy runtime', async () => {
    const folderWorkspace: FolderWorkspace = {
      id: 'folder-legacy',
      projectGroupId: projectGroup.id,
      name: 'Legacy folder',
      folderPath: '/remote/folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1,
      executionHostId: 'runtime:env-1'
    }
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-remote')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => ({
      id: `rpc-${args.method}`,
      ok: true,
      result: args.method === 'terminal.close' ? { close: { closed: true } } : { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    }))
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    const ptyId = 'remote:env-1@@legacy-pty'
    const tab = makeTab({ id: 'legacy-tab', worktreeId: workspaceKey, ptyId })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'runtime:env-1' }],
      folderWorkspaces: [folderWorkspace],
      tabsByWorktree: { [workspaceKey]: [tab] },
      ptyIdsByTabId: { [tab.id]: [ptyId] }
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(store.getState().deleteProjectGroup(projectGroup.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'Project group deletion requires backend terminal teardown support.'
    )
    expect(store.getState().projectGroups).toEqual([
      { ...projectGroup, executionHostId: 'runtime:env-1' }
    ])
    expect(store.getState().folderWorkspaces).toEqual([folderWorkspace])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([tab])
    expect(store.getState().ptyIdsByTabId[tab.id]).toEqual([ptyId])
    warn.mockRestore()
  })

  it('keeps the whole same-id subtree when legacy runtime teardown is unavailable', async () => {
    const targetRoot = { ...projectGroup, executionHostId: 'runtime:env-1' as const }
    const siblingRoot = {
      ...projectGroup,
      name: 'Sibling platform',
      executionHostId: 'runtime:env-2' as const
    }
    const targetChild = {
      ...targetRoot,
      id: 'shared-child',
      parentGroupId: targetRoot.id
    }
    const siblingChild = { ...targetChild, executionHostId: siblingRoot.executionHostId }
    const targetWorkspace: FolderWorkspace = {
      id: 'shared-folder',
      projectGroupId: targetChild.id,
      name: 'Target folder',
      folderPath: '/target/folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1,
      executionHostId: targetRoot.executionHostId
    }
    const siblingWorkspace = {
      ...targetWorkspace,
      name: 'Sibling folder',
      folderPath: '/sibling/folder',
      executionHostId: siblingRoot.executionHostId
    }
    const targetRepo = {
      ...remoteRepo,
      id: 'shared-repo',
      projectGroupId: targetChild.id,
      executionHostId: targetRoot.executionHostId
    }
    const siblingRepo = { ...targetRepo, executionHostId: siblingRoot.executionHostId }
    const workspaceKey = folderWorkspaceKey(targetWorkspace.id)
    const targetPtyId = 'remote:env-1@@target-pty'
    const siblingPtyId = 'remote:env-2@@sibling-pty'
    const targetTab = makeTab({
      id: 'target-tab',
      worktreeId: workspaceKey,
      ptyId: targetPtyId
    })
    const siblingTab = makeTab({
      id: 'sibling-tab',
      worktreeId: workspaceKey,
      ptyId: siblingPtyId
    })
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-target')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => ({
      id: `rpc-${args.method}`,
      ok: true,
      result: args.method === 'terminal.close' ? { close: { closed: true } } : { deleted: true },
      _meta: { runtimeId: 'runtime-target' }
    }))
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      activeWorktreeId: workspaceKey,
      activeWorkspaceExecutionHostId: targetRoot.executionHostId,
      projectGroups: [targetRoot, siblingRoot, targetChild, siblingChild],
      folderWorkspaces: [targetWorkspace, siblingWorkspace],
      repos: [targetRepo, siblingRepo],
      tabsByWorktree: { [workspaceKey]: [targetTab, siblingTab] },
      ptyIdsByTabId: {
        [targetTab.id]: [targetPtyId],
        [siblingTab.id]: [siblingPtyId]
      }
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(targetRoot.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'group-delete-failed',
      groupId: targetRoot.id,
      requestedProjectIds: [targetRepo.id],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'Project group deletion requires backend terminal teardown support.'
    )
    expect(store.getState().projectGroups).toEqual([
      targetRoot,
      siblingRoot,
      targetChild,
      siblingChild
    ])
    expect(store.getState().folderWorkspaces).toEqual([targetWorkspace, siblingWorkspace])
    expect(store.getState().repos).toEqual([targetRepo, siblingRepo])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([targetTab, siblingTab])
    expect(store.getState().ptyIdsByTabId[targetTab.id]).toEqual([targetPtyId])
    expect(store.getState().ptyIdsByTabId[siblingTab.id]).toEqual([siblingPtyId])
    expect(store.getState().activeWorkspaceExecutionHostId).toBe(targetRoot.executionHostId)
    warn.mockRestore()
  })

  it.each([
    ['forward', false],
    ['reverse', true]
  ])('deletes only one same-runtime physical subtree in %s order', async (_label, reverse) => {
    const localRoot = {
      ...projectGroup,
      id: 'shared-root',
      name: 'Local root',
      connectionId: null,
      executionHostId: 'runtime:env-1' as const,
      runtimeSourceExecutionHostId: 'local' as const
    }
    const sshRoot = {
      ...projectGroup,
      id: localRoot.id,
      name: 'SSH root',
      connectionId: 'builder',
      executionHostId: 'runtime:env-1' as const,
      runtimeSourceExecutionHostId: 'ssh:builder' as const
    }
    const localChild = {
      ...localRoot,
      id: 'shared-child',
      name: 'Local child',
      parentGroupId: localRoot.id
    }
    const sshChild = {
      ...sshRoot,
      id: localChild.id,
      name: 'SSH child',
      parentGroupId: sshRoot.id
    }
    const localFolder: FolderWorkspace = {
      id: 'shared-folder',
      projectGroupId: localChild.id,
      name: 'Local folder',
      folderPath: '/local/folder',
      connectionId: null,
      executionHostId: 'runtime:env-1',
      runtimeSourceExecutionHostId: 'local',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const sshFolder: FolderWorkspace = {
      ...localFolder,
      name: 'SSH folder',
      folderPath: '/ssh/folder',
      connectionId: 'builder',
      runtimeSourceExecutionHostId: 'ssh:builder'
    }
    const localRepo = {
      ...remoteRepo,
      id: 'local-repo',
      connectionId: null,
      executionHostId: 'runtime:env-1' as const,
      projectGroupId: localChild.id
    }
    const sshRepo = {
      ...remoteRepo,
      id: 'ssh-repo',
      connectionId: 'builder',
      executionHostId: 'runtime:env-1' as const,
      projectGroupId: sshChild.id
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-group',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      projectGroups: reverse
        ? [sshChild, localChild, sshRoot, localRoot]
        : [localRoot, sshRoot, localChild, sshChild],
      folderWorkspaces: reverse ? [sshFolder, localFolder] : [localFolder, sshFolder],
      repos: reverse ? [sshRepo, localRepo] : [localRepo, sshRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(sshRoot.id, {
        hostId: 'runtime:env-1',
        sourceExecutionHostId: 'ssh:builder',
        removeContainedProjects: false
      })
    ).resolves.toMatchObject({ status: 'deleted-group', requestedProjectIds: [] })

    expect(
      runtimeEnvironmentCall.mock.calls.find(
        ([request]) => request.method === 'projectGroup.delete'
      )?.[0].params
    ).toEqual({
      groupId: sshRoot.id,
      executionHostId: 'ssh:builder',
      preserveRendererWorkspaceIds: [sshFolder.id]
    })
    expect(
      store
        .getState()
        .projectGroups.map((group) => group.name)
        .sort()
    ).toEqual([localChild.name, localRoot.name])
    expect(store.getState().folderWorkspaces).toEqual([localFolder])
    expect(
      Object.fromEntries(store.getState().repos.map((repo) => [repo.id, repo.projectGroupId]))
    ).toEqual({
      [localRepo.id]: localChild.id,
      [sshRepo.id]: null
    })
  })

  it('deletes only the group when contained project removal is not requested', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const groupedRepo = { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup],
      repos: [groupedRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: false
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: [],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(reposRemove).not.toHaveBeenCalled()
    expect(store.getState().repos).toMatchObject([{ id: 'direct', projectGroupId: null }])
  })

  it('removes direct and nested child projects after deleting a group', async () => {
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'child',
      parentGroupId: projectGroup.id
    }
    const siblingRepo = { ...remoteRepo, id: 'sibling', projectGroupId: null }
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup, childGroup],
      repos: [
        { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id },
        { ...remoteRepo, id: 'nested', projectGroupId: childGroup.id },
        siblingRepo
      ]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: ['direct', 'nested'],
      removedProjectIds: ['direct', 'nested'],
      failedProjectRemovals: []
    })

    expect(reposRemove).toHaveBeenCalledWith({ repoId: 'direct' })
    expect(reposRemove).toHaveBeenCalledWith({ repoId: 'nested' })
    expect(store.getState().repos).toEqual([siblingRepo])
  })

  it('does not remove contained projects when group deletion fails', async () => {
    projectGroupsDelete.mockResolvedValue(false)
    const groupedRepo = { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id }
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup],
      repos: [groupedRepo]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'group-delete-failed',
      groupId: projectGroup.id,
      requestedProjectIds: ['direct'],
      removedProjectIds: [],
      failedProjectRemovals: []
    })

    expect(reposRemove).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([groupedRepo])
  })

  it('reports project removal failures by comparing store state after removeProject', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    reposRemove.mockImplementation(async ({ repoId }: { repoId: string }) => {
      if (repoId === 'nested') {
        throw new Error('remove failed')
      }
    })
    const childGroup: ProjectGroup = {
      ...projectGroup,
      id: 'child',
      parentGroupId: projectGroup.id
    }
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [projectGroup, childGroup],
      repos: [
        { ...remoteRepo, id: 'direct', projectGroupId: projectGroup.id },
        { ...remoteRepo, id: 'nested', projectGroupId: childGroup.id }
      ]
    })

    await expect(
      store.getState().deleteProjectGroupWithContainedProjects(projectGroup.id, {
        removeContainedProjects: true
      })
    ).resolves.toEqual({
      status: 'deleted-group',
      groupId: projectGroup.id,
      requestedProjectIds: ['direct', 'nested'],
      removedProjectIds: ['direct'],
      failedProjectRemovals: [
        {
          projectId: 'nested',
          reason: 'Project remained in Orca after removeProject completed.'
        }
      ]
    })

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['nested'])
    consoleError.mockRestore()
  })
})
