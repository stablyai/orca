import { Editor } from '@tiptap/core'
import { expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

it.each(['$$x^2$$', '$$\nx^2\n$$', '  $$x^2$$', 'Before\n\n$$x^2$$\n\nAfter'])(
  'preserves block math at a document or paragraph boundary: %s',
  (source) => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec),
      contentType: 'markdown'
    })
    try {
      const math: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'blockMath') {
          math.push(node.attrs.latex)
        }
      })
      expect(math).toEqual(['x^2'])
      const original = editor.state.doc
      for (let revision = 0; revision < 3; revision += 1) {
        editor.commands.setContent(
          encodeRawMarkdownHtmlForRichEditor(editor.getMarkdown(), codec),
          {
            contentType: 'markdown'
          }
        )
        editor.state.doc.check()
        expect(editor.state.doc.eq(original)).toBe(true)
      }
    } finally {
      editor.destroy()
    }
  }
)
