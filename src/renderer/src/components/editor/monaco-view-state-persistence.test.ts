import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor, ISelection } from 'monaco-editor'
import { editorSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { restoreMonacoViewState, snapshotMonacoViewState } from './monaco-view-state-persistence'

const selections: readonly ISelection[] = [
  {
    selectionStartLineNumber: 2,
    selectionStartColumn: 4,
    positionLineNumber: 5,
    positionColumn: 7
  },
  {
    selectionStartLineNumber: 9,
    selectionStartColumn: 3,
    positionLineNumber: 7,
    positionColumn: 2
  }
]

beforeEach(() => {
  editorSelectionCache.clear()
  scrollTopCache.clear()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Monaco view state persistence', () => {
  it('restores selected ranges and their direction after a tab remount', () => {
    const sourceEditor = {
      getScrollTop: () => 320,
      getSelections: () => selections
    } as unknown as editor.IStandaloneCodeEditor
    snapshotMonacoViewState({ current: sourceEditor }, 'file.ts::tab-1')

    const setSelections = vi.fn()
    const setScrollTop = vi.fn()
    const focus = vi.fn()
    const remountedEditor = {
      setSelections,
      setScrollTop,
      focus
    } as unknown as editor.IStandaloneCodeEditor
    restoreMonacoViewState(remountedEditor, 'file.ts::tab-1')

    expect(setSelections).toHaveBeenCalledWith(selections)
    expect(setScrollTop).toHaveBeenCalledWith(320)
    expect(focus).toHaveBeenCalledOnce()
  })
})
