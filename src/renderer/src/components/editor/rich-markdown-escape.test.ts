import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function roundTrip(source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function documentText(source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.state.doc.textContent
  } finally {
    editor.destroy()
  }
}

const ESCAPES = [
  ['Veri\\*Factu'],
  ['\\_x\\_'],
  ['\\[not a link\\]'],
  ['1\\. not a list'],
  ['a\\\\b backslash'],
  ['100\\% and \\# hash']
]

describe('backslash escape round trip', () => {
  it.each(ESCAPES)('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(ESCAPES)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('shows the escaped character without its backslash', () => {
    expect(documentText('Veri\\*Factu')).toBe('Veri*Factu')
  })

  it('preserves an escape inside a list item and a heading', () => {
    const source = '# 100\\% done\n\n- Veri\\*Factu'
    expect(roundTrip(source)).toBe(source)
  })
})
