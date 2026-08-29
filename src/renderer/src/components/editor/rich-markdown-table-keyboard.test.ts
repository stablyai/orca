import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { handleRichMarkdownTableBackspace } from './rich-markdown-table-row-delete'
import { handleRichMarkdownTableEnter } from './rich-markdown-table-enter'
import { handleRichMarkdownTableTab } from './rich-markdown-table-tab'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

// Middle body row parses to two empty cells.
const TABLE_WITH_EMPTY_ROW = `| Name | Value |
| --- | --- |
| keep | a |
|  |  |
| stay | c |
`

function createEditor(content = TABLE): Editor {
  return new Editor({
    element: null,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

function countRows(editor: Editor): number {
  let count = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') {
      count += 1
    }
  })
  return count
}

function hasTable(editor: Editor): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'table') {
      found = true
    }
    return !found
  })
  return found
}

/** Caret at the start of the text node holding `text`. */
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

/** Caret in the nth cell (0-based) of the first row where `predicate` holds. */
function caretInRow(
  editor: Editor,
  predicate: (rowText: string) => boolean,
  cellIndex = 0
): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'tableRow' || !predicate(node.textContent)) {
      return true
    }
    let offset = pos + 1
    for (let index = 0; index < cellIndex; index += 1) {
      offset += node.child(index).nodeSize
    }
    // cell open + paragraph open
    position = offset + 2
    return false
  })
  if (position === null) {
    throw new Error('Expected a matching table row')
  }
  return position
}

function selectionText(editor: Editor): string {
  return editor.state.selection.$from.parent.textContent
}

function withEditor(content: string, run: (editor: Editor) => void): void {
  const editor = createEditor(content)
  try {
    run(editor)
  } finally {
    editor.destroy()
  }
}

describe('handleRichMarkdownTableTab', () => {
  it('moves Tab to the next cell', () => {
    withEditor(TABLE, (editor) => {
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(handleRichMarkdownTableTab(editor, false)).toBe(true)
      expect(selectionText(editor)).toBe('b1')
    })
  })

  it('moves Shift-Tab to the previous cell', () => {
    withEditor(TABLE, (editor) => {
      editor.commands.setTextSelection(caretAtText(editor, 'b1'))
      expect(handleRichMarkdownTableTab(editor, true)).toBe(true)
      expect(selectionText(editor)).toBe('a1')
    })
  })

  it('wraps Tab to the next row', () => {
    withEditor(TABLE, (editor) => {
      editor.commands.setTextSelection(caretAtText(editor, 'b1'))
      expect(handleRichMarkdownTableTab(editor, false)).toBe(true)
      expect(selectionText(editor)).toBe('a2')
    })
  })

  it('adds a row when Tab is pressed in the last cell', () => {
    withEditor(TABLE, (editor) => {
      const rowsBefore = countRows(editor)
      editor.commands.setTextSelection(caretAtText(editor, 'b2') + 'b2'.length)
      expect(handleRichMarkdownTableTab(editor, false)).toBe(true)
      expect(countRows(editor)).toBe(rowsBefore + 1)
      expect(selectionText(editor)).toBe('')
      expect(editor.isActive('table')).toBe(true)
    })
  })

  it('does not claim Tab outside tables', () => {
    withEditor('Just a paragraph.\n', (editor) => {
      editor.commands.setTextSelection(1)
      expect(handleRichMarkdownTableTab(editor, false)).toBe(false)
      expect(handleRichMarkdownTableTab(editor, true)).toBe(false)
    })
  })
})

describe('handleRichMarkdownTableEnter', () => {
  it('moves Enter to the cell below', () => {
    withEditor(TABLE, (editor) => {
      editor.commands.setTextSelection(caretAtText(editor, 'a1'))
      expect(handleRichMarkdownTableEnter(editor)).toBe(true)
      expect(selectionText(editor)).toBe('a2')
    })
  })

  it('adds a row when Enter is pressed on the last row', () => {
    withEditor(TABLE, (editor) => {
      const rowsBefore = countRows(editor)
      editor.commands.setTextSelection(caretAtText(editor, 'a2'))
      expect(handleRichMarkdownTableEnter(editor)).toBe(true)
      expect(countRows(editor)).toBe(rowsBefore + 1)
      expect(selectionText(editor)).toBe('')
      expect(editor.isActive('table')).toBe(true)
    })
  })

  it('does not claim Enter outside tables', () => {
    withEditor('Just a paragraph.\n', (editor) => {
      editor.commands.setTextSelection(1)
      expect(handleRichMarkdownTableEnter(editor)).toBe(false)
    })
  })
})

