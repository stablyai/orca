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
import { flushPendingEditorChange, hasPendingEditorChange } from './editor-pending-flush'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from './diff-content-signature'
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

export type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

export type EditorSaveQueue = {
  queueSave: (
    file: OpenFile,
    fallbackContent: string,
    trigger?: EditorSaveTrigger
  ) => Promise<EditorSaveResult>
  quiesceFileSave: (fileId: string) => Promise<void>
  clearAutoSaveTimer: (fileId: string) => void
  bumpSaveGeneration: (fileId: string) => void
  syncAutoSave: () => void
  dispose: () => void
}

// Why: keeping the save queue, quiesce coordination, and the debounce timers that feed it together avoids split-brain saves.
export function createEditorSaveQueue(store: AppStoreApi): EditorSaveQueue {
  const autoSaveTimers = new Map<string, number>()
  const autoSaveScheduledContent = new Map<string, string>()
  // Why keyed by model: sibling tabs share one text and baseline, so their saves must run in turn.
  const saveQueue = new Map<string, Promise<EditorSaveResult>>()
  const saveGeneration = new Map<string, number>()

  const saveQueueKey = (fileId: string): string => {
    const state = store.getState()
    const file = state.openFiles.find((openFile) => openFile.id === fileId)
    return file?.mode === 'edit' ? editorTabModelUri(state, file) : fileId
  }

  const clearAutoSaveTimer = (fileId: string): void => {
    const timerId = autoSaveTimers.get(fileId)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
      autoSaveTimers.delete(fileId)
    }
    autoSaveScheduledContent.delete(fileId)
  }

  const bumpSaveGeneration = (fileId: string): void => {
    saveGeneration.set(fileId, (saveGeneration.get(fileId) ?? 0) + 1)
  }

  const queueSave = (
    file: OpenFile,
    fallbackContent: string,
    trigger: EditorSaveTrigger = 'user'
  ): Promise<EditorSaveResult> => {
    clearAutoSaveTimer(file.id)
    const queuedGeneration = saveGeneration.get(file.id) ?? 0
    const queueKey = saveQueueKey(file.id)

    const previousSave = saveQueue.get(queueKey) ?? Promise.resolve()
    const queuedSave = previousSave
      .catch(() => undefined)
      .then(async (): Promise<EditorSaveResult> => {
        await waitForModelBaselineRestamps(store.getState(), file)
        if ((saveGeneration.get(file.id) ?? 0) !== queuedGeneration) {
          return 'failed'
        }

        const state = store.getState()
        const liveFile = state.openFiles.find((openFile) => openFile.id === file.id) ?? null
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
            isEditorLargePasteInFlight(editorTabModelUri(state, liveFile)))
        ) {
          return 'failed'
        }

        flushPendingEditorChange(file.id, trigger === 'autosave')
        const contentToSave = store.getState().editorDrafts[file.id] ?? fallbackContent
        if (
          trigger === 'autosave' &&
          hasPendingEditorChange(file.id) &&
          liveFile.lastKnownDiskSignature === getDiskBaselineSignature(contentToSave)
        ) {
          return 'failed'
        }
        const worktree = liveFile.worktreeId
          ? findWorktreeById(state.worktreesByRepo ?? {}, liveFile.worktreeId)
          : null
        const fileContext = getEditorFileOperationContext(state, liveFile, worktree?.path ?? null)
        const connectionId = fileContext.connectionId
        const precondition = editorSavePrecondition(liveFile, trigger)
        if (precondition.kind === 'blocked') {
          // Why: a mobile refusal is reported to mobile; the desktop tab may not even be dirty.
          if (trigger !== 'mobile') {
            setModelExternalMutation(store.getState(), file.id, 'changed')
          }
          return 'blocked-stale'
        }
        // Why: stamp before writing so useEditorExternalWatch ignores our own fs:changed echo (editor-self-write-registry).
        recordSelfWrite(
          liveFile.filePath,
          contentToSave,
          liveFile.runtimeEnvironmentId,
          connectionId || liveFile.runtimeEnvironmentId?.trim()
            ? SELF_WRITE_REMOTE_TTL_MS
            : undefined
        )
        let writeResult: FileWriteResult
        try {
          writeResult = await writeEditorSave(
            fileContext,
            liveFile.filePath,
            contentToSave,
            editorTabFileAccess(state, liveFile),
            precondition
          )
        } catch (error) {
          // Why: the self-write stamp is only valid after a real write; clear on failure so it can't suppress a real update.
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          throw error
        }
        if (!writeResult.ok) {
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          // Why: the banner (or deleted tombstone) explains the refusal and pauses autosave.
          if (trigger !== 'mobile') {
            setModelExternalMutation(
              store.getState(),
              file.id,
              writeResult.diskConflict === 'missing' ? 'deleted' : 'changed'
            )
          }
          return 'blocked-stale'
        }

        // Why before the superseded check: disk holds this text either way, so the next save compares against it.
        rebaselineAfterEditorWrite(store.getState(), file.id, contentToSave)
        if ((saveGeneration.get(file.id) ?? 0) !== queuedGeneration) {
          return 'written'
        }

        const nextState = store.getState()
        const currentDraft = nextState.editorDrafts[file.id]
        const stillDirty =
          (currentDraft !== undefined && currentDraft !== contentToSave) ||
          hasPendingEditorChange(file.id)
        nextState.markFileDirty(file.id, stillDirty)
        if (!stillDirty) {
          nextState.clearEditorDraft(file.id)
        }
        // Why: disk now holds contentToSave, so a pending restore verification is moot.
        nextState.clearPendingDiskBaselineVerification(file.id)
        // Why: the write made disk match the buffer, so clear any now-stale changed-on-disk conflict.
        const savedFile = nextState.openFiles.find((openFile) => openFile.id === file.id)
        if (savedFile?.externalMutation === 'changed') {
          trackExternalChangeConflictAction(savedFile, 'save_overwrite')
          nextState.setExternalMutation(file.id, null)
        }

        window.dispatchEvent(
          new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
            detail: { fileId: file.id, content: contentToSave }
          })
        )
        return 'written'
      })

    let trackedSave: Promise<EditorSaveResult>
    trackedSave = queuedSave.finally(() => {
      if (saveQueue.get(queueKey) === trackedSave) {
        saveQueue.delete(queueKey)
      }
    })
    saveQueue.set(queueKey, trackedSave)
    return trackedSave
  }

  const quiesceFileSave = async (fileId: string): Promise<void> => {
    // Why: rich markdown debounces serialization, so force the pending draft out before we cancel timers.
    flushPendingEditorChange(fileId)
    const pendingSave = saveQueue.get(saveQueueKey(fileId))
    clearAutoSaveTimer(fileId)
    bumpSaveGeneration(fileId)
    await pendingSave?.catch(() => undefined)
  }

  const syncAutoSave = (): void => {
    const state = store.getState()
    const openFilesById = new Map(state.openFiles.map((file) => [file.id, file]))

    for (const fileId of Array.from(autoSaveTimers.keys())) {
      const file = openFilesById.get(fileId)
      const draft = state.editorDrafts[fileId]
      const shouldKeepTimer =
        state.settings?.editorAutoSave &&
        file &&
        file.isDirty &&
        canAutoSaveOpenFile(file) &&
        // Why: suspension holds until the user picks a side via the banner (or saves manually).
        !isAutosaveSuspendedForFile(file) &&
        draft !== undefined
      if (!shouldKeepTimer) {
        clearAutoSaveTimer(fileId)
      }
    }

    if (!state.settings?.editorAutoSave) {
      return
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings.editorAutoSaveDelayMs)
    for (const file of state.openFiles) {
      const draft = state.editorDrafts[file.id]
      if (
        !file.isDirty ||
        draft === undefined ||
        !canAutoSaveOpenFile(file) ||
        isAutosaveSuspendedForFile(file)
      ) {
        clearAutoSaveTimer(file.id)
        continue
      }

      if (autoSaveTimers.has(file.id) && autoSaveScheduledContent.get(file.id) === draft) {
        continue
      }

      clearAutoSaveTimer(file.id)
      autoSaveScheduledContent.set(file.id, draft)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(file.id)
        autoSaveScheduledContent.delete(file.id)
        void queueSave(file, draft, 'autosave').catch((error) => {
          console.error('[editor] autosave failed', error)
        })
      }, autoSaveDelayMs)
      autoSaveTimers.set(file.id, timerId)
    }
  }

  const dispose = (): void => {
    for (const timerId of autoSaveTimers.values()) {
      window.clearTimeout(timerId)
    }
    autoSaveTimers.clear()
    autoSaveScheduledContent.clear()
    saveQueue.clear()
    saveGeneration.clear()
  }

  return {
    queueSave,
    quiesceFileSave,
    clearAutoSaveTimer,
    bumpSaveGeneration,
    syncAutoSave,
    dispose
  }
}
