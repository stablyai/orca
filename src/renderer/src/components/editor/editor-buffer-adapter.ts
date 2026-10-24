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

/**
 * A rich Markdown, notebook or CSV commit reaches the record's draft through the content handler;
 * this carries it into the record's models no editor shows (retained after a close, or of a hidden
 * code view) as one undoable edit. A shown model follows through its editor's content sync.
 */
export function applyEditorBufferText(
  state: AppState,
  file: OpenFile,
  text: string,
  bridge: EditorModelRegistryBridge = editorModelRegistry
): void {
  const registry = bridge.get()
  // Why: a code view's commit came from its model, which already holds the text.
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
    // Why the stops: each commit is its own undo step, not merged into the previous one.
    model.pushStackElement()
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
    model.pushStackElement()
  }
}

/**
 * Panel content sync: a write landed `content` on disk for the record whose views were `viewIds`,
 * so every other view of it this panel has loaded now reads that disk text. Without it a view's
 * dirty check compares against older disk text and can mark the record clean over unsaved edits.
 */
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

/**
 * Every view an outside change to a path reaches: the event names one workspace, but a view of the
 * same record in another workspace's panel shows that text too, so it must reload as well.
 */
export function externalChangeRecordViewIds(
  state: AppState | undefined,
  panelFiles: readonly OpenFile[],
  target: EditorPathMutationTarget
): Set<string> {
  const storeFiles = state?.openFiles ?? []
  const matched = getOpenFilesForExternalFileChange([...panelFiles, ...storeFiles], target, state)
  return new Set(
    matched.flatMap((file) =>
      state && storeFiles.some((tab) => tab.id === file.id)
        ? editorModelSiblingTabs(state, file).map((tab) => tab.id)
        : [file.id]
    )
  )
}
