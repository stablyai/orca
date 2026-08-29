// @vitest-environment happy-dom

import React, { useRef } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { useRichMarkdownTableControlTarget } from './use-rich-markdown-table-control-target'

const TABLE = `| A | B |
| --- | --- |
| a1 | b1 |
`

let nextFrameId = 0
let frameCallbacks = new Map<number, FrameRequestCallback>()

function flushFrames(): void {
  const callbacks = [...frameCallbacks.values()]
  frameCallbacks.clear()
  callbacks.forEach((callback) => callback(performance.now()))
}

function TargetHarness({
  editor,
  scrollContainer
}: {
  editor: Editor
  scrollContainer: HTMLDivElement
}): React.JSX.Element {
  const renders = useRef(0)
  const scrollContainerRef = useRef(scrollContainer)
  renders.current += 1
  const target = useRichMarkdownTableControlTarget(editor, scrollContainerRef)
  return (
    <div
      data-active={String(target.active !== null)}
      data-add-axis={target.hoveredAddAxis ?? ''}
      data-axis={target.hoveredAxis ?? ''}
      data-renders={renders.current}
    />
  )
}

beforeEach(() => {
  nextFrameId = 0
  frameCallbacks = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    nextFrameId += 1
    frameCallbacks.set(nextFrameId, callback)
    return nextFrameId
  })
  vi.stubGlobal('cancelAnimationFrame', (frameId: number) => {
    frameCallbacks.delete(frameId)
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('rich markdown table control target', () => {
  it('coalesces same-cell pointer geometry and preserves observer identity on updates', async () => {
    const scrollContainer = document.createElement('div')
    const editorElement = document.createElement('div')
    scrollContainer.append(editorElement)
    document.body.append(scrollContainer)
    const editor = new Editor({
      element: editorElement,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    const cell = editorElement.querySelector('td')!
    const table = editorElement.querySelector('table')!
    let bodyTextPosition = 0
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === 'a1') {
        bodyTextPosition = position
        return false
      }
      return true
    })
    editor.commands.setTextSelection(bodyTextPosition)
    const cellRect = vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
      bottom: 50,
      height: 50,
      left: 0,
      right: 50,
      top: 0,
      width: 50,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    const tableRect = vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({
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
    const observerDisconnect = vi.fn()
    const observerConstruct = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          observerConstruct()
        }
        disconnect = observerDisconnect
        observe = vi.fn()
      }
    )
    const view = render(<TargetHarness editor={editor} scrollContainer={scrollContainer} />)
    try {
      await waitFor(() =>
        expect(view.container.firstElementChild?.getAttribute('data-active')).toBe('true')
      )
      expect(observerConstruct).toHaveBeenCalledTimes(1)
      const stableRenderCount = view.container.firstElementChild?.getAttribute('data-renders')

      editor.commands.insertContent('x')
      await act(async () => {})
      expect(view.container.firstElementChild?.getAttribute('data-renders')).toBe(stableRenderCount)
      expect(observerConstruct).toHaveBeenCalledTimes(1)
      expect(observerDisconnect).not.toHaveBeenCalled()

      fireEvent.pointerMove(cell, { clientX: 2, clientY: 2 })
      fireEvent.pointerMove(cell, { clientX: 3, clientY: 3 })
      fireEvent.pointerMove(cell, { clientX: 4, clientY: 4 })
      expect(frameCallbacks.size).toBe(1)
      expect(cellRect).not.toHaveBeenCalled()
      expect(tableRect).not.toHaveBeenCalled()
      act(flushFrames)
      expect(cellRect).toHaveBeenCalledTimes(1)
      expect(tableRect).toHaveBeenCalledTimes(1)
      expect(observerConstruct).toHaveBeenCalledTimes(1)

      const afterPointerRenderCount = view.container.firstElementChild?.getAttribute('data-renders')
      expect(Number(afterPointerRenderCount)).toBeGreaterThan(Number(stableRenderCount))
    } finally {
      view.unmount()
      editor.destroy()
      scrollContainer.remove()
    }
  })

  it('refreshes layout state when the editor scrolls without pointer movement', async () => {
    const scrollContainer = document.createElement('div')
    const editorElement = document.createElement('div')
    scrollContainer.append(editorElement)
    document.body.append(scrollContainer)
    const editor = new Editor({
      element: editorElement,
      extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      content: TABLE,
      contentType: 'markdown'
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect = vi.fn()
        observe = vi.fn()
      }
    )
    const view = render(<TargetHarness editor={editor} scrollContainer={scrollContainer} />)
    try {
      await waitFor(() =>
        expect(view.container.firstElementChild?.getAttribute('data-active')).toBe('true')
      )
      const renderCount = Number(view.container.firstElementChild?.getAttribute('data-renders'))
      fireEvent.scroll(scrollContainer)
      expect(frameCallbacks.size).toBe(1)
      act(flushFrames)
      expect(
        Number(view.container.firstElementChild?.getAttribute('data-renders'))
      ).toBeGreaterThan(renderCount)
    } finally {
      view.unmount()
      editor.destroy()
      scrollContainer.remove()
    }
  })
})
