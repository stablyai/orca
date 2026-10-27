import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import {
  isAutosaveSuspendedForFile,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from './editor-autosave'
import { flushPendingEditorBuffer, hasPendingEditorBufferChange } from './editor-pending-flush'
import { createAutoSaveHolds, editorPathHoldKey } from './editor-autosave-holds'
import {
  editorBufferIdOfView,
  editorBufferSiblingViewIds,
  editorBufferViewIds
} from '@/store/slices/editor/buffers/editor-buffer-views'
import { editorAutoSaveDueRecords } from './editor-autosave-due-records'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { isEditorLargePasteInFlight } from './editor-large-paste-in-flight'
import {
  markEditorSaveRefusal,
  settleEditorRecordAfterWrite,
  settleEditorWriteWithoutViews,
  setModelExternalMutation,
  waitForModelBaselineRestamps
} from './editor-save-rebaseline'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import {
  editorSavePrecondition,
  editorTabModelUri,
  editorSaveGrant,
  writeEditorSave,
  type EditorSaveResult,
  type EditorSaveTrigger
} from './editor-save-disk-precondition'
import { withEditorFileWriteLock } from './editor-file-write-lock'
import {
  editorSaveWriterView,
  liveEditorRecordView,
  liveEditorSaveWriter
} from './editor-save-writer-view'
import { editorBufferIdForFile } from '@/store/slices/editor/buffers/editor-buffer-identity-cache'
import { createEditorSaveSlots, type EditorSaveRequest } from './editor-save-slots'
import { EditorSaveDiscardedError, editorDiscardEpoch } from './editor-discard-epoch'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { releaseNonUtf8PausesWithoutDirtyTab } from './editor-non-utf8-autosave-pause'

export type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

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
    const state = store.getState()
    // A writer closed during the lock wait can leave siblings holding the record’s text.
    const liveFile = liveEditorSaveWriter(state, writerId, writerViewIds, trigger)
    if (!liveFile) {
      return 'failed'
    }
    const fileId = liveFile.id
    // Track views across mid-write closure and record rekeys, which retain views but change IDs.
    const recordViewIds = [fileId, ...editorBufferSiblingViewIds(state, fileId)]
    const identityKey = editorBufferIdForFile(liveFile, state)
    if (liveFile.csvPreviewOnly === true) {
      throw new Error('Large CSV previews are read-only.')
    }

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
      (isAutosaveSuspendedForFile(liveFile) ||
        isEditorLargePasteInFlight(editorTabModelUri(state, liveFile)) ||
        holds.isHeld(state, liveFile))
    ) {
      return 'failed'
    }

    const nothingToWrite = trigger === 'autosave' ? 'failed' : 'written'
    // Check the queued record’s epoch before flushing discarded text; rejoined views may now have a different epoch.
    const discarded = (): boolean => editorDiscardEpoch(request.recordId) !== request.discardEpoch
    if (discarded()) {
      return nothingToWrite
    }
    flushPendingEditorBuffer(store.getState(), fileId, trigger === 'autosave')
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
    const worktree = liveFile.worktreeId
      ? findWorktreeById(selectWorktreesByRepo(state) ?? {}, liveFile.worktreeId)
      : null
    const fileContext = getEditorFileOperationContext(state, liveFile, worktree?.path ?? null)
    const connectionId = fileContext.connectionId
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
        editorTabFileAccess(state, liveFile),
        precondition,
        // Remote host checks await; a discard during them must still prevent the write.
        () => {
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
      markEditorSaveRefusal(
        store.getState(),
        liveEditorRecordView(store.getState(), recordViewIds) ?? liveFile,
        writeResult.diskConflict
      )
      return writeResult.diskConflict === 'not-utf8' ? 'failed' : 'blocked-stale'
    }

    if (writeResult.unchanged) {
      clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
    }
    const savedView = liveEditorRecordView(store.getState(), recordViewIds)
    if (savedView) {
      settleEditorRecordAfterWrite(store.getState, savedView.id, contentToSave)
    } else {
      settleEditorWriteWithoutViews(store.getState(), recordViewIds, identityKey, contentToSave)
    }
    window.dispatchEvent(
      new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
        detail: {
          fileId,
          content: contentToSave,
          recordViewIds: savedView
            ? editorBufferSiblingViewIds(store.getState(), savedView.id)
            : [fileId]
        }
      })
    )
    return 'written'
  }

  const slots = createEditorSaveSlots(async (request) => {
    // A queued save outlives its asking view while sibling views retain the record.
    const askedView = (): OpenFile | null =>
      liveEditorSaveWriter(
        store.getState(),
        request.fileId,
        editorBufferViewIds(store.getState(), request.recordId),
        request.trigger
      )
    const asked = askedView()
    if (asked) {
      await waitForModelBaselineRestamps(store.getState(), asked)
    }
    const current = askedView()
    const view = current && editorSaveWriterView(store.getState(), current.id, request.trigger)
    if (!view) {
      return 'failed'
    }
    const viewIds = editorBufferSiblingViewIds(store.getState(), view.id)
    // Serialize edit, unstaged-diff and combined-diff writes to the same physical file.
    return withEditorFileWriteLock(editorPathHoldKey(store.getState(), view, view.filePath), () =>
      writeSave(view.id, viewIds, request)
    )
  })

  const queueSave = (
    file: OpenFile,
    fallbackContent: string,
    trigger: EditorSaveTrigger = 'user'
  ): Promise<EditorSaveResult> => {
    const key = recordKeyOf(file.id)
    clearScheduledAutoSave(key)
    const requestedDirty = store
      .getState()
      .openFiles.some((tab) => tab.id === file.id && tab.isDirty)
    const discardEpoch = editorDiscardEpoch(key)
    return slots.enqueue(key, {
      fileId: file.id,
      fallbackContent,
      trigger,
      requestedDirty,
      recordId: key,
      discardEpoch
    })
  }

  const settleFileSaves = async (fileId: string, flush = true): Promise<void> => {
    // Flush debounced rich-text serialization before dropping its timer.
    if (flush) {
      flushPendingEditorBuffer(store.getState(), fileId)
    }
    const key = recordKeyOf(fileId)
    clearScheduledAutoSave(key)
    await slots.settle(key)
  }

  const syncAutoSave = (): void => {
    const state = store.getState()
    holds.flagOverdue(state)
    releaseNonUtf8PausesWithoutDirtyTab(state.openFiles)
    const due = editorAutoSaveDueRecords(state, holds.isHeld)
    for (const key of Array.from(autoSaveTimers.keys())) {
      if (!due.has(key)) {
        clearScheduledAutoSave(key)
      }
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings?.editorAutoSaveDelayMs)
    for (const [key, { file, draft }] of due) {
      if (autoSaveTimers.has(key) && autoSaveScheduledContent.get(key) === draft) {
        continue
      }

      clearScheduledAutoSave(key)
      autoSaveScheduledContent.set(key, draft)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(key)
        autoSaveScheduledContent.delete(key)
        // The scheduling view may close while a sibling keeps the record open.
        const current = store.getState()
        const viewIds = new Set(editorBufferViewIds(current, key))
        const view = current.openFiles.find((openFile) => viewIds.has(openFile.id)) ?? file
        void queueSave(view, draft, 'autosave').catch((error) => {
          console.error('[editor] autosave failed', error)
        })
      }, autoSaveDelayMs)
      autoSaveTimers.set(key, timerId)
    }
  }

  const dispose = (): void => {
    for (const timerId of autoSaveTimers.values()) {
      window.clearTimeout(timerId)
    }
    autoSaveTimers.clear()
    autoSaveScheduledContent.clear()
    slots.clear()
    holds.dispose()
  }

  return {
    queueSave,
    settleFileSaves,
    holdAutoSave: holds.hold,
    syncAutoSave,
    dispose
  }
}
