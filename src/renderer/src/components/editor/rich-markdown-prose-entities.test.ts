import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { encodeProseTextForMarkdown } from './rich-markdown-prose-entities'
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

describe('encodeProseTextForMarkdown', () => {
  it.each([
    ['a < b && c'],
    ['Finance > Invoices'],
    ['F&B revenue'],
    ['Copyright &copy; 2026'],
    ['A &MadeUpEntity; here'],
    ['5 <6 and 7> 8'],
    ['a <beta'],
    ['a < b'],
    ['a <beta and <gamma']
  ])('leaves %j unescaped', (text) => {
    expect(encodeProseTextForMarkdown(text)).toBe(text)
  })

  it.each([
    ['Press <kbd>x</kbd>', 'Press &lt;kbd>x&lt;/kbd>'],
    ['A <!-- comment --> here', 'A &lt;!-- comment --> here'],
    ['x <y> z', 'x &lt;y> z'],
    ['a <b c="d">e', 'a &lt;b c="d">e'],
    ['<br/>', '&lt;br/>'],
    ['<?php ?>', '&lt;?php ?>'],
    ['<!DOCTYPE html>', '&lt;!DOCTYPE html>'],
    ['<![CDATA[x]]>', '&lt;![CDATA[x]]>']
  ])('escapes the complete construct in %j', (text, expected) => {
    expect(encodeProseTextForMarkdown(text)).toBe(expected)
  })

  it('encodes a block-quote marker only in the first column', () => {
    expect(encodeProseTextForMarkdown('> quoted')).toBe('&gt; quoted')
    expect(encodeProseTextForMarkdown('Finance > Invoices')).toBe('Finance > Invoices')
  })
})

describe('prose entity round trip', () => {
  it.each([
    ['a < b && c'],
    ['Finance > Invoices'],
    ['F&B revenue'],
    ['Copyright &copy; 2026'],
    ['A &MadeUpEntity; here'],
    ['5 <6 and 7> 8'],
    ['Press <kbd>x</kbd> now.'],
    ['`a < b && c` stays literal'],
    ['a <beta'],
    ['a < b'],
    ['<kbd>x</kbd>'],
    ['<!-- c -->'],
    ['x <y> z']
  ])('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it('preserves prose entities inside a heading and a list item', () => {
    const source = '# F&B > Revenue\n\n- a < b && c'
    expect(roundTrip(source)).toBe(source)
  })

  it('is stable across three cycles', () => {
    const source = 'Finance > Invoices, F&B, a < b && c, &copy; 2026'
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })
})

describe('base encoder markdown escapes', () => {
  // Why: `@tiptap/markdown` 3.22.5 encodes `&`, `<`, and `>` and nothing else, so the
  // replacement encoder has no backslash escapes to preserve. A version that adds them
  // fails these, which is the signal to carry them through.
  it.each([['*literal*'], ['[label](url)'], ['a \\ b'], ['snake_case_name'], ['5 * 3']])(
    'round-trips %j without gaining or losing an escape',
    (source) => {
      expect(roundTrip(source)).toBe(source)
    }
  )

  it('normalizes a single-tilde strike to the double-tilde spelling', () => {
    expect(roundTrip('~x~')).toBe('~~x~~')
  })

  it('leaves a leading hash and dash inside a paragraph alone', () => {
    expect(roundTrip('a # b')).toBe('a # b')
    expect(roundTrip('a - b')).toBe('a - b')
  })
})

describe('incomplete HTML construct scanning', () => {
  it.each([
    ['<?x ', 20_000],
    ['<!x ', 20_000],
    ['<![CDATA', 20_000],
    ['<!-- ', 20_000]
  ])('scans %j repeated %d times without quadratic cost', (fragment, count) => {
    const text = fragment.repeat(count)
    const started = performance.now()
    const encoded = encodeProseTextForMarkdown(text)

    expect(performance.now() - started).toBeLessThan(100)
    expect(encoded).toBe(text)
  })

  it('escapes a complete construct that follows many incomplete ones', () => {
    expect(encodeProseTextForMarkdown(`${'<?a '.repeat(1000)}<?php ?>`)).toContain('&lt;?php ?>')
  })

  it('escapes a complete construct late in a long document', () => {
    const text = `${'x'.repeat(50_000)}<?php ?>${'y'.repeat(50_000)}`

    expect(encodeProseTextForMarkdown(text)).toContain('&lt;?php ?>')
  })

  it.each([
    ['<!-- unterminated'],
    ['<?unterminated'],
    ['<![CDATA[unterminated'],
    ['<! not a decl']
  ])('leaves the unterminated construct %j alone', (text) => {
    expect(encodeProseTextForMarkdown(text)).toBe(text)
  })
})
