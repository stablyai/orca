import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createCodeSpanPaddingSession } from './rich-markdown-code-span-padding'
import type { CodeSpanPaddingSession } from './rich-markdown-code-span-padding'
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
const TERMINATOR = String.fromCharCode(0xe003)

function placeholder(index: number): string {
  return `${SENTINEL}${index}${TERMINATOR}${SENTINEL}`
}

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

  it('leaves a literal run that matches a generated mask alone', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([{ type: 'text', text: ' x ', marks: [{ type: 'code' }] }])
    const literal = `${SENTINEL} ${SENTINEL}`
    expect(session.restore(`${literal} before ${masked.text ?? ''}`)).toBe(`${literal} before  x `)
  })

  it('leaves an unpadded span carrying this session first placeholder alone', () => {
    const session = createCodeSpanPaddingSession()
    const text = `${placeholder(0)}x`
    const [masked] = session.mask([{ type: 'text', text, marks: [{ type: 'code' }] }])
    expect(masked.text).toBe(text)
    expect(session.restore(masked.text ?? '')).toBe(text)
  })

  it('leaves padding masked when the document duplicates its placeholder', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([{ type: 'text', text: ' x ', marks: [{ type: 'code' }] }])
    const collision = placeholder(0)
    const restored = session.restore(`${collision} before ${masked.text ?? ''}`)
    expect(restored).toContain(collision)
    expect(restored.endsWith('x ')).toBe(true)
  })

  it('restores a padded span in a document that also holds a literal placeholder', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([{ type: 'text', text: ' x ', marks: [{ type: 'code' }] }])
    const literal = placeholder(7)
    expect(session.restore(`${literal} ${masked.text ?? ''}`)).toBe(`${literal}  x `)
  })

  it('issues one distinct placeholder per padding run', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([{ type: 'text', text: '  x  ', marks: [{ type: 'code' }] }])
    const text = masked.text ?? ''
    const distinct = new Set(text.split(SENTINEL).filter((part) => part.endsWith(TERMINATOR)))
    expect(distinct.size).toBe(2)
    expect(session.restore(text)).toBe('  x  ')
  })

  it('issues one placeholder however long the run', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([
      { type: 'text', text: `${' '.repeat(500)}x`, marks: [{ type: 'code' }] }
    ])
    const text = masked.text ?? ''
    expect(text.split(SENTINEL).filter((part) => part.endsWith(TERMINATOR))).toHaveLength(1)
    expect(session.restore(text)).toBe(`${' '.repeat(500)}x`)
  })

  it('restores each run to its own characters', () => {
    const session = createCodeSpanPaddingSession()
    const text = `${TAB}${TAB}x${NBSP} `
    const [masked] = session.mask([{ type: 'text', text, marks: [{ type: 'code' }] }])
    expect(session.restore(masked.text ?? '')).toBe(text)
  })
})

describe('restore cost', () => {
  function maskedDocument(pads: number): { session: CodeSpanPaddingSession; markdown: string } {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([
      { type: 'text', text: `${' '.repeat(pads)}code`, marks: [{ type: 'code' }] }
    ])
    return { session, markdown: `${'x'.repeat(100_000)}${masked.text ?? ''}` }
  }

  it('restores a 6,000-character pad on a 100k document well inside the serialize debounce', () => {
    const { session, markdown } = maskedDocument(6000)
    const started = performance.now()
    const restored = session.restore(markdown)
    const elapsed = performance.now() - started
    expect(restored.endsWith(`${' '.repeat(6000)}code`)).toBe(true)
    // Why: the serialize debounce is 300ms; a bound far under it fails on a
    // reintroduced per-entry pass without flaking on a loaded machine.
    expect(elapsed).toBeLessThan(50)
  })

  it('issues one table entry per padded run, not per pad character', () => {
    const session = createCodeSpanPaddingSession()
    const [masked] = session.mask([
      {
        type: 'text',
        text: `${' '.repeat(6000)}code${' '.repeat(6000)}`,
        marks: [{ type: 'code' }]
      }
    ])
    const text = masked.text ?? ''
    expect(text.split(SENTINEL).filter((part) => part.endsWith(TERMINATOR))).toHaveLength(2)
  })

  it('costs no more for 6,000 pad characters than for 100', () => {
    const elapsed = (pads: number): number => {
      const { session, markdown } = maskedDocument(pads)
      const started = performance.now()
      session.restore(markdown)
      return performance.now() - started
    }
    // Why: warms the scan so the first measured pass is not paying for compilation.
    elapsed(100)
    const small = elapsed(100)
    const large = elapsed(6000)
    expect(large).toBeLessThan(Math.max(small * 4, 50))
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
    [`\`${SENTINEL}${SENTINEL}\``],
    [`a literal ${SENTINEL} ${SENTINEL} in prose and \`x \` after`],
    [`\`${SENTINEL} ${SENTINEL}\` and \`x \` after`],
    [`\`${SENTINEL}0${TERMINATOR}${SENTINEL}x\``],
    [`\`${SENTINEL}1${TERMINATOR}x${SENTINEL}\``],
    [`a literal ${SENTINEL}0${TERMINATOR}${SENTINEL} in prose and \`x \` after`],
    [`\`${SENTINEL}0${TERMINATOR}${SENTINEL}\` and \`x \` after`]
  ])('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each([
    ['`  `'],
    ['`   `'],
    ['a `  ` b'],
    [`\`${TAB}x${TAB}\``],
    [`a literal ${SENTINEL}0${TERMINATOR}${SENTINEL} in prose and \`x \` after`]
  ])('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it.each([
    [
      `- a literal ${SENTINEL}${SENTINEL}0${TERMINATOR}${SENTINEL}${SENTINEL} in a list\n- and \`x \` after`
    ],
    [`> quote with ${SENTINEL}0${TERMINATOR}${SENTINEL}\n>\n> and \`x \` after`],
    [`- \`${SENTINEL}0${TERMINATOR}${SENTINEL}\`\n- \`y \``],
    [`1. deep\n   - \`${SENTINEL}${SENTINEL}0${TERMINATOR}${SENTINEL}${SENTINEL}\`\n   - \`z \``]
  ])('preserves %j across the nested walks', (source) => {
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
