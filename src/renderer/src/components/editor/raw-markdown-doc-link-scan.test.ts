import { describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const key = '0123456789abcdef0123456789abcdef'

describe('raw Markdown document-link closing searches', () => {
  it.each([false, true])('skips impossible suffix searches (superscript links: %s)', (enabled) => {
    const codec = createRichMarkdownEditorCodec(key)
    const suffix = '[[missing '.repeat(300)
    const input = `prefix [[README.md]] ${suffix}`
    const original = String.prototype.indexOf
    let searches = 0
    const spy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
      this: string,
      search: string,
      position?: number
    ) {
      if (search === ']]') {
        searches++
      }
      return original.call(this, search, position)
    })
    let output: string
    try {
      output = encodeRawMarkdownHtmlForRichEditor(input, codec, { htmlSuperscriptLinks: enabled })
    } finally {
      spy.mockRestore()
    }
    expect(output).toBe(`prefix ${codec.transport.create('document-link', 'README.md')} ${suffix}`)
    expect(searches).toBe(1)
  })

  it('protects every unclosed authored prefix without rescanning the suffix', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const prefix = codec.transport.authoredPrefix
    const input = `before ${`${prefix}x `.repeat(300)}`
    const spy = vi.spyOn(String.prototype, 'indexOf')
    let output: string
    let searches: number
    try {
      output = encodeRawMarkdownHtmlForRichEditor(input, codec)
      searches = spy.mock.calls.filter(([search]) => search === ']]').length
    } finally {
      spy.mockRestore()
    }
    expect(output).toBe(`before ${`${codec.transport.create('literal', prefix)}x `.repeat(300)}`)
    expect(searches).toBe(0)
  })

  it('preserves escaped and code-protected links around the final closing marker', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const input = '\\[[README.md]] `[[inline.md]]`\n```md\n[[fenced.md]]\n```\n[[unclosed'
    expect(encodeRawMarkdownHtmlForRichEditor(input, codec)).toBe(input)
  })

  it('preserves a complete authored envelope before an unclosed document link', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const authored = `${codec.transport.authoredPrefix}literal:hello]]`
    expect(encodeRawMarkdownHtmlForRichEditor(`before ${authored} [[tail`, codec)).toBe(
      `before ${codec.transport.create('literal', authored)} [[tail`
    )
  })
})
