// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

const source = 'graph TD\nA[Line 1<br/>Line 2] --> B'

describe('fenced code in Markdown containers', () => {
  it.each(
    ['```', '~~~'].flatMap((fence) =>
      ['> ', '>> ', '- '].map((prefix) => ({ fence, prefix, label: `${prefix}${fence}` }))
    )
  )('keeps the code source in a $label fence', ({ fence, prefix }) => {
    const continuation = prefix.includes('>') ? prefix : ' '.repeat(prefix.length)
    const markdown = `${prefix}${fence}mermaid\n${continuation}graph TD\n${continuation}A[Line 1<br/>Line 2] --> B\n${continuation}${fence}\n`
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(markdown, codec),
      contentType: 'markdown'
    })
    try {
      const blocks: string[] = []
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'codeBlock') {
          blocks.push(node.textContent)
        }
      })
      expect(blocks).toEqual([source])
      expect(editor.getMarkdown()).toContain('A[Line 1<br/>Line 2] --> B')
      expect(editor.getMarkdown()).not.toContain(codec.transport.authoredPrefix)
    } finally {
      editor.destroy()
    }
  })

  it('preserves authored transport envelopes and document-link syntax as code', () => {
    const codec = createRichMarkdownEditorCodec('0'.repeat(32))
    const source = [
      `${codec.transport.authoredPrefix}inline-html:%3Cbr%2F%3E]]`,
      `[[ORCA_RICH_MD:${'1'.repeat(32)}:inline-html:%3Cbr%2F%3E]]`,
      '[[ORCA_RAW_HTML_INLINE:%3Cbr%2F%3E]]',
      '[[docs|authored link syntax]]'
    ].join('\n')
    const markdown = `> ~~~text\n${source
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}\n> ~~~`
    const encoded = encodeRawMarkdownHtmlForRichEditor(markdown, codec)
    expect(encoded).toBe(markdown)
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encoded,
      contentType: 'markdown'
    })
    try {
      expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(source)
      for (const line of source.split('\n')) {
        expect(editor.getMarkdown()).toContain(line)
      }
    } finally {
      editor.destroy()
    }
  })

  it('keeps a reference definition inside list-fenced code', () => {
    const markdown = '- ```mermaid\n  graph TD\n  [docs]: https://example.com/docs\n  ```\n\n[Docs]'
    expect(normalizeMarkdownReferenceLinks(markdown)).toBe(markdown)
  })
})

describe('indented code beginning with fence markers', () => {
  it.each(['    ', '\t'])('preserves the native indented code for %j', (indent) => {
    for (const eol of ['\n', '\r\n', '\r']) {
      for (const marker of ['```', '~~~']) {
        const source = `${indent}${marker}${eol}${indent}<inside>${eol}`
        const codec = createRichMarkdownEditorCodec()
        const encoded = encodeRawMarkdownHtmlForRichEditor(source, codec)
        const code = codec.marked.lexer(encoded).find((token) => token.type === 'code')
        expect(code && 'text' in code ? code.text : undefined).toBe(`${marker}\n<inside>`)
        expect(encoded).toBe(source)
        const editor = new Editor({
          element: null,
          extensions: createRichMarkdownExtensions({ codec }),
          content: encoded,
          contentType: 'markdown'
        })
        try {
          expect(editor.state.doc.firstChild?.textContent).toBe(`${marker}\n<inside>`)
          expect(editor.getMarkdown()).toContain('<inside>')
        } finally {
          editor.destroy()
        }
      }
    }
  })

  it.each(['    ', '\t'])('ends %j literal code before outside HTML', (indent) => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const source = `${indent}\`\`\`${eol}${indent}<inside>${eol}${eol}Outside <br/>${eol}`
      const encoded = encodeRawMarkdownHtmlForRichEditor(source, createRichMarkdownEditorCodec())
      expect(encoded).toContain(`${indent}<inside>${eol}`)
      expect(encoded).not.toContain('Outside <br/>')
    }
  })

  it.each(['    ', '\t'])('keeps %j code references separate from outside references', (indent) => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const definition = '[inside]: https://example.com/inside'
      const source = [
        `${indent}~~~`,
        `${indent}${definition}`,
        '',
        '[Outside]',
        '[outside]: https://example.com/outside'
      ].join(eol)
      const normalized = normalizeMarkdownReferenceLinks(source)
      expect(normalized).toContain(`${indent}${definition}`)
      expect(normalized).toContain('[Outside](https://example.com/outside)')
      const code = createRichMarkdownEditorCodec()
        .marked.lexer(normalized)
        .find((token) => token.type === 'code')
      expect(code && 'text' in code ? code.text : undefined).toBe(`~~~\n${definition}`)
    }
  })

  it.each(['    ', '\t'])(
    'preserves large %j literal code without a Source size refusal',
    (indent) => {
      const source = `${indent}\`\`\`\n${indent}${'a'.repeat(50_000)}\n${indent}<inside>\n`
      expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
      expect(encodeRawMarkdownHtmlForRichEditor(source, createRichMarkdownEditorCodec())).toBe(
        source
      )
    }
  )
})
