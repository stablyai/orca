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
    expect(maskCodeSpanPadding(nodes).nodes).toEqual(nodes)
  })

  it('leaves an unpadded code span alone', () => {
    const nodes = [{ type: 'text', text: 'code', marks: [{ type: 'code' }] }]
    expect(maskCodeSpanPadding(nodes).nodes).toEqual(nodes)
  })

  it('round-trips the padding it masks', () => {
    const masked = maskCodeSpanPadding([
      { type: 'text', text: ' code ', marks: [{ type: 'code' }] }
    ])
    expect(masked.nodes[0]?.text).not.toContain(' ')
    expect(
      restoreCodeSpanPadding(masked.nodes[0]?.text ?? '', masked.placeholder, masked.replacements)
    ).toBe(' code ')
  })

  it('restores the exact whitespace bytes at code-span boundaries', () => {
    const leading = '\t\u00a0 '
    const trailing = ' \u00a0\t'
    const masked = maskCodeSpanPadding([
      { type: 'text', text: `${leading}code${trailing}`, marks: [{ type: 'code' }] }
    ])

    expect(
      restoreCodeSpanPadding(masked.nodes[0]?.text ?? '', masked.placeholder, masked.replacements)
    ).toBe(`${leading}code${trailing}`)
  })
})

describe('code span padding round trip', () => {
  it.each([
    ['Read `Anexo v2.docx ` and write up.'],
    ['Read ` Anexo v2.docx` and write up.'],
    ['Plain `code` here.'],
    ['Authored \uE000\uE001\uE002\uE003 and ` padded` text'],
    ['`a\uE000b` and ` padded`'],
    ['**bold** and `code` and *it*'],
    ['`a` and `b`'],
    ['[`label`](https://example.com)'],
    ['**`B93934206`**'],
    ['`**B93934206**`'],
    ['a **`x`** b'],
    ['**bold `code` tail**'],
    ['`**a**` and **`b`**'],
    ['Read `\tcode\u00a0` and write up.']
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

  it('keeps code and emphasis nesting stable across repeated saves', () => {
    let current = '**`B93934206`** and `**literal**`'
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe('**`B93934206`** and `**literal**`')
  })
})
