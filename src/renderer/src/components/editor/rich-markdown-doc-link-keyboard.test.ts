// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { NodeSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import { createMarkdownDocLink } from './rich-markdown-doc-link'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []

function docLinkEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit, createMarkdownDocLink(createRichMarkdownEditorCodec().transport)],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'before' },
            { type: 'markdownDocLink', attrs: { target: 'Guide' } },
            { type: 'text', text: 'after' }
          ]
        }
      ]
    }
  })
  editors.push(editor)
  return editor
}

function handleKey(editor: Editor, key: string, modifiers: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, ...modifiers })
  let handled = false
  editor.view.someProp('handleKeyDown', (handler) => {
    if (!handler(editor.view, event)) {
      return false
    }
    handled = true
    return true
  })
  return handled
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('document link arrow navigation', () => {
  it.each([
    { key: 'ArrowLeft', from: 8, to: 13 },
    { key: 'ArrowLeft', from: 13, to: 8 },
    { key: 'ArrowRight', from: 7, to: 13 },
    { key: 'ArrowRight', from: 13, to: 7 }
  ])('leaves $key selection $from..$to for native collapse', ({ key, from, to }) => {
    const editor = docLinkEditor()
    editor.commands.setTextSelection({ from, to })
    const before = editor.state.doc
    const selection = editor.state.selection
    expect(handleKey(editor, key)).toBe(false)
    expect(editor.state.doc.eq(before)).toBe(true)
    expect(editor.state.selection.eq(selection)).toBe(true)
  })

  it.each([
    { key: 'ArrowLeft', position: 8, expectedCaret: 14 },
    { key: 'ArrowRight', position: 7, expectedCaret: 9 }
  ])(
    'opens an adjacent link for editing with $key at an empty caret',
    ({ key, position, expectedCaret }) => {
      const editor = docLinkEditor()
      editor.commands.setTextSelection(position)
      expect(handleKey(editor, key)).toBe(true)
      expect(editor.state.doc.textContent).toBe('before[[Guide]]after')
      expect(editor.state.selection.from).toBe(expectedCaret)
      expect(editor.state.selection.empty).toBe(true)
    }
  )

  it.each([{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }])(
    'preserves modified arrow handling: %j',
    (modifiers) => {
      const editor = docLinkEditor()
      editor.commands.setTextSelection(8)
      const before = editor.state.doc
      expect(handleKey(editor, 'ArrowLeft', modifiers)).toBe(false)
      expect(editor.state.doc.eq(before)).toBe(true)
    }
  )

  it('preserves node selection and keys away from a link', () => {
    const editor = docLinkEditor()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 7)))
    const before = editor.state.doc
    expect(handleKey(editor, 'ArrowLeft')).toBe(false)
    editor.commands.setTextSelection(1)
    expect(handleKey(editor, 'ArrowRight')).toBe(false)
    expect(editor.state.doc.eq(before)).toBe(true)
  })
})
