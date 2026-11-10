// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { toast } from 'sonner'
import { useRichMarkdownProgrammaticSync } from './useRichMarkdownProgrammaticSync'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  type RichMarkdownEditorCodec
} from '../document/rich-markdown-source-transport'
import {
  createRichMarkdownHtmlSuperscriptLinkContext,
  type RichMarkdownHtmlSuperscriptLinkContext
} from '../citations/rich-markdown-html-superscript-link-context'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function buildEditor(
  codec: RichMarkdownEditorCodec,
  htmlSuperscriptLinkContext: RichMarkdownHtmlSuperscriptLinkContext,
  markdown: string,
  element: HTMLElement | null = null
): Editor {
  return new Editor({
    element,
    extensions: createRichMarkdownExtensions({
      codec,
      htmlSuperscriptLinks: true,
      htmlSuperscriptLinkContext
    }),
    content: encodeRawMarkdownHtmlForRichEditor(markdown, codec, { htmlSuperscriptLinks: true }),
    contentType: 'markdown'
  })
}

describe('useRichMarkdownProgrammaticSync stale pending edit', () => {
  function renderPane(paneText: string, pendingCommit: boolean) {
    const codec = createRichMarkdownEditorCodec()
    const editor = buildEditor(
      codec,
      createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '',
        worktreeId: '',
        worktreeRoot: null,
        sourceOwner: { kind: 'unknown' as const }
      }),
      paneText
    )
    const lastCommittedMarkdownRef = { current: 'base' }
    const originalSourceRef = { current: 'base' }
    const baseCanonicalRef = { current: 'base' }
    const pendingEditGenerationRef = { current: { discarded: false } }
    const published: string[] = []
    const onContentChangeRef = { current: (content: string) => published.push(content) }
    const serializeTimerRef = {
      current: pendingCommit
        ? window.setTimeout(() => onContentChangeRef.current(paneText), 300)
        : null
    }
    const hook = renderHook(
      ({ content }: { content: string }) =>
        useRichMarkdownProgrammaticSync({
          codec,
          content,
          docLinkMenuSetter: vi.fn(),
          editor,
          fileId: 'f1',
          filePath: '/repo/README.md',
          isApplyingProgrammaticUpdateRef: { current: false },
          lastCommittedMarkdownRef,
          onContentChangeRef,
          originalSourceRef,
          baseCanonicalRef,
          markdownDocuments: undefined,
          rootRef: { current: null },
          runtimeTarget: { kind: 'local' },
          serializeTimerRef,
          pendingEditGenerationRef,
          slashMenuSetter: vi.fn(),
          worktreeId: 'w1',
          worktreeRoot: null
        }),
      { initialProps: { content: 'base' } }
    )
    return { editor, hook, published }
  }

  it('rejects a split pane pending edit once the other pane replaced the shared text', () => {
    vi.useFakeTimers()
    vi.mocked(toast.error).mockClear()
    const { editor, hook, published } = renderPane('pane b', true)
    try {
      hook.rerender({ content: 'pane a' })
      vi.advanceTimersByTime(300)

      expect(toast.error).toHaveBeenCalledWith(expect.any(String), {
        id: 'editor-stale-view-edit'
      })
      expect(editor.getMarkdown()).toBe('pane a')
      // Republished so the dirty flag this pane's typing raised is recomputed.
      expect(published).toEqual(['pane a'])
    } finally {
      editor.destroy()
      vi.useRealTimers()
    }
  })
})

describe('useRichMarkdownProgrammaticSync undo history', () => {
  it("never makes another view's text an undo step, so undo can't re-apply text undone there", () => {
    const codec = createRichMarkdownEditorCodec()
    const editor = buildEditor(
      codec,
      createRichMarkdownHtmlSuperscriptLinkContext({
        sourceFilePath: '',
        worktreeId: '',
        worktreeRoot: null,
        sourceOwner: { kind: 'unknown' as const }
      }),
      'base',
      document.createElement('div')
    )
    const lastCommittedMarkdownRef = { current: 'base' }
    const originalSourceRef = { current: 'base' }
    const baseCanonicalRef = { current: 'base' }
    const hook = renderHook(
      ({ content }: { content: string }) =>
        useRichMarkdownProgrammaticSync({
          codec,
          content,
          docLinkMenuSetter: vi.fn(),
          editor,
          fileId: 'f1',
          filePath: '/repo/README.md',
          isApplyingProgrammaticUpdateRef: { current: false },
          lastCommittedMarkdownRef,
          onContentChangeRef: { current: vi.fn() },
          originalSourceRef,
          baseCanonicalRef,
          markdownDocuments: undefined,
          rootRef: { current: null },
          runtimeTarget: { kind: 'local' },
          serializeTimerRef: { current: null },
          pendingEditGenerationRef: { current: { discarded: false } },
          slashMenuSetter: vi.fn(),
          worktreeId: 'w1',
          worktreeRoot: null
        }),
      { initialProps: { content: 'base' } }
    )
    try {
      // The source view typed, then undid it; this view's undo must not bring it back.
      hook.rerender({ content: 'base XYZ' })
      hook.rerender({ content: 'base' })
      editor.commands.undo()
      expect(editor.getMarkdown()).toBe('base')

      // Nor undo the source view's text out from under it.
      hook.rerender({ content: 'base XYZ' })
      editor.commands.undo()
      expect(editor.getMarkdown()).toBe('base XYZ')

      editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!')
      expect(editor.getMarkdown()).toBe('base XYZ!')
      editor.commands.undo()
      expect(editor.getMarkdown()).toBe('base XYZ')
    } finally {
      editor.destroy()
    }
  })
})
