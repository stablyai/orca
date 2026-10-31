import { createEditorAutoSaveScan } from './editor-autosave-scan'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import {
  isAutosaveSuspendedForFile,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from './editor-autosave'
import { flushEditorViewsForSave, hasPendingEditorBufferChange } from './editor-pending-flush'
import { createAutoSaveHolds, editorPathHoldKey } from './editor-autosave-holds'
import {
  editorBufferIdOfView,
  editorBufferSiblingViewIds
} from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import {
  markEditorSaveRefusal,
  settleEditorRecordAfterWrite,
  setModelExternalMutation,
  waitForModelBaselineRestamps
} from './editor-save-rebaseline'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import {
  editorSavePrecondition,
  editorSaveGrant,
  writeEditorSave,
  type EditorSaveResult,
  type EditorSaveTrigger
} from './editor-save-disk-precondition'
import { withEditorFileWriteLock } from './editor-file-write-lock'
import {
  liveEditorSaveWriter,
  sameEditorSaveResource,
  captureEditorSave
} from './editor-save-writer-view'
import { createEditorSaveSlots, type EditorSaveRequest } from './editor-save-slots'
import { EditorSaveDiscardedError, editorDiscardEpoch } from './editor-discard-epoch'
import { hasEditorBytesDraft, saveEditorBytesDraft } from './editor-bytes-documents'

export type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'setState' | 'subscribe'>

export type EditorSaveQueue = {
  queueSave: (
    file: OpenFile,
    fallbackContent: string,
    trigger?: EditorSaveTrigger
  ) => Promise<EditorSaveResult>
  /** Flushes pending text, drops the autosave timer, then waits for the running and queued saves. */
  settleFileSaves: (fileId: string, flush?: boolean) => Promise<void>
  /** Pauses autosave of these files (hold keys), in every workspace, until the release runs. */
  holdAutoSave: (keys: ReadonlySet<string>) => () => void
  syncAutoSave: () => void
  dispose: () => void
}

// Keep debounce and settle coordination with the queue to prevent competing saves.
export function createEditorSaveQueue(store: AppStoreApi): EditorSaveQueue {
  const autoSaveTimers = new Map<string, number>()
  const autoSaveScheduledContent = new Map<string, string>()

  const recordKeyOf = (fileId: string): string => editorBufferIdOfView(store.getState(), fileId)

  const clearScheduledAutoSave = (key: string): void => {
    const timerId = autoSaveTimers.get(key)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
      autoSaveTimers.delete(key)
    }
    autoSaveScheduledContent.delete(key)
  }

  const holds = createAutoSaveHolds(store.getState, () => syncAutoSave())

  const writeSave = async (
    writerId: string,
    writerViewIds: readonly string[],
    request: EditorSaveRequest
  ): Promise<EditorSaveResult> => {
    const { trigger } = request
    if (!('operation' in request.invocation)) {
      throw request.invocation.error
    }
    const { operation, access } = request.invocation
    const state = store.getState()
    // A writer closed during the lock wait can leave siblings holding the record’s text.
    const liveFile = liveEditorSaveWriter(state, writerId, writerViewIds, trigger, operation.file)
    if (!liveFile) {
      return 'failed'
    }
    const fileId = liveFile.id
    // Track views across mid-write closure and record rekeys, which retain views but change IDs.
    const recordViewIds = [fileId, ...editorBufferSiblingViewIds(state, fileId)]
    // Read-only artifact tabs must never write agent-owned files.
    if (liveFile.readOnly === true) {
      return 'failed'
    }

    if (liveFile.pendingOwnerMigration === true) {
      if (trigger === 'autosave') {
        return 'failed'
      }
      throw new Error('This file is still restoring its workspace owner. Try saving again.')
    }

    // Explicit saves bypass autosave suspension but remain guarded; only Overwrite grants conflict consent.
    if (
      trigger === 'autosave' &&
      (isAutosaveSuspendedForFile(liveFile) || holds.isHeld(state, liveFile))
    ) {
      return 'failed'
    }

    const nothingToWrite = trigger === 'autosave' ? 'failed' : 'written'
    // Check the queued record’s epoch before flushing discarded text; rejoined views may now have a different epoch.
    const discarded = (): boolean => editorDiscardEpoch(request.recordId) !== request.discardEpoch
    if (discarded()) {
      return nothingToWrite
    }
    if (!(await flushEditorViewsForSave(store.getState, fileId, trigger === 'autosave'))) {
      return discarded() ? nothingToWrite : 'failed'
    }
    // Earlier saves or reloads can leave a queued dirty request with nothing to write.
    const isDirty = store.getState().openFiles.find((file) => file.id === fileId)?.isDirty === true
    if (!isDirty && request.requestedDirty && trigger !== 'overwrite') {
      return nothingToWrite
    }
    const contentToSave = store.getState().editorDrafts[fileId] ?? request.fallbackContent
    if (
      trigger === 'autosave' &&
      hasPendingEditorBufferChange(store.getState(), fileId) &&
      liveFile.lastKnownDiskSignature === getDiskBaselineSignature(contentToSave)
    ) {
      return 'failed'
    }
    operation.assertAuthorityCurrent()
    const fileContext = operation.mutationContext()
    const connectionId = fileContext.connectionId
    const assertWriterCurrent = (): void => {
      operation.assertAuthorityCurrent()
      if (!liveEditorSaveWriter(store.getState(), fileId, recordViewIds, trigger, operation.file)) {
        throw new Error('This file is no longer open for saving.')
      }
    }
    if (hasEditorBytesDraft(fileId)) {
      return saveEditorBytesDraft(
        store.getState,
        liveFile,
        fileContext,
        trigger,
        discarded,
        assertWriterCurrent
      )
    }
    const precondition = editorSavePrecondition(liveFile, trigger)
    if (precondition.kind === 'blocked') {
      setModelExternalMutation(store.getState(), fileId, 'changed')
      return 'blocked-stale'
    }
    // Stamp before writing so watcher echoes cannot reload the editor’s own save.
    recordSelfWrite(
      liveFile.filePath,
      contentToSave,
      liveFile.runtimeEnvironmentId,
      connectionId || liveFile.runtimeEnvironmentId?.trim() ? SELF_WRITE_REMOTE_TTL_MS : undefined
    )
    let writeResult: FileWriteResult
    try {
      writeResult = await writeEditorSave(
        fileContext,
        liveFile.filePath,
        contentToSave,
        access,
        precondition,
        // Remote host checks await; a discard during them must still prevent the write.
        () => {
          assertWriterCurrent()
          if (discarded()) {
            throw new EditorSaveDiscardedError()
          }
        },
        editorSaveGrant(liveFile, fileContext, () => store.getState())
      )
    } catch (error) {
      // Clear failed-write stamps so they cannot suppress real external changes.
      clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
      if (error instanceof EditorSaveDiscardedError) {
        return nothingToWrite
      }
      throw error
    }
    if (!writeResult.ok) {
      clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
      // Explicit saves request conversion rather than suspending autosave.
      if (writeResult.diskConflict === 'not-utf8' && trigger === 'user') {
        return 'not-utf8'
      }
      const current = store.getState()
      const entitled = current.openFiles.find(
        (file) =>
          recordViewIds.includes(file.id) && sameEditorSaveResource(current, operation.file, file)
      )
      if (entitled) {
        markEditorSaveRefusal(current, entitled, writeResult.diskConflict)
      }
      return writeResult.diskConflict === 'not-utf8' ? 'failed' : 'blocked-stale'
    }

    if (writeResult.unchanged) {
      clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
    }
    const settledViewIds = settleEditorRecordAfterWrite(
      store,
      recordViewIds,
      operation.file,
      contentToSave,
      discarded()
    )
    if (settledViewIds.length === 0) {
      return 'written'
    }
    window.dispatchEvent(
      new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
        detail: {
          fileId: settledViewIds.includes(fileId) ? fileId : settledViewIds[0],
          content: contentToSave,
          recordViewIds: settledViewIds
        }
      })
    )
    return 'written'
  }

  const slots = createEditorSaveSlots(async (request) => {
    if (!('operation' in request.invocation)) {
      if (request.trigger === 'autosave') {
        return 'failed'
      }
      throw request.invocation.error
    }
    const { operation } = request.invocation
    // A queued save outlives its asking view while sibling views retain the record.
    const askedView = (): OpenFile | null =>
      liveEditorSaveWriter(
        store.getState(),
        request.fileId,
        request.viewIds,
        request.trigger,
        operation.file
      )
    const asked = askedView()
    if (asked) {
      await waitForModelBaselineRestamps(store.getState(), asked)
    }
    const current = askedView()
    const view = current
    if (!view) {
      return 'failed'
    }
    const viewIds = editorBufferSiblingViewIds(store.getState(), view.id)
    // Serialize edit, unstaged-diff and combined-diff writes to the same physical file.
    return withEditorFileWriteLock(editorPathHoldKey(store.getState(), view, view.filePath), () =>
      writeSave(view.id, viewIds, request)
    )
  })

  const captureRequest = (
    file: OpenFile,
    fallbackContent: string,
    trigger: EditorSaveTrigger
  ): EditorSaveRequest => {
    const invocation = captureEditorSave(store, file, trigger)
    const captured = 'operation' in invocation ? invocation.operation.file : file
    const state = store.getState()
    const key = recordKeyOf(captured.id)
    return {
      fileId: captured.id,
      fallbackContent,
      trigger,
      invocation,
      viewIds: editorBufferSiblingViewIds(state, captured.id),
      requestedDirty: state.openFiles.some((tab) => tab.id === captured.id && tab.isDirty),
      recordId: key,
      discardEpoch: editorDiscardEpoch(key)
    }
  }
  const enqueueSave = (request: EditorSaveRequest): Promise<EditorSaveResult> => {
    clearScheduledAutoSave(request.recordId)
    return slots.enqueue(request.recordId, request)
  }
  const queueSave: EditorSaveQueue['queueSave'] = (file, content, trigger = 'user') =>
    enqueueSave(captureRequest(file, content, trigger))

  const settleFileSaves = async (fileId: string, flush = true): Promise<void> => {
    // Flush debounced rich-text serialization before dropping its timer.
    if (flush) {
      await flushEditorViewsForSave(store.getState, fileId)
    }
    const key = recordKeyOf(fileId)
    clearScheduledAutoSave(key)
    await slots.settle(key)
  }

  const syncAutoSave = createEditorAutoSaveScan(
    store,
    holds,
    autoSaveTimers,
    autoSaveScheduledContent,
    clearScheduledAutoSave,
    captureRequest,
    enqueueSave
  )

  const dispose = (): void => {
    for (const timerId of autoSaveTimers.values()) {
      window.clearTimeout(timerId)
    }
    autoSaveTimers.clear()
    autoSaveScheduledContent.clear()
    slots.clear()
    holds.dispose()
  }

  return { queueSave, settleFileSaves, holdAutoSave: holds.hold, syncAutoSave, dispose }
}
