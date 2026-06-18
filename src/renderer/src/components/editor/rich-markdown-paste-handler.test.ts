import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'
import { handleRichMarkdownLargeTextPaste } from './rich-markdown-large-text-paste'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'

vi.mock('./rich-markdown-paste-image', () => ({
  handleRichMarkdownImagePaste: vi.fn()
}))

vi.mock('./rich-markdown-large-text-paste', () => ({
  handleRichMarkdownLargeTextPaste: vi.fn()
}))

describe('rich markdown paste handler', () => {
  beforeEach(() => {
    vi.mocked(handleRichMarkdownImagePaste).mockReset()
    vi.mocked(handleRichMarkdownLargeTextPaste).mockReset()
  })

  it('keeps image paste ownership ahead of large text fallback', () => {
    vi.mocked(handleRichMarkdownImagePaste).mockReturnValue(true)
    const editor = {} as never
    const event = {} as ClipboardEvent

    expect(
      handleRichMarkdownPaste({
        editor,
        event,
        filePath: '/repo/note.md',
        worktreeId: 'wt-1'
      })
    ).toBe(true)

    expect(handleRichMarkdownImagePaste).toHaveBeenCalledWith({
      editor,
      event,
      filePath: '/repo/note.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: undefined
    })
    expect(handleRichMarkdownLargeTextPaste).not.toHaveBeenCalled()
  })

  it('falls through to large text handling when image paste declines ownership', () => {
    vi.mocked(handleRichMarkdownImagePaste).mockReturnValue(false)
    vi.mocked(handleRichMarkdownLargeTextPaste).mockReturnValue(true)
    const editor = {} as never
    const event = {} as ClipboardEvent

    expect(
      handleRichMarkdownPaste({
        editor,
        event,
        filePath: '/repo/note.md',
        worktreeId: 'wt-1',
        runtimeEnvironmentId: 'env-1'
      })
    ).toBe(true)

    expect(handleRichMarkdownLargeTextPaste).toHaveBeenCalledWith(editor, event)
  })
})
