// @vitest-environment happy-dom

import type * as EditorAutosave from './autosave/editor-autosave'
import type * as RuntimeFileMetadataClient from '@/runtime/files/metadata/runtime-file-metadata-client'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useEditorHeaderFileRename } from './editor-header-file-rename'
import './useUntitledFileRename'
import '@/store'
import '@/store/slices/worktrees/worktree.test-fixture'
import '@/store/repos/repo.test-fixture'

const renameFileOnDiskMock = vi.hoisted(() => vi.fn())
afterEach(() => vi.unstubAllGlobals())
const renameIO = vi.hoisted(() => ({
  exists: vi.fn(),
  quiesce: vi.fn(),
  save: vi.fn(),
  move: vi.fn()
}))
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', async (original) => ({
  ...(await original<typeof RuntimeFileMetadataClient>()),
  runtimePathExists: renameIO.exists
}))
vi.mock('./autosave/editor-autosave', async (original) => ({
  ...(await original<typeof EditorAutosave>()),
  requestEditorSaveQuiesce: renameIO.quiesce,
  requestEditorFileSave: renameIO.save
}))
vi.mock('@/lib/editor/file-operations/execute-open-editor-path-move', () => ({
  executeOpenEditorPathMove: renameIO.move
}))

vi.mock('@/store/workspaces/selection/use-selected-worktree', () => ({
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))

vi.mock('@/lib/editor/file-operations/rename-file', () => ({
  renameFileOnDisk: renameFileOnDiskMock
}))

function baseFile(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: '/repo/notes.md',
    filePath: '/repo/notes.md',
    relativePath: 'notes.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: false,
    mode: 'edit',
    ...overrides
  }
}

function renameInputStub(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.value = value
  return input
}

describe('useEditorHeaderFileRename', () => {
  beforeEach(() => {
    renameFileOnDiskMock.mockReset()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  // Focused input removal emits focusout after file switches; stale blur commits must not rename the replacement file.
  it('ignores a blur-commit that arrives after the active file changed', () => {
    const { result, rerender } = renderHook((file: OpenFile) => useEditorHeaderFileRename(file), {
      initialProps: baseFile()
    })

    act(() => {
      result.current.openRenameInput()
    })
    act(() => {
      result.current.renameInputRef(renameInputStub('renamed.md'))
    })

    rerender(
      baseFile({ id: '/repo/other.md', filePath: '/repo/other.md', relativePath: 'other.md' })
    )

    expect(result.current.isRenaming).toBe(false)

    act(() => {
      result.current.commitRename()
    })

    expect(renameFileOnDiskMock).not.toHaveBeenCalled()
  })
})
