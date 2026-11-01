// @vitest-environment happy-dom

import type * as EditorAutosave from './editor-autosave'
import type * as RuntimeFileMetadataClient from '@/runtime/runtime-file-metadata-client'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { useEditorHeaderFileRename } from './editor-header-file-rename'
import { useUntitledFileRename } from './useUntitledFileRename'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'

const renameFileOnDiskMock = vi.hoisted(() => vi.fn())
afterEach(() => vi.unstubAllGlobals())
const renameIO = vi.hoisted(() => ({
  exists: vi.fn(),
  quiesce: vi.fn(),
  save: vi.fn(),
  move: vi.fn()
}))
vi.mock('@/runtime/runtime-file-metadata-client', async (original) => ({
  ...(await original<typeof RuntimeFileMetadataClient>()),
  runtimePathExists: renameIO.exists
}))
vi.mock('./editor-autosave', async (original) => ({
  ...(await original<typeof EditorAutosave>()),
  requestEditorSaveQuiesce: renameIO.quiesce,
  requestEditorFileSave: renameIO.save
}))
vi.mock('@/lib/execute-open-editor-path-move', () => ({ executeOpenEditorPathMove: renameIO.move }))

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

describe('untitled rename acquisition through waits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppStore.setState(useAppStore.getInitialState(), true)
    renameIO.exists.mockResolvedValue(false)
    renameIO.quiesce.mockResolvedValue(undefined)
    renameIO.save.mockResolvedValue(undefined)
    renameIO.move.mockResolvedValue({ ok: true })
  })

  it.each(['destination-stat', 'quiesce', 'save', 'unchanged'])(
    'keeps the selected host when %s settles',
    async (phase) => {
      const source = baseFile({
        id: 'untitled',
        filePath: '/repo/untitled.md',
        relativePath: 'untitled.md',
        isUntitled: true,
        runtimeEnvironmentId: null
      })
      useAppStore.setState({
        repos: [{ ...TEST_REPO, executionHostId: 'ssh:box', path: '/repo' }],
        worktreesByRepo: {
          [TEST_REPO.id]: [
            makeWorktree({
              id: source.worktreeId,
              repoId: TEST_REPO.id,
              path: '/repo',
              hostId: 'ssh:box'
            })
          ]
        },
        sshConnectionStates: new Map([
          [
            'box',
            {
              targetId: 'box',
              status: 'connected' as const,
              error: null,
              reconnectAttempt: 0,
              connectionGeneration: 7
            }
          ]
        ]),
        openFiles: [source],
        editorDrafts: { [source.id]: 'saved draft' }
      })
      let finish!: () => void
      const paused = new Promise<void>((resolve) => {
        finish = resolve
      })
      if (phase === 'destination-stat') {
        renameIO.exists.mockImplementationOnce(async () => {
          await paused
          return false
        })
      }
      if (phase === 'quiesce') {
        renameIO.quiesce.mockReturnValueOnce(paused)
      }
      if (phase === 'save') {
        renameIO.save.mockReturnValueOnce(paused)
      }
      const clearUntitled = vi.fn()
      const { result, unmount } = renderHook(() =>
        useUntitledFileRename({ openFiles: [source], clearUntitled })
      )
      act(() => result.current.requestRenameForFile(source.id))
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.handleRenameConfirm('renamed.md')
      })
      if (phase !== 'unchanged') {
        await vi.waitFor(() =>
          expect(
            phase === 'destination-stat'
              ? renameIO.exists
              : phase === 'quiesce'
                ? renameIO.quiesce
                : renameIO.save
          ).toHaveBeenCalledOnce()
        )
        useAppStore.setState((current) => ({
          repos: current.repos.map((repo) => ({ ...repo, executionHostId: 'ssh:other' as const })),
          worktreesByRepo: {
            [TEST_REPO.id]: [
              makeWorktree({
                id: source.worktreeId,
                repoId: TEST_REPO.id,
                path: '/repo',
                hostId: 'ssh:other'
              })
            ]
          }
        }))
        finish()
      }
      await act(async () => {
        await pending
      })
      if (phase === 'unchanged') {
        expect(renameIO.move).toHaveBeenCalledWith(
          expect.objectContaining({
            context: expect.objectContaining({
              connectionId: 'box',
              expectedExecutionHostId: 'ssh:box',
              expectedSshConnectionGeneration: 7
            }),
            fromPath: source.filePath,
            toPath: '/repo/renamed.md'
          })
        )
        expect(result.current.renameDialogFileId).toBeNull()
      } else {
        expect(renameIO.move).not.toHaveBeenCalled()
        expect(result.current.renameError).toContain('Reopen the file')
        expect(result.current.renameDialogFileId).toBe(source.id)
      }
      expect(clearUntitled).not.toHaveBeenCalled()
      unmount()
    }
  )
})
