import { useAppStore } from '@/store/index'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import type { FileContent } from '../../loading/editor-panel-content-types'
import { isEditorModelDirty } from '../../save/queue/editor-save-disk-precondition'
import { flushEditorFrames } from '../../save/flush/editor-pending-flush'
import { isPathSpecificMissingFileError } from '../editor-deleted-file-reload'
import { reconcileDirtyModel, reconcileDirtyModelWithDisk } from './editor-reload-dirty-model'
import {
  decisionTab,
  isAbsolutePathTab,
  isEditorReloadEligible,
  liveTab,
  modelBaseline,
  readDisk,
  reloadEditorFileThroughWatcherPath,
  stillSameTab,
  type EditorReloadDeps,
  type EditorReloadOutcome
} from './editor-reload-tab-state'

/**
 * Read the disk and reconcile one editor tab with it. Never discards unsaved edits: a differing
 * disk under a dirty model raises the existing conflict banner instead.
 */
export async function reloadEditorFileFromDisk(
  fileId: string,
  shown: FileContent | undefined,
  deps: EditorReloadDeps = {}
): Promise<EditorReloadOutcome> {
  const state = useAppStore.getState()
  const file = liveTab(state, fileId)
  if (!file || !isEditorReloadEligible(file)) {
    return { kind: 'skipped' }
  }
  const decider = decisionTab(state, file)
  // A custom editor frame may still hold a debounced edit; it must reach the store before the
  // dirty check, and a frame that keeps its edits back means nothing here may be replaced.
  const framesFlushed = await Promise.all(
    [...new Set([file.id, decider.id])].map((id) => flushEditorFrames(useAppStore.getState(), id))
  )
  if (!framesFlushed.every(Boolean)) {
    return deps.background ? { kind: 'skipped' } : { kind: 'cannot-check-dirty' }
  }
  if (deps.isSuperseded?.()) {
    return { kind: 'skipped' }
  }
  const flushed = stillSameTab(file)
  const liveDecider = flushed ? stillSameTab(decider) : null
  if (!flushed || !liveDecider) {
    return { kind: 'skipped' }
  }
  return reconcileAfterFlush(flushed, liveDecider, shown, deps)
}

async function reconcileAfterFlush(
  file: OpenFile,
  decider: OpenFile,
  shown: FileContent | undefined,
  deps: EditorReloadDeps
): Promise<EditorReloadOutcome> {
  const state = useAppStore.getState()
  if (isEditorModelDirty(state, decider)) {
    return reconcileDirtyModel(decider, file, deps)
  }
  const comparable =
    shown &&
    !shown.loadError &&
    !shown.isStale &&
    !shown.isBinary &&
    !shown.csvPreview &&
    modelBaseline(state, decider) !== undefined
  if (deps.background && !comparable) {
    return { kind: 'skipped' }
  }
  if (shown?.loadError && deps.retryFailedLoad) {
    deps.retryFailedLoad(file)
    return { kind: 'reloaded' }
  }
  // Content the decision read can't compare: reload it the way a watcher event would.
  if (!comparable) {
    reloadEditorFileThroughWatcherPath(file)
    return { kind: 'reloaded' }
  }
  const baselineAtStart = modelBaseline(state, decider)
  let disk: { content: string; isBinary: boolean }
  try {
    disk = await readDisk(state, decider, !deps.background)
    // An edit typed into a custom editor frame during the read must reach the store before deciding.
    const reflushed = await flushEditorFrames(useAppStore.getState(), decider.id)
    if (deps.isSuperseded?.()) {
      return { kind: 'skipped' }
    }
    if (!reflushed) {
      return deps.background ? { kind: 'skipped' } : { kind: 'cannot-check-dirty' }
    }
  } catch (error) {
    // A newer explicit reload owns the outcome, failures included.
    if (deps.isSuperseded?.()) {
      return { kind: 'skipped' }
    }
    // A closed or re-owned tab (or a preview's source) turns any read error into old news.
    if (!stillSameTab(file) || !stillSameTab(decider)) {
      return { kind: 'skipped' }
    }
    const missing = isPathSpecificMissingFileError(error, file.filePath)
    if (!missing && !isAbsolutePathTab(file)) {
      return { kind: 'read-failed', error }
    }
    // The loader owns deleted tombstones and grant renewal for files outside the workspace, but an
    // edit made during the read must reach the store first, and a dirty model is never reloaded.
    const handedOver = await flushEditorFrames(useAppStore.getState(), decider.id)
    const settled = stillSameTab(file)
    const settledDecider = settled ? stillSameTab(decider) : null
    if (deps.isSuperseded?.() || !settled || !settledDecider) {
      return { kind: 'skipped' }
    }
    if (!handedOver || isEditorModelDirty(useAppStore.getState(), settledDecider)) {
      return deps.background ? { kind: 'skipped' } : { kind: 'read-failed', error }
    }
    reloadEditorFileThroughWatcherPath(settled)
    return missing ? { kind: 'deleted' } : { kind: 'reloaded' }
  }
  const live = stillSameTab(file)
  if (!live) {
    return { kind: 'skipped' }
  }
  const current = useAppStore.getState()
  const liveDecider = decisionTab(current, live)
  // A save landed during the read: these bytes predate the new baseline, so they decide nothing.
  if (modelBaseline(current, liveDecider) !== baselineAtStart) {
    return { kind: 'skipped' }
  }
  if (isEditorModelDirty(current, liveDecider)) {
    // The user typed while the read was in flight; that draft now decides.
    return reconcileDirtyModelWithDisk(liveDecider, live, disk, false)
  }
  if (
    !disk.isBinary &&
    getDiskBaselineSignature(disk.content) === modelBaseline(current, liveDecider)
  ) {
    return { kind: 'unchanged' }
  }
  reloadEditorFileThroughWatcherPath(live)
  return { kind: 'reloaded' }
}
