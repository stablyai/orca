import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorModelRegistry, type EditorModelRegistryBridge } from '@/lib/editor-model-registry'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  editorModelSiblingTabs,
  editorTabModelUri,
  isCodeViewTab
} from './editor-save-disk-precondition'
import { getOpenFilesForExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import type { FileContent } from './editor-panel-content-types'

/** Apply rich/notebook/CSV commits to hidden retained models as one undo step; visible code models follow their own content sync. */
export function applyEditorBufferText(
  state: AppState,
  file: OpenFile,
  text: string,
  bridge: EditorModelRegistryBridge = editorModelRegistry
): void {
  const registry = bridge.get()
  // Code-view commits already came from the model, so do not apply them twice.
  if (!registry || file.mode !== 'edit' || isCodeViewTab(state, file)) {
    return
  }
  const viewIds = new Set(editorBufferSiblingViewIds(state, file.id))
  const uris = new Set(
    state.openFiles
      .filter((view) => viewIds.has(view.id) && view.mode === 'edit')
      .map((view) => editorTabModelUri(state, view))
  )
  for (const uri of uris) {
    const model = registry.editor.getModel(registry.Uri.parse(uri))
    if (!model || model.isDisposed() || model.isAttachedToEditor() || model.getValue() === text) {
      continue
    }
    // Bracket each commit as an independent undo step.
    model.pushStackElement()
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    model.pushStackElement()
  }
}

/** Advance loaded disk text for sibling views after saves so dirty comparisons cannot use stale baselines to clear unsaved edits. */
export function withRecordDiskText(
  prev: Record<string, FileContent>,
  viewIds: readonly string[],
  savedViewId: string,
  content: string
): Record<string, FileContent> {
  let next = prev
  for (const viewId of viewIds) {
    const loaded = prev[viewId]
    if (
      viewId === savedViewId ||
      !loaded ||
      loaded.isBinary ||
      loaded.loadError ||
      loaded.csvPreview ||
      loaded.content === content
    ) {
      continue
    }
    next = next === prev ? { ...prev } : next
    next[viewId] = { ...loaded, content }
  }
  return next
}

/** Include views of the same record in other workspaces when reloading an externally changed path. */
export function externalChangeRecordViewIds(
  state: AppState | undefined,
  panelFiles: readonly OpenFile[],
  target: EditorPathMutationTarget
): Set<string> {
  const storeFiles = state?.openFiles ?? []
  const matched = getOpenFilesForExternalFileChange([...panelFiles, ...storeFiles], target)
  return new Set(
    matched.flatMap((file) =>
      state && storeFiles.some((tab) => tab.id === file.id)
        ? editorModelSiblingTabs(state, file).map((tab) => tab.id)
        : [file.id]
    )
  )
}
