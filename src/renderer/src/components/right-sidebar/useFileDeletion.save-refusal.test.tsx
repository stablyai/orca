// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EDITOR_STALE_SAVE_MESSAGE } from '@/components/editor/editor-save-disk-precondition'
import { useFileDeletion } from './useFileDeletion'

const mocks = vi.hoisted(() => ({
  requestEditorFileSave: vi.fn(),
  deleteRuntimePath: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Del' }))
vi.mock('./file-explorer-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  captureFileExplorerOperationGuard: () => ({
    assertCurrent: () => ({ target: { kind: 'local' }, expectedExecutionHostId: 'local' })
  })
}))
vi.mock('./file-explorer-deletion-editors', () => ({
  getFileExplorerDeletionEditors: () => [{ id: 'tab-1', isDirty: true }]
}))
vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorFileSave: mocks.requestEditorFileSave,
  requestEditorSaveQuiesce: vi.fn(async () => undefined)
}))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  deleteRuntimePath: mocks.deleteRuntimePath,
  writeRuntimeFile: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

afterEach(() => {
  cleanup()
})

it('cancels the delete when saving a dirty tab is refused as stale', async () => {
  mocks.requestEditorFileSave.mockRejectedValue(new Error(EDITOR_STALE_SAVE_MESSAGE))
  const refreshDir = vi.fn()
  const { result } = renderHook(() =>
    useFileDeletion({
      activeWorktreeId: 'wt-1',
      openFiles: [],
      closeFile: vi.fn(),
      refreshDir,
      setSelectedPaths: vi.fn(),
      isWindows: false
    })
  )

  await act(async () => {
    result.current.requestDelete({
      name: 'file.ts',
      path: '/repo/file.ts',
      relativePath: 'file.ts',
      isDirectory: false,
      depth: 0,
      operationOwner: { kind: 'local' }
    })
  })

  await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalled())
  expect(mocks.requestEditorFileSave).toHaveBeenCalledWith({ fileId: 'tab-1' })
  expect(mocks.deleteRuntimePath).not.toHaveBeenCalled()
  expect(refreshDir).not.toHaveBeenCalled()
})
