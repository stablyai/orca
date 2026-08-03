// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { RichMarkdownTableControls } from './RichMarkdownTableControls'
import { TooltipProvider } from '@/components/ui/tooltip'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
`

afterEach(cleanup)

describe('RichMarkdownTableControls', () => {
  it('shows reachable, labeled controls only for an editable active table', async () => {
    const scrollContainer = document.createElement('div')
    const editorElement = document.createElement('div')
    const controlsElement = document.createElement('div')
    scrollContainer.append(editorElement, controlsElement)
    document.body.append(scrollContainer)
    const editor = new Editor({
      element: editorElement,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    let bodyCellPosition = 0
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === 'a1') {
        bodyCellPosition = position
        return false
      }
      return true
    })
    editor.commands.setTextSelection(bodyCellPosition)

    const view = render(
      <TooltipProvider>
        <RichMarkdownTableControls
          editor={editor}
          scrollContainerRef={{ current: scrollContainer }}
        />
      </TooltipProvider>,
      { container: controlsElement }
    )
    try {
      await waitFor(() => expect(view.getByLabelText('Row actions')).toBeTruthy())
      expect(view.getByLabelText('Column actions')).toBeTruthy()
      expect(view.getByLabelText('Add row')).toBeTruthy()
      expect(view.getByLabelText('Add column')).toBeTruthy()

      const rowActions = view.getByLabelText('Row actions')
      rowActions.focus()
      expect(document.activeElement).toBe(rowActions)

      view.rerender(
        <TooltipProvider>
          <RichMarkdownTableControls
            disabled
            editor={editor}
            scrollContainerRef={{ current: scrollContainer }}
          />
        </TooltipProvider>
      )
      expect(view.queryByLabelText('Row actions')).toBeNull()
    } finally {
      editor.destroy()
      scrollContainer.remove()
    }
  })
})
