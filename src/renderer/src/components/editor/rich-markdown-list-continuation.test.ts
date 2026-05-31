import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import {
  collapseEmptyListContinuationParagraph,
  commitEmptyOrderedListMarkerAsText,
  convertEmptyNestedOrderedItemToContinuation,
  exitTrailingEmptyOrderedListItem,
  isSingleEmptyTopLevelOrderedList
} from './rich-markdown-list-continuation'

const extensions = [StarterKit, Markdown.configure({ markedOptions: { gfm: true } })]

function createEditor(content: object): Editor {
  return new Editor({
    element: null,
    extensions,
    content
  })
}

function firstEmptyParagraphPosition(editor: Editor): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      position = pos + 1
      return false
    }

    return true
  })

  if (position === null) {
    throw new Error('Expected an empty paragraph in the test document')
  }

  return position
}

describe('rich markdown list continuation', () => {
  it('preserves a typed empty ordered-list marker when Enter is pressed', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }]
        }
      ]
    })

    try {
      editor.commands.setTextSelection(3)

      expect(isSingleEmptyTopLevelOrderedList(editor)).toBe(true)
      expect(commitEmptyOrderedListMarkerAsText(editor)).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '1.' }] },
          { type: 'paragraph' }
        ]
      })
      expect(editor.getMarkdown()).toBe('1.\n\n')
    } finally {
      editor.destroy()
    }
  })

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

  it('leaves non-empty ordered list items to the default Enter behavior', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] }]
            }
          ]
        }
      ]
    })

    try {
      editor.commands.setTextSelection(8)

      expect(isSingleEmptyTopLevelOrderedList(editor)).toBe(false)
      expect(commitEmptyOrderedListMarkerAsText(editor)).toBe(false)
      expect(editor.getMarkdown()).toBe('1. Parent')
    } finally {
      editor.destroy()
    }
  })

  it('exits a loaded trailing empty ordered-list item into a body paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }]
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }]
            },
            { type: 'listItem', content: [{ type: 'paragraph' }] }
          ]
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Next section' }] }
      ]
    })

    try {
      editor.commands.setTextSelection(firstEmptyParagraphPosition(editor))

      expect(exitTrailingEmptyOrderedListItem(editor)).toBe(true)
      expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
      expect(editor.state.selection.$from.depth).toBe(1)
      expect(editor.state.doc.toJSON()).toEqual({
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            attrs: { start: 1, type: null },
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 1' }] }]
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item 2' }] }]
              }
            ]
          },
          { type: 'paragraph' },
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Next section' }]
          }
        ]
      })
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

  it('leaves non-empty nested ordered items to the default Backspace behavior', () => {
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
                { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
                {
                  type: 'orderedList',
                  attrs: { start: 1, type: null },
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    })

    try {
      editor.commands.setTextSelection(13)

      expect(convertEmptyNestedOrderedItemToContinuation(editor)).toBe(false)
      expect(editor.getMarkdown()).toContain('1. Child')
    } finally {
      editor.destroy()
    }
  })
})
