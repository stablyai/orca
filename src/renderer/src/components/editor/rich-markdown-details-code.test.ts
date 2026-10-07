import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { isEditableDetailsHtmlBlock, matchDetailsHtmlBlock } from './details-markdown-html'

function parse(content: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(content, codec),
    contentType: 'markdown'
  })
}

describe('details mentions in Markdown code', () => {
  it('keeps literal backticks inside a code span in one parsed paragraph', () => {
    const editor = parse('Text with `` `<details>` `` inline.')
    try {
      expect(editor.state.doc.childCount).toBe(1)
      expect(editor.state.doc.textContent).toBe('Text with `<details>` inline.')
      editor.state.doc.check()
    } finally {
      editor.destroy()
    }
  })

  it.each([
    '`<details>`',
    '`<details>` is the HTML tag.',
    'Text with `<details>` inline and a `<summary>` mention.',
    '```html\n<details>\n<summary>Example</summary>\n</details>\n```'
  ])('keeps code mentions literal when parsing and saving %j', (content) => {
    const editor = parse(content)
    try {
      editor.state.doc.check()
      let detailsCount = 0
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'details') {
          detailsCount += 1
        }
      })
      expect(detailsCount).toBe(0)
      expect(editor.getMarkdown().trimEnd()).toBe(content)
    } finally {
      editor.destroy()
    }
  })

  it.each([
    'Mention `</details>` inline.',
    'Mention `<details>text</details>` inline.',
    '```html\n<details>\n</details>\n```'
  ])('does not pair real details with code mention %j', (body) => {
    const content = `<details>\n<summary>Outer</summary>\n\n${body}\n\n</details>`
    const block = matchDetailsHtmlBlock(content, 0)
    expect(block?.raw).toBe(content)
    expect(block && isEditableDetailsHtmlBlock(block)).toBe(false)
    const editor = parse(content)
    try {
      editor.state.doc.check()
      expect(editor.getMarkdown().trimEnd()).toBe(content)
    } finally {
      editor.destroy()
    }
  })
})
