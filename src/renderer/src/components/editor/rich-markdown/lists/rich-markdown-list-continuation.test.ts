import { describe, expect, it } from 'vitest'
import { Editor, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { createIsolatedMarkdownExtensionForTests } from '../schema/isolated-markdown-extension-for-tests'
import {
  collapseEmptyListContinuationParagraph,
  convertEmptyNestedOrderedItemToContinuation
} from './rich-markdown-list-continuation'

function createEditor(content: JSONContent): Editor {
  // Isolate each editor’s marked registry so tokenizer state cannot accumulate across tests.
  return new Editor({
    element: null,
    extensions: [StarterKit, createIsolatedMarkdownExtensionForTests()],
    content
  })
}

describe('rich markdown list continuation', () => {
  it('converts an empty nested ordered item into a parent-list continuation paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Leverage an existing CLI/project' }]
                },
                {
                  type: 'orderedList',
                  attrs: { start: 1, type: null },
                  content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }]
                }
              ]
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Implement CLI' }] }]
            }
          ]
        }
      ]
    })

    try {
      editor.commands.setTextSelection(39)

      expect(convertEmptyNestedOrderedItemToContinuation(editor)).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual({
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            attrs: { start: 1, type: null },
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Leverage an existing CLI/project' }]
                  },
                  { type: 'paragraph' }
                ]
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Implement CLI' }] }]
              }
            ]
          }
        ]
      })
      expect(editor.getMarkdown()).not.toContain('  1.')
    } finally {
      editor.destroy()
    }
  })

  it('collapses an empty continuation paragraph back to the parent list item text', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'fsdfsf' }] },
                { type: 'paragraph' }
              ]
            }
          ]
        }
      ]
    })

    try {
      editor.commands.setTextSelection(11)

      expect(collapseEmptyListContinuationParagraph(editor)).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual({
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            attrs: { start: 1, type: null },
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'fsdfsf' }] }]
              }
            ]
          }
        ]
      })
      expect(editor.state.selection.from).toBe(9)
      expect(editor.getMarkdown()).toBe('1. fsdfsf')
    } finally {
      editor.destroy()
    }
  })
})
