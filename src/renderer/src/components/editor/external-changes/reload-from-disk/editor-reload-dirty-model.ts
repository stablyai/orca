import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getConnectionIdForFile } from '@/lib/workspace/ownership/connection-context'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from '../../autosave/editor-autosave'
import {
  editorModelSiblingTabs,
  isEditorModelDirty
} from '../../save/queue/editor-save-disk-precondition'
import { setModelExternalMutation } from '../../save/queue/editor-save-rebaseline'
import { markFileChangedOnDisk } from '../editor-changed-on-disk-mark'
import {
  noteEditorConflictReport,
  watchEditorConflictReports
} from '../editor-conflict-report-count'
import { joinPath } from '@/lib/path'
import { isRuntimePathAbsolute } from '../../../../../../shared/file-access/cross-platform-path'
import { getRecentSelfWrite } from '../editor-self-write-registry'
import {
  modelBaseline,
  readDisk,
  reloadEditorFileThroughWatcherPath,
  stillSameTab,
  type EditorReloadDeps,
  type EditorReloadOutcome
} from './editor-reload-tab-state'
import { flushEditorFrames } from '../../save/flush/editor-pending-flush'

// A dirty model is never reloaded: a differing disk raises the conflict banner instead.

// Every external-change notification for a file counts as a report for it; a conflict may only be
// cleared by a read that no report for its file overtook. Marks and refused saves count in the same tally.
if (typeof window !== 'undefined') {
  window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
    noteEditorConflictReport(externalChangePath(detail))
  })
}

function externalChangePath(detail: unknown): string | undefined {
  if (
    typeof detail !== 'object' ||
    detail === null ||
    !('worktreePath' in detail) ||
    !('relativePath' in detail) ||
    typeof detail.worktreePath !== 'string' ||
    typeof detail.relativePath !== 'string' ||
    !detail.worktreePath
  ) {
    return undefined
  }
  return isRuntimePathAbsolute(detail.relativePath)
    ? detail.relativePath
    : joinPath(detail.worktreePath, detail.relativePath)
}

function hasModelConflict(state: AppState, file: OpenFile): boolean {
  return editorModelSiblingTabs(state, file).some((tab) => tab.externalMutation === 'changed')
}

export async function reconcileDirtyModel(
  decider: OpenFile,
  shownTab: OpenFile,
  deps: EditorReloadDeps
): Promise<EditorReloadOutcome> {
  // A save landing during the read moves the baseline the read must be compared with; read again once.
  for (let attempt = 0; ; attempt++) {
    const state = useAppStore.getState()
    const baselineAtStart = modelBaseline(state, decider)
    if (baselineAtStart === undefined) {
      return { kind: 'cannot-check-dirty' }
    }
    const conflictAtStart = hasModelConflict(state, decider)
    const reports = watchEditorConflictReports(decider.filePath)
    let disk: { content: string; isBinary: boolean }
    try {
      disk = await readDisk(state, decider, !deps.background)
      reports.stop()
      if (deps.isSuperseded?.()) {
        return { kind: 'skipped' }
      }
    } catch (error) {
      reports.stop()
      if (deps.isSuperseded?.()) {
        return { kind: 'skipped' }
      }
      return stillSameTab(shownTab) && stillSameTab(decider)
        ? { kind: 'read-failed', error }
        : { kind: 'skipped' }
    }
    const live = stillSameTab(shownTab)
    const liveDecider = live ? stillSameTab(decider) : null
    if (!live || !liveDecider) {
      return { kind: 'skipped' }
    }
    const current = useAppStore.getState()
    if (modelBaseline(current, liveDecider) !== baselineAtStart) {
      if (attempt === 0) {
        continue
      }
      // Saves keep landing; this read can't be trusted and the user can simply click again.
      return { kind: 'skipped' }
    }
    if (!isEditorModelDirty(current, liveDecider)) {
      // A save settled during the read: the model is clean now, so compare and reload as for any clean tab.
      if (
        !disk.isBinary &&
        getDiskBaselineSignature(disk.content) === modelBaseline(current, liveDecider)
      ) {
        return { kind: 'unchanged' }
      }
      // A custom editor frame may hold an edit made during the read; it must land before a reload.
      const handedOver = await flushEditorFrames(useAppStore.getState(), liveDecider.id)
      const settled = stillSameTab(live)
      const settledDecider = settled ? stillSameTab(liveDecider) : null
      if (deps.isSuperseded?.() || !settled || !settledDecider) {
        return { kind: 'skipped' }
      }
      if (!handedOver) {
        return deps.background ? { kind: 'skipped' } : { kind: 'cannot-check-dirty' }
      }
      if (isEditorModelDirty(useAppStore.getState(), settledDecider)) {
        return reconcileDirtyModelWithDisk(settledDecider, settled, disk, false)
      }
      reloadEditorFileThroughWatcherPath(settled)
      return { kind: 'reloaded' }
    }
    return reconcileDirtyModelWithDisk(
      liveDecider,
      live,
      disk,
      conflictAtStart && !reports.reported()
    )
  }
}

export function reconcileDirtyModelWithDisk(
  decider: OpenFile,
  shownTab: OpenFile,
  disk: { content: string; isBinary: boolean },
  /** Only a conflict raised before the read, with no change reported since, can be cleared by it. */
  conflictPredatesRead: boolean
): EditorReloadOutcome {
  const state = useAppStore.getState()
  const baseline = modelBaseline(state, decider)
  if (disk.isBinary || baseline === undefined) {
    return { kind: 'cannot-check-dirty' }
  }
  // Our own save is landing: the disk holds the user's text, not someone else's.
  if (
    getRecentSelfWrite(decider.filePath, decider.runtimeEnvironmentId)?.content === disk.content
  ) {
    return { kind: 'unchanged' }
  }
  if (getDiskBaselineSignature(disk.content) === baseline) {
    if (!hasModelConflict(state, decider)) {
      return { kind: 'unchanged' }
    }
    if (!conflictPredatesRead) {
      // A write was reported while this read was in flight; these bytes may predate it.
      return decider.id === shownTab.id
        ? { kind: 'conflict-shown' }
        : { kind: 'conflict-elsewhere', sourceTab: decider }
    }
    // The disk is back at the version the edits were typed over, so there is no conflict left.
    for (const tab of editorModelSiblingTabs(state, decider)) {
      setModelExternalMutation(state, tab.id, null)
    }
    return { kind: 'unchanged' }
  }
  markFileChangedOnDisk(state, decider, {
    connectionId: getConnectionIdForFile(decider.worktreeId, decider.filePath) ?? undefined,
    origin: 'live'
  })
  return decider.id === shownTab.id
    ? { kind: 'conflict-shown' }
    : { kind: 'conflict-elsewhere', sourceTab: decider }
}
