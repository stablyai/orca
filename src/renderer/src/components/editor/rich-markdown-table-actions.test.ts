// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { CellSelection, TableMap } from '@tiptap/pm/tables'
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

function cellAtText(editor: Editor, text: string): number {
  const $text = editor.state.doc.resolve(caretAtText(editor, text))
  for (let depth = $text.depth; depth > 0; depth -= 1) {
    if ($text.node(depth).type.spec.tableRole) {
      return $text.before(depth)
    }
  }
  throw new Error(`Expected table cell: ${text}`)
}

function tableDimensions(editor: Editor): { rows: number; columns: number } {
  let dimensions = { rows: 0, columns: 0 }
  editor.state.doc.descendants((node) => {
    if (node.type.spec.tableRole === 'table') {
      const tableMap = TableMap.get(node)
      dimensions = { rows: tableMap.height, columns: tableMap.width }
      return false
    }
    return true
  })
  return dimensions
}

function setFirstRowColumnWidths(editor: Editor, widths: number[]): void {
  const table = editor.state.doc.firstChild
  const row = table?.firstChild
  if (!table || table.type.name !== 'table' || !row) {
    throw new Error('Expected a table with a first row')
  }
  const transaction = editor.state.tr
  row.forEach((cell, offset, index) => {
    transaction.setNodeMarkup(2 + offset, undefined, {
      ...cell.attrs,
      colwidth: [widths[index]]
    })
  })
  editor.view.dispatch(transaction)
}

