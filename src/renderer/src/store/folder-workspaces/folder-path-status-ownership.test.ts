import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { makeFolderWorkspace } from '@/components/worktree-jump-palette-test-fixtures'
import { createTestStore } from '../slices/store-test-helpers'

const mocks = vi.hoisted(() => ({ getPathStatus: vi.fn(), callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const original = await importOriginal<typeof RuntimeRpcClient>()
  return { ...original, callRuntimeRpc: mocks.callRuntimeRpc }
})

const owners = [
  { executionHostId: 'local', runtimeEnvironmentId: null, path: '/local/folder' },
  { executionHostId: 'runtime:builder', runtimeEnvironmentId: 'builder', path: '/remote/folder' }
] as const

const folders = owners.map((owner) =>
  makeFolderWorkspace({ executionHostId: owner.executionHostId, folderPath: owner.path })
)
const request = { scope: 'folder-workspace', folderWorkspaceId: folders[0].id } as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: { folderWorkspaces: { getPathStatus: mocks.getPathStatus } }
  })
})

describe('folder path status ownership', () => {
  it.each(owners)(
    'keeps the $executionHostId cache valid after catalog reordering',
    async (owner) => {
      const store = createTestStore()
      store.setState({ folderWorkspaces: folders })
      for (const candidate of owners) {
        const status: FolderWorkspacePathStatus = {
          path: candidate.path,
          exists: candidate.executionHostId === 'local',
          ...(candidate.executionHostId === 'local' ? {} : { reason: 'missing' as const })
        }
        mocks.getPathStatus.mockResolvedValue(status)
        mocks.callRuntimeRpc.mockResolvedValue({ status })
        await store.getState().fetchFolderWorkspacePathStatus(request, candidate)
      }

      store.setState({ folderWorkspaces: folders.toReversed() })

      expect(store.getState().getFreshFolderWorkspacePathStatus(request, owner)).toMatchObject({
        path: owner.path,
        exists: owner.executionHostId === 'local'
      })
      expect(mocks.getPathStatus).toHaveBeenCalledOnce()
      expect(mocks.callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
        { kind: 'environment', environmentId: 'builder' },
        'folderWorkspace.getPathStatus',
        request,
        { timeoutMs: 15_000 }
      )
    }
  )

  it.each(owners)(
    'rejects a delayed $executionHostId error after its folder path changes',
    async (owner) => {
      const store = createTestStore()
      // The selected folder is second, so a bare-id lookup would fingerprint the other host.
      store.setState({
        folderWorkspaces: [
          ...folders.filter((folder) => folder.executionHostId !== owner.executionHostId),
          ...folders.filter((folder) => folder.executionHostId === owner.executionHostId)
        ]
      })
      const pending = Promise.withResolvers<FolderWorkspacePathStatus>()
      mocks.getPathStatus.mockReturnValue(pending.promise)
      mocks.callRuntimeRpc.mockImplementation(async () => ({ status: await pending.promise }))
      const oldProbe = store.getState().fetchFolderWorkspacePathStatus(request, owner)
      const repairedPath = `${owner.path}-repaired`
      store.setState((state) => ({
        folderWorkspaces: state.folderWorkspaces.map((folder) =>
          folder.executionHostId === owner.executionHostId
            ? { ...folder, folderPath: repairedPath }
            : folder
        ),
        folderWorkspacePathStatuses: {}
      }))
      const repairedStatus = { path: repairedPath, exists: true }
      mocks.getPathStatus.mockResolvedValue(repairedStatus)
      mocks.callRuntimeRpc.mockResolvedValue({ status: repairedStatus })
      await store.getState().fetchFolderWorkspacePathStatus(request, { ...owner, force: true })

      pending.resolve({ path: owner.path, exists: false, reason: 'missing' })
      await oldProbe

      expect(store.getState().getFreshFolderWorkspacePathStatus(request, owner)).toEqual(
        repairedStatus
      )
    }
  )

  it('does not borrow a same-id folder when the requested host has no owner', async () => {
    const store = createTestStore()
    store.setState({ folderWorkspaces: folders })
    mocks.callRuntimeRpc.mockResolvedValue({
      status: { path: '/unrelated/folder', exists: false, reason: 'missing' }
    })
    const owner = { runtimeEnvironmentId: 'missing-host' }

    await store.getState().fetchFolderWorkspacePathStatus(request, owner)

    expect(store.getState().getFreshFolderWorkspacePathStatus(request, owner)).toBeNull()
    expect(store.getState().folderWorkspacePathStatuses).toEqual({})
  })

  it.each(owners)(
    'checks the $executionHostId project group when its id exists on another host',
    async (owner) => {
      const groups: ProjectGroup[] = owners.map((candidate) => ({
        id: 'group-1',
        name: 'Research',
        parentPath: candidate.path,
        parentGroupId: null,
        executionHostId: candidate.executionHostId,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }))
      const store = createTestStore()
      store.setState({ projectGroups: groups })
      const groupRequest = { scope: 'project-group', projectGroupId: 'group-1' } as const
      const status = { path: owner.path, exists: true }
      mocks.getPathStatus.mockResolvedValue(status)
      mocks.callRuntimeRpc.mockResolvedValue({ status })
      await store.getState().fetchFolderWorkspacePathStatus(groupRequest, owner)

      store.setState({ projectGroups: groups.toReversed() })

      expect(store.getState().getFreshFolderWorkspacePathStatus(groupRequest, owner)).toEqual(
        status
      )
    }
  )
})
