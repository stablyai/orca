// @vitest-environment happy-dom
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { richMarkdownSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { useEditorScrollRestore } from './useEditorScrollRestore'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

function createEditor(from: number, to: number, docSize = 100, setTextSelection = vi.fn()): Editor {
  return {
    commands: { setTextSelection },
    state: {
      doc: { content: { size: docSize } },
      selection: { from, to }
    }
  } as unknown as Editor
}

beforeEach(() => {
  richMarkdownSelectionCache.clear()
  scrollTopCache.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useEditorScrollRestore', () => {
  it('snapshots the rich editor selection before unmount', () => {
    const container = document.createElement('div')
    const editor = createEditor(4, 7)
    const { unmount } = renderHook(() =>
      useEditorScrollRestore({ current: container }, 'file.md:rich', editor)
    )

    unmount()

    expect(richMarkdownSelectionCache.get('file.md:rich')).toEqual({ from: 4, to: 7 })
  })

  it('restores and clamps a cached selection to the current document', () => {
    const container = document.createElement('div')
    const setTextSelection = vi.fn()
    const editor = createEditor(1, 1, 9, setTextSelection)
    richMarkdownSelectionCache.set('file.md:rich', { from: 6, to: 15 })

    renderHook(() => useEditorScrollRestore({ current: container }, 'file.md:rich', editor))

    expect(setTextSelection).toHaveBeenCalledWith({ from: 6, to: 9 })
  })

  it('keeps the restored selection when deferred autofocus lands', () => {
    let runFrame: FrameRequestCallback = () => {
      throw new Error('expected focus frame to be scheduled')
    }
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      runFrame = callback
      return 9
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const state: {
      doc: { content: { size: number } }
      selection: object
    } = {
      doc: { content: { size: 20 } },
      selection: { from: 1, to: 1 }
    }
    const setTextSelection = vi.fn((selection: { from: number; to: number }) => {
      const restoredSelection = Object.create(TextSelection.prototype)
      Object.defineProperties(restoredSelection, {
        from: { value: selection.from },
        to: { value: selection.to }
      })
      state.selection = restoredSelection
    })
    const focus = vi.fn()
    const editor = {
      isDestroyed: false,
      commands: { focus, setTextSelection },
      state
    } as unknown as Editor
    const container = document.createElement('div')
    richMarkdownSelectionCache.set('file.md:rich', { from: 6, to: 8 })

    autoFocusRichEditor(editor, null)
    renderHook(() => useEditorScrollRestore({ current: container }, 'file.md:rich', editor))
    runFrame(0)

    expect(setTextSelection).toHaveBeenCalledWith({ from: 6, to: 8 })
    expect(focus).toHaveBeenCalledWith(null, { scrollIntoView: false })
  })
})