describe('handleRichMarkdownTableBackspace', () => {
  it('deletes a fully empty row and leaves sibling rows intact', () => {
    withEditor(TABLE_WITH_EMPTY_ROW, (editor) => {
      expect(countRows(editor)).toBe(4)
      editor.commands.setTextSelection(caretInRow(editor, (text) => text.length === 0))
      expect(handleRichMarkdownTableBackspace(editor)).toBe(true)

      expect(countRows(editor)).toBe(3)
      const markdown = editor.getMarkdown()
      expect(markdown).toContain('keep')
      expect(markdown).toContain('stay')
      expect(markdown).toContain('| Name')
      expect(hasTable(editor)).toBe(true)
    })
  })

  it('removes the whole table once the last remaining row is deleted', () => {
    withEditor('', (editor) => {
      editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
      expect(countRows(editor)).toBe(2)

      editor.commands.setTextSelection(caretInRow(editor, () => true))
      expect(handleRichMarkdownTableBackspace(editor)).toBe(true)
      expect(countRows(editor)).toBe(1)

      editor.commands.setTextSelection(caretInRow(editor, () => true))
      expect(handleRichMarkdownTableBackspace(editor)).toBe(true)
      expect(hasTable(editor)).toBe(false)
    })
  })

  it('keeps an emptied header row while body rows remain', () => {
    withEditor(
      `|  |  |
| --- | --- |
| keep | a |
| stay | c |
`,
      (editor) => {
        const before = editor.getMarkdown()
        editor.commands.setTextSelection(caretInRow(editor, (text) => text.length === 0))
        // Consumed so ProseMirror cannot merge the table into what precedes it.
        expect(handleRichMarkdownTableBackspace(editor)).toBe(true)
        expect(countRows(editor)).toBe(3)
        expect(editor.getMarkdown()).toBe(before)
      }
    )
  })

  it('does not hijack Backspace when the current cell still has content', () => {
    withEditor(TABLE_WITH_EMPTY_ROW, (editor) => {
      editor.commands.setTextSelection(caretAtText(editor, 'keep'))
      expect(handleRichMarkdownTableBackspace(editor)).toBe(false)
      expect(countRows(editor)).toBe(4)
    })
  })

  it('steps to the previous cell from an empty cell in a row that has content', () => {
    withEditor(TABLE, (editor) => {
      // Empty the "b1" cell, leaving "a1" in place.
      const cellStart = caretAtText(editor, 'b1')
      editor.view.dispatch(editor.state.tr.delete(cellStart, cellStart + 'b1'.length))

      editor.commands.setTextSelection(caretInRow(editor, (text) => text === 'a1', 1))
      expect(handleRichMarkdownTableBackspace(editor)).toBe(true)
      expect(countRows(editor)).toBe(3)
      expect(selectionText(editor)).toBe('a1')
    })
  })

  it('does not treat an image-only cell as empty', () => {
    withEditor(TABLE_WITH_EMPTY_ROW, (editor) => {
      const emptyRowCaret = caretInRow(editor, (text) => text.length === 0, 1)
      editor.commands.insertContentAt(emptyRowCaret, {
        type: 'image',
        attrs: { src: 'shot.png' }
      })

      editor.commands.setTextSelection(caretInRow(editor, (text) => text.length === 0))
      expect(handleRichMarkdownTableBackspace(editor)).toBe(true)
      // Row keeps the image cell; Backspace steps back instead of deleting.
      expect(countRows(editor)).toBe(4)
    })
  })

  it('does not hijack Backspace outside tables', () => {
    withEditor('Just a paragraph.\n', (editor) => {
      editor.commands.setTextSelection(1)
      expect(handleRichMarkdownTableBackspace(editor)).toBe(false)
    })
  })
})
