// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor } from 'monaco-editor'
import type { GitBlameResult } from '../../../../shared/git-blame'
import { useGitBlame } from './useGitBlame'

const mocks = vi.hoisted(() => ({
  getRuntimeGitBlame: vi.fn(),
  getConnectionIdForFile: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBlame: mocks.getRuntimeGitBlame
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { enableInlineGitBlame: true },
      worktreesByRepo: {
        repo: [{ id: 'wt-1', path: '/repo' }]
      }
    })
  }
}))

vi.mock('@/store/slices/worktree-helpers', () => ({
  findWorktreeById: (_map: unknown, id: string) =>
    id === 'wt-1' ? ({ path: '/repo' } as never) : undefined
}))

vi.mock('monaco-editor', () => ({
  editor: {
    TrackedRangeStickiness: {
      NeverGrowsWhenTypingAtEdges: 1
    }
  }
}))

function createEditor(): {
  editor: editor.IStandaloneCodeEditor
  setDecoration: ReturnType<typeof vi.fn>
  clearDecoration: ReturnType<typeof vi.fn>
  triggerContentChange: () => void
} {
  let versionId = 1
  const clearDecoration = vi.fn()
  const decorations = {
    set: vi.fn(),
    clear: clearDecoration
  }
  let contentListener: (() => void) | null = null
  const editorInstance = {
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getModel: () => ({
      getVersionId: () => versionId,
      getLineMaxColumn: () => 10
    }),
    createDecorationsCollection: () => decorations,
    onDidChangeCursorPosition: () => ({ dispose: vi.fn() }),
    onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
    onDidChangeModelContent: (listener: () => void) => {
      contentListener = listener
      return {
        dispose: () => {
          contentListener = null
        }
      }
    },
    onDidDispose: () => ({ dispose: vi.fn() })
  } as unknown as editor.IStandaloneCodeEditor

  return {
    editor: editorInstance,
    setDecoration: decorations.set,
    clearDecoration,
    triggerContentChange: () => {
      versionId += 1
      contentListener?.()
    }
  }
}

function blameResult(): GitBlameResult {
  return [
    {
      sha: 'a'.repeat(40),
      shortSha: 'a'.repeat(7),
      author: 'Ada',
      authorTime: 1,
      summary: 'init'
    }
  ]
}

describe('useGitBlame', () => {
  beforeEach(() => {
    mocks.getRuntimeGitBlame.mockReset()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getRuntimeGitBlame.mockResolvedValue(blameResult())
  })

  it('evicts a rejected cache entry after unmount so remount refetches', async () => {
    let reject!: (error: Error) => void
    const pending = new Promise<GitBlameResult>((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
    mocks.getRuntimeGitBlame.mockReturnValueOnce(pending)
    const first = createEditor()

    const firstView = renderHook(() =>
      useGitBlame({
        editor: first.editor,
        worktreeId: 'wt-1',
        filePath: '/repo/b.ts',
        enabled: true
      })
    )
    firstView.unmount()
    await act(async () => {
      reject(new Error('request failed'))
    })

    const second = createEditor()
    renderHook(() =>
      useGitBlame({
        editor: second.editor,
        worktreeId: 'wt-1',
        filePath: '/repo/b.ts',
        enabled: true
      })
    )
    await act(async () => {})

    expect(mocks.getRuntimeGitBlame).toHaveBeenCalledTimes(2)
  })

  it('clears decorations and evicts cache when the model changes', async () => {
    mocks.getRuntimeGitBlame.mockResolvedValue(blameResult())
    const first = createEditor()

    const firstView = renderHook(() =>
      useGitBlame({
        editor: first.editor,
        worktreeId: 'wt-1',
        filePath: '/repo/a.ts',
        enabled: true
      })
    )
    await act(async () => {})
    expect(first.setDecoration).toHaveBeenCalled()

    await act(async () => {
      first.triggerContentChange()
    })
    expect(first.clearDecoration).toHaveBeenCalled()
    firstView.unmount()

    const second = createEditor()
    renderHook(() =>
      useGitBlame({
        editor: second.editor,
        worktreeId: 'wt-1',
        filePath: '/repo/a.ts',
        enabled: true
      })
    )
    await act(async () => {})

    await waitFor(() => expect(mocks.getRuntimeGitBlame).toHaveBeenCalledTimes(2))
  })
})
