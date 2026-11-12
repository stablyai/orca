import type { Tab } from '../../../../../../shared/tab-types'
import type { OpenFile } from '../types/open-file'

export type EditorTabContentType = Extract<
  Tab['contentType'],
  'editor' | 'diff' | 'conflict-review' | 'check-details' | 'git-graph'
>

export function isEditorTabContentType(
  contentType: Tab['contentType']
): contentType is EditorTabContentType {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details' ||
    contentType === 'git-graph'
  )
}

/** Editor tabs with no file behind them: their path is a synthetic id, never a workspace path. */
export function isVirtualEditorFile(file: Pick<OpenFile, 'mode'>): boolean {
  return file.mode === 'check-details' || file.mode === 'git-graph'
}

export function editorTabContentTypeForMode(mode: OpenFile['mode']): EditorTabContentType {
  return mode === 'conflict-review' ||
    mode === 'check-details' ||
    mode === 'git-graph' ||
    mode === 'diff'
    ? mode
    : 'editor'
}
