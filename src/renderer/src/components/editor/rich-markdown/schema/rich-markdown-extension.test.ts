import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'

describe('Markdown source compatibility without a DOM', () => {
  it.each(['', ' ', '\n\n', '\t\n'])(
    'initializes blank source %j as an editable paragraph',
    (content) => {
      const editor = new Editor({
        element: null,
        extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
        content,
        contentType: 'markdown'
      })
      try {
        expect(editor.getJSON()).toMatchObject({ type: 'doc', content: [{ type: 'paragraph' }] })
        expect(editor.getMarkdown().trim()).toBe('')
        editor.commands.insertContentAt(1, { type: 'text', text: 'New document' })
        expect(editor.getMarkdown()).toBe('New document')
      } finally {
        editor.destroy()
      }
    }
  )

  it.each([
    '**literal**',
    '[literal](./example.md)',
    '![image](./image.png)',
    '[literal][ref]',
    '`[literal]`',
    '[literal] _emphasis_',
    String.raw`\[literal\]`,
    '<script>alert(1)</script> [literal]'
  ])('keeps typed formatting syntax %j literal after saving and reopening', (text) => {
    const editor = new Editor({
      element: null,
      extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
      content: '',
      contentType: 'markdown'
    })
    try {
      editor.commands.insertContentAt(1, { type: 'text', text })
      const reopened = new Editor({
        element: null,
        extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
        content: editor.getMarkdown(),
        contentType: 'markdown'
      })
      try {
        expect(reopened.getText()).toBe(text)
        expect(reopened.getJSON()).toEqual(editor.getJSON())
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })
})
