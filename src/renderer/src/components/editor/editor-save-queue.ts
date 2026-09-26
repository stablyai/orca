import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { writeRuntimeFile } from '@/runtime/runtime-file-client'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import {
  canAutoSaveOpenFile,
  isAutosaveSuspendedForFile,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from './editor-autosave'
import { flushPendingEditorChange } from './editor-pending-flush'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from './diff-content-signature'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'

export type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

export type EditorSaveQueue = {
  queueSave: (
    file: OpenFile,
    fallbackContent: string,
    trigger?: 'autosave' | 'user'
  ) => Promise<void>
  quiesceFileSave: (fileId: string) => Promise<void>
  clearAutoSaveTimer: (fileId: string) => void
  bumpSaveGeneration: (fileId: string) => void
  syncAutoSave: () => void
  dispose: () => void
}

type PendingEditorSave = {
  fallbackContent: string
  trigger: 'autosave' | 'user'
  generation: number
}

type EditorSaveEntry = {
  request: PendingEditorSave | null
  promise: Promise<void>
}

// Why: keeping the save queue, quiesce coordination, and the debounce timers that feed it together avoids split-brain saves.
export function createEditorSaveQueue(store: AppStoreApi): EditorSaveQueue {
  const autoSaveTimers = new Map<string, number>()
  const autoSaveScheduledContent = new Map<string, string>()
  const saveQueue = new Map<string, EditorSaveEntry>()
  const saveGeneration = new Map<string, number>()

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
    const pending = saveQueue.get(fileId)
    if (pending) {
      pending.request = null
    }
  }

  const queueSave = (
    { id: fileId }: OpenFile,
    fallbackContent: string,
    trigger: 'autosave' | 'user' = 'user'
  ): Promise<void> => {
    clearAutoSaveTimer(fileId)
    const queuedGeneration = saveGeneration.get(fileId) ?? 0
    const previousSave = saveQueue.get(fileId)
    const pending = previousSave?.request
    // Pending saves read the latest draft, so keep only one trailing write per generation.
    if (previousSave && pending?.generation === queuedGeneration) {
      pending.fallbackContent = fallbackContent
      if (trigger === 'user') {
        pending.trigger = trigger
      }
      return previousSave.promise
    }

    const entry: EditorSaveEntry = {
      request: { fallbackContent, trigger, generation: queuedGeneration },
      promise: Promise.resolve()
    }
    entry.promise = (previousSave?.promise ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const request = entry.request
        entry.request = null
        if (!request || (saveGeneration.get(fileId) ?? 0) !== queuedGeneration) {
          return
        }

        const state = store.getState()
        const liveFile = state.openFiles.find((openFile) => openFile.id === fileId) ?? null
        if (!liveFile) {
          return
        }

        // Why: read-only tabs (AI Vault View Log) must never write the agent-owned artifact through editor paths.
        if (liveFile.readOnly === true) {
          return
        }

        if (liveFile.pendingOwnerMigration === true) {
          if (request.trigger === 'autosave') {
            return
          }
          throw new Error('This file is still restoring its workspace owner. Try saving again.')
        }

        // Why: only autosave is blocked while suspended; explicit user saves proceed (the banner warned).
        if (request.trigger === 'autosave' && isAutosaveSuspendedForFile(liveFile)) {
          return
        }

        const contentToSave = state.editorDrafts[fileId] ?? request.fallbackContent
        request.fallbackContent = ''
        const worktree = liveFile.worktreeId
          ? findWorktreeById(state.worktreesByRepo ?? {}, liveFile.worktreeId)
          : null
        const fileContext = getEditorFileOperationContext(state, liveFile, worktree?.path ?? null)
        const connectionId = fileContext.connectionId
        // Why: stamp before writing so useEditorExternalWatch ignores our own fs:changed echo (editor-self-write-registry).
        recordSelfWrite(
          liveFile.filePath,
          contentToSave,
          liveFile.runtimeEnvironmentId,
          connectionId || liveFile.runtimeEnvironmentId?.trim()
            ? SELF_WRITE_REMOTE_TTL_MS
            : undefined
        )
        try {
          await writeRuntimeFile(fileContext, liveFile.filePath, contentToSave)
        } catch (error) {
          // Why: the self-write stamp is only valid after a real write; clear on failure so it can't suppress a real update.
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          throw error
        }

        if ((saveGeneration.get(fileId) ?? 0) !== queuedGeneration) {
          return
        }

        const nextState = store.getState()
        const currentDraft = nextState.editorDrafts[fileId]
        const stillDirty = currentDraft !== undefined && currentDraft !== contentToSave
        nextState.markFileDirty(fileId, stillDirty)
        if (!stillDirty) {
          nextState.clearEditorDraft(fileId)
        }
        // Why: disk now holds contentToSave — rebaseline so our own save isn't flagged external; drop pending verification.
        nextState.setLastKnownDiskSignature(fileId, getDiskBaselineSignature(contentToSave))
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
      })
      .finally(() => {
        if (saveQueue.get(fileId) === entry) {
          saveQueue.delete(fileId)
        }
      })
    saveQueue.set(fileId, entry)
    return entry.promise
  }

  const quiesceFileSave = async (fileId: string): Promise<void> => {
    // Why: rich markdown debounces serialization, so force the pending draft out before we cancel timers.
    flushPendingEditorChange(fileId)
    const pendingSave = saveQueue.get(fileId)
    clearAutoSaveTimer(fileId)
    bumpSaveGeneration(fileId)
    await pendingSave?.promise.catch(() => undefined)
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
        void queueSave(file, draft, 'autosave')
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
