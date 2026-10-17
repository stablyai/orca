import type { AppState } from '../store'
import type { OpenFile } from '../store/slices/editor'
import { detectLanguage } from './language-detect'

// Why: a notebook's outputs can run to hundreds of MB; copying that into the restart session on
// every edit costs more than restoring it is worth, so such notebooks ask to be saved instead.
const NOTEBOOK_BACKUP_LIMIT_CHARS = 10_000 * 1024

/** Whether a dirty draft is copied into the restart session; the draft's length stands in for its outputs. */
export function canBackUpEditorDraft(
  file: Pick<OpenFile, 'filePath' | 'relativePath'>,
  draft: string
): boolean {
  return (
    draft.length <= NOTEBOOK_BACKUP_LIMIT_CHARS ||
    detectLanguage(file.relativePath || file.filePath) !== 'notebook'
  )
}

/** Dirty files whose unsaved changes a restart would not bring back. */
export function getDirtyFilesWithoutBackup(
  state: Pick<AppState, 'openFiles' | 'editorDrafts'>
): OpenFile[] {
  return state.openFiles.filter((file) => {
    const draft = state.editorDrafts[file.id]
    return file.isDirty && draft !== undefined && !canBackUpEditorDraft(file, draft)
  })
}
