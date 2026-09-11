import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { maskCodeSpanPadding, restoreCodeSpanPadding } from './rich-markdown-code-span-padding'
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

describe('maskCodeSpanPadding', () => {
  it('leaves a node without a code mark alone', () => {
    const nodes = [{ type: 'text', text: ' padded ', marks: [] }]
    expect(maskCodeSpanPadding(nodes)).toEqual(nodes)
  })

  it('leaves an unpadded code span alone', () => {
    const nodes = [{ type: 'text', text: 'code', marks: [{ type: 'code' }] }]
    expect(maskCodeSpanPadding(nodes)).toEqual(nodes)
  })

  it('round-trips the padding it masks', () => {
    const [masked] = maskCodeSpanPadding([
      { type: 'text', text: ' code ', marks: [{ type: 'code' }] }
    ])
    expect(masked.text).not.toContain(' ')
    expect(restoreCodeSpanPadding(masked.text ?? '')).toBe(' code ')
  })
})

describe('code span padding round trip', () => {
  it.each([
    ['Read `Anexo v2.docx ` and write up.'],
    ['Read ` Anexo v2.docx` and write up.'],
    ['Plain `code` here.'],
    ['**bold** and `code` and *it*'],
    ['`a` and `b`'],
    ['[`label`](https://example.com)']
  ])('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it('is stable across three cycles', () => {
    const source = 'Read `Anexo v2.docx ` and write up.'
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('still strips emphasis padding, which CommonMark requires', () => {
    expect(roundTrip('a **bold** b')).toBe('a **bold** b')
  })

  it('drops a matched pair of pads, which the parser strips before the document', () => {
    expect(roundTrip('Read ` Anexo v2.docx ` and write up.')).toBe(
      'Read `Anexo v2.docx` and write up.'
    )
  })
})
