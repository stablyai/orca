// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []

function createEditor() {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reviewable paragraph' }] }]
    }
  })
  editors.push(editor)
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
    top: 100,
    bottom: 120,
    left: 0,
    right: 10
  })
  return editor
}

function comment(id: string): DiffComment {
  return {
    id,
    worktreeId: 'workspace',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber: 1,
    body: 'Review',
    createdAt: 0,
    side: 'modified'
  }
}

function addCard(container: HTMLElement, id: string, height: number) {
  const card = document.createElement('div')
  card.setAttribute('data-rich-markdown-review-note-id', id)
  const rect = vi
    .spyOn(card, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 10, height))
  container.append(card)
  return { card, rect }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  vi.restoreAllMocks()
})

describe('review note height collection', () => {
  it('remeasures current cards and preserves first-match and missing-card behavior', () => {
    const editor = createEditor()
    const container = document.createElement('div')
    const markdownComments = [comment('first'), comment('second')]
    const first = addCard(container, 'first', 20)
    const duplicate = addCard(container, 'first', 500)
    const unrelated = addCard(container, 'unrelated', 500)
    addCard(container, 'second', 30)
    const measure = () =>
      measureRichMarkdownReviewNotePositions({
        editor,
        container,
        markdownComments,
        markdownSourceLineOffset: 0
      })
    expect(measure().map((position) => position.top)).toEqual([100, 128])
    first.rect.mockReturnValue(new DOMRect(0, 0, 10, 100))
    expect(measure().map((position) => position.top)).toEqual([100, 208])
    first.card.remove()
    duplicate.card.remove()
    expect(measure().map((position) => position.top)).toEqual([100, 210])
    expect(duplicate.rect).not.toHaveBeenCalled()
    expect(unrelated.rect).not.toHaveBeenCalled()
  })
})
