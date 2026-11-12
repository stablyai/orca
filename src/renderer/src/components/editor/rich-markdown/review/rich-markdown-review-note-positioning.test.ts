// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  vi.restoreAllMocks()
})

function makeComment(id: string, lineNumber: number): DiffComment {
  return {
    id,
    worktreeId: 'workspace',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber,
    body: 'Review',
    createdAt: 1,
    side: 'modified'
  }
}

describe('measureRichMarkdownReviewNotePositions', () => {
  it('keeps notes on separator lines or past the end anchored to the block above', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: 'First\n\nSecond\n\nThird',
      contentType: 'markdown'
    })
    editors.push(editor)
    const blockStarts: number[] = []
    editor.state.doc.forEach((_node, offset) => blockStarts.push(offset + 1))
    vi.spyOn(editor.view, 'coordsAtPos').mockImplementation((pos) => ({
      top: pos,
      bottom: pos + 1,
      left: 0,
      right: 1
    }))

    const topOf = (lineNumber: number) =>
      measureRichMarkdownReviewNotePositions({
        editor,
        container: document.createElement('div'),
        markdownComments: [makeComment('note', lineNumber)],
        markdownSourceLineOffset: 0
      })[0]?.top

    expect([topOf(3), topOf(4), topOf(9)]).toEqual([blockStarts[1], blockStarts[1], blockStarts[2]])
  })
})
