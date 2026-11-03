import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspacePathStatus } from '../../../../shared/folder-workspace-path-status'

import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import './folder-path-status'
import '../../../../shared/project-groups'
import { makeFolderWorkspace } from '@/components/worktree-jump/worktree-jump-palette-test-fixtures'
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
})