function firstRowColumnWidths(editor: Editor): number[] {
  const table = editor.state.doc.firstChild
  const row = table?.firstChild
  if (!row) {
    throw new Error('Expected a table with a first row')
  }
  const widths: number[] = []
  row.forEach((cell) => widths.push(cell.attrs.colwidth?.[0] ?? 0))
  return widths
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

  it('gives a new column an equal share of the locked table width', () => {
    const editor = createEditor()
    try {
      setFirstRowColumnWidths(editor, [200, 100])
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(runRichMarkdownTableAction(editor, 'insert-column-right')).toBe(true)
      expect(firstRowColumnWidths(editor)).toEqual([133, 100, 67])
    } finally {
      editor.destroy()
    }
  })

  it('reverts a rebalanced column insertion in a single undo', () => {
    const editor = createEditor()
    try {
      setFirstRowColumnWidths(editor, [200, 100])
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(runRichMarkdownTableAction(editor, 'insert-column-right')).toBe(true)
      expect(tableDimensions(editor).columns).toBe(3)

      editor.commands.undo()

      expect(tableDimensions(editor).columns).toBe(2)
    } finally {
      editor.destroy()
    }
  })

  it('does not throw when a cached cell position outlives the document', () => {
    const editor = createEditor()
    try {
      const cellPosition = cellAtText(editor, 'a2')
      editor.commands.setContent('Paragraph', { contentType: 'markdown' })
      expect(runRichMarkdownTableAction(editor, 'delete-row', { cellPosition })).toBe(false)
      expect(editor.getMarkdown()).toBe('Paragraph')
    } finally {
      editor.destroy()
    }
  })

  it('keeps a two-column table when one column is deleted', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(caretAtText(editor, 'b1'))
      expect(runRichMarkdownTableAction(editor, 'delete-column')).toBe(true)
      expect(tableDimensions(editor)).toEqual({ rows: 3, columns: 1 })
    } finally {
      editor.destroy()
    }
  })

  it('keeps a merged-cell table when one logical column is deleted', () => {
    const editor = createEditor()
    try {
      const firstHeader = cellAtText(editor, 'A')
      const lastHeader = cellAtText(editor, 'B')
      editor.view.dispatch(
        editor.state.tr.setSelection(
          CellSelection.create(editor.state.doc, firstHeader, lastHeader)
        )
      )
      expect(editor.chain().mergeCells().run()).toBe(true)
      const table = editor.view.dom.querySelector('table')
      expect(table?.rows.item(0)?.cells).toHaveLength(1)

      editor.commands.setTextSelection(caretAtText(editor, 'b1'))
      expect(runRichMarkdownTableAction(editor, 'delete-column')).toBe(true)
      expect(editor.isActive('table')).toBe(true)
      expect(tableDimensions(editor)).toEqual({ rows: 3, columns: 1 })
      expect(editor.state.doc.textContent).toContain('a1')
    } finally {
      editor.destroy()
    }
  })

  it('keeps a multi-row single-column table when one row is deleted', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(caretAtText(editor, 'b1'))
      expect(runRichMarkdownTableAction(editor, 'delete-column')).toBe(true)
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(runRichMarkdownTableAction(editor, 'delete-row')).toBe(true)
      expect(tableDimensions(editor)).toEqual({ rows: 2, columns: 1 })
      expect(editor.isActive('table')).toBe(true)
    } finally {
      editor.destroy()
    }
  })

  it('targets the clicked cell instead of a stale caret', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(
        runRichMarkdownTableAction(editor, 'delete-row', {
          cellPosition: cellAtText(editor, 'b2')
        })
      ).toBe(true)
      expect(editor.getMarkdown()).toContain('a1')
      expect(editor.getMarkdown()).not.toContain('a2')
    } finally {
      editor.destroy()
    }
  })

  it('does not mutate stale selection when coordinate targeting fails', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      const before = editor.getMarkdown()
      const originalPosAtCoords = editor.view.posAtCoords
      editor.view.posAtCoords = () => {
        throw new Error('view unavailable')
      }
      expect(runRichMarkdownTableAction(editor, 'delete-row', { clientX: 10, clientY: 20 })).toBe(
        false
      )
      expect(editor.getMarkdown()).toBe(before)
      editor.view.posAtCoords = originalPosAtCoords
    } finally {
      editor.destroy()
    }
  })

  it('preserves a multi-cell selection when the clicked cell belongs to it', () => {
    const editor = createEditor()
    try {
      const first = cellAtText(editor, 'a1')
      const last = cellAtText(editor, 'b2')
      editor.view.dispatch(
        editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last))
      )
      expect(runRichMarkdownTableAction(editor, 'delete-row', { cellPosition: last })).toBe(true)
      expect(tableDimensions(editor)).toEqual({ rows: 1, columns: 2 })
      expect(editor.getMarkdown()).not.toContain('a1')
      expect(editor.getMarkdown()).not.toContain('a2')
    } finally {
      editor.destroy()
    }
  })

  it('protects the Markdown header boundary', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(caretAtText(editor, 'A'))
      expect(runRichMarkdownTableAction(editor, 'insert-row-above')).toBe(false)
      expect(runRichMarkdownTableAction(editor, 'delete-row')).toBe(false)
      expect(tableDimensions(editor)).toEqual({ rows: 3, columns: 2 })
    } finally {
      editor.destroy()
    }
  })

  it('deletes the table when its final column is removed', () => {
    const editor = runAction('delete-column', 'b1')
    try {
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(runRichMarkdownTableAction(editor, 'delete-column')).toBe(true)
      expect(editor.getMarkdown()).not.toContain('|')
    } finally {
      editor.destroy()
    }
  })

  it('deletes a one-row headerless table instead of leaving an invalid shell', () => {
    const editor = createEditor()
    try {
      editor.commands.setContent('Before', { contentType: 'markdown' })
      editor.commands.setTextSelection(1)
      editor.commands.insertTable({ rows: 1, cols: 2, withHeaderRow: false })
      expect(runRichMarkdownTableAction(editor, 'delete-row')).toBe(true)
      expect(editor.isActive('table')).toBe(false)
    } finally {
      editor.destroy()
    }
  })

  it('serializes and reopens after structural edits', () => {
    const editor = runAction('insert-column-right', 'b1')
    const markdown = editor.getMarkdown()
    editor.destroy()
    const reopened = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: markdown,
      contentType: 'markdown'
    })
    try {
      expect(tableDimensions(reopened)).toEqual({ rows: 3, columns: 3 })
      expect(markdown).toMatch(/\|\s*-{3,}/)
    } finally {
      reopened.destroy()
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
