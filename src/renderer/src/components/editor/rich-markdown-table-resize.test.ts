// @vitest-environment happy-dom

import { Editor } from '@tiptap/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const TABLE = `| A | B |
| --- | --- |
| alpha | beta |
`

function createEditor(content = TABLE): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    contentType: 'markdown'
  })
}

function firstCellPosition(editor: Editor): number {
  let position: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || node.text !== 'A') {
      return true
    }
    position = pos
    return false
  })
  if (position === null) {
    throw new Error('Expected a table header cell')
  }
  return position
}

beforeAll(() => {
  document.open()
  document.write('<!doctype html><html><body></body></html>')
  document.close()
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('rich Markdown table resizing', () => {
  it('configures TipTap native resizing with a stable wrapper and minimum width', () => {
    const extensions = createRichMarkdownExtensions({
      codec: createRichMarkdownEditorCodec()
    })
    const table = extensions.find((extension) => extension.name === 'table')

    expect(table?.options).toMatchObject({
      resizable: true,
      renderWrapper: true,
      cellMinWidth: 96
    })

    const editor = createEditor()
    try {
      expect(editor.view.dom.querySelector('.tableWrapper')).not.toBeNull()
      expect(editor.view.dom.querySelectorAll('colgroup > col')).toHaveLength(2)
    } finally {
      editor.destroy()
    }
  })

  it('keeps resized column widths in memory and out of serialized Markdown', () => {
    const editor = createEditor()
    try {
      editor.commands.setTextSelection(firstCellPosition(editor))
      const before = editor.getMarkdown()

      expect(editor.commands.setCellAttribute('colwidth', [160])).toBe(true)
      expect((editor.view.dom.querySelector('col') as HTMLElement | null)?.style.width).toBe(
        '160px'
      )
      const after = editor.getMarkdown()
      expect(after).toBe(before)

      const reopened = createEditor(after)
      try {
        expect((reopened.view.dom.querySelector('col') as HTMLElement | null)?.style.width).not.toBe(
          '160px'
        )
      } finally {
        reopened.destroy()
      }
    } finally {
      editor.destroy()
    }
  })
})
