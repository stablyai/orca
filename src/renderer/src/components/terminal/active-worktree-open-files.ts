import type { OpenFile } from '@/store/slices/editor'

const EMPTY_OPEN_FILES: OpenFile[] = []

let cachedOpenFiles: OpenFile[] | null = null
let cachedWorktreeId: string | null = null
let cachedFiles: OpenFile[] = EMPTY_OPEN_FILES

export function getActiveWorktreeOpenFiles(
  openFiles: OpenFile[],
  activeWorktreeId: string | null
): OpenFile[] {
  if (!activeWorktreeId) {
    return EMPTY_OPEN_FILES
  }
  if (openFiles === cachedOpenFiles && activeWorktreeId === cachedWorktreeId) {
    return cachedFiles
  }

  const nextFiles = openFiles.filter((file) => file.worktreeId === activeWorktreeId)
  if (
    cachedOpenFiles !== null &&
    activeWorktreeId === cachedWorktreeId &&
    nextFiles.length === cachedFiles.length &&
    nextFiles.every((file, index) => file === cachedFiles[index])
  ) {
    cachedOpenFiles = openFiles
    return cachedFiles
  }

  cachedOpenFiles = openFiles
  cachedWorktreeId = activeWorktreeId
  cachedFiles = nextFiles.length > 0 ? nextFiles : EMPTY_OPEN_FILES
  return cachedFiles
}
