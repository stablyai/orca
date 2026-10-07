import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { LineageMember } from '../../../../../shared/lineage-discovery-types'
import type { Worktree } from '../../../../../shared/worktree/types'

/** Maps a member to the store's worktree by id, then by path; null for a manual PR with no worktree. */
export function useLineageMemberWorktreeResolver(): (member: LineageMember) => Worktree | null {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const allWorktrees = useAllWorktrees()
  return useCallback(
    (member) => {
      const byId = member.worktreeId
        ? findWorktreeById(worktreesByRepo, member.worktreeId)
        : undefined
      const byPath = member.worktreePath
        ? allWorktrees.find((worktree) => worktree.path === member.worktreePath)
        : undefined
      return byId ?? byPath ?? null
    },
    [allWorktrees, worktreesByRepo]
  )
}
