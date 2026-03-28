import type { OpenFile } from '@/store/slices/editor'

export type EditorHeaderCopyState = {
  copyText: string | null
  copyToastLabel: string
  pathLabel: string
  pathTitle: string
}

export function getEditorHeaderCopyState(file: OpenFile): EditorHeaderCopyState {
  const isCombinedDiff = file.mode === 'diff' && file.diffStaged === undefined

  if (isCombinedDiff) {
    return {
      copyText: file.filePath,
      copyToastLabel: 'Worktree path copied',
      pathLabel: file.relativePath,
      pathTitle: file.filePath
    }
  }

  return {
    copyText: file.filePath,
    copyToastLabel: 'File path copied',
    pathLabel: file.filePath,
    pathTitle: file.filePath
  }
}
