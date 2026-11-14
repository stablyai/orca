// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { deleteFolderWorkspaceUnlessUnsaved } from './folder-workspace-delete'
import { MIXED_GROUP } from '../../../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import type { AppState } from '@/store/types'

function fixture() {
  const store = createUIStore()
  const folder = makeFolderWorkspace({ projectGroupId: MIXED_GROUP.id, executionHostId: 'local' })
  store.setState({
    folderWorkspaces: [folder],
    projectGroups: [MIXED_GROUP],
    repos: [],
    openFiles: [],
    editorDrafts: {},
    editorBufferIdOf: {},
    editorBufferViews: {},
    activeWorktreeId: null
  })
  return { store, folder }
}

it('coalesces pending folder removals and releases them after every completion', async () => {
  const { store, folder } = fixture()
  const remove = vi.fn<AppState['deleteFolderWorkspace']>()
  store.setState({ deleteFolderWorkspace: remove })
  for (let cycle = 0; cycle < 20; cycle++) {
    const deferred = Promise.withResolvers<boolean>()
    remove.mockReturnValueOnce(deferred.promise)
    const first = deleteFolderWorkspaceUnlessUnsaved(store.getState, folder.id, 'local')
    for (let press = 0; press < 4; press++) {
      expect(deleteFolderWorkspaceUnlessUnsaved(store.getState, folder.id, 'local')).toBe(first)
    }
    expect(remove).toHaveBeenCalledTimes(cycle + 1)
    deferred.resolve(true)
    await expect(first).resolves.toBe(true)
  }
})

it('keeps host twins independent and releases a rejected removal for retry', async () => {
  const { store, folder } = fixture()
  store.setState({ folderWorkspaces: [folder, { ...folder, executionHostId: 'runtime:other' }] })
  const local = Promise.withResolvers<boolean>()
  const remote = Promise.withResolvers<boolean>()
  const remove = vi
    .fn()
    .mockReturnValueOnce(local.promise)
    .mockReturnValueOnce(remote.promise)
    .mockResolvedValue(false)
  store.setState({ deleteFolderWorkspace: remove })
  const localDeletion = deleteFolderWorkspaceUnlessUnsaved(store.getState, folder.id, 'local')
  const remoteDeletion = deleteFolderWorkspaceUnlessUnsaved(
    store.getState,
    folder.id,
    'runtime:other'
  )
  expect(remove).toHaveBeenCalledTimes(2)
  const rejection = expect(localDeletion).rejects.toThrow('offline')
  local.reject(new Error('offline'))
  await rejection
  await expect(
    deleteFolderWorkspaceUnlessUnsaved(store.getState, folder.id, 'local')
  ).resolves.toBe(false)
  expect(remove).toHaveBeenCalledTimes(3)
  remote.resolve(true)
  await expect(remoteDeletion).resolves.toBe(true)
})
