import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeDeleteState } from '../../../../store/slices/worktrees/teardown/worktree-delete-state-types'
import {
  getDeleteWorktreeChangeCheckStates,
  getDeleteWorktreeDirtyChangeCounts,
  getDeleteWorktreeDirtyChangePreviews
} from './delete-worktree-dirty-change-counts'

export function useDeleteWorktreeDirtyChanges({
  deleteTargets,
  gitStatusByWorktreeIdentity,
  deleteStateByWorktreeId,
  repoMap
}: {
  deleteTargets: readonly Worktree[]
  gitStatusByWorktreeIdentity: ReadonlyMap<string, readonly GitStatusEntry[] | null>
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState | undefined>
  repoMap: ReadonlyMap<string, Repo>
}) {
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitStatusReadErrorByWorktree = useAppStore((s) => s.gitStatusReadErrorByWorktree)
  return useMemo(() => {
    const statusInput = {
      deleteTargets,
      gitStatusByWorktree,
      gitStatusReadErrorByWorktree,
      gitStatusByWorktreeIdentity,
      repoMap
    }
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
    gitStatusReadErrorByWorktree,
    repoMap
  ])
}
