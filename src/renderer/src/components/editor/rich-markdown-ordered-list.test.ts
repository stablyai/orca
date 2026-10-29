// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

function openMarkdown(source: string): Editor {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content: encodeRawMarkdownHtmlForRichEditor(source, codec),
    contentType: 'markdown'
  })
}

function orderedListCount(editor: Editor): number {
  return JSON.stringify(editor.getJSON()).match(/"type":"orderedList"/g)?.length ?? 0
}

describe('rich markdown ordered list markers', () => {
  it.each([
    'Mr. Smith came back.\n\nDr. Jones looked at him.\n\nSt. Louis was a long way off.',
    'A. Smith wrote back.\n\nOK. That works.\n\niv. is not a list here.\n\nI. said so.',
    '> a. first\n> continued'
  ])('keeps %j as prose when opened and saved', (source) => {
    const editor = openMarkdown(source)
    try {
      expect(orderedListCount(editor)).toBe(0)
      expect(editor.getMarkdown()).toBe(source)
    } finally {
      editor.destroy()
    }
  })

  it.each([
    ['1. one\n2. two\n\nDr. Smith said.', 1],
    ['1. one\nDr. Smith said.', 1],
    ['3. three\n4. four', 1],
    ['1. parent\n   1. child\n   2. child two\n2. sibling', 2],
    ['1. [ ] task\n2. [x] done', 1]
  ] as const)('round-trips numeric list %j unchanged', (source, lists) => {
    const editor = openMarkdown(source)
    try {
      expect(orderedListCount(editor)).toBe(lists)
      expect(editor.getMarkdown()).toBe(source)
    } finally {
      editor.destroy()
    }
  })

  it('saves a lettered list pasted as HTML with numeric markers', () => {
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: '<ol type="a" start="2"><li><p>x</p></li><li><p>y</p></li></ol>'
    })
    try {
      expect(editor.getMarkdown()).toBe('2. x\n3. y')
    } finally {
      editor.destroy()
    }
  })
})
