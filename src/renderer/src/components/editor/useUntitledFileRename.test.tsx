// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as RuntimeFileClient from '@/runtime/runtime-file-client'
import type * as EditorAutosave from './editor-autosave'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { useUntitledFileRename } from './useUntitledFileRename'

const mocks = vi.hoisted(() => ({
  stat: vi.fn(),
  exists: vi.fn(),
  rename: vi.fn(),
  save: vi.fn()
}))
vi.mock('@/runtime/runtime-file-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeFileClient>()
  return {
    ...actual,
    statRuntimePath: mocks.stat,
    runtimePathExists: mocks.exists,
    renameRuntimePath: mocks.rename
  }
})
vi.mock('./editor-autosave', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorAutosave>()
  return {
    ...actual,
    requestEditorSaveQuiesce: vi.fn().mockResolvedValue(undefined),
    requestEditorFileSave: mocks.save
  }
})

const source = '/repo/untitled.md'
const destination = '/notes/scratch.md'

function startRename() {
  const hook = renderHook(() => {
    const openFiles = useAppStore((state) => state.openFiles)
    return useUntitledFileRename({ openFiles, clearUntitled: vi.fn() })
  })
  act(() => hook.result.current.requestRenameForFile(source))
  return hook
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
  useAppStore.getState().openFile(
    {
      filePath: source,
      relativePath: 'untitled.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      language: 'markdown',
      isUntitled: true,
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
  useAppStore.getState().setEditorDraft(source, 'my scratch note')
  mocks.stat.mockReset().mockRejectedValue(new Error('ENOENT'))
  mocks.exists.mockReset().mockResolvedValue(false)
  mocks.rename.mockReset().mockResolvedValue(undefined)
  mocks.save.mockReset().mockResolvedValue(undefined)
})

afterEach(cleanup)

it('saves and retargets the note outside the workspace with lasting file access', async () => {
  const hook = startRename()
  await act(() => hook.result.current.handleRenameConfirm(destination))

  expect(mocks.stat).toHaveBeenCalledWith(expect.anything(), destination, { kind: 'user-file' })
  expect(mocks.save).toHaveBeenCalledWith({ fileId: source, fallbackContent: 'my scratch note' })
  expect(mocks.rename).toHaveBeenCalledWith(expect.anything(), source, destination, {
    kind: 'document-folder',
    documentPath: source
  })
  const state = useAppStore.getState()
  expect(state.openFiles).toHaveLength(1)
  const file = state.openFiles[0]!
  expect(file).toMatchObject({
    filePath: destination,
    relativePath: destination
  })
  expect(file.isUntitled).toBeFalsy()
  expect(state.editorDrafts[file.id]).toBe('my scratch note')
  expect(editorTabFileAccess(state, file)).toEqual({ kind: 'user-file' })
  expect(hook.result.current.renameDialogFileId).toBeNull()
})

it('preserves the untitled note when the destination already exists', async () => {
  mocks.stat.mockResolvedValue({ size: 1, isDirectory: false, mtime: 1 })
  const hook = startRename()
  await act(() => hook.result.current.handleRenameConfirm(destination))

  expect(hook.result.current.renameError).toBe('A file with that name already exists')
  expect(mocks.save).not.toHaveBeenCalled()
  expect(mocks.rename).not.toHaveBeenCalled()
  expect(useAppStore.getState().openFiles[0]?.filePath).toBe(source)
  expect(useAppStore.getState().editorDrafts[source]).toBe('my scratch note')
})

it.each([
  ['stat', 'EACCES: permission denied'],
  ['rename', 'EXDEV: cross-device link not permitted']
])('preserves the note and shows the %s failure', async (operation, message) => {
  mocks[operation === 'stat' ? 'stat' : 'rename'].mockRejectedValue(new Error(message))
  const hook = startRename()
  await act(() => hook.result.current.handleRenameConfirm(destination))

  expect(hook.result.current.renameError).toBe(message)
  expect(hook.result.current.renameDialogFileId).toBe(source)
  expect(useAppStore.getState().openFiles[0]?.filePath).toBe(source)
  expect(useAppStore.getState().editorDrafts[source]).toBe('my scratch note')
})

it('does not allow an outside destination after its owner changes to a remote runtime', async () => {
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo',
          hostId: 'runtime:remote-1',
          runtimeOwnerEnvironmentId: 'remote-1'
        })
      ]
    }
  })
  const hook = startRename()
  await act(() => hook.result.current.handleRenameConfirm(destination))

  expect(hook.result.current.renameError).toBeTruthy()
  expect(mocks.stat).not.toHaveBeenCalled()
  expect(mocks.rename).not.toHaveBeenCalled()
  expect(useAppStore.getState().openFiles[0]?.filePath).toBe(source)
})
