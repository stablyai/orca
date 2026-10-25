// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  FILE_ALREADY_EXISTS_DIFFERENTLY_MESSAGE,
  missingOrIdenticalPrecondition
} from '../../../../shared/file-write-disk-precondition'
import { getFileExplorerOperationOwner } from './file-explorer-operation-owner'
import {
  clearFileExplorerUndoHistory,
  fileExplorerHasRedo,
  fileExplorerHasUndo,
  undoFileExplorer
} from './fileExplorerUndoRedo'
import { useFileDeletion } from './useFileDeletion'

const mocks = vi.hoisted(() => ({
  remove: vi.fn().mockResolvedValue(undefined),
  write: vi.fn()
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn().mockResolvedValue(true)
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Delete' }))
vi.mock('@/components/editor/editor-autosave', () => ({
  requestEditorFileSave: vi.fn().mockResolvedValue(undefined),
  requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  deleteRuntimePath: mocks.remove,
  writeRuntimeFile: mocks.write
}))
vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFileContent: vi.fn().mockResolvedValue({ content: 'deleted body', isBinary: false })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const initialState = useAppStore.getInitialState()
const root = '/project'
const worktreeId = `repo::${root}`

beforeEach(() => {
  vi.clearAllMocks()
  clearFileExplorerUndoHistory()
  useAppStore.setState({
    repos: [],
    activeWorktreeId: worktreeId,
    worktreesByRepo: {
      repo: [makeWorktree({ id: worktreeId, repoId: 'repo', path: root, hostId: 'local' })]
    }
  })
})
afterEach(() => useAppStore.setState(initialState, true))

it('undo of a delete never replaces a file recreated at the same path', async () => {
  mocks.write.mockResolvedValue({ ok: false, diskConflict: 'changed' })
  const { result } = renderHook(() =>
    useFileDeletion({
      activeWorktreeId: worktreeId,
      openFiles: [],
      closeFile: vi.fn(),
      refreshDir: vi.fn().mockResolvedValue(undefined),
      setSelectedPaths: vi.fn(),
      isWindows: false
    })
  )
  await act(async () =>
    result.current.requestDelete({
      name: 'notes.txt',
      path: `${root}/notes.txt`,
      relativePath: 'notes.txt',
      isDirectory: false,
      depth: 0,
      operationOwner: getFileExplorerOperationOwner(worktreeId)
    })
  )
  await vi.waitFor(() => expect(fileExplorerHasUndo()).toBe(true))

  await expect(undoFileExplorer()).rejects.toThrow(FILE_ALREADY_EXISTS_DIFFERENTLY_MESSAGE)
  expect(mocks.write.mock.calls[0]?.[4]).toEqual(missingOrIdenticalPrecondition('deleted body'))
  // The refused step stays on the stack, so the user can undo again once the path is clear.
  expect(fileExplorerHasUndo()).toBe(true)
  expect(fileExplorerHasRedo()).toBe(false)

  mocks.write.mockResolvedValue({ ok: true })
  await expect(undoFileExplorer()).resolves.toBe(true)
  expect(fileExplorerHasUndo()).toBe(false)
  expect(fileExplorerHasRedo()).toBe(true)
})

it('drops an undo whose failure may have applied it, as before', async () => {
  // A timed-out reply may follow a write that landed; replaying could replace a newer file.
  mocks.write.mockRejectedValue(new Error('Timed out waiting for the remote Orca runtime'))
  const { result } = renderHook(() =>
    useFileDeletion({
      activeWorktreeId: worktreeId,
      openFiles: [],
      closeFile: vi.fn(),
      refreshDir: vi.fn().mockResolvedValue(undefined),
      setSelectedPaths: vi.fn(),
      isWindows: false
    })
  )
  await act(async () =>
    result.current.requestDelete({
      name: 'notes.txt',
      path: `${root}/notes.txt`,
      relativePath: 'notes.txt',
      isDirectory: false,
      depth: 0,
      operationOwner: getFileExplorerOperationOwner(worktreeId)
    })
  )
  await vi.waitFor(() => expect(fileExplorerHasUndo()).toBe(true))

  await expect(undoFileExplorer()).rejects.toThrow('Timed out')
  expect(fileExplorerHasUndo()).toBe(false)
})
