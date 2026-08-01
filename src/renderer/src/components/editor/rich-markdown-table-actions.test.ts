// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  runRichMarkdownTableAction,
  type RichMarkdownTableAction
} from './rich-markdown-table-actions'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

function createEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: TABLE,
    contentType: 'markdown'
  })
}

function caretAtText(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || node.text !== text) {
      return true
    }
    position = pos
    return false
  })
  if (position === null) {
    throw new Error(`Expected cell text: ${text}`)
  }
  return position
}

function tableDimensions(editor: Editor): { rows: number; columns: number } {
  let rows = 0
  let columns = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      rows += 1
      columns = Math.max(columns, node.childCount)
    }
  })
  return { rows, columns }
}

function runAction(action: RichMarkdownTableAction, cellText: string): Editor {
  const editor = createEditor()
  editor.commands.setTextSelection(caretAtText(editor, cellText))
  expect(runRichMarkdownTableAction(editor, action)).toBe(true)
  return editor
}

describe('rich markdown table actions', () => {
  it.each([
    ['insert-row-above', { rows: 4, columns: 2 }],
    ['insert-row-below', { rows: 4, columns: 2 }],
    ['insert-column-left', { rows: 3, columns: 3 }],
    ['insert-column-right', { rows: 3, columns: 3 }]
  ] as const)('runs %s from the current cell', (action, expectedDimensions) => {
    const editor = runAction(action, 'a1')
    try {
      expect(tableDimensions(editor)).toEqual(expectedDimensions)
      expect(editor.getMarkdown()).toContain('| ---')
    } finally {
      editor.destroy()
    }
  })

  it('deletes the current body row', () => {
    const editor = runAction('delete-row', 'a1')
    try {
      expect(tableDimensions(editor)).toEqual({ rows: 2, columns: 2 })
      expect(editor.getMarkdown()).not.toContain('a1')
      expect(editor.getMarkdown()).toContain('a2')
    } finally {
      editor.destroy()
    }
  })

  it('deletes the current column', () => {
    const editor = runAction('delete-column', 'b1')
    try {
      expect(tableDimensions(editor)).toEqual({ rows: 3, columns: 1 })
      expect(editor.getMarkdown()).not.toContain('B')
      expect(editor.getMarkdown()).not.toContain('b1')
      expect(editor.getMarkdown()).toContain('a1')
    } finally {
      editor.destroy()
    }
  })

  it('does nothing outside a table', () => {
    const editor = createEditor()
    try {
      editor.commands.setContent('Paragraph', { contentType: 'markdown' })
      expect(runRichMarkdownTableAction(editor, 'insert-row-below')).toBe(false)
      expect(editor.getMarkdown()).toBe('Paragraph')
    } finally {
      editor.destroy()
    }
  })
})
