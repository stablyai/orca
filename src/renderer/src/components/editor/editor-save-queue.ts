import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import {
  canAutoSaveOpenFile,
  isAutosaveSuspendedForFile,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from './editor-autosave'
import { flushPendingEditorBuffer, hasPendingEditorBufferChange } from './editor-pending-flush'
import { createAutoSaveHolds, editorPathHoldKey } from './editor-autosave-holds'
import { editorBufferIdOfView } from '@/store/slices/editor/buffers/editor-buffer-views'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { isEditorLargePasteInFlight } from './editor-large-paste-in-flight'
import {
  rebaselineAfterEditorWrite,
  setModelExternalMutation,
  waitForModelBaselineRestamps
} from './editor-save-rebaseline'
import type { FileWriteResult } from '../../../../shared/file-write-disk-precondition'
import {
  editorSavePrecondition,
  editorTabModelUri,
  writeEditorSave,
  type EditorSaveResult,
  type EditorSaveTrigger
} from './editor-save-disk-precondition'
import { withEditorFileWriteLock } from './editor-file-write-lock'
import { editorSaveWriterView } from './editor-save-writer-view'
import { createEditorSaveSlots, type EditorSaveRequest } from './editor-save-slots'
import { EditorSaveDiscardedError, editorDiscardEpoch } from './editor-discard-epoch'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'

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

// Why: keeping the save queue, settle coordination, and the debounce timers that feed it together avoids split-brain saves.
export function createEditorSaveQueue(store: AppStoreApi): EditorSaveQueue {
  // Keyed by record.
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
    fileId: string,
    request: EditorSaveRequest
  ): Promise<EditorSaveResult> => {
    const { trigger } = request
    const state = store.getState()
    const liveFile = state.openFiles.find((openFile) => openFile.id === fileId) ?? null
    if (!liveFile) {
      return 'failed'
    }
    if (liveFile.csvPreviewOnly === true) {
      throw new Error('Large CSV previews are read-only.')
    }

    // Why: read-only tabs (AI Vault View Log) must never write the agent-owned artifact through editor paths.
    if (liveFile.readOnly === true) {
      return 'failed'
    }

    if (liveFile.pendingOwnerMigration === true) {
      if (trigger === 'autosave') {
        return 'failed'
      }
      throw new Error('This file is still restoring its workspace owner. Try saving again.')
    }

    // Why: only autosave is blocked while suspended; explicit user saves proceed (the banner warned).
    if (
      trigger === 'autosave' &&
      (isAutosaveSuspendedForFile(liveFile) ||
        isEditorLargePasteInFlight(editorTabModelUri(state, liveFile)) ||
        holds.isHeld(state, liveFile))
    ) {
      return 'failed'
    }

    const nothingToWrite = trigger === 'autosave' ? 'failed' : 'written'
    // Why: before the flush, which could republish discarded edits; no await follows before the write.
    const discarded = (): boolean =>
      editorDiscardEpoch(recordKeyOf(request.fileId)) !== request.discardEpoch
    if (discarded()) {
      return nothingToWrite
    }
    flushPendingEditorBuffer(store.getState(), fileId, trigger === 'autosave')
    // Why: edits saved by the save ahead or reloaded since the request leave nothing to write.
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
    // Why: stamp before writing so useEditorExternalWatch ignores our own fs:changed echo (editor-self-write-registry).
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
        // Why: a remote write awaits host checks first; a discard in that window must stop the bytes.
        () => {
          if (discarded()) {
            throw new EditorSaveDiscardedError()
          }
        }
      )
    } catch (error) {
      // Why: the self-write stamp is only valid after a real write; clear on failure so it can't suppress a real update.
      clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
      if (error instanceof EditorSaveDiscardedError) {
        return nothingToWrite
      }
      throw error
    }
    if (!writeResult.ok) {
      clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
      // Why: the banner (or deleted tombstone) explains the refusal and pauses autosave.
      setModelExternalMutation(
        store.getState(),
        fileId,
        writeResult.diskConflict === 'missing' ? 'deleted' : 'changed'
      )
      return 'blocked-stale'
    }

    rebaselineAfterEditorWrite(store.getState(), fileId, contentToSave)
    const nextState = store.getState()
    const currentDraft = nextState.editorDrafts[fileId]
    const stillDirty =
      (currentDraft !== undefined && currentDraft !== contentToSave) ||
      hasPendingEditorBufferChange(nextState, fileId)
    nextState.markFileDirty(fileId, stillDirty)
    if (!stillDirty) {
      nextState.clearEditorDraft(fileId)
    }
    // Why: disk now holds contentToSave, so a pending restore verification is moot.
    nextState.clearPendingDiskBaselineVerification(fileId)
    // Why: the write made disk match the buffer, so clear any now-stale changed-on-disk conflict.
    const savedFile = nextState.openFiles.find((openFile) => openFile.id === fileId)
    if (savedFile?.externalMutation === 'changed') {
      trackExternalChangeConflictAction(savedFile, 'save_overwrite')
      nextState.setExternalMutation(fileId, null)
    }

    window.dispatchEvent(
      new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
        detail: { fileId, content: contentToSave }
      })
    )
    return 'written'
  }

  const slots = createEditorSaveSlots(async (request) => {
    const asked = store.getState().openFiles.find((file) => file.id === request.fileId)
    if (asked) {
      await waitForModelBaselineRestamps(store.getState(), asked)
    }
    const view = editorSaveWriterView(store.getState(), request.fileId, request.trigger)
    if (!view) {
      return 'failed'
    }
    // Why: an edit tab, its unstaged diff and a combined-diff section can all write one file.
    return withEditorFileWriteLock(editorPathHoldKey(store.getState(), view, view.filePath), () =>
      writeSave(view.id, request)
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
      discardEpoch
    })
  }

  const settleFileSaves = async (fileId: string, flush = true): Promise<void> => {
    // Why: rich markdown debounces serialization, so force the pending draft out before dropping the timer.
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
    const openFilesByKey = new Map(
      state.openFiles.map((file) => [editorBufferIdOfView(state, file.id), file])
    )

    for (const key of Array.from(autoSaveTimers.keys())) {
      const file = openFilesByKey.get(key)
      const draft = file ? state.editorDrafts[file.id] : undefined
      const shouldKeepTimer =
        state.settings?.editorAutoSave &&
        file &&
        file.isDirty &&
        canAutoSaveOpenFile(file) &&
        // Why: suspension holds until the user picks a side via the banner (or saves manually).
        !isAutosaveSuspendedForFile(file) &&
        !holds.isHeld(state, file) &&
        draft !== undefined
      if (!shouldKeepTimer) {
        clearScheduledAutoSave(key)
      }
    }

    if (!state.settings?.editorAutoSave) {
      return
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings.editorAutoSaveDelayMs)
    for (const file of state.openFiles) {
      const key = editorBufferIdOfView(state, file.id)
      const draft = state.editorDrafts[file.id]
      if (
        !file.isDirty ||
        draft === undefined ||
        !canAutoSaveOpenFile(file) ||
        isAutosaveSuspendedForFile(file) ||
        holds.isHeld(state, file)
      ) {
        clearScheduledAutoSave(key)
        continue
      }

      if (autoSaveTimers.has(key) && autoSaveScheduledContent.get(key) === draft) {
        continue
      }

      clearScheduledAutoSave(key)
      autoSaveScheduledContent.set(key, draft)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(key)
        autoSaveScheduledContent.delete(key)
        void queueSave(file, draft, 'autosave').catch((error) => {
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
