import { useMemo } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import type { useRepoById } from '@/store/selectors'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  getWorktreeMergeReviewMenuMode,
  type WorktreeMergeReviewMenuMode
} from './worktree-context-menu-policy'
import { useWorktreeMergeReviewState } from './use-worktree-merge-review-state'

/**
 * Merge-review state and rows for one card.
 *
 * Why both cards get a mode: a pending review belongs to the main checkout, so
 * while one is open the main row must offer accept/reject even though it can
 * never start a sync itself.
 */
export function useWorktreeMergeReviewMenu(args: {
  worktree: Worktree
  repo: ReturnType<typeof useRepoById>
  allWorktrees: readonly Worktree[]
  isMultiContext: boolean
  folderWorkspaceId: string | null
  menuOpen: boolean
}): {
  mainWorktreeId: string | null
  mergeReviewMode: WorktreeMergeReviewMenuMode
} {
  const { allWorktrees, folderWorkspaceId, isMultiContext, menuOpen, repo, worktree } = args
  const mainWorktree = useMemo(
    () =>
      allWorktrees.find((item) => item.repoId === worktree.repoId && item.isMainWorktree) ?? null,
    [allWorktrees, worktree.repoId]
  )
  // Why the extra gate: a folder workspace is not a Git checkout, so probing it
  // would only spawn Git to fail — and no mode below could ever use the answer.
  const mergeReview = useWorktreeMergeReviewState({
    worktreePath: worktree.path,
    worktreeId: worktree.id,
    enabled: menuOpen && !isMultiContext && folderWorkspaceId === null
  })
  const mergeReviewMode = getWorktreeMergeReviewMenuMode({
    isMultiContext,
    isFolderWorkspace: folderWorkspaceId !== null,
    // Why the execution host and not connectionId: runtime-hosted repos carry
    // connectionId: null and would otherwise look local.
    isRemote: repo ? getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID : false,
    isMainWorktree: worktree.isMainWorktree,
    worktreeBranch: worktree.branch,
    mainWorktreeBranch: mainWorktree?.branch || null,
    phase: mergeReview.phase,
    syncSupported: mergeReview.syncSupported
  })
  return { mainWorktreeId: mainWorktree?.id ?? null, mergeReviewMode }
}
