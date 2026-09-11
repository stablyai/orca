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
    ['5 <6 and 7> 8']
  ])('leaves %j unescaped', (text) => {
    expect(encodeProseTextForMarkdown(text)).toBe(text)
  })

  it.each([
    ['Press <kbd>x</kbd>', 'Press &lt;kbd>x&lt;/kbd>'],
    ['A <!-- comment --> here', 'A &lt;!-- comment --> here']
  ])('escapes the tag opening in %j', (text, expected) => {
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
    ['`a < b && c` stays literal']
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
