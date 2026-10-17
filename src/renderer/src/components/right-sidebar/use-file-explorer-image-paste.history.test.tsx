// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useFileExplorerImagePaste } from './use-file-explorer-image-paste'
import {
  clearFileExplorerUndoHistory,
  commitFileExplorerOp,
  fileExplorerHasRedo,
  fileExplorerHasUndo,
  redoFileExplorer,
  undoFileExplorer
} from './fileExplorerUndoRedo'

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  release: vi.fn(),
  importPaths: vi.fn(),
  deletePath: vi.fn(),
  capture: vi.fn(),
  assertCurrent: vi.fn(),
  error: vi.fn()
}))
vi.mock('@/runtime/runtime-file-import-client', () => ({
  importExternalPathsToRuntime: mocks.importPaths
}))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  deleteRuntimePath: mocks.deletePath
}))
vi.mock('./file-explorer-operation-owner', () => ({
  captureFileExplorerOperationGuard: mocks.capture
}))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))

const snapshot = { handle: 'snapshot', path: '/staging/pasted-image.png' }
const route = { target: { kind: 'local' }, expectedExecutionHostId: 'local' } as const
const refreshDir = vi.fn()
const setSelectedPath = vi.fn()
const revealPath = vi.fn()
const initial = {
  worktreeId: 'folder:notes',
  worktreePath: '/notes',
  displayRootPath: '/notes/images',
  selectedNode: null,
  operationOwner: { kind: 'local' as const },
  refreshDir,
  setSelectedPath,
  revealPath
}
const imported = (destPath = '/notes/images/pasted-image.png') => ({
  results: [
    { status: 'imported', destPath, sourcePath: snapshot.path, kind: 'file', renamed: false }
  ]
})
function setup() {
  return renderHook((params) => useFileExplorerImagePaste(params), { initialProps: initial })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.stage.mockResolvedValue(snapshot)
  mocks.release.mockResolvedValue(true)
  mocks.importPaths.mockResolvedValue(imported())
  mocks.deletePath.mockResolvedValue(undefined)
  mocks.assertCurrent.mockReturnValue(route)
  mocks.capture.mockReturnValue({ route, assertCurrent: mocks.assertCurrent })
  refreshDir.mockResolvedValue(undefined)
  vi.stubGlobal('api', {
    ui: { stageClipboardImageForImport: mocks.stage, releaseClipboardImageImport: mocks.release }
  })
})
afterEach(async () => {
  clearFileExplorerUndoHistory()
  await Promise.resolve()
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('undoes the actual imported path and redoes the original snapshot without rereading clipboard', async () => {
  mocks.importPaths.mockResolvedValueOnce(imported('/notes/images/pasted-image copy.png'))
  const { result } = setup()
  await act(() => result.current.pasteImage())
  expect(fileExplorerHasUndo()).toBe(true)
  expect(mocks.release).not.toHaveBeenCalled()
  await act(() => undoFileExplorer())
  expect(mocks.deletePath).toHaveBeenCalledExactlyOnceWith(
    { ...route, worktreeId: 'folder:notes', worktreePath: '/notes' },
    '/notes/images/pasted-image copy.png',
    false
  )
  expect(setSelectedPath).toHaveBeenLastCalledWith('/notes/images')
  mocks.stage.mockRejectedValue(new Error('Clipboard has changed'))
  mocks.importPaths.mockResolvedValueOnce(imported('/notes/images/pasted-image copy 2.png'))
  await act(() => redoFileExplorer())
  expect(mocks.stage).toHaveBeenCalledOnce()
  expect(mocks.importPaths).toHaveBeenLastCalledWith(
    expect.objectContaining(route),
    [snapshot.path],
    '/notes/images',
    { requireExistingDestination: true, assertCurrent: mocks.assertCurrent }
  )
  expect(revealPath).toHaveBeenLastCalledWith('/notes/images/pasted-image copy 2.png')
  await act(() => undoFileExplorer())
  expect(mocks.deletePath.mock.lastCall?.[1]).toBe('/notes/images/pasted-image copy 2.png')
  commitFileExplorerOp({ undo: async () => {}, redo: async () => {} })
  await Promise.resolve()
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(snapshot.handle)
})

it('preserves the image snapshot when undo or redo fails', async () => {
  const { result } = setup()
  await act(() => result.current.pasteImage())
  mocks.deletePath.mockRejectedValueOnce(new Error('Permission denied'))
  await expect(undoFileExplorer()).rejects.toThrow('Permission denied')
  expect(fileExplorerHasUndo()).toBe(true)
  await act(() => undoFileExplorer())
  mocks.importPaths.mockResolvedValueOnce({
    results: [{ status: 'failed', sourcePath: snapshot.path, reason: 'Folder missing' }]
  })
  await expect(redoFileExplorer()).rejects.toThrow('Folder missing')
  expect(fileExplorerHasRedo()).toBe(true)
  expect(mocks.release).not.toHaveBeenCalled()
  await act(() => redoFileExplorer())
  expect(fileExplorerHasUndo()).toBe(true)
})

it('keeps undo when the post-import directory refresh fails', async () => {
  refreshDir.mockRejectedValueOnce(new Error('Refresh failed'))
  const { result } = setup()
  await act(() => result.current.pasteImage())
  expect(fileExplorerHasUndo()).toBe(true)
  await act(() => undoFileExplorer())
  expect(mocks.deletePath).toHaveBeenCalledOnce()
})

it('tracks a successful redo even when the visible folder changes during its upload', async () => {
  const { result, rerender } = setup()
  await act(() => result.current.pasteImage())
  await act(() => undoFileExplorer())
  let finish = () => {}
  mocks.importPaths.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () => resolve(imported('/notes/images/pasted-image copy.png'))
    })
  )
  revealPath.mockClear()
  let redo: Promise<boolean> | undefined
  act(() => {
    redo = redoFileExplorer()
  })
  rerender({ ...initial, displayRootPath: '/notes/other' })
  await act(async () => {
    finish()
    await redo
  })
  expect(revealPath).not.toHaveBeenCalled()
  await act(() => undoFileExplorer())
  expect(mocks.deletePath.mock.lastCall?.[1]).toBe('/notes/images/pasted-image copy.png')
})

it('does not record an empty clipboard or a failed import', async () => {
  const { result } = setup()
  mocks.stage.mockResolvedValueOnce(null)
  await act(() => result.current.pasteImage())
  expect(fileExplorerHasUndo()).toBe(false)
  mocks.importPaths.mockResolvedValueOnce({ results: [] })
  await act(() => result.current.pasteImage())
  expect(fileExplorerHasUndo()).toBe(false)
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(snapshot.handle)
})
