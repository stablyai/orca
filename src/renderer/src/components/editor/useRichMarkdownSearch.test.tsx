// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { describe, expect, it, vi } from 'vitest'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

function createEditor(): { editor: Editor; emitUpdate: () => void } {
  const updateListeners = new Set<() => void>()
  const transaction = {
    setMeta: vi.fn().mockReturnThis()
  }
  const editor = {
    commands: { focus: vi.fn() },
    off: vi.fn((event: string, listener: () => void) => {
      if (event === 'update') {
        updateListeners.delete(listener)
      }
    }),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'update') {
        updateListeners.add(listener)
      }
    }),
    registerPlugin: vi.fn(),
    state: { doc: {}, tr: transaction },
    unregisterPlugin: vi.fn(),
    view: { dispatch: vi.fn() }
  } as unknown as Editor
  return {
    editor,
    emitUpdate: () => updateListeners.forEach((listener) => listener())
  }
}

describe('useRichMarkdownSearch', () => {
  it('rerenders for editor updates only while search is open', () => {
    const closedUpdateCount = 100
    const { editor, emitUpdate } = createEditor()
    const rootRef = { current: document.createElement('div') }
    const scrollContainerRef = { current: document.createElement('div') }
    let renderCount = 0
    const hook = renderHook(() => {
      renderCount += 1
      return useRichMarkdownSearch({ editor, rootRef, scrollContainerRef })
    })

    const closedRenderCount = renderCount
    for (let index = 0; index < closedUpdateCount; index += 1) {
      act(emitUpdate)
    }

    expect(renderCount - closedRenderCount).toBe(0)
    expect(editor.on).not.toHaveBeenCalledWith('update', expect.any(Function))

    act(() => hook.result.current.openSearch())

    const openRenderCount = renderCount
    expect(editor.on).toHaveBeenCalledWith('update', expect.any(Function))
    act(emitUpdate)
    expect(renderCount - openRenderCount).toBe(1)

    act(() => hook.result.current.searchActions.closeSearch())

    const reclosedRenderCount = renderCount
    for (let index = 0; index < closedUpdateCount; index += 1) {
      act(emitUpdate)
    }
    expect(renderCount - reclosedRenderCount).toBe(0)
    expect(editor.off).toHaveBeenCalledWith('update', expect.any(Function))
  })
})
