import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
function roundTrip(source: string): string {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return editor.getMarkdown().trimEnd()
  } finally {
    editor.destroy()
  }
}
describe('ordered list start values', () => {
  it('preserves a zero-start ordered list', () => {
    const source = '0. zero\n1. one'
    expect(roundTrip(source)).toBe(source)
  })
  it('keeps a zero-start list stable across repeated saves', () => {
    let current = '0. zero\n1. one'
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe('0. zero\n1. one')
  })
  it('does not change ordinary ordered lists', () => {
    expect(roundTrip('1. one\n2. two')).toBe('1. one\n2. two')
  })
})
