import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import type { EditorSaveResult, EditorSaveTrigger } from './editor-save-disk-precondition'

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
