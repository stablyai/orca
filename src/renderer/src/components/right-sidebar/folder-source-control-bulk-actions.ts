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

/** Resolve the paths a folder bulk action may operate on for the given area. */
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

/** Runs bulk stage, unstage, and discard actions for a folder-scope repo. */
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
  discardAllArea: (area: 'unstaged' | 'untracked', paths: readonly string[]) => Promise<void>
} {
  /** Runs one confirmed bulk operation and refreshes the panel. */
  const runBulk = useCallback(
    async (
      area: 'staged' | 'unstaged' | 'untracked',
      operation: (ctx: RuntimeGitContext, paths: string[]) => Promise<void>,
      confirmedPaths?: readonly string[]
    ) => {
      const paths = [...(confirmedPaths ?? resolveFolderBulkPaths(entries, area, operation))]
      if (paths.length === 0) {
        return
      }
      await operation(context, paths)
      onBranchChanged?.()
      await loadDetails()
    },
    [context, entries, loadDetails, onBranchChanged]
  )

  /** Stages every eligible unstaged/untracked path. */
  const stageAllArea = useCallback(
    (area: 'unstaged' | 'untracked') => runBulk(area, bulkStageRuntimeGitPaths),
    [runBulk]
  )

  /** Unstages every eligible staged path. */
  const unstageAllArea = useCallback(
    (area: 'staged') => runBulk(area, bulkUnstageRuntimeGitPaths),
    [runBulk]
  )

  /** Discards the confirmed path snapshot for the requested area. */
  const discardAllArea = useCallback(
    (area: 'unstaged' | 'untracked', paths: readonly string[]) =>
      runBulk(area, bulkDiscardRuntimeGitPaths, paths),
    [runBulk]
  )

  return { stageAllArea, unstageAllArea, discardAllArea }
}
