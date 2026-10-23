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
  it.each(['a.', 'Z)', 'aa.', 'zz)', 'I.', 'iii)', '1.', '3)', '1234567890.'])(
    'opens %j without throwing during Markdown initialization',
    (marker) => {
      const source = `> ${marker} first\ncontinued`
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
            `> ${marker} first\n> continued`,
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
    ['> a. x\nlazy\n> b. y\nlazy2\n', '> 1. x\nlazy\n> 2. y\nlazy2\n'],
    ['> a. x\nlazy\n> quoted para\n', '> 1. x\nlazy\n> quoted para\n'],
    ['> a. x\n>    > nested\nlazy', '> 1. x\n>    > nested\nlazy'],
    [
      '> a. x\n>    > nested\n>    > more\n> b. y\nlazy',
      '> 1. x\n>    > nested\n>    > more\n> 2. y\nlazy'
    ],
    ['> a. x\nlazy\n   > y', '> 1. x\nlazy\n   > y'],
    ['> a.\tx\nlazy\n   > y', '> 1.\tx\nlazy\n   > y'],
    // Tiptap reads a 5+ space gap as text, not code; compare with the fully quoted form.
    ['> a.     x\n>    > nested\nlazy', '> a.     x\n>    > nested\n>    > lazy'],
    ['> iv. x\n> v. y\n>    > nested\nlazy', '> iv. x\n> v. y\n>    > nested\n>    > lazy']
  ])(
    'ends the continued list at the next quoted line like a numeric list: %j',
    (source, numeric) => {
      const editor = openMarkdown(source)
      const control = openMarkdown(numeric)
      try {
        const withoutListAttrs = (json: unknown): string =>
          JSON.stringify(json).replace(/"attrs":\{[^}]*\},?/g, '')
        expect(withoutListAttrs(editor.getJSON())).toEqual(withoutListAttrs(control.getJSON()))
        const withoutMarkers = (markdown: string): string =>
          markdown.replace(/[a-zA-Z0-9]+[.)](?= )/g, '#.')
        expect(withoutMarkers(editor.getMarkdown())).toBe(withoutMarkers(control.getMarkdown()))
      } finally {
        editor.destroy()
        control.destroy()
      }
    }
  )

  // Guards a dependency bump: any item start Tiptap accepts must still reach the fallback.
  it.each([
    '> \ta. x\nlazy',
    '>     a. x\nlazy',
    '> a.\u00a0x\nlazy',
    '> 1.\u00a0x\nlazy',
    '> a.\tx\nlazy',
    '> Mr. Smith\nlazy',
    '> iv) x\nlazy',
    '> zz. x\nlazy',
    '>  > a. x\nlazy',
    '> a. x\r\nlazy'
  ])('opens %j with whitespace Tiptap accepts but Marked does not', (source) => {
    const editor = openMarkdown(source)
    try {
      expect(editor.getText()).toContain('lazy')
    } finally {
      editor.destroy()
    }
  })

  it('opens many quoted lazy continuations without nesting each into the last', () => {
    const editor = openMarkdown('> a. x\nlazy\n'.repeat(1000))
    try {
      expect(JSON.stringify(editor.getJSON()).match(/"blockquote"/g)).toHaveLength(1)
      expect(editor.getText()).toContain('lazy')
    } finally {
      editor.destroy()
    }
  })
})
