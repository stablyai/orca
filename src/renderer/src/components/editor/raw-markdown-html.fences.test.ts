import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

describe('rich Markdown fenced code encoding', () => {
  it.each(['\n', '\r\n', '\r'])(
    'keeps placeholders literal in consecutive fences with %j line endings',
    (eol) => {
      const content = [
        '```python',
        'msg = "hello"',
        '```',
        '',
        '```bash',
        'run_tool <input.json> <start> <end>',
        '```',
        ''
      ].join(eol)
      const codec = createRichMarkdownEditorCodec()
      const encoded = encodeRawMarkdownHtmlForRichEditor(content, codec)
      expect(encoded).toBe(content)
      const code = codec.marked.lexer(encoded).filter((token) => token.type === 'code')
      expect(code.map((token) => ('text' in token ? token.text : undefined))).toEqual([
        'msg = "hello"',
        'run_tool <input.json> <start> <end>'
      ])
    }
  )

  it('encodes real HTML between fences while protecting their contents', () => {
    const content = ['```', '<one>', '```', '', 'A real <br> tag.', '', '```', '<two>', '```'].join(
      '\n'
    )
    const encoded = encodeRawMarkdownHtmlForRichEditor(content, createRichMarkdownEditorCodec())
    expect(encoded).toContain('<one>')
    expect(encoded).toContain('<two>')
    expect(encoded).not.toContain('<br>')
  })

  it('preserves an unclosed indented tilde fence after blank lines', () => {
    const content = '\n\n  ~~~~python\n<inside>\n~~~\n<still-inside>\n'
    expect(encodeRawMarkdownHtmlForRichEditor(content, createRichMarkdownEditorCodec())).toBe(
      content
    )
  })

  it.each(['    ', '\t'])('preserves indented code beginning with backticks (%j)', (indent) => {
    const content = `${indent}\`\`\`\n${indent}<inside>\n`
    const codec = createRichMarkdownEditorCodec()
    const encoded = encodeRawMarkdownHtmlForRichEditor(content, codec)
    const code = codec.marked.lexer(encoded).find((token) => token.type === 'code')
    expect(code && 'text' in code ? code.text : undefined).toBe('```\n<inside>')
    expect(encoded).toBe(content)
  })
})
