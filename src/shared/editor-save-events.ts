export const MCODE_EDITOR_SAVE_DIRTY_FILES_EVENT = 'mcode:editor-save-dirty-files'
export const MCODE_EDITOR_PREPARE_HOT_EXIT_EVENT = 'mcode:editor-prepare-hot-exit'

export type EditorSaveDirtyFilesDetail = {
  claim: () => void
  resolve: () => void
  reject: (message: string) => void
}

export type EditorPrepareHotExitDetail = EditorSaveDirtyFilesDetail
