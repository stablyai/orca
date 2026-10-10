// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { measureRichMarkdownReviewNotePositions } from './rich-markdown-review-note-positioning'

const editors: Editor[] = []
const SOURCE = 'First\n\nSecond\n\nThird'

function createEditor(content = SOURCE): Editor {
  const root = document.createElement('div')
  document.body.append(root)
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: root,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })
  vi.spyOn(editor.view, 'coordsAtPos').mockImplementation((pos) => ({
    left: 0,
    right: 0,
    top: pos,
    bottom: pos + 1
  }))
  editors.push(editor)
  return editor
}

function note(lineNumber: number, selectedText?: string, id = 'note'): DiffComment {
  return {
    id,
    worktreeId: 'workspace',
    filePath: 'notes.md',
    source: 'markdown',
    lineNumber,
    selectedText,
    body: 'Review this paragraph',
    createdAt: 1,
    side: 'modified'
  }
}

function measure(editor: Editor, notes: DiffComment[], offset = 0) {
  return measureRichMarkdownReviewNotePositions({
    container: document.createElement('div'),
    editor,
    markdownComments: notes,
    markdownSourceLineOffset: offset
  })
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('review cards after document edits', () => {
  it('preserves ordinary source-block anchors', () => {
    const editor = createEditor()
    expect([1, 3, 5].map((line) => measure(editor, [note(line)])[0]?.top)).toEqual([1, 8, 16])
  })

  it.each([
    [2, 1],
    [4, 8],
    [99, 16]
  ])('keeps a note at source line %i visible beside the preceding block', (line, top) => {
    const editor = createEditor()
    const comment = note(line)
    const positions = measure(editor, [comment])
    expect(positions).toHaveLength(1)
    expect(positions[0]?.comment).toBe(comment)
    expect(positions[0]?.top).toBe(top)
  })

  it('keeps a card after an external reload removes the original paragraph', () => {
    const editor = createEditor()
    const comment = note(5, 'Third')
    expect(measure(editor, [comment])).toHaveLength(1)
    editor.commands.setContent('First', { contentType: 'markdown' })
    const document = editor.state.doc
    const selection = editor.state.selection
    expect(measure(editor, [comment])[0]).toEqual({ comment, top: 1 })
    expect(editor.state.doc).toBe(document)
    expect(editor.state.selection).toBe(selection)
    expect(comment.lineNumber).toBe(5)
  })

  it('still anchors surviving selected text when its old line is past the document end', () => {
    const editor = createEditor()
    expect(measure(editor, [note(99, 'Second')])[0]?.top).toBe(8)
  })

  it.each([1, 2])('keeps a note on leading blank source line %i visible', (line) => {
    const editor = createEditor('\n\nFirst\n\nSecond')
    expect(measure(editor, [note(line)])[0]?.top).toBe(1)
    expect(measure(editor, [note(line, 'Second')])[0]?.top).toBe(10)
  })

  it('applies frontmatter source offsets before the fallback', () => {
    const editor = createEditor('First')
    expect(measure(editor, [note(15)], 10)[0]?.top).toBe(1)
  })

  it('keeps notes visible after the entire body is removed', () => {
    const editor = createEditor('')
    expect(measure(editor, [note(5)])[0]?.top).toBe(1)
    editor.state.doc.check()
  })

  it('stacks multiple orphan cards without changing or dropping their stored notes', () => {
    const editor = createEditor('First')
    const comments = [note(99, undefined, 'later'), note(5, undefined, 'earlier')]
    const positions = measure(editor, comments)
    expect(positions.map(({ comment }) => comment.id)).toEqual(['earlier', 'later'])
    expect(positions[1]?.top).toBeGreaterThan(positions[0]?.top ?? 0)
    expect(comments.map((comment) => comment.id)).toEqual(['later', 'earlier'])
  })
})
