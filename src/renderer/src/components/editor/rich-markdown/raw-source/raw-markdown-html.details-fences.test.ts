import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from '../document/rich-markdown-source-transport'

const key = '0123456789abcdef0123456789abcdef'

describe('raw Markdown details fence scanning', () => {
  it('uses each document’s own fences when the codec is reused', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const first = '<details><summary>First</summary>\n\nBody\n\n</details>'
    const second =
      '<details><summary>Second</summary>\n\n```html\n</details>\n```\n\nBody\n\n</details>'
    expect(encodeRawMarkdownHtmlForRichEditor(first, codec)).toBe(first)
    expect(encodeRawMarkdownHtmlForRichEditor(second, codec)).toBe(
      codec.transport.create('block-html', second)
    )
    expect(encodeRawMarkdownHtmlForRichEditor(first, codec)).toBe(first)
  })
})
