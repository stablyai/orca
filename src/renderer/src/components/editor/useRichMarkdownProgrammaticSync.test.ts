// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { useRichMarkdownProgrammaticSync } from './useRichMarkdownProgrammaticSync'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  createRichMarkdownEditorCodec,
  type RichMarkdownEditorCodec
} from './rich-markdown-source-transport'
import {
  createRichMarkdownHtmlSuperscriptLinkContext,
  type RichMarkdownHtmlSuperscriptLinkContext
} from './rich-markdown-html-superscript-link-context'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { notifyStaleViewEditRejected, staleViewEditEpoch } from './editor-stale-view-edit'

vi.mock('./editor-stale-view-edit', () => ({
  notifyStaleViewEditRejected: vi.fn(),
  staleViewEditEpoch: vi.fn(() => 0)
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

describe('useRichMarkdownProgrammaticSync external-reload baseline adoption (#6080)', () => {
  it('adopts externally-canonicalized bytes as the reconciliation baseline without a reload', () => {
    const codec = createRichMarkdownEditorCodec()
    const htmlSuperscriptLinkContext = createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '',
      worktreeId: '',
      worktreeRoot: null,
      sourceOwner: { kind: 'unknown' as const }
    })
    // Show the canonical form of originally underscored emphasis without a trailing newline.
    const canonical = '# T\n\n*old*'
    const editor = buildEditor(codec, htmlSuperscriptLinkContext, canonical)
    expect(editor.getMarkdown()).toBe(canonical)

    const lastCommittedMarkdownRef = { current: '# T\n\n_old_' }
    const originalSourceRef = { current: '# T\n\n_old_' }
    const baseCanonicalRef = { current: canonical }
    const isApplyingProgrammaticUpdateRef = { current: false }

    try {
      // Style-only external changes need new source baselines even when the rendered document already matches.
      renderHook(() =>
        useRichMarkdownProgrammaticSync({
          codec,
          content: canonical,
          docLinkMenuSetter: vi.fn(),
          editor,
          fileId: 'f1',
          filePath: '/repo/README.md',
          isApplyingProgrammaticUpdateRef,
          lastCommittedMarkdownRef,
          onContentChangeRef: { current: vi.fn() },
          originalSourceRef,
          baseCanonicalRef,
          markdownDocuments: undefined,
          rootRef: { current: null },
          runtimeTarget: { kind: 'local' },
          serializeTimerRef: { current: null },
          pendingEditEpochRef: { current: 0 },
          slashMenuSetter: vi.fn(),
          worktreeId: 'w1',
          worktreeRoot: null
        })
      )

      // Stale underscore baselines would undo the external style rewrite on the next edit.
      expect(lastCommittedMarkdownRef.current).toBe(canonical)
      expect(originalSourceRef.current).toBe(canonical)
      expect(baseCanonicalRef.current).toBe(canonical)
    } finally {
      editor.destroy()
    }
  })
})

describe('useRichMarkdownProgrammaticSync stale pending edit', () => {
  function renderPane(paneText: string, pendingCommit: (() => void) | null) {
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
    const pendingEditEpochRef = { current: 0 }
    const onContentChangeRef = { current: vi.fn<(content: string) => void>() }
    const serializeTimerRef = {
      current: pendingCommit ? window.setTimeout(pendingCommit, 300) : null
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
          pendingEditEpochRef,
          slashMenuSetter: vi.fn(),
          worktreeId: 'w1',
          worktreeRoot: null
        }),
      { initialProps: { content: 'base' } }
    )
    return { editor, hook, serializeTimerRef, onContentChangeRef }
  }

  it('rejects a split pane pending edit once the other pane replaced the shared text', () => {
    vi.useFakeTimers()
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const commitPaneB = vi.fn()
    const { editor, hook, serializeTimerRef, onContentChangeRef } = renderPane(
      'pane b',
      commitPaneB
    )
    try {
      hook.rerender({ content: 'pane a' })
      vi.advanceTimersByTime(300)

      expect(commitPaneB).not.toHaveBeenCalled()
      expect(serializeTimerRef.current).toBeNull()
      expect(notifyStaleViewEditRejected).toHaveBeenCalledExactlyOnceWith('f1', 0)
      expect(editor.getMarkdown()).toBe('pane a')
      // Republished so the dirty flag this pane's typing raised is recomputed.
      expect(onContentChangeRef.current).toHaveBeenCalledWith('pane a')
    } finally {
      editor.destroy()
      vi.useRealTimers()
    }
  })

  it('cancels acknowledged typing and recomputes dirty without a toast', () => {
    vi.useFakeTimers()
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const commit = vi.fn()
    const { editor, hook, serializeTimerRef, onContentChangeRef } = renderPane('same edit', commit)
    try {
      hook.rerender({ content: 'same edit' })
      vi.advanceTimersByTime(300)
      expect(serializeTimerRef.current).toBeNull()
      expect(commit).not.toHaveBeenCalled()
      expect(onContentChangeRef.current).toHaveBeenCalledWith('same edit')
      expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()
    } finally {
      editor.destroy()
      vi.useRealTimers()
    }
  })

  it('silently cancels typing after discard even when shared text did not change', () => {
    vi.useFakeTimers()
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const commit = vi.fn()
    const { editor, hook, serializeTimerRef, onContentChangeRef } = renderPane('typing', commit)
    try {
      vi.mocked(staleViewEditEpoch).mockReturnValue(1)
      hook.rerender({ content: 'base' })
      vi.advanceTimersByTime(300)
      expect(serializeTimerRef.current).toBeNull()
      expect(commit).not.toHaveBeenCalled()
      expect(editor.getMarkdown()).toBe('base')
      expect(onContentChangeRef.current).toHaveBeenCalledWith('base')
      expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()
    } finally {
      vi.mocked(staleViewEditEpoch).mockReturnValue(0)
      editor.destroy()
      vi.useRealTimers()
    }
  })

  it('re-syncs silently when the pane had no pending edit', () => {
    vi.mocked(notifyStaleViewEditRejected).mockClear()
    const { editor, hook } = renderPane('base', null)
    try {
      hook.rerender({ content: 'pane a' })
      expect(notifyStaleViewEditRejected).not.toHaveBeenCalled()
      expect(editor.getMarkdown()).toBe('pane a')
    } finally {
      editor.destroy()
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
          pendingEditEpochRef: { current: 0 },
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
