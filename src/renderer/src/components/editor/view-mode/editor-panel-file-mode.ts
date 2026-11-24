import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import { filePreviewForPath } from '../../../../../shared/file-preview/file-preview-kind'
import { isSvgFilePath } from '../../../../../shared/file-preview/svg-document'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { getEditorToggleModes } from './markdown-preview-controls'

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

// Store-only Changes gate shared by the toolbar and shortcut; loaded-binary checks stay with panel content.
export function canToggleChangesModeForFile(file: OpenFile): boolean {
  if (!canUseChangesModeForFile(file) || file.csvPreviewOnly) {
    return false
  }
  // Why: PDFs, media and raster images load as binary, where the toolbar hides Changes; SVG loads as markup.
  if (filePreviewForPath(file.filePath) !== null && !isSvgFilePath(file.filePath)) {
    return false
  }
  // Why: matches the render model's viewerLanguage — read-only tabs render as plaintext.
  const language = file.readOnly ? 'plaintext' : detectLanguage(file.filePath)
  return getEditorToggleModes({ language, mode: file.mode, diffSource: file.diffSource }).includes(
    'changes'
  )
}
