import type { AppState } from '@/store/types'
import { editorModelRegistry } from '@/lib/editor/monaco/editor-model-registry'
import {
  snapshotBufferLineEnding,
  type BufferLineEndingSnapshot
} from '../buffer-text/existing-file-line-ending'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'

/** New tab id → the unsaved buffer's line ending, until that tab's editor mounts or it closes. */
const renamedLineEndingByViewId = new Map<string, BufferLineEndingSnapshot>()

/**
 * A rename gives a tab a new id and path, which remounts its editor on a new model, possibly after
 * the old model is disposed. Snapshot the unsaved buffer's ending now so the remount keeps it.
 */
export function handOffRenamedEditorModels(
  state: Pick<AppState, 'openFiles' | 'editorDrafts'> &
    Parameters<typeof getEditorModelOwnerKey>[1],
  rekeys: readonly { oldFileId: string; newFileId: string }[]
): void {
  const registry = editorModelRegistry.get()
  const files = new Map(state.openFiles.map((file) => [file.id, file]))
  const handoffs = rekeys.flatMap(({ oldFileId, newFileId }) => {
    // A tab renamed again before it mounted keeps its first snapshot.
    const pending = renamedLineEndingByViewId.get(oldFileId)
    if (pending) {
      return [{ oldFileId, newFileId, snapshot: pending }]
    }
    const file = files.get(oldFileId)
    // A clean tab reloads from disk, so only an unsaved draft continues the buffer.
    if (file?.mode !== 'edit' || state.editorDrafts[oldFileId] === undefined || !registry) {
      return []
    }
    const model = registry.editor.getModel(
      registry.Uri.parse(toEditorModelUri(file.filePath, getEditorModelOwnerKey(file, state)))
    )
    return model && !model.isDisposed()
      ? [{ oldFileId, newFileId, snapshot: snapshotBufferLineEnding(model) }]
      : []
  })
  // Why two passes: a swap of two ids must not delete the entry it just wrote.
  for (const { oldFileId } of handoffs) {
    renamedLineEndingByViewId.delete(oldFileId)
  }
  for (const { newFileId, snapshot } of handoffs) {
    renamedLineEndingByViewId.set(newFileId, snapshot)
  }
}

export function takeRenamedBufferLineEnding(viewId: string): BufferLineEndingSnapshot | undefined {
  const snapshot = renamedLineEndingByViewId.get(viewId)
  renamedLineEndingByViewId.delete(viewId)
  return snapshot
}

/** A closed tab's snapshot must never reach a later tab that reuses its id. */
export function dropRenamedBufferLineEnding(viewId: string): void {
  renamedLineEndingByViewId.delete(viewId)
}
