// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { useEditorHeaderFileRename } from './editor-header-file-rename'

const renameFileOnDiskMock = vi.hoisted(() => vi.fn())

vi.mock('@/store/selectors', () => ({
  useWorktreeById: () => ({ path: '/repo', repoId: 'repo-1' })
}))

vi.mock('@/lib/rename-file', () => ({
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

  // Unmounting the focused input emits a trailing focusout, so commitRename can
  // still run after the active file changed — with the old input as ref target.
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
