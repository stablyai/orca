import { dirname } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'

type UntitledPathFile = Pick<OpenFile, 'filePath' | 'relativePath'>

const MARKDOWN_SUFFIX = /\.md$/i

/**
 * True when the untitled placeholder is the one "New Markdown" creates. "New File" creates an
 * extensionless placeholder, which must keep whatever extension the user types instead.
 */
export function isMarkdownUntitledName(currentName: string): boolean {
  return MARKDOWN_SUFFIX.test(currentName)
}

/**
 * True for `.` and `..`, which pass a path-separator check but resolve to the containing or
 * parent directory once joined into the worktree root.
 */
export function isReservedRelativeName(fileName: string): boolean {
  return fileName === '.' || fileName === '..'
}

/** Resolves the file name a rename should produce, or '' when nothing usable was typed. */
export function resolveUntitledRenameFileName(currentName: string, typedName: string): string {
  const trimmed = typedName.trim()
  if (!isMarkdownUntitledName(currentName)) {
    return trimmed
  }
  // Why: the markdown dialog shows a fixed ".md" next to the input, so strip a typed one
  // rather than producing notes.md.md.
  const stem = trimmed.replace(MARKDOWN_SUFFIX, '')
  return stem ? `${stem}.md` : ''
}

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
