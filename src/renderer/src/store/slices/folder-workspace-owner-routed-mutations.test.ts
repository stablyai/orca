import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

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
      updates: { comment: 'Ready' }
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
        updates: { comment: 'Ready' }
      },
      timeoutMs: 15_000
    })
    expect(folderWorkspacesUpdate).not.toHaveBeenCalled()
    expect(store.getState().folderWorkspaces[0]?.comment).toBe('Ready')
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
      folderWorkspaceId: folderWorkspace.id
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
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
      params: { folderWorkspaceId: folderWorkspace.id },
      timeoutMs: 15_000
    })
    expect(folderWorkspacesDelete).not.toHaveBeenCalled()
  })
})
