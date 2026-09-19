import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import { describe, expect, it } from 'vitest'
import { splitRichMarkdownHeading } from './rich-markdown-heading-split'

function createEditor(inTable = false): Editor {
  const heading = {
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: 'Section Two' }]
  }
  return new Editor({
    element: null,
    extensions: [StarterKit, Table, TableRow, TableCell, TableHeader],
    content: {
      type: 'doc',
      content: [
        inTable
          ? {
              type: 'table',
              content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [heading] }] }]
            }
          : heading
      ]
    }
  })
}

describe('splitRichMarkdownHeading', () => {
  it('turns the trailing split block into a paragraph', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(9)
      expect(splitRichMarkdownHeading(editor)).toBe(true)
      expect(editor.state.doc.toJSON()).toEqual({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Section ' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }
        ]
      })
    } finally {
      editor.destroy()
    }
  })

  it('leaves heading boundaries to the default Enter behavior', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(12)
      expect(splitRichMarkdownHeading(editor)).toBe(false)
    } finally {
      editor.destroy()
    }
  })
})

it('leaves a heading in a table cell to table Enter navigation', () => {
  const editor = createEditor(true)
  try {
    editor.state.doc.check()
    editor.commands.setTextSelection(7)
    const before = editor.getJSON()
    expect(splitRichMarkdownHeading(editor)).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  } finally {
    editor.destroy()
  }
})
