import { useCallback } from 'react'
import {
  bulkDiscardRuntimeGitPaths,
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths,
  type RuntimeGitContext
} from '@/runtime/runtime-git-client'
import type { GitStatusEntry } from '../../../../shared/types'
import {
  getDiscardAllPaths,
  getStageAllPaths,
  getUnstageAllPaths,
  type StageAllArea
} from './discard-all-sequence'

export function resolveFolderBulkPaths(
  entries: readonly GitStatusEntry[],
  area: 'staged' | 'unstaged' | 'untracked',
  operation: (ctx: RuntimeGitContext, paths: string[]) => Promise<void>
): string[] {
  return operation === bulkStageRuntimeGitPaths
    ? getStageAllPaths(entries, area as StageAllArea)
    : operation === bulkUnstageRuntimeGitPaths
      ? getUnstageAllPaths(entries)
      : getDiscardAllPaths(entries, area)
}

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
      const paths = resolveFolderBulkPaths(entries, area, operation)
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
