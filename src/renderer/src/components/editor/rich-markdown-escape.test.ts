import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { ESCAPE_MARK_NAME, expandEscapeSources } from './rich-markdown-escape'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function createEditor(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

function roundTrip(source: string): string {
  const editor = createEditor(source)
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

function documentText(source: string): string {
  const editor = createEditor(source)
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

const ESCAPES_INSIDE_MARKS = [
  ['[a\\*b](http://x.com)'],
  ['[label\\*](http://x.com)'],
  ['[\\*](http://x.com)'],
  ['**bold**\\*'],
  ['**a**\\*b'],
  ['**Veri\\*Factu**'],
  ['*em\\*x*'],
  ['~~s\\*t~~']
]

const ADJACENT_ESCAPES = [
  ['\\*\\_'],
  ['\\#\\%'],
  ['a\\*\\*b'],
  ['\\[x\\]\\[y\\]'],
  ['\\~\\~strike\\~\\~'],
  ['\\*\\*\\*']
]

/** Each row pairs a source with the characters the document shows for it. */
const ADJACENT_ESCAPE_TEXT = [
  ['\\*\\_', '*_'],
  ['a\\*\\*b', 'a**b'],
  ['a\\\\\\*b', 'a\\*b']
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

describe('adjacent escapes', () => {
  it.each(ADJACENT_ESCAPES)('gives %j each escape its own backslash', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(ADJACENT_ESCAPES)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it.each(ADJACENT_ESCAPE_TEXT)('shows %j as %j', (source, text) => {
    expect(documentText(source)).toBe(text)
  })
})

const DIFFERENTLY_MARKED_ADJACENT_ESCAPES = [
  ['[\\*](http://a.com)\\_'],
  ['\\*[\\_](http://b.com)'],
  ['**\\***\\_'],
  ['**\\***~~\\_~~'],
  ['~~\\*~~**\\_**']
]

describe('adjacent escapes under different marks', () => {
  it.each(DIFFERENTLY_MARKED_ADJACENT_ESCAPES)('keeps %j whole', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(DIFFERENTLY_MARKED_ADJACENT_ESCAPES)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('keeps each escape its own node when the surrounding marks differ', () => {
    const nodes = expandEscapeSources([
      {
        type: 'text',
        text: '*',
        marks: [
          { type: ESCAPE_MARK_NAME, attrs: { source: '\\*' } },
          { type: 'link', attrs: { href: 'http://a.com' } }
        ]
      },
      {
        type: 'text',
        text: '_',
        marks: [
          { type: ESCAPE_MARK_NAME, attrs: { source: '\\_' } },
          { type: 'link', attrs: { href: 'http://b.com' } }
        ]
      }
    ])
    expect(nodes).toHaveLength(2)
    expect(nodes.map((node) => node.text)).toEqual(['\\*', '\\_'])
  })

  it('still joins adjacent escapes that carry the same marks', () => {
    const link = { type: 'link', attrs: { href: 'http://a.com' } }
    const nodes = expandEscapeSources([
      {
        type: 'text',
        text: '*',
        marks: [{ type: ESCAPE_MARK_NAME, attrs: { source: '\\*' } }, link]
      },
      {
        type: 'text',
        text: '_',
        marks: [{ type: ESCAPE_MARK_NAME, attrs: { source: '\\_' } }, link]
      }
    ])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.text).toBe('\\*\\_')
  })
})

describe('escape inside a mark run', () => {
  it.each(ESCAPES_INSIDE_MARKS)('serializes %j inside its delimiters', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(ESCAPES_INSIDE_MARKS)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('keeps a link label whole rather than splitting it in two', () => {
    expect(roundTrip('[a\\*b](http://x.com)')).not.toContain('[b]')
  })
})
