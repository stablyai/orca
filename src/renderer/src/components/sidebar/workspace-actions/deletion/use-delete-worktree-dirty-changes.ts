import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GitStatusResult } from '../../../../../../shared/git/status/git-status-types'
import type { WorktreeDeleteState } from '../../../../store/slices/worktrees/teardown/worktree-delete-state-types'
import {
  getDeleteWorktreeChangeCheckStates,
  getDeleteWorktreeDirtyChangeCounts,
  getDeleteWorktreeDirtyChangePreviews
} from './delete-worktree-dirty-change-counts'

/** Per-target change checks, dirty counts, and previews for the delete confirmation. */
export function useDeleteWorktreeDirtyChanges({
  deleteTargets,
  gitStatusByWorktreeIdentity,
  repoMap,
  deleteStateByWorktreeId
}: {
  deleteTargets: readonly Worktree[]
  gitStatusByWorktreeIdentity: ReadonlyMap<string, GitStatusResult['entries'] | null>
  repoMap: ReadonlyMap<string, Repo>
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState | undefined>
}) {
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const dirtyChanges = useMemo(() => {
    const statusInput = { deleteTargets, gitStatusByWorktree, gitStatusByWorktreeIdentity, repoMap }
    return {
      checkStates: getDeleteWorktreeChangeCheckStates(statusInput),
      counts: getDeleteWorktreeDirtyChangeCounts({ ...statusInput, deleteStateByWorktreeId }),
      previews: getDeleteWorktreeDirtyChangePreviews(statusInput)
    }
  }, [
    deleteStateByWorktreeId,
    deleteTargets,
    gitStatusByWorktree,
    gitStatusByWorktreeIdentity,
    repoMap
  ])
  // Per-target hints only warn once changes are known; pending or failed checks still lose data.
  const hasUnknownChangeState = [...dirtyChanges.checkStates].some(
    ([key, state]) => state !== 'complete' && !dirtyChanges.counts.has(key)
  )
  return { dirtyChanges, hasUnknownChangeState }
}
