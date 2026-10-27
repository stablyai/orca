// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR } from '../../../../../../shared/clipboard-text'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn<(title: string, options: { description?: string }) => void>(),
  writeClipboardText: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector({})
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffCommentsOrEmpty: () => [
    {
      id: 'c1',
      worktreeId: 'wt-1',
      filePath: 'src/app.ts',
      lineNumber: 1,
      body: 'rename this',
      createdAt: 1,
      side: 'modified'
    } satisfies DiffComment
  ]
}))

import { useSourceControlDiffCommentNotes } from './use-diff-comment-notes'

function renderNotes() {
  return renderHook(() =>
    useSourceControlDiffCommentNotes({
      activeWorktreeId: 'wt-1',
      clearDiffComments: async () => true,
      clearDiffCommentsForFile: async () => true
    })
  )
}

describe('diff-comment notes copy failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
  })

  function readErrorToast(): [string, { description?: string }] {
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const firstCall = mocks.toastError.mock.calls[0]
    if (!firstCall) {
      throw new Error('Expected an error toast')
    }
    return firstCall
  }

  it('never shows "Copied" for a clipboard write that rejected', async () => {
    mocks.writeClipboardText.mockRejectedValue(
      new Error(
        "Error invoking remote method 'ui:writeClipboardText': Error: NSPasteboard failed at /Users/someone/Library/Caches/orca"
      )
    )
    const { result } = renderNotes()

    await act(async () => {
      await result.current.handleCopyDiffComments()
    })

    expect(result.current.diffCommentsCopied).toBe(false)
    const [title, options] = readErrorToast()
    expect(title).toBe('Failed to copy notes')
    // An unrecognized native failure must not reach the toast (CWE-209).
    expect(options.description).toBeUndefined()
  })

  it('describes only the recognized size failure', async () => {
    mocks.writeClipboardText.mockRejectedValue(
      new Error(
        `Error invoking remote method 'ui:writeClipboardText': Error: ${CLIPBOARD_TEXT_WRITE_TOO_LARGE_ERROR}`
      )
    )
    const { result } = renderNotes()

    await act(async () => {
      await result.current.handleCopyDiffComments()
    })

    expect(result.current.diffCommentsCopied).toBe(false)
    expect(readErrorToast()[1].description).toBe('The text is too large to copy.')
  })

  it('stays silent when the write resolves', async () => {
    mocks.writeClipboardText.mockResolvedValue(undefined)
    const { result } = renderNotes()

    await act(async () => {
      await result.current.handleCopyDiffComments()
    })

    expect(result.current.diffCommentsCopied).toBe(true)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
