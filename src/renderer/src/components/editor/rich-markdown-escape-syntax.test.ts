import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
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

function markdownOf(text: string): string {
  const editor = createEditor({ type: 'doc', content: [paragraph(text)] })
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

function expectReopens(editor: Editor) {
  const reopened = createEditor(editor.getMarkdown())
  try {
    expect(reopened.getJSON()).toEqual(editor.getJSON())
  } finally {
    reopened.destroy()
  }
}

describe('Markdown inline escaping of intraword underscores', () => {
  it('does not escape an underscore flanked by word characters on both sides', () => {
    expect(markdownOf('user_name_field')).toBe('user_name_field')
  })

  it('does not escape an intraword underscore next to digits', () => {
    expect(markdownOf('a_2_b')).toBe('a_2_b')
  })

  it('escapes a leading underscore that could open emphasis', () => {
    expect(markdownOf('_word')).toBe('\\_word')
  })

  it('escapes a trailing underscore that could close emphasis', () => {
    expect(markdownOf('word_')).toBe('word\\_')
  })

  it('escapes an underscore flanked by whitespace or punctuation', () => {
    expect(markdownOf('a _ b')).toBe('a \\_ b')
    expect(markdownOf('(_)')).toBe('(\\_)')
  })

  it('round-trips text containing intraword underscores without corrupting it', () => {
    const editor = createEditor({
      type: 'doc',
      content: [paragraph('see user_name_field and other_value in the config')]
    })
    try {
      expect(editor.getMarkdown()).toBe('see user_name_field and other_value in the config')
      expectReopens(editor)
    } finally {
      editor.destroy()
    }
  })

  it('still escapes every other markdown-significant character unchanged', () => {
    expect(markdownOf('a\\b *c* `d` ~e~')).toBe('a\\\\b \\*c\\* \\`d\\` \\~e\\~')
  })

  it('still escapes non-intraword emphasis-style underscore usage unchanged', () => {
    expect(markdownOf('_emphasis_')).toBe('\\_emphasis\\_')
  })
})
