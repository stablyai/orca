import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  editorBufferIdOfView,
  editorBufferSiblingViewIds
} from '@/store/slices/editor/buffers/editor-buffer-views'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import { worktreePurgeClosedFileIds } from '@/store/slices/worktrees/teardown/worktree-purge-closed-files'
import { canAutoSaveOpenFile } from './editor-autosave'
import { flushClosingEditorBuffers } from './editor-pending-flush'
import { editorTabModelUri, isCodeViewTab } from './editor-save-disk-precondition'
import { editorModelRegistry } from '@/lib/editor-model-registry'

/**
 * Savable tabs among `closedIds` holding unsaved text whose every view of the record also closes,
 * one per record.
 */
export function lastViewUnsavedFiles(state: AppState, closedIds: ReadonlySet<string>): OpenFile[] {
  const seenRecords = new Set<string>()
  const result: OpenFile[] = []
  for (const file of state.openFiles ?? []) {
    const unsaved = file.isDirty || state.editorDrafts?.[file.id] !== undefined
    if (!closedIds.has(file.id) || !unsaved || !canAutoSaveOpenFile(file)) {
      continue
    }
    const recordId = editorBufferIdOfView(state, file.id)
    const viewIds = editorBufferSiblingViewIds(state, file.id)
    if (viewIds.every((id) => closedIds.has(id)) && !seenRecords.has(recordId)) {
      seenRecords.add(recordId)
      result.push(file)
    }
  }
  return result
}

/** Every view that shows `file`'s text: the views of its record. */
export function unsavedTextViewIds(state: AppState, file: OpenFile): string[] {
  return [...new Set([file.id, ...editorBufferSiblingViewIds(state, file.id)])]
}

/** The freshest text of `file`: its mounted code model, else a draft a sharing view holds. */
export function currentUnsavedText(state: AppState, file: OpenFile): string | undefined {
  const registry = isCodeViewTab(state, file) ? editorModelRegistry.get() : null
  const model = registry?.editor.getModel(registry.Uri.parse(editorTabModelUri(state, file)))
  // Why attached only: a retained model can hold older text than a restored draft.
  if (model?.isAttachedToEditor()) {
    return model.getValue()
  }
  return (
    unsavedTextViewIds(state, file)
      .map((id) => state.editorDrafts?.[id])
      .find((draft) => draft !== undefined) ?? model?.getValue()
  )
}

/** Commits text every delayed view (rich Markdown, CSV, notebook pane) holds for these tabs. */
export function flushRemovalPendingEdits(state: AppState, fileIds: Iterable<string>): void {
  try {
    flushClosingEditorBuffers(state, fileIds)
  } catch (error) {
    // Why: a flush failing must not block the removal that asked.
    console.error('[editor] flushing pending edits before a removal failed', error)
  }
}

/** Unsaved files a removal of `targets` would close, after flushing their delayed views. */
export function collectRemovalUnsavedFiles(
  getState: () => AppState,
  targets: readonly WorktreePurgeTarget[]
): OpenFile[] {
  flushRemovalPendingEdits(getState(), worktreePurgeClosedFileIds(getState(), targets))
  const state = getState()
  return lastViewUnsavedFiles(state, worktreePurgeClosedFileIds(state, targets))
}
