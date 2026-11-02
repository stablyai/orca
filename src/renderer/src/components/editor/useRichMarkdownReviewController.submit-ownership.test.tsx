// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import {
  createRichMarkdownAnnotationHighlightExtension,
  richMarkdownAnnotationHighlightPluginKey
} from './rich-markdown-annotation-highlight'
import type { RichMarkdownAnnotationTarget } from './rich-markdown-review-annotations'
import { useRichMarkdownReviewController } from './useRichMarkdownReviewController'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const editors: Editor[] = []
const target: RichMarkdownAnnotationTarget = {
  from: 1,
  to: 4,
  lineNumber: 1,
  selectedText: 'abc',
  top: 0,
  buttonTop: 0,
  buttonLeft: 0
}
const saved: DiffComment = {
  id: 'saved-note',
  createdAt: 1,
  worktreeId: 'folder-owner',
  filePath: 'notes.md',
  source: 'markdown',
  lineNumber: 1,
  selectedText: 'abc',
  body: 'Review abc',
  side: 'modified'
}

function createEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, createRichMarkdownAnnotationHighlightExtension()],
    content: '<p>abc xyz</p>'
  })
  editors.push(editor)
  return editor
}

function highlightXyz(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(richMarkdownAnnotationHighlightPluginKey, {
      activeRange: { from: 5, to: 8 },
      noteRanges: [{ from: 5, to: 8 }]
    })
  )
}

function highlightedText(editor: Editor): string[] {
  return [...editor.view.dom.querySelectorAll('.rich-markdown-annotation-selection')].map(
    (element) => element.textContent ?? ''
  )
}

function mountReview() {
  const editor = createEditor()
  const editorRef: { current: Editor | null } = { current: editor }
  const rootRef: { current: HTMLDivElement | null } = { current: document.createElement('div') }
  const pending = Promise.withResolvers<DiffComment | null>()
  const addDiffComment = vi.fn((_input: Omit<DiffComment, 'id' | 'createdAt'>) => pending.promise)
  let comments: DiffComment[] = []
  const hook = renderHook(() =>
    useRichMarkdownReviewController({
      addDiffComment,
      allDiffComments: comments,
      content: 'abc xyz',
      editorRef,
      filePath: '/workspace/notes.md',
      markdownAnnotationsEnabled: true,
      markdownReviewContent: 'abc xyz',
      markdownSourceLineOffset: 0,
      rootRef,
      scrollContainerRef: { current: document.createElement('div') },
      worktreeId: 'folder-owner',
      worktreeRoot: '/workspace'
    })
  )
  act(() => hook.result.current.setAnnotationPopover(target))
  return {
    ...hook,
    editor,
    pending,
    addDiffComment,
    updateComments(next: DiffComment[]) {
      comments = next
      hook.rerender()
    }
  }
}

afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
})

describe('review submission owner', () => {
  it('leaves a newer draft open when an older submission completes', async () => {
    const review = mountReview()
    const submission = review.result.current.submitAnnotation('Review abc')
    const nextTarget = { ...target, from: 5, to: 8, selectedText: 'xyz' }
    act(() => review.result.current.setAnnotationPopover(nextTarget))
    await act(async () => {
      review.pending.resolve(saved)
      await submission
    })
    expect(review.result.current.annotationPopover).toEqual(nextTarget)
  })

  it('keeps highlights for comments that arrive while persistence is pending', async () => {
    const review = mountReview()
    const submission = review.result.current.submitAnnotation('Review abc')
    act(() => {
      review.updateComments([{ ...saved, id: 'other-note', selectedText: 'xyz' }])
      highlightXyz(review.editor)
    })
    await act(async () => {
      review.pending.resolve(saved)
      await submission
    })
    expect(highlightedText(review.editor)).toEqual(['abc', 'xyz'])
  })

  it('preserves a failed draft for retry', async () => {
    const failure = mountReview()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const failedSubmission = failure.result.current.submitAnnotation('Review abc')
      await act(async () => {
        failure.pending.resolve(null)
        await failedSubmission
      })
      expect(failure.result.current.annotationPopover).toEqual(target)
      expect(highlightedText(failure.editor)).toEqual([])
    } finally {
      error.mockRestore()
    }
  })
})
