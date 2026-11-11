// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from '../raw-source/raw-markdown-html'
import { createRichMarkdownExtensions } from '../schema/rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'

function openMarkdown(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

function orderedListCount(editor: Editor): number {
  return JSON.stringify(editor.getJSON()).match(/"type":"orderedList"/g)?.length ?? 0
}

describe('rich markdown ordered list markers', () => {
  it.each([
    'Mr. Smith came back.\n\nDr. Jones looked at him.\n\nSt. Louis was a long way off.',
    'A. Smith wrote back.\n\nOK. That works.\n\niv. is not a list here.\n\nI. said so.',
    '> a. first\n> continued'
  ])('keeps %j as prose when opened and saved', (source) => {
    const editor = openMarkdown(source)
    try {
      expect(orderedListCount(editor)).toBe(0)
      expect(editor.getMarkdown()).toBe(source)
    } finally {
      editor.destroy()
    }
  })

  it('saves a lettered list pasted as HTML with numeric markers', () => {
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: '<ol type="a" start="2"><li><p>x</p></li><li><p>y</p></li></ol>'
    })
    try {
      expect(editor.getMarkdown()).toBe('2. x\n3. y')
    } finally {
      editor.destroy()
    }
  })
})
