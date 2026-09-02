import type { IDisposable, editor } from 'monaco-editor'

export function preserveDiffViewStateAcrossModelSwaps(
  diffEditor: editor.IStandaloneDiffEditor
): IDisposable {
  let pendingViewState: editor.IDiffEditorViewState | null = null
  let restoreFrame: number | null = null

  const captureViewState = (): void => {
    // Why: Monaco resets cursor and scroll state when a retained editor swaps
    // models, so capture once before either diff side starts rotating.
    pendingViewState ??= diffEditor.saveViewState()
  }
  const scheduleRestore = (): void => {
    if (!pendingViewState) {
      return
    }
    if (restoreFrame !== null) {
      cancelAnimationFrame(restoreFrame)
    }
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = null
      const viewState = pendingViewState
      pendingViewState = null
      if (viewState && diffEditor.getModel()) {
        diffEditor.restoreViewState(viewState)
      }
    })
  }

  const originalEditor = diffEditor.getOriginalEditor()
  const modifiedEditor = diffEditor.getModifiedEditor()
  const subscriptions = [
    originalEditor.onWillChangeModel(captureViewState),
    originalEditor.onDidChangeModel(scheduleRestore),
    modifiedEditor.onWillChangeModel(captureViewState),
    modifiedEditor.onDidChangeModel(scheduleRestore)
  ]

  return {
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose()
      }
      if (restoreFrame !== null) {
        cancelAnimationFrame(restoreFrame)
      }
      restoreFrame = null
      pendingViewState = null
    }
  }
}
