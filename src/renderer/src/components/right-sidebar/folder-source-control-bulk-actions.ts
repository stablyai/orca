import { useCallback } from 'react'
import {
  bulkDiscardRuntimeGitPaths,
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import type { GitStatusEntry } from '../../../../shared/types'

export function useFolderSourceControlBulkActions({
  context,
  entries,
  loadDetails,
  onBranchChanged
}: {
  context: RuntimeGitContext
  entries: readonly GitStatusEntry[]
  loadDetails: () => Promise<void>
  onBranchChanged?: () => void
}): {
  stageAllArea: (area: 'unstaged' | 'untracked') => Promise<void>
  unstageAllArea: (area: 'staged') => Promise<void>
  discardAllArea: (area: 'unstaged' | 'untracked') => Promise<void>
} {
  const runBulk = useCallback(
    async (
      area: 'staged' | 'unstaged' | 'untracked',
      operation: (ctx: RuntimeGitContext, paths: string[]) => Promise<void>
    ) => {
      const paths = entries.filter((entry) => entry.area === area).map((entry) => entry.path)
      if (paths.length === 0) {
        return
      }
      await operation(context, paths)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, entries, loadDetails, onBranchChanged]
  )

  const stageAllArea = useCallback(
    (area: 'unstaged' | 'untracked') => runBulk(area, bulkStageRuntimeGitPaths),
    [runBulk]
  )

  const unstageAllArea = useCallback(
    (area: 'staged') => runBulk(area, bulkUnstageRuntimeGitPaths),
    [runBulk]
  )

  const discardAllArea = useCallback(
    (area: 'unstaged' | 'untracked') => runBulk(area, bulkDiscardRuntimeGitPaths),
    [runBulk]
  )

  return { stageAllArea, unstageAllArea, discardAllArea }
}
