export const ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT = 'orca:editor-save-dirty-files'
export const ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT = 'orca:editor-prepare-hot-exit'
export const ORCA_EDITOR_PREPARE_HOT_EXIT_REPLY_EVENT = 'orca:editor-prepare-hot-exit-reply'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

// Why plain data: the request comes from the context-isolated preload world, which hands
// the page a structured clone of `detail`, so functions in it would arrive as null.
export type EditorPrepareHotExitRequest = {
  requestId: string
  /** False for automatic restarts, which must refuse without asking the user. */
  userInitiated: boolean
}

export type EditorPrepareHotExitReply =
  | { requestId: string; kind: 'claimed' | 'resolved' }
  | { requestId: string; kind: 'rejected'; message: string }
