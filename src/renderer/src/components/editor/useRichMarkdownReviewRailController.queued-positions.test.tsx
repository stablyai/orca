// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { useRichMarkdownReviewRailController } from './useRichMarkdownReviewRailController'

const frames = new Map<number, FrameRequestCallback>()
const editors: Editor[] = []
let nextFrameId = 0

const comment: DiffComment = {
  id: 'note',
  worktreeId: 'workspace',
  filePath: 'note.md',
  source: 'markdown',
  lineNumber: 1,
  selectedText: 'selected',
  body: 'Review note',
  createdAt: 0,
  side: 'modified'
}

beforeEach(() => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrameId
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  frames.clear()
  vi.restoreAllMocks()
})

function makeEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit],
    content: '<p>selected body</p>'
  })
  editor.view.coordsAtPos = () => ({ left: 0, right: 1, top: 0, bottom: 1 })
  editors.push(editor)
  return editor
}

function flushFrames(): void {
  const pending = [...frames.values()]
  frames.clear()
  act(() => {
    for (const callback of pending) {
      callback(performance.now())
    }
  })
}

describe('review rail queued note positions', () => {
  it('renders current notes when comments change before a queued frame', () => {
    const initialProps = {
      canAnnotateRichMarkdown: true,
      content: 'selected body',
      editorRef: { current: makeEditor() },
      markdownComments: [comment],
      markdownSourceLineOffset: 0,
      markdownSourceLineOffsetRef: { current: 0 },
      scrollContainerRef: { current: document.createElement('div') }
    }
    const rail = renderHook((props) => useRichMarkdownReviewRailController(props), {
      initialProps
    })
    act(() => rail.result.current.setReviewRailOpen(true))
    rail.rerender({ ...initialProps, markdownComments: [{ ...comment, id: 'latest-note' }] })
    flushFrames()
    expect(rail.result.current.notePositions.map((position) => position.comment.id)).toEqual([
      'latest-note'
    ])
  })
})
