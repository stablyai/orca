// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import {
  isRichMarkdownTableContextCommand,
  runRichMarkdownContextCommand
} from './rich-markdown-context-command-routing'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

function textPosition(editor: Editor, text: string): number {
  let position: number | null = null
  editor.state.doc.descendants((node, nodePosition) => {
    if (node.isText && node.text === text) {
      position = nodePosition
      return false
    }
    return true
  })
  if (position === null) {
    throw new Error(`Missing text: ${text}`)
  }
  return position
}

describe('rich markdown context command routing', () => {
  it('separates table commands for the shared rich-editor table owner', () => {
    expect(isRichMarkdownTableContextCommand('delete-row')).toBe(true)
    expect(isRichMarkdownTableContextCommand('bold')).toBe(false)
  })

  it('runs table actions against the clicked cell coordinates', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    try {
      editor.commands.setTextSelection(textPosition(editor, 'a1'))
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({
        inside: -1,
        pos: textPosition(editor, 'b2')
      })

      runRichMarkdownContextCommand({
        payload: { command: 'delete-row', x: 120, y: 240 },
        editor,
        toggleLink: vi.fn(),
        pickImage: vi.fn()
      })

      expect(editor.getMarkdown()).toContain('a1')
      expect(editor.getMarkdown()).not.toContain('a2')
    } finally {
      editor.destroy()
    }
  })
})
