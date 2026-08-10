import { describe, expect, it } from 'vitest'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

describe('encodeRawMarkdownHtmlForRichEditor fenced code', () => {
  it('keeps HTML-shaped angle brackets inside a single fenced code block', () => {
    const codec = createRichMarkdownEditorCodec('a'.repeat(32))
    const md = '```bash\nrun_tool <input.json> <start> <end>\n```\n'
    const encoded = encodeRawMarkdownHtmlForRichEditor(md, codec)
    expect(encoded).toContain('run_tool <input.json> <start> <end>')
    expect(encoded).not.toContain('inline-html')
  })

  it('keeps angle brackets inside a second consecutive fenced code block', () => {
    // Why: blank lines between fences used to open a phantom fence via ^\s* matching
    // across newlines, so the real second opener closed it and left the body unfenced (#13307).
    const codec = createRichMarkdownEditorCodec('a'.repeat(32))
    const md =
      '```python\nmsg = "hello"\n```\n\n```bash\nrun_tool <input.json> <start> <end>\n```\n'
    const encoded = encodeRawMarkdownHtmlForRichEditor(md, codec)
    expect(encoded).toContain('run_tool <input.json> <start> <end>')
    expect(encoded).not.toContain('inline-html')
  })

  it('still wraps real inline HTML outside code fences', () => {
    const codec = createRichMarkdownEditorCodec('a'.repeat(32))
    const md = 'before <b>bold</b> after\n'
    const encoded = encodeRawMarkdownHtmlForRichEditor(md, codec)
    expect(encoded).toContain('inline-html')
    expect(encoded).toContain(encodeURIComponent('<b>'))
  })
})
