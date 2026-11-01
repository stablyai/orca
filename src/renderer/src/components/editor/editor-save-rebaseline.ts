import { editorSaveResourceKey } from '@/store/slices/editor/buffers/editor-buffer-identity'
import { sameEditorSaveResource } from './editor-save-writer-view'
import type { AppStoreApi } from './editor-save-queue'
import { writeEditorBuffer } from '@/store/slices/editor/buffers/editor-buffer-record'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getWrittenContentDiskSignature } from '../../../../shared/disk-baseline-signature'
import type { FileWriteDiskConflict } from '../../../../shared/file-write-disk-precondition'
import { notifyEditorFileCacheStale } from './editor-autosave'
import { hasPendingEditorBufferChange } from './editor-pending-flush'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import {
  pauseAutosaveForNonUtf8File,
  resumeAutosaveForNonUtf8File
} from './editor-non-utf8-autosave-pause'
import {
  editorModelSiblingTabs,
  noteEditorBaselineWrite,
  waitForEditorBaselineRestamp
} from './editor-save-disk-precondition'

export function setModelExternalMutation(
  state: AppState,
  fileId: string,
  mutation: NonNullable<OpenFile['externalMutation']> | null
): void {
  state.setExternalMutation(fileId, mutation)
}

/** The banner, deleted tombstone or non-UTF-8 notice explains a refused save and pauses autosave. */
export function markEditorSaveRefusal(
  state: AppState,
  file: OpenFile,
  diskConflict: FileWriteDiskConflict
): void {
  if (diskConflict === 'not-utf8') {
    pauseAutosaveForNonUtf8File(file)
    return
  }
  setModelExternalMutation(state, file.id, diskConflict === 'missing' ? 'deleted' : 'changed')
}

/** A Keep in any tab of this text restamps the baseline the save uses, so wait for all of them. */
export function waitForModelBaselineRestamps(state: AppState, file: OpenFile): Promise<unknown> {
  const tab = state.openFiles.find((openFile) => openFile.id === file.id)
  const tabs = tab ? editorModelSiblingTabs(state, tab) : [file]
  return Promise.all(tabs.map((sibling) => waitForEditorBaselineRestamp(sibling.id)))
}

/** Publish baseline, dirty state and drafts together; a completed write never changes another host's record. */
export function settleEditorRecordAfterWrite(
  store: AppStoreApi,
  viewIds: readonly string[],
  source: OpenFile,
  content: string,
  discarded: boolean
): string[] {
  const resourceKey = editorSaveResourceKey(source, store.getState())
  const signature = getWrittenContentDiskSignature(content)
  const moved: OpenFile[] = []
  store.setState((state) => {
    let next = state
    const writerStillOpen = state.openFiles.some(
      (file) => viewIds.includes(file.id) && sameEditorSaveResource(state, source, file)
    )
    const seen = new Set<string>()
    for (const file of state.openFiles) {
      const recordId = editorBufferIdOfView(state, file.id)
      if (!sameEditorSaveResource(state, source, file) || seen.has(recordId)) {
        continue
      }
      seen.add(recordId)
      const siblings = editorModelSiblingTabs(state, file)
      const original = siblings.some((peer) => viewIds.includes(peer.id))
      const draft = state.editorDrafts[file.id]
      const isDirty = discarded
        ? file.isDirty
        : (draft === undefined ? !original && file.isDirty : draft !== content) ||
          hasPendingEditorBufferChange(state, file.id)
      // A live divergent record must not adopt another record's write as its autosave baseline.
      if (!original && isDirty && writerStillOpen) {
        continue
      }
      const editorDrafts = { ...next.editorDrafts }
      for (const peer of siblings) {
        moved.push(peer)
        if (!isDirty && !discarded) {
          delete editorDrafts[peer.id]
        }
      }
      next = {
        ...next,
        ...writeEditorBuffer(next, file.id, {
          isDirty,
          lastKnownDiskSignature: signature,
          externalMutation:
            !discarded && file.externalMutation === 'changed' ? undefined : file.externalMutation
        }),
        editorDrafts
      }
    }
    const editorBufferKept = { ...next.editorBufferKept }
    for (const [key, kept] of Object.entries(editorBufferKept)) {
      const keptKey =
        kept.resourceKey ??
        JSON.stringify([source.mode, source.mirroredFromRuntimeSession === true, key])
      if (
        !resourceKey ||
        keptKey !== resourceKey ||
        !kept.viewIds.some((id) => viewIds.includes(id))
      ) {
        continue
      }
      if (!discarded && kept.draft === content) {
        delete editorBufferKept[key]
      } else {
        editorBufferKept[key] = {
          ...kept,
          record: { ...kept.record, lastKnownDiskSignature: signature }
        }
      }
    }
    return { ...next, editorBufferKept }
  })
  const currentView = (file: OpenFile): OpenFile | undefined =>
    store
      .getState()
      .openFiles.find(
        (view) => view.id === file.id && sameEditorSaveResource(store.getState(), source, view)
      )
  for (const previous of moved) {
    const file = currentView(previous)
    if (!file) {
      continue
    }
    noteEditorBaselineWrite(file.id)
    resumeAutosaveForNonUtf8File(file)
    if (file.externalMutation === 'changed' && !discarded) {
      trackExternalChangeConflictAction(file, 'save_overwrite')
    }
    if (
      file.id !== source.id &&
      !store.getState().openFiles.find((peer) => peer.id === file.id)?.isDirty
    ) {
      notifyEditorFileCacheStale(file.id)
    }
  }
  return moved.filter(currentView).map((file) => file.id)
}
