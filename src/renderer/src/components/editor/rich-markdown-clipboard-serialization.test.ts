// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import {
  serializeRichMarkdownSliceAsMarkdown,
  serializeRichMarkdownSliceForClipboard
} from './rich-markdown-clipboard-serialization'
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

  it('serializes mounted partial selections without flattening structure', () => {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(
        '- first item\n- second item\n\n```ts\nconst value = 1\n```\n',
        codec
      ),
      contentType: 'markdown',
      editorProps: {
        clipboardTextSerializer: (slice) => {
          const markdown = editor.markdown
          return markdown
            ? serializeRichMarkdownSliceAsMarkdown(slice, (content) => markdown.serialize(content))
            : ''
        }
      }
    })
    try {
      const { doc } = editor.state
      const list = doc.firstChild
      expect(list?.type.name).toBe('bulletList')
      if (!list?.firstChild) {
        throw new Error('expected a list item')
      }
      const firstItemStart = 2
      const firstItemEnd = firstItemStart + list.firstChild.nodeSize
      const listSlice = doc.slice(firstItemStart, firstItemEnd)
      const markdown = editor.view.someProp('clipboardTextSerializer', (serializer) =>
        serializer(listSlice, editor.view)
      )
      expect(markdown).toContain('- first item')
      expect(markdown).not.toContain('second item')

      const codeBlock = doc.lastChild
      if (!codeBlock) {
        throw new Error('expected a code block')
      }
      const codeStart = doc.content.size - codeBlock.nodeSize
      const codeSlice = doc.slice(codeStart, doc.content.size)
      const codeClipboard = serializeRichMarkdownSliceForClipboard(editor.view, codeSlice)
      expect(codeClipboard.html).toContain('<pre')
      expect(codeClipboard.html).toContain('const value = 1')
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
