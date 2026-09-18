import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function withEditor<T>(source: string, read: (editor: Editor) => T): T {
  const codec = createRichMarkdownEditorCodec()
  const editor = new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
  try {
    return read(editor)
  } finally {
    editor.destroy()
  }
}

function roundTrip(source: string): string {
  return withEditor(source, (editor) => editor.getMarkdown().trimEnd())
}

function countInlineMath(source: string): number {
  return withEditor(source, (editor) => {
    let total = 0
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'inlineMath') {
        total += 1
      }
    })
    return total
  })
}

describe('inline math delimiters', () => {
  it.each([
    ['Costs are US$ 5,000 and R$ 40,000 total.'],
    ['R$ 40,000 and R$ 50,000'],
    ['The fee is $ 100 and the tax is $ 20.'],
    ['one $ two $ three'],
    ['$ not math $'],
    ['R$ 40,000 and US$5,000 in one paragraph.'],
    ['A line with US$ 5,000 here\nand another with R$ 40,000 there.']
  ])('leaves %j untouched', (source) => {
    expect(roundTrip(source)).toBe(source)
    expect(countInlineMath(source)).toBe(0)
  })

  it.each([
    ['$x$', 1],
    ['Real math: $E = mc^2$ here.', 1],
    ['$a+b$ and $c+d$ two real', 2]
  ])('still parses math in %j', (source, expected) => {
    expect(roundTrip(source)).toBe(source)
    expect(countInlineMath(source)).toBe(expected)
  })

  it('does not span a soft line break', () => {
    expect(countInlineMath('A line with US$ 5,000 here\nand another with R$ 40,000 there.')).toBe(0)
  })
})
