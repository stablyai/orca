// @vitest-environment happy-dom
import { act } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRichMarkdownReviewRailController } from './useRichMarkdownReviewRailController'
import type { DiffComment } from '../../../../shared/diff-comment-types'

vi.mock('./rich-markdown-review-note-positioning', () => ({
  measureRichMarkdownReviewNotePositions: () => []
}))

const comments: DiffComment[] = [
  {
    id: 'note',
    worktreeId: 'workspace',
    filePath: 'reading.md',
    source: 'markdown',
    lineNumber: 1,
    body: 'Review this paragraph',
    createdAt: 1,
    side: 'modified'
  }
]

describe('review rail reading position', () => {
  let editor: Editor
  let root: Root
  let host: HTMLDivElement
  let container: HTMLDivElement
  let editorRef: { current: Editor | null }
  let containerRef: { current: HTMLDivElement | null }
  let rail: ReturnType<typeof useRichMarkdownReviewRailController> | null

  beforeEach(() => {
    vi.useFakeTimers()
    editor = new Editor({
      extensions: [StarterKit],
      content: '<p>Keep this reading location</p><p>Another paragraph</p>'
    })
    vi.runOnlyPendingTimers()
    editor.commands.setTextSelection({ from: 12, to: 3 })
    container = document.createElement('div')
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 5000 },
      clientHeight: { configurable: true, value: 400 }
    })
    container.scrollTop = 1000
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 800, 400))
    vi.spyOn(editor.view.dom, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 100, 800, 400)
    )
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 7, inside: 1 })
    host = document.createElement('div')
    document.body.append(host, container)
    root = createRoot(host)
    editorRef = { current: editor }
    containerRef = { current: container }
    rail = null
    vi.spyOn(editor.view, 'coordsAtPos').mockImplementation(() => {
      const open = host.querySelector('[data-rail-open="true"]') !== null
      const top = 100 + (open ? 1320 : 1020) - container.scrollTop
      return { top, bottom: top + 20, left: 32, right: 40 }
    })
    function Harness() {
      const controller = useRichMarkdownReviewRailController({
        canAnnotateRichMarkdown: true,
        content: 'reading',
        editorRef,
        markdownComments: comments,
        markdownSourceLineOffset: 0,
        markdownSourceLineOffsetRef: { current: 0 },
        scrollContainerRef: containerRef
      })
      rail = controller
      return <span data-rail-open={controller.reviewRailOpen} />
    }
    act(() => root.render(<Harness />))
  })

  afterEach(() => {
    rail?.cancelNotePositionFrame()
    act(() => root.unmount())
    if (!editor.isDestroyed) {
      editor.destroy()
    }
    host.remove()
    container.remove()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function controller() {
    if (!rail) {
      throw new Error('Missing review rail controller')
    }
    return rail
  }

  function toggle(): void {
    controller().toggleReviewRail()
  }

  it('keeps the same document position at the same viewport offset across show and hide', () => {
    const state = editor.state
    const focus = vi.spyOn(editor.view, 'focus')
    act(toggle)
    expect(controller().reviewRailOpen).toBe(true)
    expect(container.scrollTop).toBe(1300)
    expect(editor.view.coordsAtPos(7).top).toBe(120)
    act(toggle)
    expect(container.scrollTop).toBe(1000)
    expect(editor.state).toBe(state)
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not scroll an editor already at the top', () => {
    container.scrollTop = 0
    act(toggle)
    expect(container.scrollTop).toBe(0)
  })

  it('still toggles when there is no document position under the viewport', () => {
    vi.mocked(editor.view.posAtCoords).mockReturnValue(null)
    act(toggle)
    expect(controller().reviewRailOpen).toBe(true)
    expect(container.scrollTop).toBe(1000)
  })

  it('does not restore a captured position into a replacement editor', () => {
    const replacement = new Editor({ extensions: [StarterKit], content: '<p>Another file</p>' })
    try {
      act(() => {
        toggle()
        editorRef.current = replacement
      })
      expect(container.scrollTop).toBe(1000)
    } finally {
      replacement.destroy()
    }
  })

  it('does not restore through a destroyed editor', () => {
    act(() => {
      toggle()
      editor.destroy()
    })
    expect(container.scrollTop).toBe(1000)
  })

  it('does not restore into a replacement scroll container', () => {
    act(() => {
      toggle()
      containerRef.current = document.createElement('div')
    })
    expect(container.scrollTop).toBe(1000)
    expect(containerRef.current?.scrollTop).toBe(0)
  })

  it('does not use a captured position after the document changes', () => {
    act(() => {
      toggle()
      editor.commands.insertContentAt(1, 'changed ')
    })
    expect(container.scrollTop).toBe(1000)
  })

  it('keeps explicit note navigation separate from the visibility toggle', () => {
    act(() => controller().setReviewRailOpen(true))
    expect(container.scrollTop).toBe(1000)
    expect(editor.view.posAtCoords).not.toHaveBeenCalled()
  })
})
