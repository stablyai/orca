import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { notifyEditorFileCacheStale } from './editor-autosave'
import { isEditorModelDirty } from './editor-save-disk-precondition'

/**
 * A clean tab's text (cache, or a leftover draft) that no longer matches its disk version, such as
 * a cache kept across another tab's write. It must never be pushed into a live model.
 */
export function isStaleCachedEditorText(fileId: string, content: string): boolean {
  const state = useAppStore.getState()
  const file = state?.openFiles?.find((openFile) => openFile.id === fileId)
  if (!file || file.isDirty || file.mode !== 'edit') {
    return false
  }
  const baseline = file.lastKnownDiskSignature
  return baseline !== undefined && getDiskBaselineSignature(content) !== baseline
}

// Why keyed by baseline too: once the baseline moves, the same stale text must be able to reload again.
const requestedReloads = new Map<string, string>()

/** Drops a stale cache so it reloads from disk, once per cached text and baseline: a reload that lands the same text can't loop. */
export function requestStaleCacheReload(fileId: string, content: string): void {
  const openFiles = useAppStore.getState()?.openFiles ?? []
  const file = openFiles.find((openFile) => openFile.id === fileId)
  const stamp = `${file?.lastKnownDiskSignature ?? ''}\n${getDiskBaselineSignature(content)}`
  if (requestedReloads.get(fileId) === stamp) {
    return
  }
  // Why: drop closed tabs' stamps, which no settling mount will ever clear.
  for (const id of requestedReloads.keys()) {
    if (!openFiles.some((openFile) => openFile.id === id)) {
      requestedReloads.delete(id)
    }
  }
  requestedReloads.set(fileId, stamp)
  notifyEditorFileCacheStale(fileId)
}

/** A mount found the tab's text fresh, so an earlier reload settled; a later stale copy may reload again. */
export function settleStaleCacheReload(fileId: string): void {
  requestedReloads.delete(fileId)
}

/**
 * The one rule for pushing a tab's text into its live model: a clean tab's text never enters a dirty
 * model. Reload and Overwrite clear the model's edits first.
 */
export function mayPushTabTextIntoModel(fileId: string): boolean {
  const state = useAppStore.getState()
  const file = state.openFiles.find((openFile) => openFile.id === fileId)
  if (!file) {
    return true
  }
  if (file.isDirty) {
    // Why: a dirty view's text is its draft; with no draft (host-mirrored dirty, dropped draft) its
    // text is disk-derived and must not overwrite the shared model's unsaved edits.
    return state.editorDrafts[fileId] !== undefined
  }
  // Why a clean view's draft may enter: views of a record share one draft, so it is the record's
  // text (a commit that reads clean, e.g. a rich undo differing from disk only in trailing space).
  return !isEditorModelDirty(state, file)
}
