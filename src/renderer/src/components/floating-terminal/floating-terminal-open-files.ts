import type { OpenFile } from '@/store/slices/editor'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

let cachedOpenFiles: OpenFile[] | null = null
let cachedFloatingFiles: OpenFile[] = []

export function getFloatingTerminalOpenFiles(openFiles: OpenFile[]): OpenFile[] {
  if (openFiles === cachedOpenFiles) {
    return cachedFloatingFiles
  }

  const nextFloatingFiles = openFiles.filter(
    (file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID
  )
  if (
    cachedOpenFiles !== null &&
    nextFloatingFiles.length === cachedFloatingFiles.length &&
    nextFloatingFiles.every((file, index) => file === cachedFloatingFiles[index])
  ) {
    cachedOpenFiles = openFiles
    return cachedFloatingFiles
  }

  cachedOpenFiles = openFiles
  cachedFloatingFiles = nextFloatingFiles
  return cachedFloatingFiles
}
