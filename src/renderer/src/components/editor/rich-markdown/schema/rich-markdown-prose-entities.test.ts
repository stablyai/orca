import { Editor, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'

function createEditor(content: JSONContent | string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content:
      typeof content === 'string' ? encodeRawMarkdownHtmlForRichEditor(content, codec) : content,
    ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {})
  })
}

function paragraph(text: string, marks?: JSONContent['marks']): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks }] }] }
}

describe('typed prose entities', () => {
  it.each([
    ['a < b && c', 'a < b && c'],
    ['Finance > Invoices', 'Finance > Invoices'],
    ['I typed &copy; and &#42;', 'I typed &amp;copy; and &amp;#42;'],
    ['<kbd>x</kbd> and <http://x.y>', '&lt;kbd&gt;x&lt;/kbd&gt; and &lt;http://x.y&gt;'],
    ['> quote', '&gt; quote'],
    ['x <= y <3', 'x &lt;= y &lt;3'],
    ['see http://x.y>', 'see http://x.y&gt;']
  ])('serializes %j as %j', (text, markdown) => {
    const editor = createEditor(paragraph(text))
    try {
      expect(editor.getMarkdown()).toBe(markdown)
    } finally {
      editor.destroy()
    }
  })

  it.each(['a < b && c, F&B > R, &copy; &amp; <i>', '> quote', '<kbd>x</kbd>'])(
    'reopens %j unchanged',
    (text) => {
      const editor = createEditor(paragraph(text))
      const reopened = createEditor(editor.getMarkdown())
      try {
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        editor.destroy()
        reopened.destroy()
      }
    }
  )

  it('leaves entity text inside a code span alone', () => {
    const editor = createEditor(paragraph('&amp; <b> > x', [{ type: 'code' }]))
    try {
      expect(editor.getMarkdown()).toBe('`&amp; <b> > x`')
    } finally {
      editor.destroy()
    }
  })
})
