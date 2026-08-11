import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
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
import { createTestStore, makeTab } from './store-test-helpers'

const folderWorkspacesUpdate = vi.fn()
const folderWorkspacesDelete = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: '/workspace/platform',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: projectGroup.id,
    name: 'Platform folder',
    folderPath: '/workspace/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  folderWorkspacesUpdate.mockReset()
  folderWorkspacesDelete.mockReset()
  folderWorkspacesList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      folderWorkspaces: {
        update: folderWorkspacesUpdate,
        delete: folderWorkspacesDelete,
        list: folderWorkspacesList
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('folder workspace owner-routed mutations', () => {
  it('updates a local folder locally while another runtime is focused', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesUpdate.mockResolvedValue({ ...folderWorkspace, comment: 'Ready' })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Ready' })
    ).resolves.toBe(true)

    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      updates: { comment: 'Ready' },
      executionHostId: 'local'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces[0]?.comment).toBe('Ready')
  })

  it('updates a runtime folder through its owner instead of the focused runtime', async () => {
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-runtime' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-update-folder',
      ok: true,
      result: { folderWorkspace: { ...folderWorkspace, comment: 'Ready' } },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'runtime:env-owner' }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Ready' })
    ).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-owner',
      method: 'folderWorkspace.update',
      params: {
        folderWorkspaceId: folderWorkspace.id,
        updates: { comment: 'Ready' },
        executionHostId: 'local'
      },
      timeoutMs: 15_000
    })
    expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces[0]?.comment).toBe('Ready')
  })

  it('updates only the selected host when local and direct-SSH folders share an ID', async () => {
    const localFolder = makeFolderWorkspace({ connectionId: null, executionHostId: 'local' })
    const sshFolder = makeFolderWorkspace({
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    })
    folderWorkspacesUpdate.mockResolvedValue({ ...sshFolder, comment: 'Remote update' })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        { ...projectGroup, connectionId: null, executionHostId: 'local' },
        { ...projectGroup, connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
      ],
      folderWorkspaces: [localFolder, sshFolder]
    })

    await expect(
      store.getState().updateFolderWorkspace(localFolder.id, { comment: 'Ambiguous' })
    ).resolves.toBe(false)
    await expect(
      store.getState().updateFolderWorkspace(
        sshFolder.id,
        { comment: 'Remote update' },
        {
          executionHostId: 'ssh:ssh-1'
        }
      )
    ).resolves.toBe(true)

    expect(folderWorkspacesUpdate).toHaveBeenCalledTimes(1)
    expect(folderWorkspacesUpdate).toHaveBeenCalledWith({
      folderWorkspaceId: sshFolder.id,
      updates: { comment: 'Remote update' },
      executionHostId: 'ssh:ssh-1'
    })
    expect(store.getState().folderWorkspaces).toEqual([
      localFolder,
      { ...sshFolder, comment: 'Remote update' }
    ])
  })

  it('fails a runtime update when physical owner provenance is ambiguous', async () => {
    const folderWorkspace = makeFolderWorkspace({
      executionHostId: 'runtime:env-owner'
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          ...projectGroup,
          executionHostId: 'runtime:env-owner',
          runtimeSourceExecutionHostId: 'local'
        },
        {
          ...projectGroup,
          executionHostId: 'runtime:env-owner',
          runtimeSourceExecutionHostId: 'ssh:ssh-1'
        }
      ],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Unsafe' })
    ).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
  })

  it('rejects contradictory direct authority before update or delete routing', async () => {
    const folderWorkspace = makeFolderWorkspace({
      connectionId: 'ssh-1',
      executionHostId: 'local'
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, connectionId: null, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Unsafe' })
    ).resolves.toBe(false)
    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(false)

    expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
    expect(folderWorkspacesDelete).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('rejects conflicting paired source stamps before runtime mutation', async () => {
    const folderWorkspace = makeFolderWorkspace({ executionHostId: 'runtime:env-owner' })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          ...projectGroup,
          connectionId: 'ssh-1',
          executionHostId: 'runtime:env-owner',
          runtimeSourceExecutionHostId: 'local'
        }
      ],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(
      store.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Unsafe' })
    ).resolves.toBe(false)
    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('ignores an older response after the same field changes again', async () => {
    const folderWorkspace = makeFolderWorkspace()
    let resolveOlder!: (workspace: FolderWorkspace) => void
    let resolveNewer!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate
      .mockImplementationOnce(
        () =>
          new Promise<FolderWorkspace>((resolve) => {
            resolveOlder = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<FolderWorkspace>((resolve) => {
            resolveNewer = resolve
          })
      )
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    const olderUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: true })
    const newerUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: false })
    resolveNewer({ ...folderWorkspace, isUnread: false, updatedAt: 3 })
    await newerUpdate
    resolveOlder({ ...folderWorkspace, isUnread: true, updatedAt: 2 })
    await olderUpdate

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(3)
  })

  it('does not share update generations between store instances', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesUpdate
      .mockResolvedValueOnce({ ...folderWorkspace, comment: 'First store' })
      .mockResolvedValueOnce({ ...folderWorkspace, comment: 'Second store' })
    const firstStore = createTestStore()
    const secondStore = createTestStore()
    for (const store of [firstStore, secondStore]) {
      store.setState({
        projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
        folderWorkspaces: [folderWorkspace]
      })
    }

    await Promise.all([
      firstStore.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'First store' }),
      secondStore.getState().updateFolderWorkspace(folderWorkspace.id, { comment: 'Second store' })
    ])

    expect(firstStore.getState().folderWorkspaces[0]?.comment).toBe('First store')
    expect(secondStore.getState().folderWorkspaces[0]?.comment).toBe('Second store')
  })

  it('does not apply an update response over a newer catalog refresh', async () => {
    const folderWorkspace = makeFolderWorkspace()
    let resolveUpdate!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate.mockImplementation(
      () =>
        new Promise<FolderWorkspace>((resolve) => {
          resolveUpdate = resolve
        })
    )
    folderWorkspacesList.mockResolvedValue([{ ...folderWorkspace, isUnread: false, updatedAt: 3 }])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    const pendingUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: true })
    await store.getState().fetchFolderWorkspaces()
    resolveUpdate({ ...folderWorkspace, isUnread: true, updatedAt: 2 })
    await pendingUpdate

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(false)
    expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(3)
  })

  it('applies an update response when the overlapping catalog was older', async () => {
    const folderWorkspace = makeFolderWorkspace()
    let resolveUpdate!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate.mockImplementation(
      () =>
        new Promise<FolderWorkspace>((resolve) => {
          resolveUpdate = resolve
        })
    )
    folderWorkspacesList.mockResolvedValue([folderWorkspace])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    const pendingUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { isUnread: true })
    await store.getState().fetchFolderWorkspaces()
    resolveUpdate({ ...folderWorkspace, isUnread: true, updatedAt: 2 })
    await pendingUpdate

    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(true)
    expect(store.getState().folderWorkspaces[0]?.updatedAt).toBe(2)
  })

  it('does not fence a runtime update when the local same-ID catalog refreshes', async () => {
    const localWorkspace = makeFolderWorkspace({ updatedAt: 3 })
    const runtimeWorkspace = {
      ...makeFolderWorkspace(),
      executionHostId: 'runtime:env-owner' as const
    }
    let resolveRuntimeUpdate!: (response: {
      id: string
      ok: true
      result: { folderWorkspace: FolderWorkspace }
      _meta: { runtimeId: string }
    }) => void
    runtimeEnvironmentCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRuntimeUpdate = resolve
        })
    )
    folderWorkspacesList.mockResolvedValue([localWorkspace])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [localWorkspace, runtimeWorkspace]
    })

    const pendingUpdate = store
      .getState()
      .updateFolderWorkspace(
        runtimeWorkspace.id,
        { isUnread: true },
        { executionHostId: 'runtime:env-owner' }
      )
    await store.getState().fetchFolderWorkspaces({ runtimeEnvironmentId: null })
    resolveRuntimeUpdate({
      id: 'rpc-update-folder',
      ok: true,
      result: {
        folderWorkspace: { ...runtimeWorkspace, isUnread: true, updatedAt: 2 }
      },
      _meta: { runtimeId: 'runtime-owner' }
    })
    await pendingUpdate

    expect(store.getState().folderWorkspaces).toEqual([
      { ...localWorkspace, executionHostId: 'local' },
      { ...runtimeWorkspace, isUnread: true, updatedAt: 2 }
    ])
  })

  it('does not rewind newer optimistic activity when an older response arrives', async () => {
    const folderWorkspace = makeFolderWorkspace()
    let resolveUpdate!: (workspace: FolderWorkspace) => void
    folderWorkspacesUpdate.mockImplementation(
      () =>
        new Promise<FolderWorkspace>((resolve) => {
          resolveUpdate = resolve
        })
    )
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    const pendingUpdate = store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { lastActivityAt: 10 })
    store.setState({
      folderWorkspaces: [{ ...folderWorkspace, lastActivityAt: 20 }]
    })
    resolveUpdate({ ...folderWorkspace, lastActivityAt: 10, updatedAt: 2 })
    await pendingUpdate

    expect(store.getState().folderWorkspaces[0]?.lastActivityAt).toBe(20)
  })

  it('reconciles optimistic fields when persistence fails', async () => {
    const persisted = makeFolderWorkspace({ isUnread: true, updatedAt: 2 })
    folderWorkspacesUpdate.mockResolvedValue(null)
    folderWorkspacesList.mockResolvedValue([persisted])
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [{ ...persisted, isUnread: false }]
    })

    await expect(
      store.getState().updateFolderWorkspace(persisted.id, { isUnread: false })
    ).resolves.toBe(false)

    expect(folderWorkspacesList).toHaveBeenCalledTimes(1)
    expect(store.getState().folderWorkspaces[0]?.isUnread).toBe(true)
  })

  it('preserves path-status cache entries for metadata-only updates', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesUpdate.mockResolvedValue({
      ...folderWorkspace,
      lastActivityAt: 10,
      updatedAt: 2
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace],
      folderWorkspacePathStatuses: {
        cached: {
          status: { path: folderWorkspace.folderPath, exists: true },
          checkedAt: 1,
          requestSnapshot: 'snapshot'
        }
      }
    })

    await store.getState().updateFolderWorkspace(folderWorkspace.id, { lastActivityAt: 10 })

    expect(store.getState().folderWorkspacePathStatuses.cached).toBeDefined()
  })

  it('invalidates path-status cache entries when the folder path changes', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesUpdate.mockResolvedValue({
      ...folderWorkspace,
      folderPath: '/workspace/renamed',
      updatedAt: 2
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace],
      folderWorkspacePathStatuses: {
        cached: {
          status: { path: folderWorkspace.folderPath, exists: true },
          checkedAt: 1,
          requestSnapshot: 'snapshot'
        }
      }
    })

    await store
      .getState()
      .updateFolderWorkspace(folderWorkspace.id, { folderPath: '/workspace/renamed' })

    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })

  it('deletes a local folder locally while another runtime is focused', async () => {
    const folderWorkspace = makeFolderWorkspace()
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'local' }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(folderWorkspacesDelete).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      executionHostId: 'local'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('deletes an explicit-local folder as local under an SSH group', async () => {
    const folderWorkspace = makeFolderWorkspace({ connectionId: null })
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(folderWorkspacesDelete).toHaveBeenCalledWith({
      folderWorkspaceId: folderWorkspace.id,
      executionHostId: 'local'
    })
  })

  it('tells local deletion to preserve a same-ID runtime sibling graph', async () => {
    const localWorkspace = makeFolderWorkspace({ executionHostId: 'local' })
    const runtimeWorkspace = makeFolderWorkspace({ executionHostId: 'runtime:env-sibling' })
    const workspaceKey = folderWorkspaceKey(localWorkspace.id)
    const targetTab = makeTab({ id: 'target-tab', worktreeId: workspaceKey, ptyId: 'local-pty' })
    const siblingPtyId = 'remote:env-sibling@@term_sibling'
    const siblingTab = makeTab({
      id: 'sibling-tab',
      worktreeId: workspaceKey,
      ptyId: siblingPtyId
    })
    folderWorkspacesDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      activeWorktreeId: workspaceKey,
      activeWorkspaceExecutionHostId: 'local',
      projectGroups: [
        { ...projectGroup, executionHostId: 'local' },
        { ...projectGroup, executionHostId: 'runtime:env-sibling' }
      ],
      folderWorkspaces: [localWorkspace, runtimeWorkspace],
      tabsByWorktree: { [workspaceKey]: [targetTab, siblingTab] },
      ptyIdsByTabId: {
        [targetTab.id]: ['local-pty'],
        [siblingTab.id]: [siblingPtyId]
      }
    })

    await expect(store.getState().deleteFolderWorkspace(localWorkspace.id)).resolves.toBe(true)

    expect(folderWorkspacesDelete).toHaveBeenCalledWith({
      folderWorkspaceId: localWorkspace.id,
      executionHostId: 'local',
      preserveRendererWorkspaceKey: true
    })
    expect(store.getState().folderWorkspaces).toEqual([runtimeWorkspace])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([siblingTab])
    expect(store.getState().ptyIdsByTabId[targetTab.id]).toBeUndefined()
    expect(store.getState().ptyIdsByTabId[siblingTab.id]).toEqual([siblingPtyId])
  })

  it('deletes a runtime folder through its owner instead of the focused runtime', async () => {
    const folderWorkspace = makeFolderWorkspace({ id: 'folder-runtime' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-folder',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-focused' } as never,
      projectGroups: [{ ...projectGroup, executionHostId: 'runtime:env-owner' }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-owner',
      method: 'folderWorkspace.delete',
      params: {
        folderWorkspaceId: folderWorkspace.id,
        executionHostId: 'local'
      },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined
    })
    expect(folderWorkspacesDelete).not.toHaveBeenCalled()
  })

  it('deletes a unique folder through an owner-unqualified runtime with backend teardown', async () => {
    const folderWorkspace = makeFolderWorkspace({
      id: 'folder-old-host',
      executionHostId: 'runtime:env-owner'
    })
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-owner')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-folder',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [{ ...projectGroup, executionHostId: folderWorkspace.executionHostId }],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-owner',
      method: 'folderWorkspace.delete',
      params: { folderWorkspaceId: folderWorkspace.id },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined
    })
    expect(folderWorkspacesDelete).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces).toEqual([])
  })

  it('lets a legacy runtime handle ambiguous physical provenance by ID', async () => {
    const folderWorkspace = makeFolderWorkspace({
      id: 'folder-old-ambiguous',
      executionHostId: 'runtime:env-owner'
    })
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-owner')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== FOLDER_WORKSPACE_OWNER_QUALIFIED_DELETE_RUNTIME_CAPABILITY
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-delete-folder',
      ok: true,
      result: { deleted: true },
      _meta: { runtimeId: 'runtime-owner' }
    })
    const store = createTestStore()
    store.setState({
      projectGroups: [
        {
          ...projectGroup,
          executionHostId: 'runtime:env-owner',
          runtimeSourceExecutionHostId: 'local'
        },
        {
          ...projectGroup,
          executionHostId: 'runtime:env-owner',
          runtimeSourceExecutionHostId: 'ssh:ssh-1'
        }
      ],
      folderWorkspaces: [folderWorkspace]
    })

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(true)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-owner',
      method: 'folderWorkspace.delete',
      params: { folderWorkspaceId: folderWorkspace.id },
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined
    })
  })

  it('refuses to delete an open folder through a legacy runtime', async () => {
    const folderWorkspace = makeFolderWorkspace({
      id: 'folder-legacy',
      executionHostId: 'runtime:env-owner'
    })
    const siblingWorkspace = {
      ...folderWorkspace,
      name: 'Sibling folder',
      executionHostId: 'runtime:env-sibling' as const
    }
    const workspaceKey = folderWorkspaceKey(folderWorkspace.id)
    const targetPtyId = 'remote:env-owner@@pty-owner'
    const siblingPtyId = 'remote:env-sibling@@pty-1'
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
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-owner')
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
      _meta: { runtimeId: 'runtime-owner' }
    }))
    const store = createTestStore()
    store.setState({
      activeWorktreeId: workspaceKey,
      activeWorkspaceExecutionHostId: folderWorkspace.executionHostId,
      projectGroups: [
        { ...projectGroup, executionHostId: folderWorkspace.executionHostId },
        { ...projectGroup, executionHostId: siblingWorkspace.executionHostId }
      ],
      folderWorkspaces: [folderWorkspace, siblingWorkspace],
      tabsByWorktree: { [workspaceKey]: [targetTab, siblingTab] },
      ptyIdsByTabId: {
        [targetTab.id]: [targetPtyId],
        [siblingTab.id]: [siblingPtyId]
      }
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(store.getState().deleteFolderWorkspace(folderWorkspace.id)).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'Folder workspace deletion requires backend terminal teardown support.'
    )
    expect(store.getState().folderWorkspaces).toEqual([folderWorkspace, siblingWorkspace])
    expect(store.getState().tabsByWorktree[workspaceKey]).toEqual([targetTab, siblingTab])
    expect(store.getState().ptyIdsByTabId[targetTab.id]).toEqual([targetPtyId])
    expect(store.getState().ptyIdsByTabId[siblingTab.id]).toEqual([siblingPtyId])
    warn.mockRestore()
  })
})
