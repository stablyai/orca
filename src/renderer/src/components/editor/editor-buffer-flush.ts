import type { AppState } from '@/store/types'
import { editorBufferViewIds } from '@/store/slices/editor/buffers/editor-buffer-record'
import type { RecoveredEditorDraft } from '../../../../shared/workspace-session-state-types'
import { flushPendingEditorChange, pendingWholeDocumentEdits } from './editor-pending-flush'

let recoveredSequence = 0

/**
 * Flushes every tab's delayed edits for one file. Two views that each serialize the whole document
 * (rich markdown) can't merge, so the most recently edited one is applied last and wins; the text
 * the other produced is kept as a recovered draft for its own workspace instead of being lost.
 */
export type EditorFlushState = Pick<
  AppState,
  'openFiles' | 'editorBufferIndex' | 'editorDrafts' | 'addRecoveredEditorDrafts'
>

export function flushEditorBufferViews(
  getState: () => EditorFlushState,
  fileId: string,
  autosave = false
): void {
  const ids = editorBufferViewIds(getState(), fileId)
  const wholeDocument = ids
    .flatMap((id) => pendingWholeDocumentEdits(id).map((edit) => ({ ...edit, id })))
    .sort((a, b) => a.editedAt - b.editedAt)
  if (wholeDocument.length > 1) {
    const produced = wholeDocument.map((edit) => {
      edit.flush()
      return { id: edit.id, text: getState().editorDrafts[edit.id] }
    })
    recoverOverwrittenTexts(getState(), produced)
  }
  for (const id of ids) {
    flushPendingEditorChange(id, autosave)
  }
}

function recoverOverwrittenTexts(
  state: EditorFlushState,
  produced: { id: string; text: string | undefined }[]
): void {
  const kept = produced.at(-1)?.text
  const recovered: RecoveredEditorDraft[] = []
  for (const { id, text } of produced.slice(0, -1)) {
    const file = state.openFiles.find((openFile) => openFile.id === id)
    if (!file || text === undefined || text === kept) {
      continue
    }
    recoveredSequence += 1
    const now = Date.now()
    recovered.push({
      id: `flush:${now}:${recoveredSequence}`,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      ...(file.runtimeEnvironmentId !== undefined
        ? { runtimeEnvironmentId: file.runtimeEnvironmentId }
        : {}),
      draft: text,
      ...(file.lastKnownDiskSignature ? { baselineSignature: file.lastKnownDiskSignature } : {}),
      recoveredAt: now
    })
  }
  if (recovered.length > 0) {
    state.addRecoveredEditorDrafts(recovered)
  }
}
