import { useMemo } from 'react'
import type { OpenFile } from '@/store/slices/editor'

/** Returns the editor files owned by the rendered worktree. */
export function useWorktreeFiles(
  openFiles: readonly OpenFile[],
  renderedActiveWorktreeId: string | null
): OpenFile[] {
  return useMemo(
    () =>
      renderedActiveWorktreeId
        ? openFiles.filter((file) => file.worktreeId === renderedActiveWorktreeId)
        : [],
    [openFiles, renderedActiveWorktreeId]
  )
}
