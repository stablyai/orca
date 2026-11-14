// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { normalizeEmptyListItems } from '../schema/rich-markdown-normalize'
import { registerRichMarkdownBlockSource } from '../document/rich-markdown-block-source'
import { commitRichMarkdownSerialization } from '../document/rich-markdown-serialization-commit'

function openMarkdown(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  normalizeEmptyListItems(editor)
  registerRichMarkdownBlockSource(editor, codec, false)
  return editor
}

function roundTrip(source: string): string {
  const editor = openMarkdown(source)
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function markedText(editor: Editor, mark: string): string[] {
  const text: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((item) => item.type.name === mark)) {
      text.push(node.text ?? '')
    }
  })
  return text
}

describe('tight bullet task continuations', () => {
  it('keeps a formatted continuation editable through save and reopen', () => {
    const source = '- Parent\n  - [ ] First\n    **bold** continuation\n  - [x] Done'
    const mark = 'bold'
    const text = 'bold'
    const editor = openMarkdown(source)
    try {
      editor.state.doc.check()
      expect(markedText(editor, mark)).toEqual([text])
      const refs = {
        originalSourceRef: { current: source },
        baseCanonicalRef: { current: editor.getMarkdown() },
        lastCommittedMarkdownRef: { current: source }
      }
      let end = -1
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text?.includes('continuation')) {
          end = position + node.nodeSize
        }
      })
      expect(end).toBeGreaterThan(0)
      editor.view.dispatch(editor.state.tr.insertText('!', end))
      const saved = commitRichMarkdownSerialization(editor, refs, roundTrip)
      const reopened = openMarkdown(saved.markdown)
      try {
        reopened.state.doc.check()
        expect(markedText(reopened, mark)).toEqual([text])
        expect(reopened.state.doc.textContent).toBe(`ParentFirst${text} continuation!Done`)
        let found = false
        reopened.state.doc.descendants((node) => {
          if (node.type.name === 'taskItem' && node.firstChild?.textContent === 'First') {
            found = true
            expect(node.childCount).toBe(2)
            expect(node.child(1).type.name).toBe('paragraph')
          }
          if (node.type.name === 'taskItem' && node.firstChild?.textContent === 'Done') {
            expect(node.attrs.checked).toBe(true)
          }
        })
        expect(found).toBe(true)
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })
})
