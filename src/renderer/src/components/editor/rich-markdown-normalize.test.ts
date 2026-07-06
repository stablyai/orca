import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { normalizeEmptyListItems, normalizeSoftBreaks } from './rich-markdown-normalize'

const extensions = [StarterKit, Markdown.configure({ markedOptions: { gfm: true } })]

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

  it('leaves hard-wrapped document prose as one paragraph', () => {
    const editor = createEditor('Line one\nLine two\nLine three')

    try {
      normalizeEmptyListItems(editor)

      expect(editor.state.doc.childCount).toBe(1)
      expect(editor.state.doc.child(0).type.name).toBe('paragraph')
      expect(editor.state.doc.child(0).textContent).toBe('Line one\nLine two\nLine three')
    } finally {
      editor.destroy()
    }
  })

  it('keeps soft-break splitting without splitting text nodes', () => {
    const editor = createEditor('Line one\nLine two\nLine three')

    try {
      const split = vi.spyOn(String.prototype, 'split')

      normalizeSoftBreaks(editor)

      expect(editor.state.doc.childCount).toBe(3)
      expect(editor.state.doc.child(0).textContent).toBe('Line one')
      expect(editor.state.doc.child(1).textContent).toBe('Line two')
      expect(editor.state.doc.child(2).textContent).toBe('Line three')
      expect(split).not.toHaveBeenCalled()
    } finally {
      editor.destroy()
    }
  })
})
