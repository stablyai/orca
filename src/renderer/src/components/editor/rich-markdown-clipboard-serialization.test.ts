import { Editor } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { serializeRichMarkdownSliceAsMarkdown } from './rich-markdown-clipboard-serialization'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

describe('rich Markdown clipboard serialization', () => {
  it.each([
    'First paragraph.\n\nSecond paragraph.',
    '# Heading\n\nA **bold** paragraph with a [link](https://example.com).',
    '# Heading\n\n- First item\n- Second item\n\nLast paragraph.'
  ])('preserves block boundaries when copying %s', (source) => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec),
      contentType: 'markdown'
    })
    try {
      const slice = editor.state.doc.slice(0, editor.state.doc.content.size)
      const original = editor.state.doc
      const manager = editor.markdown
      if (!manager) {
        throw new Error('Markdown manager is required')
      }
      const markdown = serializeRichMarkdownSliceAsMarkdown(slice, (content) =>
        manager.serialize(content)
      )
      expect(markdown).toBe(source)
      editor.commands.setContent(encodeRawMarkdownHtmlForRichEditor(markdown, codec), {
        contentType: 'markdown'
      })
      expect(editor.state.doc.eq(original)).toBe(true)
    } finally {
      editor.destroy()
    }
  })

  it('copies only the selected inline text and retains its mark', () => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor('A **bold** paragraph.', codec),
      contentType: 'markdown'
    })
    try {
      const slice = editor.state.doc.slice(3, 7)
      const manager = editor.markdown
      if (!manager) {
        throw new Error('Markdown manager is required')
      }
      const markdown = serializeRichMarkdownSliceAsMarkdown(slice, (content) =>
        manager.serialize(content)
      )
      expect(markdown).toBe('**bold**')
      editor.commands.setContent(markdown, { contentType: 'markdown' })
      expect(editor.getJSON()).toEqual({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }]
          }
        ]
      })
    } finally {
      editor.destroy()
    }
  })

  it('returns empty text without serializing an empty selection', () => {
    const serialize = vi.fn(() => 'unexpected content')
    expect(serializeRichMarkdownSliceAsMarkdown(Slice.empty, serialize)).toBe('')
    expect(serialize).not.toHaveBeenCalled()
  })
})
