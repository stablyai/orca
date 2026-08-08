// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import type { RichMarkdownContextMenuCommandPayload } from '../../../../shared/rich-markdown-context-menu'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { useRichMarkdownTableContextMenu } from './use-rich-markdown-table-context-menu'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |
`

function TableContextMenuHarness({ editor }: { editor: Editor }): null {
  useRichMarkdownTableContextMenu(editor)
  return null
}

afterEach(cleanup)

describe('rich markdown table context menu', () => {
  it('reports and routes the exact table target without coordinate hit testing later', () => {
    const editorElement = document.createElement('div')
    document.body.append(editorElement)
    const editor = new Editor({
      element: editorElement,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    const setRichMarkdownContextMenuTarget = vi.fn()
    const commandListeners: ((payload: RichMarkdownContextMenuCommandPayload) => void)[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onRichMarkdownContextCommand: vi.fn((callback) => {
            commandListeners.push(callback)
            return vi.fn()
          }),
          setRichMarkdownContextMenuTarget
        }
      }
    })
    const view = render(<TableContextMenuHarness editor={editor} />)
    try {
      const bodyCells = editorElement.querySelectorAll('td')
      const targetCell = bodyCells.item(3)
      fireEvent.pointerDown(targetCell, { button: 2, clientX: 12, clientY: 34 })
      expect(setRichMarkdownContextMenuTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({ cellType: 'body', x: 12, y: 34 })
      )
      fireEvent.contextMenu(targetCell, { clientX: 12, clientY: 34 })
      const target = setRichMarkdownContextMenuTarget.mock.lastCall?.[0]
      expect(target).toMatchObject({ cellType: 'body', x: 12, y: 34 })

      editor.commands.setTextSelection(1)
      expect(commandListeners).toHaveLength(1)
      commandListeners[0]({
        command: 'delete-row',
        tableTargetId: target.targetId,
        x: 12,
        y: 34
      })

      expect(editor.state.doc.textContent).toContain('a1')
      expect(editor.state.doc.textContent).not.toContain('a2')
    } finally {
      view.unmount()
      editor.destroy()
      editorElement.remove()
    }
  })

  it('reports header targets so native row actions can be disabled', () => {
    const editorElement = document.createElement('div')
    document.body.append(editorElement)
    const editor = new Editor({
      element: editorElement,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    const setRichMarkdownContextMenuTarget = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          onRichMarkdownContextCommand: vi.fn(() => vi.fn()),
          setRichMarkdownContextMenuTarget
        }
      }
    })
    const view = render(<TableContextMenuHarness editor={editor} />)
    try {
      fireEvent.contextMenu(editorElement.querySelector('th')!, { clientX: 8, clientY: 9 })
      expect(setRichMarkdownContextMenuTarget).toHaveBeenLastCalledWith(
        expect.objectContaining({ cellType: 'header', x: 8, y: 9 })
      )
    } finally {
      view.unmount()
      editor.destroy()
      editorElement.remove()
    }
  })
})
