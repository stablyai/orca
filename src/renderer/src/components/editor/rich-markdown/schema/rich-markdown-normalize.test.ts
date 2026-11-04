import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from './isolated-markdown-extension-for-tests'
import { normalizeEmptyListItems } from './rich-markdown-normalize'

const extensions = [StarterKit, createIsolatedMarkdownExtensionForTests()]

afterEach(() => {
  vi.restoreAllMocks()
})

function createEditor(content: string): Editor {
  return new Editor({
    element: null,
    extensions,
    content,
    contentType: 'markdown'
  })
}

describe('rich markdown normalization', () => {
  it('normalizes empty ordered list items into caret targets', () => {
    const editor = createEditor('1. Item 1\n2. Item 2\n3. \n\n## Next section\n')

    try {
      normalizeEmptyListItems(editor)

      const list = editor.state.doc.child(0)
      const emptyItem = list.child(2)
      expect(emptyItem.type.name).toBe('listItem')
      expect(emptyItem.childCount).toBe(1)
      expect(emptyItem.child(0).type.name).toBe('paragraph')
      expect(emptyItem.child(0).content.size).toBe(0)
    } finally {
      editor.destroy()
    }
  })
})
