import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { editorBufferSiblingViewIds } from '@/store/slices/editor/buffers/editor-buffer-views'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import { worktreePurgeClosedFileIds } from '@/store/slices/worktrees/teardown/worktree-purge-closed-files'
import { canAutoSaveOpenFile } from './editor-autosave'
import { flushPendingEditorBuffer } from './editor-pending-flush'
import { editorModelSiblingTabs, editorTabModelUri } from './editor-save-disk-precondition'

/**
 * Savable tabs among `closedIds` holding unsaved text whose every view (shared model, shared
 * record) also closes, one per model.
 */
export function lastViewUnsavedFiles(state: AppState, closedIds: ReadonlySet<string>): OpenFile[] {
  const seenModels = new Set<string>()
  const result: OpenFile[] = []
  for (const file of state.openFiles ?? []) {
    const unsaved = file.isDirty || state.editorDrafts?.[file.id] !== undefined
    if (!closedIds.has(file.id) || !unsaved || !canAutoSaveOpenFile(file)) {
      continue
    }
    const modelSiblings = editorModelSiblingTabs(state, file)
    const viewIds = [
      ...modelSiblings.map((tab) => tab.id),
      ...editorBufferSiblingViewIds(state, file.id)
    ]
    const modelKey = modelSiblings.length > 1 ? editorTabModelUri(state, file) : file.id
    if (viewIds.every((id) => closedIds.has(id)) && !seenModels.has(modelKey)) {
      seenModels.add(modelKey)
      result.push(file)
    }
  }
  return result
}

/** Commits text delayed views (rich Markdown, CSV, notebook) still hold for these tabs. */
export function flushRemovalPendingEdits(state: AppState, fileIds: Iterable<string>): void {
  try {
    for (const fileId of fileIds) {
      flushPendingEditorBuffer(state, fileId)
    }
  } catch (error) {
    // Why: a view's flush failing must not block the removal that asked.
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
