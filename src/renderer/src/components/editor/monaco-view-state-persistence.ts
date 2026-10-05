import type { MutableRefObject } from 'react'
import type { editor, ISelection } from 'monaco-editor'
import {
  editorSelectionCache,
  editorViewStateCache,
  scrollTopCache,
  setWithLRU
} from '@/lib/scroll-cache'

type MonacoViewStateTrackingParams = {
  editorInstance: editor.IStandaloneCodeEditor
  fileIdRef: MutableRefObject<string>
  viewStateKey: string
  scrollThrottleTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  setEditorCursorLine: (fileId: string, line: number) => void
}

export function installMonacoViewStateTracking(params: MonacoViewStateTrackingParams): {
  cursorPositionSub: { dispose: () => void }
  scrollStateSub: { dispose: () => void }
} {
  const { editorInstance, fileIdRef, viewStateKey, scrollThrottleTimerRef, setEditorCursorLine } =
    params

  // Track cursor line for "copy path to line" feature
  const pos = editorInstance.getPosition()
  if (pos) {
    setEditorCursorLine(fileIdRef.current, pos.lineNumber)
  }
  const cursorPositionSub = editorInstance.onDidChangeCursorPosition((e) => {
    setEditorCursorLine(fileIdRef.current, e.position.lineNumber)
  })

  // Why: only the resting scroll position matters, so trailing-throttle writes (~150ms) instead of writing every 60fps frame.
  const scrollStateSub = editorInstance.onDidScrollChange((e) => {
    if (scrollThrottleTimerRef.current !== null) {
      clearTimeout(scrollThrottleTimerRef.current)
    }
    scrollThrottleTimerRef.current = setTimeout(() => {
      setWithLRU(scrollTopCache, viewStateKey, e.scrollTop)
      scrollThrottleTimerRef.current = null
    }, 150)
  })

  return { cursorPositionSub, scrollStateSub }
}

export function restoreMonacoViewState(
  editorInstance: Pick<
    editor.IStandaloneCodeEditor,
    | 'setSelections'
    | 'setScrollTop'
    | 'focus'
    | 'onDidDispose'
    | 'onDidChangeModel'
    | 'restoreViewState'
  >,
  viewStateKey: string
): void {
  const savedSelections = editorSelectionCache.get(viewStateKey)
  const savedScrollTop = scrollTopCache.get(viewStateKey)
  const savedViewState = editorViewStateCache.get(viewStateKey)
  if (savedViewState || savedScrollTop !== undefined || savedSelections) {
    let restoreFrame: number | null = null
    let active = true
    const cancelRestore = (): void => {
      if (!active) {
        return
      }
      active = false
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame)
        restoreFrame = null
      }
      subscriptions.forEach((subscription) => subscription.dispose())
    }
    const subscriptions = [
      editorInstance.onDidDispose(cancelRestore),
      editorInstance.onDidChangeModel(cancelRestore)
    ]
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = null
      if (!active) {
        return
      }
      cancelRestore()
      if (savedViewState) {
        editorInstance.restoreViewState(savedViewState)
      } else {
        if (savedSelections) {
          editorInstance.setSelections(savedSelections)
        }
        if (savedScrollTop !== undefined) {
          editorInstance.setScrollTop(savedScrollTop)
        }
      }
      editorInstance.focus()
    })
  } else {
    editorInstance.focus()
  }
}

// Why: takes the ref, not the instance — the caller runs this from an effect cleanup, where reading `.current` inline trips the ref-in-cleanup lint.
export function snapshotMonacoViewState(
  editorRef: MutableRefObject<
    | (Pick<editor.IStandaloneCodeEditor, 'getScrollTop' | 'saveViewState'> & {
        getSelections(): readonly ISelection[] | null
      })
    | null
  >,
  viewStateKey: string
): void {
  const ed = editorRef.current
  if (ed) {
    const viewState = ed.saveViewState()
    if (viewState) {
      setWithLRU(editorViewStateCache, viewStateKey, viewState)
    }
    setWithLRU(scrollTopCache, viewStateKey, ed.getScrollTop())
    const selections = ed.getSelections()
    if (selections) {
      setWithLRU(editorSelectionCache, viewStateKey, selections)
    }
  }
}
