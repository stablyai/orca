import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor, ISelection } from 'monaco-editor'
import { editorSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import {
  installMonacoViewStateTracking,
  restoreMonacoViewState,
  snapshotMonacoViewState
} from './monaco-view-state-persistence'

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

  it('defers selection caching until the lifecycle snapshot', () => {
    let emitCursorPosition:
      | ((event: { position: { lineNumber: number; column: number } }) => void)
      | undefined
    const editorInstance = {
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      onDidChangeCursorPosition: (
        listener: (event: { position: { lineNumber: number; column: number } }) => void
      ) => {
        emitCursorPosition = listener
        return { dispose: vi.fn() }
      },
      onDidScrollChange: () => ({ dispose: vi.fn() })
    } as unknown as editor.IStandaloneCodeEditor
    const setEditorCursorLine = vi.fn()

    installMonacoViewStateTracking({
      editorInstance,
      filePath: 'file.ts',
      viewStateKey: 'file.ts::tab-1',
      scrollThrottleTimerRef: { current: null },
      setEditorCursorLine
    })
    emitCursorPosition?.({ position: { lineNumber: 12, column: 3 } })

    expect(setEditorCursorLine).toHaveBeenLastCalledWith('file.ts', 12)
    expect(editorSelectionCache.size).toBe(0)
  })
})
