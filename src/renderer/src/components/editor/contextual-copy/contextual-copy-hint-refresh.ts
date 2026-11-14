import type { editor, IEvent } from 'monaco-editor'
import { subscribeTranslationScope } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'

export function createContextualCopyHintRefresh(
  editorInstance: editor.IStandaloneCodeEditor,
  isVisible: () => boolean,
  update: () => void
): { refresh: () => void; dispose: () => void } {
  let copyHintFrame: number | null = null
  let disposed = false
  let stopLabelSubscriptions: (() => void) | null = null
  const cancelCopyHintFrame = (): void => {
    if (copyHintFrame !== null) {
      window.cancelAnimationFrame(copyHintFrame)
      copyHintFrame = null
    }
  }

  const refreshCopyHint = (): void => {
    cancelCopyHintFrame()
    if (!disposed) {
      update()
    }
  }

  const scheduleCopyHintRefresh = (): void => {
    if (disposed || copyHintFrame !== null || !editorInstance.hasTextFocus() || !isVisible()) {
      return
    }
    copyHintFrame = window.requestAnimationFrame(() => {
      copyHintFrame = null
      if (!disposed && editorInstance.hasTextFocus() && isVisible()) {
        update()
      }
    })
  }

  const subscribeCopyHintLabels = (): void => {
    if (stopLabelSubscriptions !== null) {
      return
    }
    let keybindings = useAppStore.getState().keybindings
    const unsubscribeKeybindings = useAppStore.subscribe((state) => {
      if (state.keybindings !== keybindings) {
        keybindings = state.keybindings
        scheduleCopyHintRefresh()
      }
    })
    const unsubscribeTranslation = subscribeTranslationScope(scheduleCopyHintRefresh)
    stopLabelSubscriptions = () => {
      unsubscribeKeybindings()
      unsubscribeTranslation()
      stopLabelSubscriptions = null
    }
  }

  const stop = (): void => {
    cancelCopyHintFrame()
    stopLabelSubscriptions?.()
  }

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Monaco 0.55.1 exposes this event at runtime but omits it from its public declaration.
  const viewZoneEditor = editorInstance as editor.IStandaloneCodeEditor & {
    readonly onDidChangeViewZones: IEvent<void>
  }
  const listeners = [
    editorInstance.onDidFocusEditorText(subscribeCopyHintLabels),
    editorInstance.onDidBlurEditorText(stop),
    editorInstance.onDidLayoutChange(scheduleCopyHintRefresh),
    editorInstance.onDidChangeModel(scheduleCopyHintRefresh),
    editorInstance.onDidChangeModelContent(scheduleCopyHintRefresh),
    editorInstance.onDidChangeConfiguration(scheduleCopyHintRefresh),
    editorInstance.onDidContentSizeChange(scheduleCopyHintRefresh),
    editorInstance.onDidChangeHiddenAreas(scheduleCopyHintRefresh),
    editorInstance.onDidChangeModelDecorations(scheduleCopyHintRefresh),
    viewZoneEditor.onDidChangeViewZones(scheduleCopyHintRefresh)
  ]

  if (editorInstance.hasTextFocus()) {
    subscribeCopyHintLabels()
  }
  return {
    refresh: refreshCopyHint,
    dispose: () => {
      disposed = true
      stop()
      for (const listener of listeners) {
        listener.dispose()
      }
    }
  }
}
