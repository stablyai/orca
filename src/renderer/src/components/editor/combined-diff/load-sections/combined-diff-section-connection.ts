import { getConnectionIdForFile } from '@/lib/connection-context'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { acquireEditorFileOperation } from '@/lib/editor-file-operation-owner'
import type { OpenFile } from '@/store/slices/editor'

export function acquireCombinedDiffSectionOperation(file: OpenFile, sectionPath: string) {
  const operation = acquireEditorFileOperation(useAppStore.getState, file, {
    filePath: joinPath(file.filePath, sectionPath),
    worktreePath: file.filePath
  })
  return { ...operation, context: { ...operation.context, worktreePath: file.filePath } }
}

/** Mixed local/SSH folder workspaces need child-repo path ownership to route section reads to the correct host. */
export function getCombinedDiffSectionConnectionId(
  worktreeId: string | null,
  worktreeRootPath: string,
  sectionPath: string
): string | undefined {
  return getConnectionIdForFile(worktreeId, joinPath(worktreeRootPath, sectionPath)) ?? undefined
}
