// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRichMarkdownCommentBlocks,
  getRichMarkdownCommentBlocks
} from './rich-markdown-comment-blocks'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []

function createEditor(source: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({
      codec: createRichMarkdownEditorCodec()
    }),
    content: source,
    contentType: 'markdown'
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  vi.restoreAllMocks()
})

describe('review source block serialization after edits', () => {
  it('preserves exact block positions through multiline edits, moves, insertions, deletion and undo', () => {
    const editor = createEditor(
      'First\n\n```text\none\ntwo\n```\n\n> quote\n>\n> second\n\n- item one\n- item two\n\nLast'
    )
    const check = () =>
      expect(getRichMarkdownCommentBlocks(editor)).toEqual(buildRichMarkdownCommentBlocks(editor))
    check()
    editor.view.dispatch(
      editor.state.tr.insertText('extra\n', editor.state.doc.child(0).nodeSize + 1)
    )
    check()
    const node = editor.state.doc.child(0)
    const move = editor.state.tr.delete(0, node.nodeSize)
    move.insert(move.doc.content.size, node)
    editor.view.dispatch(move)
    check()
    const paragraph = editor.schema.nodes.paragraph.create(null, editor.schema.text('inserted'))
    editor.view.dispatch(editor.state.tr.insert(0, paragraph))
    check()
    editor.view.dispatch(editor.state.tr.delete(0, paragraph.nodeSize))
    check()
    expect(editor.commands.undo()).toBe(true)
    check()
    expect(editor.commands.redo()).toBe(true)
    check()
  })
})
