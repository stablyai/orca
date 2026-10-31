import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { editor, ISelection } from 'monaco-editor'
import { editorSelectionCache, editorViewStateCache, scrollTopCache } from '@/lib/scroll-cache'
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
  editorViewStateCache.clear()
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
  it('restores the complete viewport, selections and folded regions after a tab remount', () => {
    const viewState: editor.ICodeEditorViewState = {
      cursorState: [],
      viewState: {
        scrollLeft: 480,
        firstPosition: { lineNumber: 18, column: 1 },
        firstPositionDeltaTop: 5
      },
      contributionsState: {
        'editor.contrib.folding': { collapsedRegions: [{ startLineNumber: 3, endLineNumber: 12 }] }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot accesses only the four stubbed editor methods.
    const sourceEditor = {
      getModel: () => ({ uri: { toString: () => 'file:///repo/file.ts' } }),
      saveViewState: () => viewState,
      getScrollTop: () => 320,
      getSelections: () => selections
    } as unknown as editor.IStandaloneCodeEditor
    snapshotMonacoViewState({ current: sourceEditor }, 'file.ts::tab-1')

    const setSelections = vi.fn()
    const setScrollTop = vi.fn()
    const focus = vi.fn()
    const restoreViewState = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore accesses only these stubbed editor methods.
    const remountedEditor = {
      getModel: sourceEditor.getModel,
      restoreViewState,
      setSelections,
      setScrollTop,
      focus
    } as unknown as editor.IStandaloneCodeEditor
    restoreMonacoViewState(remountedEditor, 'file.ts::tab-1')

    expect(restoreViewState).toHaveBeenCalledExactlyOnceWith(viewState)
    expect(setSelections).not.toHaveBeenCalled()
    expect(setScrollTop).not.toHaveBeenCalled()
    expect(focus).toHaveBeenCalledOnce()
  })

  it('restores a sibling pane without claiming focus during a scoped reveal', () => {
    scrollTopCache.set('file.ts::sibling', 320)
    const pane = {
      getModel: () => null,
      setSelections: vi.fn(),
      setScrollTop: vi.fn(),
      focus: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore accesses only these stubbed editor methods.
    const instance = pane as unknown as editor.IStandaloneCodeEditor
    restoreMonacoViewState(instance, 'file.ts::sibling', () => false)
    expect(pane.setScrollTop).toHaveBeenCalledWith(320)
    expect(pane.focus).not.toHaveBeenCalled()
  })

  it('does not apply saved folds to another host or pane showing the same path', () => {
    const source = {
      getModel: () => ({ uri: { toString: () => 'file:///repo/file.ts?owner=host-a' } }),
      saveViewState: () => ({ cursorState: [], viewState: {}, contributionsState: {} }),
      getScrollTop: () => 100,
      getSelections: () => selections
    }
    snapshotMonacoViewState(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: snapshot accesses only these stubbed editor methods.
      { current: source as unknown as editor.IStandaloneCodeEditor },
      'pane-a'
    )
    const other = {
      getModel: () => ({ uri: { toString: () => 'file:///repo/file.ts?owner=host-b' } }),
      restoreViewState: vi.fn(),
      setScrollTop: vi.fn(),
      setSelections: vi.fn(),
      focus: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restore accesses only these stubbed editor methods.
    const instance = other as unknown as editor.IStandaloneCodeEditor
    restoreMonacoViewState(instance, 'pane-a')
    expect(other.restoreViewState).not.toHaveBeenCalled()
    other.getModel = source.getModel
    restoreMonacoViewState(instance, 'pane-b')
    expect(other.restoreViewState).not.toHaveBeenCalled()
  })

  it('defers selection caching until the lifecycle snapshot', () => {
    let emitCursorPosition:
      | ((event: { position: { lineNumber: number; column: number } }) => void)
      | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tracking accesses only these three stubbed editor methods.
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
      fileIdRef: { current: 'file.ts' },
      viewStateKey: 'file.ts::tab-1',
      scrollThrottleTimerRef: { current: null },
      setEditorCursorLine
    })
    emitCursorPosition?.({ position: { lineNumber: 12, column: 3 } })

    expect(setEditorCursorLine).toHaveBeenLastCalledWith('file.ts', 12)
    expect(editorSelectionCache.size).toBe(0)
  })
})
