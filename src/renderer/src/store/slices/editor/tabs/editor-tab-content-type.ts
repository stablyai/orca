import type { Tab } from '../../../../../../shared/tab-types'
import type { OpenFile } from '../types/open-file'

export type EditorTabContentType = Extract<
  Tab['contentType'],
  'editor' | 'diff' | 'conflict-review' | 'check-details'
>

export function isEditorTabContentType(
  contentType: Tab['contentType']
): contentType is EditorTabContentType {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}

/** Editor tabs with no file behind them: their path is a synthetic id, never a workspace path. */
export function isVirtualEditorFile(file: Pick<OpenFile, 'mode'>): boolean {
  return file.mode === 'check-details'
}

/** Conflict review and combined diff tabs keep the worktree root in `filePath`, not a file. */
export function isWorktreeRootEditorFile(file: Pick<OpenFile, 'mode' | 'diffSource'>): boolean {
  return (
    file.mode === 'conflict-review' ||
    (file.mode === 'diff' && (file.diffSource?.startsWith('combined-') ?? false))
  )
}

export function editorTabContentTypeForMode(mode: OpenFile['mode']): EditorTabContentType {
  return mode === 'conflict-review' || mode === 'check-details' || mode === 'diff' ? mode : 'editor'
}
