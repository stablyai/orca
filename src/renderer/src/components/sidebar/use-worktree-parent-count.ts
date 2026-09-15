import { useMemo } from 'react'
import { getEligibleWorktreeParents } from './worktree-parent-candidates'

export function useWorktreeParentCount(
  enabled: boolean,
  {
    child,
    worktrees,
    lineageById,
    worktreeMap,
    repoMap,
    repos,
    cyclicLineageIds
  }: Parameters<typeof getEligibleWorktreeParents>[0]
): number {
  return useMemo(
    () =>
      enabled
        ? getEligibleWorktreeParents({
            child,
            worktrees,
            lineageById,
            worktreeMap,
            repoMap,
            repos,
            cyclicLineageIds
          }).length
        : 0,
    [enabled, child, worktrees, lineageById, worktreeMap, repoMap, repos, cyclicLineageIds]
  )
}
