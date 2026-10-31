// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { DragSelectionGuard, richMarkdownSelectionCompletionEvents } from './drag-selection-guard'
import { useRichMarkdownReviewController } from './useRichMarkdownReviewController'
import type { RichMarkdownAnnotationTarget } from './rich-markdown-review-annotations'

vi.mock('./useRichMarkdownReviewData', () => ({
  useRichMarkdownReviewData: () => ({
    canAnnotateRichMarkdown: true,
    markdownComments: [],
    markdownReviewNotes: [],
    sourceRelativePath: 'notes.md',
    unsentMarkdownReviewScope: null
  })
}))

vi.mock('./useRichMarkdownReviewCopyFeedback', () => ({
  useRichMarkdownReviewCopyFeedback: () => ({
    clearReviewCopyTimers: vi.fn(),
    reviewCopyFeedback: null
  })
}))

vi.mock('./useRichMarkdownReviewRailController', () => ({
  useRichMarkdownReviewRailController: () => ({
    cancelNotePositionFrame: vi.fn(),
    clearAttentionTimers: vi.fn(),
    setReviewRailOpen: vi.fn(),
    reviewRailOpen: false
  })
}))

const sampleTarget: RichMarkdownAnnotationTarget = {
  from: 1,
  to: 4,
  lineNumber: 1,
  startLine: 1,
  selectedText: 'abc',
  top: 12,
  buttonTop: 12,
  buttonLeft: 8
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useRichMarkdownReviewController openAnnotationPopover draft guard', () => {
  it('returns true without replacing an open draft (product B)', () => {
    const dispatch = vi.fn()
    const editorRef = {
      current: {
        view: { dispatch },
        state: {
          tr: {
            setMeta: vi.fn(function setMeta(this: unknown) {
              return this
            })
          }
        }
      } as unknown as Editor
    }
    const rootRef = { current: document.createElement('div') }
    const scrollContainerRef = { current: document.createElement('div') }

    const { result } = renderHook(() =>
      useRichMarkdownReviewController({
        addDiffComment: vi.fn(),
        allDiffComments: [],
        content: 'abc',
        editorRef,
        filePath: '/repo/notes.md',
        markdownAnnotationsEnabled: true,
        markdownReviewContent: 'abc',
        markdownSourceLineOffset: 0,
        rootRef,
        scrollContainerRef,
        worktreeId: 'wt-1',
        worktreeRoot: '/repo'
      })
    )

    act(() => {
      result.current.setAnnotationPopover(sampleTarget)
    })
    expect(result.current.annotationPopover).toEqual(sampleTarget)

    let kept = false
    act(() => {
      kept = result.current.openAnnotationPopover(true)
    })

    expect(kept).toBe(true)
    expect(result.current.annotationPopover).toEqual(sampleTarget)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('completes a native selection before opening a review note for its text', () => {
    vi.useFakeTimers()
    const editor = new Editor({
      extensions: [StarterKit, DragSelectionGuard],
      content: '<p>abc lower</p>',
      editorProps: { handleDOMEvents: richMarkdownSelectionCompletionEvents }
    })
    const editorRef = { current: editor }
    const rootRef = { current: document.createElement('div') }
    const scrollContainerRef = { current: document.createElement('div') }
    rootRef.current.append(editor.view.dom)
    document.body.append(rootRef.current)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 100, 20))

    const { result } = renderHook(() =>
      useRichMarkdownReviewController({
        addDiffComment: vi.fn(),
        allDiffComments: [],
        content: 'abc',
        editorRef,
        filePath: '/repo/notes.md',
        markdownAnnotationsEnabled: true,
        markdownReviewContent: 'abc',
        markdownSourceLineOffset: 0,
        rootRef,
        scrollContainerRef,
        worktreeId: 'wt-1',
        worktreeRoot: '/repo'
      })
    )

    try {
      editor.view.focus()
      const text = editor.view.dom.querySelector('p')?.firstChild
      if (!text) {
        throw new Error('Expected editor text')
      }
      const holdNotification = (event: Event) => event.stopImmediatePropagation()
      document.addEventListener('selectionchange', holdNotification, true)
      try {
        document.getSelection()?.setBaseAndExtent(text, 9, text, 4)
      } finally {
        document.removeEventListener('selectionchange', holdNotification, true)
      }
      expect(editor.state.selection.empty).toBe(true)
      let opened = false
      act(() => {
        opened = result.current.openAnnotationPopover(true)
      })
      expect(opened).toBe(true)
      expect(result.current.annotationPopover).toMatchObject({
        from: 5,
        to: 10,
        selectedText: 'lower'
      })
    } finally {
      editor.destroy()
      rootRef.current.remove()
    }
  })
})
