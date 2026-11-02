import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const key = '0123456789abcdef0123456789abcdef'

describe('raw Markdown details fence scanning', () => {
  it('preserves nested and mixed-case editable toggles', () => {
    const content =
      '<DeTaIlS open><SuMmArY>Outer</SuMmArY>\n\n<details><summary>Inner</summary>\n\nBody\n\n</details>\n\n</DeTaIlS>'
    expect(encodeRawMarkdownHtmlForRichEditor(content, createRichMarkdownEditorCodec(key))).toBe(
      content
    )
  })

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

  it('preserves fenced code before a non-editable sibling', () => {
    const codec = createRichMarkdownEditorCodec(key)
    const editable = '<details><summary>Editable</summary>\n\nBody\n\n</details>'
    const raw = '<details class="custom"><summary>Raw</summary>\n\nBody\n\n</details>'
    const prefix = '~~~html\n<details><summary>Code</summary></details>\n~~~\n\n'
    expect(encodeRawMarkdownHtmlForRichEditor(`${prefix}${editable}\n\n${raw}`, codec)).toBe(
      `${prefix}${editable}\n\n${codec.transport.create('block-html', raw)}`
    )
  })
})
