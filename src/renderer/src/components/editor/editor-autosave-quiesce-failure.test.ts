// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { requestEditorFileSave, requestEditorSaveQuiesce } from './editor-autosave'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { registerPendingEditorFlush } from './editor-pending-flush'
import { createEditorSaveQueue } from './editor-save-queue'
import { useUntitledFileRename } from './useUntitledFileRename'
import { useFileDeletion } from '../right-sidebar/useFileDeletion'
import type { TreeNode } from '../right-sidebar/file-explorer-types'

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  toast: vi.fn(),
  flush: vi.fn()
}))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileClient>()
  return {
    ...actual,
    writeRuntimeFile: mocks.write,
    renameRuntimePath: mocks.rename,
    deleteRuntimePath: mocks.delete,
    runtimePathExists: vi.fn().mockResolvedValue(false)
  }
})
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Delete' }))
vi.mock('../right-sidebar/fileExplorerUndoRedo', () => ({ commitFileExplorerOp: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))

const fileId = '/repo/note.md'
const failure = new Error('serializer failure')

beforeEach(() => {
  vi.useFakeTimers()
  mocks.write.mockReset().mockResolvedValue(undefined)
  mocks.rename.mockReset().mockResolvedValue(undefined)
  mocks.delete.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
  mocks.flush.mockReset().mockImplementation(() => {
    throw failure
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: createGlobalSettingsFixture({ editorAutoSave: true }),
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
  useAppStore.getState().openFile(
    {
      filePath: fileId,
      relativePath: 'note.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  useAppStore.getState().setEditorDraft(fileId, 'previous serialized draft')
  useAppStore.getState().markFileDirty(fileId, true)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function failPendingFlush(): () => void {
  return registerPendingEditorFlush(fileId, mocks.flush)
}

it('rejects a claimed quiesce request when the pending rich-editor flush fails', async () => {
  const unregister = failPendingFlush()
  const detach = attachEditorAutosaveController(useAppStore)
  try {
    await expect(requestEditorSaveQuiesce({ fileId })).rejects.toThrow('serializer failure')
    expect(useAppStore.getState().editorDrafts[fileId]).toBe('previous serialized draft')
    expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    unregister()
    await expect(requestEditorSaveQuiesce({ fileId })).resolves.toBeUndefined()
  } finally {
    detach()
    unregister()
  }
}, 1000)

it('cancels a pending autosave even when flushing the pending editor change fails', async () => {
  const queue = createEditorSaveQueue(useAppStore)
  queue.syncAutoSave()
  const unregister = failPendingFlush()
  try {
    await expect(queue.quiesceFileSave(fileId)).rejects.toThrow('serializer failure')
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.flush).toHaveBeenCalledTimes(1)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(useAppStore.getState().editorDrafts[fileId]).toBe('previous serialized draft')
  } finally {
    queue.dispose()
    unregister()
  }
})

it('waits for every matching file to stop saving before rejecting a batch quiesce', async () => {
  const secondId = '/repo/second.md'
  useAppStore.getState().openFile(
    {
      filePath: secondId,
      relativePath: 'second.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'markdown',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  let releaseWrite!: () => void
  mocks.write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
  )
  const detach = attachEditorAutosaveController(useAppStore)
  const pending = requestEditorFileSave({ fileId: secondId, fallbackContent: 'second note' })
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  const unregister = failPendingFlush()
  let settled = false
  const quiesce = requestEditorSaveQuiesce({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    relativePath: '',
    indexedOpenFiles: { matches: (files) => files }
  }).catch((error: unknown) => {
    settled = true
    return error
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    releaseWrite()
    await expect(quiesce).resolves.toMatchObject({ message: 'serializer failure' })
  } finally {
    releaseWrite()
    await pending
    detach()
    unregister()
  }
})

it('keeps the Save As dialog and draft when quiescing fails', async () => {
  const hook = renderHook(() =>
    useUntitledFileRename({
      openFiles: useAppStore.getState().openFiles,
      clearUntitled: vi.fn()
    })
  )
  act(() => hook.result.current.requestRenameForFile(fileId))
  const unregister = failPendingFlush()
  const detach = attachEditorAutosaveController(useAppStore)
  try {
    await act(() => hook.result.current.handleRenameConfirm('renamed.md'))
    expect(hook.result.current.renameError).toBe('serializer failure')
    expect(hook.result.current.renameDialogFileId).toBe(fileId)
    expect(useAppStore.getState().editorDrafts[fileId]).toBe('previous serialized draft')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.rename).not.toHaveBeenCalled()
  } finally {
    detach()
    unregister()
  }
})

it('aborts a folder delete on quiesce failure and allows a later retry', async () => {
  const closeFile = vi.fn()
  const hook = renderHook(() =>
    useFileDeletion({
      activeWorktreeId: 'wt-1',
      openFiles: [{ id: fileId, filePath: fileId }],
      closeFile,
      refreshDir: vi.fn().mockResolvedValue(undefined),
      setSelectedPaths: vi.fn(),
      isWindows: false
    })
  )
  const node: TreeNode = {
    name: 'repo',
    path: '/repo',
    relativePath: '',
    isDirectory: true,
    depth: 0,
    operationOwner: { kind: 'local' }
  }
  const unregister = failPendingFlush()
  const detach = attachEditorAutosaveController(useAppStore)
  try {
    await act(async () => hook.result.current.requestDelete(node))
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('serializer failure'))
    expect(mocks.delete).not.toHaveBeenCalled()
    expect(closeFile).not.toHaveBeenCalled()
    expect(useAppStore.getState().editorDrafts[fileId]).toBe('previous serialized draft')
    unregister()
    await act(async () => hook.result.current.requestDelete(node))
    await vi.waitFor(() => expect(mocks.delete).toHaveBeenCalledTimes(1))
    expect(closeFile).toHaveBeenCalledWith(fileId)
  } finally {
    detach()
    unregister()
  }
})

it('waits for a running write before reporting a failed flush', async () => {
  let releaseWrite!: () => void
  mocks.write.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
  )
  const queue = createEditorSaveQueue(useAppStore)
  const file = useAppStore.getState().openFiles[0]!
  const pending = queue.queueSave(file, 'previous serialized draft')
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.write).toHaveBeenCalledTimes(1)
  const unregister = failPendingFlush()
  let settled = false
  const quiesce = queue.quiesceFileSave(fileId).catch((error: unknown) => {
    settled = true
    return error
  })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    releaseWrite()
    await expect(quiesce).resolves.toBe(failure)
  } finally {
    releaseWrite()
    await pending
    queue.dispose()
    unregister()
  }
})
