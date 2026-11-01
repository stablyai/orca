import type { MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
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

function editorViewStateKey(
  editorInstance: editor.IStandaloneCodeEditor,
  viewStateKey: string
): string | null {
  const model = editorInstance.getModel()
  return model ? JSON.stringify([viewStateKey, model.uri.toString()]) : null
}

export function installMonacoViewStateTracking(params: MonacoViewStateTrackingParams): {
  cursorPositionSub: { dispose: () => void }
  scrollStateSub: { dispose: () => void }
} {
  const { editorInstance, fileIdRef, viewStateKey, scrollThrottleTimerRef, setEditorCursorLine } =
    params

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
  editorInstance: editor.IStandaloneCodeEditor,
  viewStateKey: string,
  canFocus?: () => boolean
): void {
  const cacheKey = editorViewStateKey(editorInstance, viewStateKey)
  const savedViewState = cacheKey === null ? undefined : editorViewStateCache.get(cacheKey)
  const savedSelections = editorSelectionCache.get(viewStateKey)
  const savedScrollTop = scrollTopCache.get(viewStateKey)
  if (savedViewState || savedScrollTop !== undefined || savedSelections) {
    // Why: Monaco renders synchronously so one RAF suffices; focus inside it to avoid a scroll-0 flash before restore.
    requestAnimationFrame(() => {
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
      if (canFocus?.() !== false) {
        editorInstance.focus()
      }
    })
  } else if (canFocus?.() !== false) {
    editorInstance.focus()
  }
}

// Accept the ref so effect cleanup can read the current instance without violating ref-in-cleanup lint.
export function snapshotMonacoViewState(
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>,
  viewStateKey: string
): void {
  const ed = editorRef.current
  if (ed) {
    const cacheKey = editorViewStateKey(ed, viewStateKey)
    const viewState = ed.saveViewState()
    if (cacheKey !== null && viewState) {
      setWithLRU(editorViewStateCache, cacheKey, viewState)
    }
    setWithLRU(scrollTopCache, viewStateKey, ed.getScrollTop())
    const selections = ed.getSelections()
    if (selections) {
      setWithLRU(editorSelectionCache, viewStateKey, selections)
    }
  }
}
