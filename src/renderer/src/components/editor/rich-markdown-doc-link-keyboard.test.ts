// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
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
})
