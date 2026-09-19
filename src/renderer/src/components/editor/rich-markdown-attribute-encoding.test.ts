import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

function open(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

for (const text of ['two "" quotes', 'slash\\"quote', 'two\\\\', '[brackets]\\', '中文 😀']) {
  describe(`attribute ${JSON.stringify(text)}`, () => {
    it.each(['title', 'alt'])('preserves image %s through editing and reopening', (attribute) => {
      const editor = open('![image](image.png)')
      try {
        const image = editor.state.doc.nodeAt(1)
        expect(image?.type.name).toBe('image')
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(1, undefined, { ...image?.attrs, [attribute]: text })
        )
        let saved = editor.getMarkdown()
        for (let revision = 0; revision < 3; revision += 1) {
          const reopened = open(saved)
          try {
            reopened.state.doc.check()
            expect(reopened.state.doc.nodeAt(1)?.attrs[attribute]).toBe(text)
            saved = reopened.getMarkdown()
          } finally {
            reopened.destroy()
          }
        }
      } finally {
        editor.destroy()
      }
    })
  })
}
