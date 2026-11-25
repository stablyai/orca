import { dirname } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor/types/open-file'

type UntitledPathFile = Pick<OpenFile, 'filePath' | 'relativePath'>

export function getUntitledFileRoot(file: UntitledPathFile, worktreePath?: string | null): string {
  if (worktreePath) {
    return worktreePath
  }

  if (!file.relativePath) {
    return dirname(file.filePath)
  }

  const rootLength = file.filePath.length - file.relativePath.length - 1
  if (rootLength <= 0) {
    return dirname(file.filePath)
  }

  return file.filePath.slice(0, rootLength)
}

// Leftmost dotted run keeps a compound plugin suffix such as `.excalidraw.svg` whole.
const UNTITLED_EXTENSION_PATTERN = /(?:\.[^./\\\s]+)+$/

export function splitUntitledFileName(fileName: string): { stem: string; extension: string } {
  const extension = UNTITLED_EXTENSION_PATTERN.exec(fileName)?.[0] ?? ''
  return { stem: fileName.slice(0, fileName.length - extension.length), extension }
}
