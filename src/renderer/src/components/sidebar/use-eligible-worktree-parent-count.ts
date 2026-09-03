import { useMemo } from 'react'
import { useRepoOwners } from '@/store/selectors'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'

export function useEligibleWorktreeParentCount(args: {
  child: Worktree
  enabled: boolean
  worktrees: readonly Worktree[]
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  cyclicLineageIds: ReadonlySet<string>
}): number {
  const { child, enabled, worktrees, lineageById, worktreeMap, cyclicLineageIds } = args
  const repoOwners = useRepoOwners()
  return useMemo(
    () =>
      enabled
        ? getEligibleWorktreeParents({
            child,
            worktrees,
            lineageById,
            worktreeMap,
            repoOwners,
            cyclicLineageIds
          }).length
        : 0,
    [child, cyclicLineageIds, enabled, lineageById, repoOwners, worktreeMap, worktrees]
  )
}
