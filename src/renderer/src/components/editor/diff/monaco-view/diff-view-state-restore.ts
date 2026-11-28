import type { IDisposable, editor } from 'monaco-editor'

const SETTLE_WINDOW_MS = 1000

/**
 * Restores a cached diff view state next frame, then re-applies it if the mount layout shifts it away.
 * Why: retained models reach Monaco with a cached diff, so inline wrapped diffs mount with view zones
 * sized for a stale wrap width. Monaco shrinks them a task later and the hidden original editor's
 * scroll sync clamps the restored position away. The settle window starts at the first restore, so a
 * slow first frame can't use it up. Disposing ends only the settle window.
 */
export function restoreDiffViewStateWhileLayoutSettles(
  diffEditor: editor.IStandaloneDiffEditor,
  viewState: editor.IDiffEditorViewState
): IDisposable {
  const originalEditor = diffEditor.getOriginalEditor()
  const modifiedEditor = diffEditor.getModifiedEditor()
  const savedScroll = viewState.modified?.viewState
  const subscriptions: IDisposable[] = []
  let settling = true
  let restored = false
  let restoring = false
  let checkPending = false
  let frame: number | null = null
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  const restore = (): void => {
    restored = true
    if (diffEditor.getModel()) {
      restoring = true
      try {
        diffEditor.restoreViewState(viewState)
      } finally {
        restoring = false
      }
    }
  }
  const restoreAndStartSettling = (): void => {
    frame = null
    if (!settling) {
      return
    }
    restore()
    if (settling) {
      settleTimer = setTimeout(stopSettling, SETTLE_WINDOW_MS)
    }
  }
  // Same math as Monaco's restore: saved first visible position minus its offset, clamped to the scroll range.
  const hasDrifted = (): boolean => {
    if (!savedScroll) {
      return false
    }
    const { lineNumber, column } = savedScroll.firstPosition
    const target =
      modifiedEditor.getTopForPosition(lineNumber, column) - savedScroll.firstPositionDeltaTop
    const maxTop = modifiedEditor.getScrollHeight() - modifiedEditor.getLayoutInfo().height
    return Math.abs(modifiedEditor.getScrollTop() - Math.max(0, Math.min(target, maxTop))) >= 1
  }
  const stopSettling = (): void => {
    settling = false
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    clearTimeout(settleTimer)
    for (const subscription of subscriptions.splice(0)) {
      subscription.dispose()
    }
  }
  // A microtask runs after Monaco re-anchors scroll at the end of its zone update, and before paint.
  const checkAfterHeightChange = (event: editor.IContentSizeChangedEvent): void => {
    if (!restored || !event.contentHeightChanged || checkPending) {
      return
    }
    checkPending = true
    queueMicrotask(() => {
      checkPending = false
      if (settling && diffEditor.getModel() && hasDrifted()) {
        restore()
      }
    })
  }

  frame = requestAnimationFrame(restoreAndStartSettling)
  diffEditor.onDidDispose(stopSettling)
  // Capture on the diff container so wheel, scrollbar, overview ruler, and either pane end the window.
  const container = diffEditor.getContainerDomNode()
  const inputEvents = ['pointerdown', 'wheel', 'keydown'] as const
  for (const type of inputEvents) {
    container.addEventListener(type, stopSettling, { capture: true, passive: true })
  }
  // Why: goToDiff can scroll without moving the cursor (e.g. single hunk), so end settling before it runs.
  const hasOwnGoToDiff = Object.hasOwn(diffEditor, 'goToDiff')
  const originalGoToDiff = typeof diffEditor.goToDiff === 'function' ? diffEditor.goToDiff : null
  if (originalGoToDiff) {
    diffEditor.goToDiff = (target) => {
      stopSettling()
      originalGoToDiff.call(diffEditor, target)
    }
  }
  subscriptions.push(
    originalEditor.onDidContentSizeChange(checkAfterHeightChange),
    modifiedEditor.onDidContentSizeChange(checkAfterHeightChange),
    // A model swap restores its own fresher state, and user input owns the position from then on.
    originalEditor.onDidChangeModel(stopSettling),
    modifiedEditor.onDidChangeModel(stopSettling),
    // Programmatic navigation (header next/previous change) happens outside the container.
    modifiedEditor.onDidChangeCursorPosition((event) => {
      if (!restoring && event.source === 'api') {
        stopSettling()
      }
    }),
    {
      dispose: () => {
        if (originalGoToDiff) {
          if (hasOwnGoToDiff) {
            diffEditor.goToDiff = originalGoToDiff
          } else {
            Reflect.deleteProperty(diffEditor, 'goToDiff')
          }
        }
        for (const type of inputEvents) {
          container.removeEventListener(type, stopSettling, { capture: true })
        }
      }
    }
  )

  return { dispose: stopSettling }
}
