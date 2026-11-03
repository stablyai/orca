import type { EditorViewMode, OpenFile } from '@/store/slices/editor'

export function isAbsolutePathLike(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(value)
}

export function canUseChangesModeForFile(file: OpenFile): boolean {
  return (
    file.mode === 'edit' &&
    !file.isUntitled &&
    file.relativePath !== file.filePath &&
    !isAbsolutePathLike(file.relativePath)
  )
}

/** Next edit↔changes mode for the toolbar toggle; null when changes mode is unavailable. */
export function toggleEditorDiffViewMode(
  currentMode: EditorViewMode | undefined,
  canUseChanges: boolean
): EditorViewMode | null {
  if (!canUseChanges) {
    return null
  }
  return currentMode === 'changes' ? 'edit' : 'changes'
}
