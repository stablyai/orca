import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it, vi } from 'vitest'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'

function createEditor(content: JSONContent | string) {
  return new Editor({
    element: null,
    extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
    content,
    ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {})
  })
}

function paragraph(text: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

function expectReopens(editor: Editor) {
  const reopened = createEditor(editor.getMarkdown())
  try {
    expect(reopened.getJSON()).toEqual(editor.getJSON())
  } finally {
    reopened.destroy()
  }
}

describe('literal Markdown serialization', () => {
  it.each(['[ref]: ./target.md', '[ref]: <./target.md> "Title"'])(
    'preserves literal references across blocks with definition %j',
    (definition) => {
      const editor = createEditor({
        type: 'doc',
        content: [paragraph('[literal][ref] and [ref]'), paragraph(definition)]
      })
      try {
        expectReopens(editor)
      } finally {
        editor.destroy()
      }
    }
  )

  it('reuses unchanged blocks but revalidates edited syntax', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('[literal]'), paragraph('[[]]')]
    })
    const parse = vi.spyOn(editor.markdown!, 'parse')
    try {
      expect(editor.getMarkdown()).toBe('[literal]\n\n[[]]')
      expect(parse).toHaveBeenCalledTimes(2)
      editor.getMarkdown()
      expect(parse).toHaveBeenCalledTimes(2)
      editor.commands.insertContentAt(10, { type: 'text', text: '(./target.md)' })
      const saved = editor.getMarkdown()
      expect(parse).toHaveBeenCalledTimes(3)
      expect(saved).toContain('\\[literal\\]')
      expectReopens(editor)
    } finally {
      parse.mockRestore()
      editor.destroy()
    }
  })

  it('keeps upstream escaping when the parser cannot validate a block', () => {
    const editor = createEditor('[[]]')
    const upstream = editor.markdown!.serialize(editor.getJSON())
    const parse = vi.spyOn(editor.markdown!, 'parse').mockImplementation(() => {
      throw new Error('custom parser failure')
    })
    try {
      expect(editor.getMarkdown()).toBe(upstream)
    } finally {
      parse.mockRestore()
      editor.destroy()
    }
  })

  it('preserves headings, marked text, and nested blocks', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '[[]]' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '[literal]', marks: [{ type: 'bold' }] }]
        },
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [paragraph('[literal](./a)')] }]
        }
      ]
    })
    try {
      expectReopens(editor)
    } finally {
      editor.destroy()
    }
  })
})
