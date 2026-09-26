import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { resolveTerminalRichInputInsertionPosition } from './use-terminal-rich-input-editor-attachments'

describe('resolveTerminalRichInputInsertionPosition', () => {
  it('maps a stale position into the remaining text block', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'deleted text' }] }]
      }
    })
    const stalePosition = editor.state.doc.content.size
    const emptyDoc = editor.state.schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph' }]
    })

    expect(resolveTerminalRichInputInsertionPosition(emptyDoc, stalePosition)).toBe(1)
  })

  it('maps a document-end position into the final text block', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'second' }] }
        ]
      }
    })

    const position = resolveTerminalRichInputInsertionPosition(
      editor.state.doc,
      editor.state.doc.content.size
    )

    expect(editor.state.doc.resolve(position).parent.isTextblock).toBe(true)
    expect(position).toBe(editor.state.doc.content.size - 1)
  })
})
