import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function encodeWithDeadline(content: string): string {
  // Interrupt a quadratic regression without hanging the synchronous test worker.
  return runInNewContext(
    'encode(content, codec)',
    {
      encode: encodeRawMarkdownHtmlForRichEditor,
      content,
      codec: createRichMarkdownEditorCodec('0'.repeat(32))
    },
    { timeout: 1500 }
  )
}

describe('rich Markdown blank-run encoding', () => {
  it('preserves a long blank document without repeatedly searching its suffix', () => {
    const content = '\n'.repeat(100_000)
    expect(encodeWithDeadline(content)).toBe(content)
  })

  it('inlines a reference definition after a long blank prefix without rescanning it', () => {
    const blankPrefix = '\n'.repeat(100_000)
    const content = `${blankPrefix}[Docs]\n\n[docs]: https://example.com/docs\n`
    expect(encodeWithDeadline(content)).toBe(`${blankPrefix}[Docs](https://example.com/docs)\n\n`)
  })

  it('preserves code and surrounding HTML after a long blank prefix', () => {
    const blankPrefix = '\n'.repeat(100_000)
    const content = '```\n<div>inside</div>\n```\n<b>after</b>'
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const expected = encodeRawMarkdownHtmlForRichEditor(content, codec)
    expect(expected).toContain('<div>inside</div>')
    expect(expected).not.toContain('<b>after</b>')
    expect(encodeWithDeadline(blankPrefix + content)).toBe(blankPrefix + expected)
  })
})
