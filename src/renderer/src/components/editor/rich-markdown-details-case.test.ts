import { Editor } from '@tiptap/core'
import { expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

it.each(['details', 'Details', 'DETAILS', 'dEtAiLs'])(
  'opens %s after prose as an editable toggle',
  (tag) => {
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: `Before\n<${tag}><summary>Title</summary>\n\nBody\n\n</${tag}>`,
      contentType: 'markdown'
    })
    try {
      expect(editor.state.doc.child(0).textContent).toBe('Before')
      const toggle = editor.state.doc.child(1)
      expect(toggle.type.name).toBe('details')
      expect(toggle.child(0).textContent).toBe('Title')
      expect(toggle.child(1).textContent).toBe('Body')
    } finally {
      editor.destroy()
    }
  }
)
