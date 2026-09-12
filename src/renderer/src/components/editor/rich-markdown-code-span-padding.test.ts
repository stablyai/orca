import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createCodeSpanPaddingSession } from './rich-markdown-code-span-padding'
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

const TAB = '\t'
const NBSP = String.fromCharCode(0x00a0)
const SENTINEL = String.fromCharCode(0xe002)

describe('createCodeSpanPaddingSession', () => {
  it('leaves a node without a code mark alone', () => {
    const nodes = [{ type: 'text', text: ' padded ', marks: [] }]
    expect(createCodeSpanPaddingSession().mask(nodes)).toEqual(nodes)
  })

  it('leaves an unpadded code span alone', () => {
    const nodes = [{ type: 'text', text: 'code', marks: [{ type: 'code' }] }]
    expect(createCodeSpanPaddingSession().mask(nodes)).toEqual(nodes)
  })

  it('round-trips the padding it masks', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([{ type: 'text', text: ' code ', marks: [{ type: 'code' }] }])
    expect(masked.text?.startsWith(' ')).toBe(false)
    expect(masked.text?.endsWith(' ')).toBe(false)
    expect(session.restore(masked.text ?? '')).toBe(' code ')
  })

  it.each([[`${TAB}code${TAB}`], [`${NBSP}code${NBSP}`], [`${TAB}code${NBSP}`]])(
    'restores %j as its original characters',
    (text) => {
      const session = createCodeSpanPaddingSession()
      const [masked] = session.mask([{ type: 'text', text, marks: [{ type: 'code' }] }])
      expect(session.restore(masked.text ?? '')).toBe(text)
    }
  )

  it.each([['  '], ['   '], [' ']])('partitions the all-whitespace span %j once', (text) => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([{ type: 'text', text, marks: [{ type: 'code' }] }])
    expect(session.restore(masked.text ?? '')).toBe(text)
  })

  it('keeps a sentinel the span already carried', () => {
    const session = createCodeSpanPaddingSession()
    const text = ` ${SENTINEL}x${SENTINEL} `
    const [masked] = session.mask([{ type: 'text', text, marks: [{ type: 'code' }] }])
    expect(session.restore(masked.text ?? '')).toBe(text)
  })

  it('restores only the masks it generated', () => {
    const session = createCodeSpanPaddingSession()
    const unrelated = `${SENTINEL}z${SENTINEL}`
    expect(session.restore(unrelated)).toBe(unrelated)
  })
})

describe('code span padding round trip', () => {
  it.each([
    ['Read `Anexo v2.docx ` and write up.'],
    ['Read ` Anexo v2.docx` and write up.'],
    ['Plain `code` here.'],
    ['**bold** and `code` and *it*'],
    ['`a` and `b`'],
    ['[`label`](https://example.com)'],
    ['`  `'],
    ['`   `'],
    ['a `  ` b'],
    [`\`${TAB}x${TAB}\``],
    [`\`${NBSP}x${NBSP}\``],
    [`a literal ${String.fromCharCode(0xe000)} in prose`],
    [`a literal ${SENTINEL} in prose`],
    [`\`${SENTINEL}x${SENTINEL}\``],
    [`\`a${SENTINEL}b${SENTINEL}c\``],
    [`\`${SENTINEL}${SENTINEL}\``]
  ])('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each([['`  `'], ['`   `'], ['a `  ` b'], [`\`${TAB}x${TAB}\``]])(
    'keeps %j stable across three cycles',
    (source) => {
      let current = source
      for (let cycle = 0; cycle < 3; cycle += 1) {
        current = roundTrip(current)
      }
      expect(current).toBe(source)
    }
  )

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
