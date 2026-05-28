import type { OpenFile } from '@/store/slices/editor'
import type { GitBranchChangeEntry, GitStatusEntry } from '../../../../shared/types'
import { getEditorDisplayLabel } from './editor-labels'

export type EditorHeaderCopyState = {
  copyText: string | null
  copyToastLabel: string
  pathLabel: string
  pathTitle: string
}

export type EditorHeaderOpenFileState = {
  canOpen: boolean
}

export function getEditorHeaderCopyState(file: OpenFile): EditorHeaderCopyState {
  if (file.mode === 'conflict-review') {
    return {
      copyText: file.filePath,
      copyToastLabel: 'Worktree path copied',
      pathLabel: 'Conflict Review',
      pathTitle: file.filePath
    }
  }

  const isCombinedDiff =
    file.mode === 'diff' &&
    (file.diffSource === 'combined-uncommitted' ||
      file.diffSource === 'combined-branch' ||
      file.diffSource === 'combined-commit')

  if (isCombinedDiff) {
    return {
      copyText: file.filePath,
      copyToastLabel: 'Worktree path copied',
      pathLabel: file.relativePath,
      pathTitle: file.filePath
    }
  }

  const displayLabel = getEditorDisplayLabel(file, 'fullPath')

  return {
    copyText: file.filePath,
    copyToastLabel: 'File path copied',
    pathLabel: displayLabel,
    pathTitle: displayLabel
  }
}

export function getEditorHeaderOpenFileState(
  file: OpenFile,
  worktreeEntry?: GitStatusEntry | null,
  branchEntry?: GitBranchChangeEntry | null
): EditorHeaderOpenFileState {
  const isSingleDiff =
    file.mode === 'diff' &&
    file.diffSource !== undefined &&
    file.diffSource !== 'combined-uncommitted' &&
    file.diffSource !== 'combined-branch' &&
    file.diffSource !== 'combined-commit'

  if (!isSingleDiff) {
    return { canOpen: false }
  }

  if (file.diffSource === 'branch') {
    return { canOpen: branchEntry?.status !== 'deleted' || !branchEntry }
  }
  if (file.diffSource === 'commit') {
    return { canOpen: false }
  }

  // Why: diff tabs can outlive the current Source Control snapshot. If the
  // live entry is missing, keep the action enabled instead of hiding a valid
  // open-file path just because sidebar polling has moved on.
  if (!worktreeEntry) {
    return { canOpen: true }
  }

  return { canOpen: worktreeEntry.status !== 'deleted' }
}
