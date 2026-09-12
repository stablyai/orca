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

const NESTINGS = [
  ['**`B93934206`**'],
  ['`**B93934206**`'],
  ['a **`x`** b'],
  ['**bold `code` tail**'],
  ['*italic `code`*'],
  ['`**a**` and **`b`**'],
  ['***`x`***'],
  ['**`a`** and **b** and `c`']
]

describe('code mark ordering', () => {
  it.each(NESTINGS)('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(NESTINGS)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it.each([
    ['[`label`](https://example.com)'],
    ['`code` and [`linked code`](http://x.com) and **bold**'],
    ['[**bold link**](http://x.com)']
  ])('leaves the linked code label %j unchanged', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it('keeps the two nestings distinct', () => {
    expect(roundTrip('**`a`**')).not.toBe(roundTrip('`**a**`'))
  })
})
