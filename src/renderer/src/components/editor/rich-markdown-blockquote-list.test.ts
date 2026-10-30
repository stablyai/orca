import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

function openMarkdown(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

describe('rich markdown blockquote list continuations', () => {
  // A no-break space reaches the fallback (only Tiptap reads it); plain spaces are controls.
  it.each(['1.\u00a0', '3)\u00a0', '1234567890.\u00a0', '1. ', '3) '])(
    'opens %j without throwing during Markdown initialization',
    (marker) => {
      const source = `> ${marker}first\ncontinued`
      const codec = createRichMarkdownEditorCodec()
      const editor = new Editor({
        element: null,
        extensions: createRichMarkdownExtensions({ codec }),
        content: encodeRawMarkdownHtmlForRichEditor(source, codec),
        contentType: 'markdown'
      })
      try {
        expect(editor.getText()).toContain('first')
        expect(editor.getText()).toContain('continued')
        expect(editor.getJSON().content?.[0]?.type).toBe('blockquote')
        expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
          type: 'orderedList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }]
        })
        const expectedCodec = createRichMarkdownEditorCodec()
        const expected = new Editor({
          element: null,
          extensions: createRichMarkdownExtensions({ codec: expectedCodec }),
          content: encodeRawMarkdownHtmlForRichEditor(
            `> ${marker}first\n> continued`,
            expectedCodec
          ),
          contentType: 'markdown'
        })
        try {
          expect(editor.getJSON()).toEqual(expected.getJSON())
        } finally {
          expected.destroy()
        }
      } finally {
        editor.destroy()
      }
    }
  )

  it.each([
    ['> 1.\u00a0x\nlazy\n> 2.\u00a0y\nlazy2\n', '> 1. x\nlazy\n> 2. y\nlazy2\n'],
    ['> 1.\u00a0x\nlazy\n> quoted para\n', '> 1. x\nlazy\n> quoted para\n'],
    ['> 1.\u00a0x\n>    > nested\nlazy', '> 1. x\n>    > nested\nlazy'],
    [
      '> 1.\u00a0x\n>    > nested\n>    > more\n> 2.\u00a0y\nlazy',
      '> 1. x\n>    > nested\n>    > more\n> 2. y\nlazy'
    ],
    ['> 1.\u00a0x\nlazy\n   > y', '> 1. x\nlazy\n   > y'],
    // Tiptap reads a 5+ space gap as text, not code; compare with the fully quoted form.
    ['> 1.\u00a0    x\n>    > nested\nlazy', '> 1.\u00a0    x\n>    > nested\n>    > lazy']
  ])('ends the continued list at the next quoted line: %j', (source, control) => {
    const editor = openMarkdown(source)
    const expected = openMarkdown(control)
    try {
      expect(editor.getJSON()).toEqual(expected.getJSON())
      expect(editor.getMarkdown()).toBe(expected.getMarkdown())
    } finally {
      editor.destroy()
      expected.destroy()
    }
  })

  // Guards a dependency bump: any item start Tiptap accepts must still reach the fallback.
  it.each([
    '> \t1. x\nlazy',
    '>     1. x\nlazy',
    '> 1.\u00a0x\nlazy',
    '> 4)\u00a0x\nlazy',
    '>  > 1.\u00a0x\nlazy',
    '> 1.\u00a0x\r\nlazy'
  ])('opens %j with whitespace Tiptap accepts but Marked does not', (source) => {
    const editor = openMarkdown(source)
    try {
      expect(editor.getText()).toContain('lazy')
    } finally {
      editor.destroy()
    }
  })

  it('opens many quoted lazy continuations without nesting each into the last', () => {
    const editor = openMarkdown('> 1.\u00a0x\nlazy\n'.repeat(1000))
    try {
      expect(JSON.stringify(editor.getJSON()).match(/"blockquote"/g)).toHaveLength(1)
      expect(editor.getText()).toContain('lazy')
    } finally {
      editor.destroy()
    }
  })
})
