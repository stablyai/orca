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
  const stageAllArea = useCallback(
    async (area: 'unstaged' | 'untracked') => {
      const paths = entries.filter((entry) => entry.area === area).map((entry) => entry.path)
      if (paths.length === 0) {
        return
      }
      await bulkStageRuntimeGitPaths(context, paths)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, entries, loadDetails, onBranchChanged]
  )

  const unstageAllArea = useCallback(
    async (area: 'staged') => {
      const paths = entries.filter((entry) => entry.area === area).map((entry) => entry.path)
      if (paths.length === 0) {
        return
      }
      await bulkUnstageRuntimeGitPaths(context, paths)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, entries, loadDetails, onBranchChanged]
  )

  const discardAllArea = useCallback(
    async (area: 'unstaged' | 'untracked') => {
      const paths = entries.filter((entry) => entry.area === area).map((entry) => entry.path)
      if (paths.length === 0) {
        return
      }
      await bulkDiscardRuntimeGitPaths(context, paths)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, entries, loadDetails, onBranchChanged]
  )

  return { stageAllArea, unstageAllArea, discardAllArea }
}
