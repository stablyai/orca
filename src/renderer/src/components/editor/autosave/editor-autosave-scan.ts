import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { AppStoreApi } from '../save/queue/editor-save-queue-contract'
import type { EditorSaveRequest } from '../save/queue/editor-save-slots'
import type {
  EditorSaveResult,
  EditorSaveTrigger
} from '../save/queue/editor-save-disk-precondition'
import type { AutoSaveHolds } from './editor-autosave-holds'
import { normalizeAutoSaveDelayMs } from './editor-autosave'
import { editorAutoSaveDueRecords } from './editor-autosave-due-records'
import { releaseNonUtf8PausesWithoutDirtyTab } from './editor-non-utf8-autosave-pause'

export function clearScheduledEditorAutoSave(
  timers: Map<string, number>,
  scheduledContent: Map<string, string>,
  key: string
): void {
  const timerId = timers.get(key)
  if (timerId !== undefined) {
    window.clearTimeout(timerId)
    timers.delete(key)
  }
  scheduledContent.delete(key)
}

export function createEditorAutoSaveScan(
  store: AppStoreApi,
  holds: AutoSaveHolds,
  timers: Map<string, number>,
  scheduledContent: Map<string, string>,
  clearScheduled: (key: string) => void,
  capture: (file: OpenFile, draft: string, trigger: EditorSaveTrigger) => EditorSaveRequest,
  enqueue: (request: EditorSaveRequest) => Promise<EditorSaveResult>
): () => void {
  const scanAutoSave = (): void => {
    const state = store.getState()
    holds.flagOverdue(state)
    releaseNonUtf8PausesWithoutDirtyTab(state.openFiles)
    const due = editorAutoSaveDueRecords(state, holds.isHeld)
    for (const key of timers.keys()) {
      if (!due.has(key)) {
        clearScheduled(key)
      }
    }
    const delay = normalizeAutoSaveDelayMs(state.settings?.editorAutoSaveDelayMs)
    for (const [key, { file, draft }] of due) {
      if (timers.has(key) && scheduledContent.get(key) === draft) {
        continue
      }
      const request = capture(file, draft, 'autosave')
      const currentDraft = store.getState().editorDrafts[request.fileId] ?? draft
      clearScheduled(key)
      clearScheduled(request.recordId)
      scheduledContent.set(request.recordId, currentDraft)
      timers.set(
        request.recordId,
        window.setTimeout(() => {
          timers.delete(request.recordId)
          scheduledContent.delete(request.recordId)
          void enqueue(request).catch((error) => console.error('[editor] autosave failed', error))
        }, delay)
      )
    }
  }

  let scanningAutoSave = false
  let autoSaveScanRequested = false
  const syncAutoSave = (): void => {
    autoSaveScanRequested = true
    if (scanningAutoSave) {
      return
    }
    scanningAutoSave = true
    try {
      do {
        autoSaveScanRequested = false
        scanAutoSave()
      } while (autoSaveScanRequested)
    } finally {
      scanningAutoSave = false
    }
  }
  return syncAutoSave
}
