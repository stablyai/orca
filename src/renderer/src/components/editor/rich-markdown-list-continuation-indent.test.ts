import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  normalizeOrderedContinuationIndent,
  orderedContentColumn
} from './rich-markdown-list-continuation-indent'
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

const SHAPES = [
  ['9. Single digit item and words here\n   and must stay inside item 9.'],
  ['10. Two digit item and words here\n    and must stay inside item 10.'],
  ['- Bullet item\n  continuation line here.'],
  ['10. An item mentioning the 12-step\n     write-up are in the folder.'],
  ['1. First\n   cont one.\n2. Second\n   cont two.'],
  ['9. Nine item\n   cont nine.\n10. Ten item\n    cont ten.'],
  ['1. Outer\n   cont outer.\n   1. Inner\n      cont inner.'],
  ['1. Item with a block\n\n   A second paragraph inside.'],
  ['100. Three digit\n     cont three.']
]

describe('orderedContentColumn', () => {
  it.each([
    ['9. item', 3],
    ['10. item', 4],
    ['100. item', 5],
    ['   1. nested', 6]
  ])('measures %j as %i', (line, expected) => {
    expect(orderedContentColumn(line)).toBe(expected)
  })

  it('returns null for a line that is not an ordered item', () => {
    expect(orderedContentColumn('- bullet')).toBeNull()
  })
})

describe('normalizeOrderedContinuationIndent', () => {
  it('rewrites a two-digit continuation to the width the tokenizer assumes', () => {
    expect(normalizeOrderedContinuationIndent('10. item\n    cont.')).toBe('10. item\n  cont.')
  })

  it('leaves a single-digit continuation alone', () => {
    expect(normalizeOrderedContinuationIndent('9. item\n   cont.')).toBe('9. item\n  cont.')
  })
})

describe('list continuation round trip', () => {
  it.each(SHAPES)('preserves %j', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each(SHAPES)('keeps %j stable across three cycles', (source) => {
    let current = source
    for (let cycle = 0; cycle < 3; cycle += 1) {
      current = roundTrip(current)
    }
    expect(current).toBe(source)
  })

  it('keeps the continuation inside its item rather than deleting characters', () => {
    const source = '10. An item mentioning the 12-step\n     write-up are in the folder.'
    expect(roundTrip(roundTrip(roundTrip(source)))).toContain('write-up')
  })
})

describe('hard break inside a list item', () => {
  it.each([
    ['1. line1  \n   line2', 3],
    ['10. line1  \n    line2', 4],
    ['100. line1  \n     line2', 5],
    ['- line1  \n  line2', 2]
  ])('gives %j the item content column of %i', (source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each([['1. line1  \n   line2'], ['10. line1  \n    line2'], ['- line1  \n  line2']])(
    'keeps %j stable across three cycles',
    (source) => {
      let current = source
      for (let cycle = 0; cycle < 3; cycle += 1) {
        current = roundTrip(current)
      }
      expect(current).toBe(source)
    }
  )

  it('indents an unindented hard-break continuation to the content column', () => {
    expect(roundTrip('1. line1  \nline2')).toBe('1. line1  \n   line2')
    expect(roundTrip('10. line1  \nline2')).toBe('10. line1  \n    line2')
  })

  it('gives every hard-break line the same column', () => {
    expect(roundTrip('1. line1  \n   line2  \n   line3')).toBe('1. line1  \n   line2  \n   line3')
  })
})
