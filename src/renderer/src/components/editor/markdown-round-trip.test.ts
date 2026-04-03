import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'

function roundTripMarkdown(content: string): string {
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions(),
    content: encodeRawMarkdownHtmlForRichEditor(content),
    contentType: 'markdown'
  })

  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}

describe('rich markdown round trip', () => {
  it('preserves inline html inside paragraphs', () => {
    expect(roundTripMarkdown('Before <span>hi</span> after\n')).toBe('Before <span>hi</span> after')
  })

  it('preserves mdx-like inline tags', () => {
    expect(roundTripMarkdown('Use <Widget /> today\n')).toBe('Use <Widget /> today')
  })

  it('preserves block html and comments', () => {
    expect(roundTripMarkdown('<div>block</div>\n')).toBe('<div>block</div>')
    expect(roundTripMarkdown('<!-- comment -->\n')).toBe('<!-- comment -->')
  })

  it('preserves markdown tables', () => {
    expect(roundTripMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n')).toContain('| a')
  })
})
