import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const cells = [
  String.raw`before \| after`,
  '`invalid` \\| `mismatch`, tail',
  String.raw`**bold \| text** and *other \| text*`,
  String.raw`[label \| tail](https://example.com)`,
  String.raw`[label](https://example.com/a\|b)`,
  String.raw`a \\\| b`,
  '`a|b`',
  '`a\\|b`',
  String.raw`![alt \| text](image.png)`,
  String.raw`before <!-- note \| keep --> after`,
  'before <!-- note | keep --> after',
  '[[target|label]]',
  '<span title="a|b">text</span>'
]

describe('Markdown table pipe preservation', () => {
  it.each(cells)('preserves cells after editing, saving, and repeated reopening: %s', (cell) => {
    const source = `| Header \\| tail | Other |\n| :--- | ---: |\n| ${cell} | keep |\n\nEdit here\n`
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec),
      contentType: 'markdown'
    })
    try {
      const table = editor.state.doc.firstChild
      expect(table?.type.name).toBe('table')
      let position = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'Edit here') {
          position = pos
        }
      })
      expect(position).toBeGreaterThan(-1)
      editor.view.dispatch(editor.state.tr.insertText('Edited here', position, position + 9))
      const saved = editor.getMarkdown()
      expect(saved).toContain('Edited here')
      for (let iteration = 0; iteration < 3; iteration++) {
        editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(saved, codec), {
          contentType: 'markdown'
        })
        expect(editor.state.doc.firstChild?.eq(table!)).toBe(true)
        expect(editor.getMarkdown()).toBe(saved)
      }
    } finally {
      editor.destroy()
    }
  })
})
