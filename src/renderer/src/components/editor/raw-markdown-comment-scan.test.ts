import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const key = '0123456789abcdef0123456789abcdef'
afterEach(() => vi.restoreAllMocks())

describe('raw Markdown HTML comment scanning', () => {
  it('does not repeatedly match a suffix with no comment closer', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const input = `prefix ${'<!--x'.repeat(8000)} <b>tail</b>`
    const match = vi.spyOn(String.prototype, 'match')
    const output = encodeRawMarkdownHtmlForRichEditor(input, codec)
    const scans = match.mock.calls.filter(
      ([pattern]) => pattern instanceof RegExp && pattern.source.startsWith('^<!--')
    ).length
    expect(output).toBe(
      `prefix ${'<!--x'.repeat(8000)} ${codec.transport.create('inline-html', '<b>')}tail${codec.transport.create('inline-html', '</b>')}`
    )
    expect(scans).toBe(2)
  })

  it('preserves complete comments and an unterminated tail', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const input = 'before <!--outer<!--inner--> after <!--unfinished'
    expect(encodeRawMarkdownHtmlForRichEditor(input, codec)).toBe(
      `before ${codec.transport.create('inline-html', '<!--outer<!--inner-->')} after <!--unfinished`
    )
  })

  it.each(['`<!--x`', '```html\n<!--x\n```\n', '\\<!--x', 'prefix <!--->'])(
    'keeps protected or incomplete text literal: %j',
    (input) => {
      expect(encodeRawMarkdownHtmlForRichEditor(input, createRichMarkdownEditorCodec(key))).toBe(
        input
      )
    }
  )
  it('retains the existing block-only handling of an overlapping marker', () => {
    const codec = createRichMarkdownEditorCodec(key)
    expect(encodeRawMarkdownHtmlForRichEditor('<!--->', codec)).toBe(
      codec.transport.create('block-html', '<!--->')
    )
  })
})
