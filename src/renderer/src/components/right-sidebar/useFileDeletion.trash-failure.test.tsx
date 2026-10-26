// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TRASH_DELETE_FAILED_MESSAGE } from '../../../../shared/trash-delete-failure'
import { useFileDeletion } from './useFileDeletion'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  deleteRuntimePath: vi.fn(),
  commitFileExplorerOp: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => mocks.confirm
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Del' }))
vi.mock('./file-explorer-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  captureFileExplorerOperationGuard: () => ({
    assertCurrent: () => ({ target: { kind: 'local' }, expectedExecutionHostId: 'local' })
  })
}))
vi.mock('./file-explorer-deletion-editors', () => ({
  getFileExplorerDeletionEditors: () => [{ id: 'tab-1', isDirty: false }]
}))
vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorFileSave: vi.fn(async () => undefined),
  requestEditorSaveQuiesce: vi.fn(async () => undefined)
}))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  deleteRuntimePath: mocks.deleteRuntimePath,
  writeRuntimeFile: vi.fn()
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: vi.fn(async () => ({ content: 'hello', isBinary: false }))
}))
vi.mock('./fileExplorerUndoRedo', () => ({ commitFileExplorerOp: mocks.commitFileExplorerOp }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ getKnownWorktreeById: () => null }), setState: vi.fn() }
}))

const trashFailure = new Error(
  `Error invoking remote method 'fs:deletePath': Error: ${TRASH_DELETE_FAILED_MESSAGE}: Failed to perform delete operation`
)

function renderDeletion() {
  const closeFile = vi.fn()
  const refreshDir = vi.fn(async () => undefined)
  const { result } = renderHook(() =>
    useFileDeletion({
      activeWorktreeId: 'wt-1',
      openFiles: [],
      closeFile,
      refreshDir,
      setSelectedPaths: vi.fn(),
      isWindows: true
    })
  )
  return { result, closeFile, refreshDir }
}

async function requestDelete(result: ReturnType<typeof renderDeletion>['result']) {
  await act(async () => {
    result.current.requestDelete({
      name: 'file.ts',
      path: 'C:\\repo\\file.ts',
      relativePath: 'file.ts',
      isDirectory: false,
      depth: 0,
      operationOwner: { kind: 'local' }
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

it('permanently deletes after the user confirms a Trash failure', async () => {
  mocks.deleteRuntimePath.mockRejectedValueOnce(trashFailure).mockResolvedValueOnce(undefined)
  mocks.confirm.mockResolvedValue(true)
  const { result, closeFile } = renderDeletion()

  await requestDelete(result)

  await vi.waitFor(() => expect(closeFile).toHaveBeenCalledWith('tab-1'))
  expect(mocks.deleteRuntimePath).toHaveBeenLastCalledWith(
    expect.anything(),
    'C:\\repo\\file.ts',
    false,
    { permanent: true }
  )
  expect(mocks.toastError).not.toHaveBeenCalled()

  // Undo restores from the pre-delete snapshot; redo must not retry the failing Trash path.
  const op = mocks.commitFileExplorerOp.mock.calls[0][0]
  await op.redo()
  expect(mocks.deleteRuntimePath).toHaveBeenLastCalledWith(
    expect.anything(),
    'C:\\repo\\file.ts',
    false,
    { permanent: true }
  )
})

it('keeps the file and stays quiet when the user cancels', async () => {
  mocks.deleteRuntimePath.mockRejectedValueOnce(trashFailure)
  mocks.confirm.mockResolvedValue(false)
  const { result, closeFile } = renderDeletion()

  await requestDelete(result)

  await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
  expect(mocks.deleteRuntimePath).toHaveBeenCalledTimes(1)
  expect(closeFile).not.toHaveBeenCalled()
  expect(mocks.commitFileExplorerOp).not.toHaveBeenCalled()
  expect(mocks.toastError).not.toHaveBeenCalled()
})

it('reports an error when the permanent delete also fails', async () => {
  mocks.deleteRuntimePath
    .mockRejectedValueOnce(trashFailure)
    .mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'))
  mocks.confirm.mockResolvedValue(true)
  const { result, closeFile, refreshDir } = renderDeletion()

  await requestDelete(result)

  await vi.waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith('EBUSY: resource busy or locked')
  )
  expect(closeFile).not.toHaveBeenCalled()
  expect(refreshDir).not.toHaveBeenCalled()
  expect(mocks.commitFileExplorerOp).not.toHaveBeenCalled()
})

it('does not offer permanent deletion for errors other than a Trash failure', async () => {
  mocks.deleteRuntimePath.mockRejectedValueOnce(new Error('Access denied: path outside workspace'))
  const { result, closeFile } = renderDeletion()

  await requestDelete(result)

  await vi.waitFor(() =>
    expect(mocks.toastError).toHaveBeenCalledWith('Access denied: path outside workspace')
  )
  expect(mocks.confirm).not.toHaveBeenCalled()
  expect(mocks.deleteRuntimePath).toHaveBeenCalledTimes(1)
  expect(closeFile).not.toHaveBeenCalled()
})
