// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onRichMarkdownContextCommand: vi.fn(() => vi.fn()),
        setRichMarkdownContextMenuTarget: vi.fn()
      }
    }
  })
})

describe('RichMarkdownTableControls', () => {
  it('does not mutate header cells before ProseMirror handles pointer input', async () => {
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
      const header = editorElement.querySelector('th')
      if (!header) {
        throw new Error('Expected a table header cell')
      }
      let headerPosition = 0
      editor.state.doc.descendants((node, position) => {
        if (node.type.spec.tableRole === 'header_cell') {
          headerPosition = position
          return false
        }
        return true
      })

      fireEvent.pointerDown(header, { clientX: 20, clientY: 20 })

      expect(editor.state.doc.nodeAt(headerPosition)?.attrs.colwidth).toBeNull()
    } finally {
      view.unmount()
      editor.destroy()
      scrollContainer.remove()
    }
  })

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
      const cell = editorElement.querySelector('td')
      if (!cell) {
        throw new Error('Expected a table body cell')
      }
      const table = cell.closest('table')
      if (!table) {
        throw new Error('Expected the table body cell to have a table parent')
      }
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
        bottom: 50,
        height: 50,
        left: 0,
        right: 50,
        toJSON: () => ({}),
        top: 0,
        width: 50,
        x: 0,
        y: 0
      })
      vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({
        bottom: 100,
        height: 100,
        left: 0,
        right: 100,
        toJSON: () => ({}),
        top: 0,
        width: 100,
        x: 0,
        y: 0
      })
      fireEvent.pointerMove(cell, { clientX: 20, clientY: 0 })
      await waitFor(() => expect(view.getByLabelText('Column actions')).toBeTruthy())
      expect(view.queryByLabelText('Row actions')).toBeNull()
      expect(view.queryByLabelText('Add row')).toBeNull()
      expect(view.queryByLabelText('Add column')).toBeNull()

      fireEvent.pointerMove(cell, { clientX: 0, clientY: 20 })
      await waitFor(() => expect(view.getByLabelText('Row actions')).toBeTruthy())
      const rowActions = view.getByLabelText('Row actions')
      rowActions.focus()
      expect(document.activeElement).toBe(rowActions)

      fireEvent.pointerMove(cell, { clientX: 20, clientY: 100 })
      await waitFor(() => expect(view.getByLabelText('Add row')).toBeTruthy())
      expect(view.queryByLabelText('Add column')).toBeNull()

      fireEvent.pointerMove(cell, { clientX: 100, clientY: 20 })
      await waitFor(() => expect(view.getByLabelText('Add column')).toBeTruthy())
      expect(view.queryByLabelText('Add row')).toBeNull()

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
      view.unmount()
      editor.destroy()
      scrollContainer.remove()
    }
  })

  it('keeps an add control reachable after scrolling without another pointer move', async () => {
    const scrollContainer = document.createElement('div')
    const editorElement = document.createElement('div')
    const controlsElement = document.createElement('div')
    scrollContainer.append(editorElement, controlsElement)
    document.body.append(scrollContainer)
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 100 },
      clientWidth: { configurable: true, value: 100 }
    })
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    const editor = new Editor({
      element: editorElement,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    let bodyTextPosition = 0
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === 'a1') {
        bodyTextPosition = position
        return false
      }
      return true
    })
    editor.commands.setTextSelection(bodyTextPosition)
    const cell = editorElement.querySelector('td')!
    const row = cell.parentElement!
    const table = cell.closest('table')!
    vi.spyOn(cell, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 100,
      height: 50,
      left: -scrollContainer.scrollLeft,
      right: 50 - scrollContainer.scrollLeft,
      top: 50,
      width: 50,
      x: -scrollContainer.scrollLeft,
      y: 50,
      toJSON: () => ({})
    }))
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 100,
      height: 50,
      left: -scrollContainer.scrollLeft,
      right: 150 - scrollContainer.scrollLeft,
      top: 50,
      width: 150,
      x: -scrollContainer.scrollLeft,
      y: 50,
      toJSON: () => ({})
    }))
    vi.spyOn(table, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 100,
      height: 100,
      left: -scrollContainer.scrollLeft,
      right: 150 - scrollContainer.scrollLeft,
      top: 0,
      width: 150,
      x: -scrollContainer.scrollLeft,
      y: 0,
      toJSON: () => ({})
    }))
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
      fireEvent.pointerMove(cell, { clientX: 20, clientY: 95 })
      await waitFor(() => expect(view.getByLabelText('Add row').style.width).toBe('92px'))

      scrollContainer.scrollLeft = 100
      fireEvent.scroll(scrollContainer)
      await waitFor(() => expect(view.getByLabelText('Add row').style.width).toBe('46px'))
    } finally {
      view.unmount()
      editor.destroy()
      scrollContainer.remove()
    }
  })
})
