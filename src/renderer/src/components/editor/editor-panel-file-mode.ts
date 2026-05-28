import type { OpenFile } from '@/store/slices/editor'

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
