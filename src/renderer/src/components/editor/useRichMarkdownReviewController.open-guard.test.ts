// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
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

  it('flushes the pending ProseMirror selection before reading the target', () => {
    const flush = vi.fn()
    const setSelection = vi.fn()
    // Why: an empty selection makes getRichMarkdownAnnotationTarget return null,
    // so the open no-ops; we only assert the flush ran first (drag-race fix).
    const editorRef = {
      current: {
        view: {
          dispatch: vi.fn(),
          domObserver: { flush, currentSelection: { set: setSelection } }
        },
        state: { selection: { empty: true } }
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

    let opened = true
    act(() => {
      opened = result.current.openAnnotationPopover(true)
    })

    expect(flush).toHaveBeenCalledTimes(1)
    expect(opened).toBe(false)
    expect(result.current.annotationPopover).toBeNull()
  })
})
