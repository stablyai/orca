import { toast } from 'sonner'
import { useAppStore, type AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { translate } from '@/i18n/i18n'
import {
  editorBufferIdOfView,
  editorBufferSiblingViewIds
} from '@/store/slices/editor/buffers/editor-buffer-views'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { readEditorCsvFileContent } from './csv/csv-file-content'
import {
  getOpenFilesForExternalFileChange,
  isExternalReloadableEditorTab,
  notifyEditorFileCacheStale,
  notifyEditorFileReloaded,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  requestEditorSaveQuiesce,
  type EditorPathMutationTarget
} from './editor-autosave'
import { bumpEditorDiscardEpoch } from './editor-discard-epoch'
import { planEditorFileRead } from './editor-file-read-plan'
import { flushPendingEditorBuffer, hasPendingEditorBufferChange } from './editor-pending-flush'
import {
  editorModelDraftHolder,
  editorModelSiblingTabs,
  isEditorModelDirty,
  setEditorDiskBaseline
} from './editor-save-disk-precondition'
import { setModelExternalMutation } from './editor-save-rebaseline'
import { offerReloadUndo } from './editor-disk-reload-undo'
import { getEditorSaveTargetFile } from './editor-save-target'
import { isVirtualEditorFile } from '@/store/slices/editor/tabs/editor-tab-content-type'

const reloadingRecords = new Set<string>()

export function canReloadEditorTabFromDisk(file: OpenFile): boolean {
  return (
    (file.mode === 'edit' || file.mode === 'markdown-preview') &&
    isExternalReloadableEditorTab(file) &&
    !isVirtualEditorFile(file) &&
    file.isUntitled !== true
  )
}

type ReloadSnapshot = {
  recordId: string
  viewIds: string
  owner: string
  dirty: boolean
  draft: string | undefined
  baseline: string | undefined
  mutation: OpenFile['externalMutation'] | null
}

function snapshotRecord(state: AppState, fileId: string): ReloadSnapshot | null {
  const tab = state.openFiles.find((file) => file.id === fileId)
  if (!tab || tab.pendingOwnerMigration === true) {
    return null
  }
  const holder = editorModelDraftHolder(state, tab)
  return {
    recordId: editorBufferIdOfView(state, fileId),
    viewIds: editorModelSiblingTabs(state, tab)
      .map((view) => view.id)
      .sort()
      .join('\n'),
    owner: JSON.stringify([
      tab.filePath,
      tab.worktreeId,
      tab.runtimeEnvironmentId ?? null,
      tab.externalSshTargetId ?? null
    ]),
    dirty: isEditorModelDirty(state, tab),
    draft: state.editorDrafts[holder?.id ?? fileId],
    baseline: tab.lastKnownDiskSignature,
    mutation: tab.externalMutation ?? null
  }
}

function sameRecordState(a: ReloadSnapshot, b: ReloadSnapshot): boolean {
  return (
    a.recordId === b.recordId &&
    a.viewIds === b.viewIds &&
    a.owner === b.owner &&
    a.dirty === b.dirty &&
    a.draft === b.draft &&
    a.baseline === b.baseline
  )
}

class ReloadReadError extends Error {}

/** Notes watcher events for any view of `fileId`'s record, which may land after the read took its bytes. */
function watchExternalChanges(fileId: string): {
  seen: () => boolean
  stop: () => void
} {
  let seen = false
  const onChange = (event: Event): void => {
    const detail = (event as CustomEvent<EditorPathMutationTarget>).detail
    const state = useAppStore.getState()
    const tab = state.openFiles.find((file) => file.id === fileId)
    if (!detail || !tab) {
      return
    }
    // Any view of the record counts: a sibling workspace's watcher may report the same file.
    const viewIds = new Set(editorModelSiblingTabs(state, tab).map((view) => view.id))
    if (getOpenFilesForExternalFileChange(state.openFiles, detail).some((f) => viewIds.has(f.id))) {
      seen = true
    }
  }
  window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onChange)
  return {
    seen: () => seen,
    stop: () => window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, onChange)
  }
}

/** One read through the panel loader's routing; anything but editable text refuses the reload. */
async function readEditableDiskText(tab: OpenFile): Promise<string> {
  const plan = await planEditorFileRead({
    id: tab.id,
    filePath: tab.filePath,
    worktreeId: tab.worktreeId,
    relativePath: tab.relativePath,
    tab,
    wakeWslDistro: true,
    trace: {}
  })
  if (plan.kind === 'reown') {
    throw new ReloadReadError(
      translate(
        'auto.components.editor.editorDiskReload.restoring',
        'This tab is still being restored.'
      )
    )
  }
  const result = await readEditorCsvFileContent(plan.args, false)
  if (result.loadError || result.isBinary || result.csvPreview) {
    throw new ReloadReadError(
      translate(
        'auto.components.editor.editorDiskReload.notText',
        'The file on disk is no longer editable text.'
      )
    )
  }
  return result.content
}

function viewIdsWithPreviews(state: AppState, fileId: string): string[] {
  const ids = [fileId, ...editorBufferSiblingViewIds(state, fileId)]
  const previews = state.openFiles.filter(
    (file) =>
      file.mode === 'markdown-preview' &&
      file.markdownPreviewSourceFileId !== undefined &&
      ids.includes(file.markdownPreviewSourceFileId)
  )
  return [...new Set([...ids, ...previews.map((file) => file.id)])]
}

