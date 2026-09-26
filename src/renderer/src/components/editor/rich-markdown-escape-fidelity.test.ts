import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it, vi } from 'vitest'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
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

function expectReopens(editor: Editor, reopen = createEditor): void {
  const reopened = reopen(editor.getMarkdown())
  try {
    expect(reopened.getJSON()).toEqual(editor.getJSON())
  } finally {
    reopened.destroy()
  }
}

function createRichEditor(content: JSONContent | string) {
  const codec = createRichMarkdownEditorCodec()
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec }),
    content:
      typeof content === 'string' ? encodeRawMarkdownHtmlForRichEditor(content, codec) : content,
    ...(typeof content === 'string' ? { contentType: 'markdown' as const } : {})
  })
}

describe('optional Markdown escapes', () => {
  it.each(['user_name_field', 'a_2_b', 'a__b', 'пристаням_стремятся', '𐐀_𐐁', 'é_value'])(
    'preserves intraword underscores in %s',
    (text) => {
      const editor = createEditor({ type: 'doc', content: [paragraph(text)] })
      try {
        expect(editor.getMarkdown()).toBe(text)
        expectReopens(editor)
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['__init__', '___init___', '_word_', 'see a. __b__c', 'a\\_b', 'a\\\\_b'])(
    'keeps literal delimiter runs and backslashes safe: %s',
    (text) => {
      const editor = createEditor({ type: 'doc', content: [paragraph(text)] })
      try {
        expectReopens(editor)
      } finally {
        editor.destroy()
      }
    }
  )

  it('preserves identifiers alongside emphasis-like literals', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph('__init__ user_name')] })
    try {
      expect(editor.getMarkdown()).toContain('user_name')
      expectReopens(editor)
    } finally {
      editor.destroy()
    }
  })

  it('preserves callouts and identifiers in nested containers', () => {
    const source = '> [!NOTE] user_name\n>\n> - [literal] a__b\n\n- outer_name\n  - inner_name'
    const editor = createEditor(source)
    try {
      expect(editor.getMarkdown()).toContain('> [!NOTE] user_name')
      expect(editor.getMarkdown()).toContain('[literal] a__b')
      expect(editor.getMarkdown()).toContain('inner_name')
      expectReopens(editor)
    } finally {
      editor.destroy()
    }
  })

  it('validates marks across adjacent text nodes', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a_' },
            { type: 'text', text: '_b_', marks: [{ type: 'bold' }] },
            { type: 'text', text: '_c user_name' }
          ]
        }
      ]
    })
    try {
      expect(editor.getMarkdown()).toContain('user_name')
      expectReopens(editor)
    } finally {
      editor.destroy()
    }
  })

  it('does not activate definitions nested in another block', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('[ref]'), { type: 'blockquote', content: [paragraph('[ref]: /target')] }]
    })
    try {
      expectReopens(editor)
    } finally {
      editor.destroy()
    }
  })
})

describe('literal escape validation boundaries', () => {
  it('validates a nested container once and caches unchanged blocks', () => {
    const editor = createEditor('> [!NOTE] user_name\n>\n> - inner_value')
    const parse = vi.spyOn(editor.markdown!, 'parse')
    try {
      expect(editor.getMarkdown()).toContain('[!NOTE] user_name')
      expect(parse).toHaveBeenCalledTimes(1)
      editor.getMarkdown()
      expect(parse).toHaveBeenCalledTimes(1)
      editor.commands.insertContentAt(3, { type: 'text', text: 'edit ' })
      editor.getMarkdown()
      expect(parse).toHaveBeenCalledTimes(2)
      expectReopens(editor)
    } finally {
      parse.mockRestore()
      editor.destroy()
    }
  })

  it('skips optional validation for an oversized block', () => {
    const editor = createEditor({ type: 'doc', content: [paragraph(`${'a_'.repeat(25_001)}b`)] })
    const parse = vi.spyOn(editor.markdown!, 'parse')
    try {
      expect(editor.getMarkdown()).toContain('a\\_')
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
      editor.destroy()
    }
  })

  it.each([
    '> [!TIP] user_name\n>\n> - [x] inner_value',
    '> user_name <span data-value="literal_[]">raw\\_value</span>',
    '<div>literal\\_[]</div>\n\nuser_name',
    '> user_name `literal\\_[]`',
    '```text\nliteral\\_[]\n```\n\nuser_name',
    '[ref]\n\n> [ref]: /target\n>\n> tail',
    '> [ref]\n\n[ref]: /target'
  ])('preserves source ownership and reopen semantics: %s', (source) => {
    const editor = createRichEditor(source)
    try {
      expectReopens(editor, createRichEditor)
      if (source.includes('<div>')) {
        expect(editor.getMarkdown()).toContain('<div>literal\\_[]</div>')
      }
      if (source.includes('<span')) {
        expect(editor.getMarkdown()).toContain('<span data-value="literal_[]">')
      }
    } finally {
      editor.destroy()
    }
  })
})
