import type { MutableRefObject } from 'react'
import type { editor } from 'monaco-editor'
import { scrollTopCache, cursorPositionCache, setWithLRU } from '@/lib/scroll-cache'

type MonacoViewStateTrackingParams = {
  editorInstance: editor.IStandaloneCodeEditor
  filePath: string
  viewStateKey: string
  scrollThrottleTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  setEditorCursorLine: (fileId: string, line: number) => void
}

export function installMonacoViewStateTracking(params: MonacoViewStateTrackingParams): {
  cursorPositionSub: { dispose: () => void }
  scrollStateSub: { dispose: () => void }
} {
  const { editorInstance, filePath, viewStateKey, scrollThrottleTimerRef, setEditorCursorLine } =
    params

  // Track cursor line for "copy path to line" feature
  const pos = editorInstance.getPosition()
  if (pos) {
    setEditorCursorLine(filePath, pos.lineNumber)
  }
  const cursorPositionSub = editorInstance.onDidChangeCursorPosition((e) => {
    setEditorCursorLine(filePath, e.position.lineNumber)
    setWithLRU(cursorPositionCache, viewStateKey, {
      lineNumber: e.position.lineNumber,
      column: e.position.column
    })
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
  viewStateKey: string
): void {
  const savedCursor = cursorPositionCache.get(viewStateKey)
  const savedScrollTop = scrollTopCache.get(viewStateKey)
  if (savedScrollTop !== undefined || savedCursor) {
    // Why: Monaco renders synchronously so one RAF suffices; focus inside it to avoid a scroll-0 flash before restore.
    requestAnimationFrame(() => {
      if (savedCursor) {
        editorInstance.setPosition(savedCursor)
      }
      if (savedScrollTop !== undefined) {
        editorInstance.setScrollTop(savedScrollTop)
      }
      editorInstance.focus()
    })
  } else {
    editorInstance.focus()
  }
}

// Why: takes the ref, not the instance — the caller runs this from an effect cleanup, where reading `.current` inline trips the ref-in-cleanup lint.
export function snapshotMonacoViewState(
  editorRef: MutableRefObject<editor.IStandaloneCodeEditor | null>,
  viewStateKey: string
): void {
  const ed = editorRef.current
  if (ed) {
    setWithLRU(scrollTopCache, viewStateKey, ed.getScrollTop())
    const pos = ed.getPosition()
    if (pos) {
      setWithLRU(cursorPositionCache, viewStateKey, {
        lineNumber: pos.lineNumber,
        column: pos.column
      })
    }
  }
}
