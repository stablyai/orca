import { joinPath } from '@/lib/path'
import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { OpenFile } from '@/store/slices/editor'
import { getUntitledFileRoot } from './untitled-file-rename-path'

export type EditorHeaderPathSegment = {
  id: string
  label: string
  relativeDirectoryPath: string
  isFile: boolean
}

const PREVIEW_SUFFIX = ' (preview)'

export function canNavigateEditorHeaderPath(
  file: Pick<OpenFile, 'mode' | 'relativePath'>
): boolean {
  return (
    (file.mode === 'edit' || file.mode === 'markdown-preview') &&
    !isRuntimePathAbsolute(file.relativePath)
  )
}

export function getEditorHeaderPathPreviewSuffix(file: Pick<OpenFile, 'mode'>): string | null {
  return file.mode === 'markdown-preview' ? PREVIEW_SUFFIX : null
}

export function getEditorHeaderPathSegments(
  file: Pick<OpenFile, 'mode' | 'relativePath'>
): EditorHeaderPathSegment[] | null {
  if (!canNavigateEditorHeaderPath(file)) {
    return null
  }

  const parts = file.relativePath.split(/[\\/]+/).filter(Boolean)
  return parts.map((label, index) => {
    const isFile = index === parts.length - 1
    const directoryParts = isFile ? parts.slice(0, -1) : parts.slice(0, index + 1)
    return {
      id: parts.slice(0, index + 1).join('/'),
      label,
      relativeDirectoryPath: directoryParts.join('/'),
      isFile
    }
  })
}

export function resolveEditorHeaderDirectoryAbsolutePath(
  file: Pick<OpenFile, 'filePath' | 'relativePath'>,
  worktreePath: string | null | undefined,
  relativeDirectoryPath: string
): string {
  const root = worktreePath?.trim() || getUntitledFileRoot(file, worktreePath)
  return relativeDirectoryPath ? joinPath(root, relativeDirectoryPath) : root
}

export function isEditorHeaderPathCurrentEntry(
  listingDirectoryAbsolutePath: string,
  entryName: string,
  currentFilePath: string
): boolean {
  return (
    normalizeRuntimePathForComparison(joinPath(listingDirectoryAbsolutePath, entryName)) ===
    normalizeRuntimePathForComparison(currentFilePath)
  )
}

export function getEditorHeaderPathOpenKind(
  currentMode: OpenFile['mode'],
  language: string
): 'edit' | 'markdown-preview' {
  return currentMode === 'markdown-preview' && language === 'markdown' ? 'markdown-preview' : 'edit'
}