/** Nothing unsaved: drop every view's cache so each panel rereads disk. */
function reloadCleanRecord(state: AppState, fileId: string): void {
  setModelExternalMutation(state, fileId, null)
  for (const viewId of viewIdsWithPreviews(state, fileId)) {
    notifyEditorFileCacheStale(viewId, { userReload: true })
  }
}

/** Synchronous so no save, edit or read can interleave between the last check and the swap. */
function applyReloadedText(
  state: AppState,
  tab: OpenFile,
  content: string,
  before: ReloadSnapshot,
  onUndo: (() => void) | undefined
): void {
  const views = editorModelSiblingTabs(state, tab)
  const signature = getDiskBaselineSignature(content)
  // Fence delayed view commits and queued saves of the discarded text, as Don't Save does.
  bumpEditorDiscardEpoch(before.recordId)
  state.clearEditorDraft(tab.id)
  state.markFileDirty(tab.id, false)
  setModelExternalMutation(state, tab.id, null)
  setEditorDiskBaseline(state, tab.id, signature)
  notifyEditorFileReloaded({
    fileId: tab.id,
    content,
    recordViewIds: views.map((view) => view.id)
  })
  if (before.draft === undefined || before.draft === content) {
    return
  }
  offerReloadUndo({
    file: tab,
    draft: before.draft,
    viewIds: views.map((view) => view.id),
    baseline: before.baseline,
    // Restored edits conflict only if disk moved past the version they were typed over.
    restoredMutation:
      before.mutation === 'changed' || signature !== before.baseline ? 'changed' : null,
    onUndo
  })
}

/**
 * Replace a tab's unsaved edits with the file on disk. Unsaved text is discarded only after the
 * disk read succeeds, and only if nothing changed the record while it was reading.
 */
export async function reloadEditorFileFromDisk(
  fileId: string,
  options?: { onUndo?: () => void }
): Promise<void> {
  let state = useAppStore.getState()
  const requested = state.openFiles.find((file) => file.id === fileId)
  if (!requested) {
    return
  }
  const tab = getEditorSaveTargetFile(requested, state.openFiles)
  if (!tab) {
    // A preview whose source closed owns no unsaved text.
    notifyEditorFileCacheStale(requested.id, { userReload: true })
    return
  }
  const recordId = editorBufferIdOfView(state, tab.id)
  if (reloadingRecords.has(recordId)) {
    return
  }
  // Flush first: debounced rich, notebook and CSV input is unsaved text not yet in the draft.
  flushPendingEditorBuffer(state, tab.id)
  state = useAppStore.getState()
  const initial = snapshotRecord(state, tab.id)
  if (!initial) {
    toastReloadFailed(
      tab,
      translate(
        'auto.components.editor.editorDiskReload.restoring',
        'This tab is still being restored.'
      )
    )
    return
  }
  if (!initial.dirty && initial.draft === undefined) {
    reloadCleanRecord(state, tab.id)
    return
  }
  const releases: (() => void)[] = []
  const externalChanges = watchExternalChanges(tab.id)
  reloadingRecords.add(recordId)
  try {
    // Hold autosave so the draft being replaced cannot reach disk while the read runs.
    releases.push(await requestEditorSaveQuiesce({ fileId: tab.id, discard: true }))
    const before = snapshotRecord(useAppStore.getState(), tab.id)
    if (!before) {
      return
    }
    const liveTab = useAppStore.getState().openFiles.find((file) => file.id === tab.id) ?? tab
    const content = await readEditableDiskText(liveTab)
    // Let an explicit save that started during the read land, so its baseline change cancels us.
    releases.push(await requestEditorSaveQuiesce({ fileId: tab.id, discard: true }))
    state = useAppStore.getState()
    flushPendingEditorBuffer(state, tab.id)
    state = useAppStore.getState()
    const after = snapshotRecord(state, tab.id)
    const current = state.openFiles.find((file) => file.id === tab.id)
    if (
      !after ||
      !current ||
      !sameRecordState(before, after) ||
      hasPendingEditorBufferChange(state, tab.id)
    ) {
      toast(
        translate(
          'auto.components.editor.editorDiskReload.canceled',
          'Reload from Disk was canceled because the file was edited or saved while reading.'
        ),
        { description: tab.relativePath }
      )
      return
    }
    applyReloadedText(state, current, content, before, options?.onUndo)
    if (externalChanges.seen() || (before.mutation === null && after.mutation !== null)) {
      // The file changed again mid-read; the tab is clean now, so reread rather than show older bytes.
      reloadCleanRecord(useAppStore.getState(), current.id)
    }
  } catch (error) {
    toastReloadFailed(
      tab,
      error instanceof Error ? error.message : String(error ?? 'Unknown error')
    )
  } finally {
    externalChanges.stop()
    reloadingRecords.delete(recordId)
    for (const release of releases) {
      release()
    }
  }
}

function toastReloadFailed(tab: OpenFile, reason: string): void {
  toast.error(
    translate(
      'auto.components.editor.editorDiskReload.failed',
      "Couldn't reload {{value0}} from disk. Your unsaved edits were kept.",
      { value0: tab.relativePath }
    ),
    { description: reason }
  )
}
