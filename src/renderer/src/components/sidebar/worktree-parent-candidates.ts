import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { canAssignWorktreeParent } from './worktree-parent-eligibility'
import { getCyclicProjectedWorktreeLineageIds } from './worktree-lineage-projection'

type ParentCandidateArgs = {
  child: Worktree
  worktrees: readonly Worktree[]
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
  cyclicLineageIds?: ReadonlySet<string>
}

export function getWorktreeOwnerHostId(
  worktree: Worktree,
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
): string | null {
  const repo = repoMap.get(worktree.repoId)
  return repo ? getWorktreeExecutionHostId(worktree, repo) : (worktree.hostId ?? null)
}

export function getEligibleWorktreeParents({
  child,
  worktrees,
  lineageById,
  worktreeMap,
  repoMap,
  cyclicLineageIds: precomputedCyclicLineageIds
}: ParentCandidateArgs): Worktree[] {
  const childHostId = getWorktreeOwnerHostId(child, repoMap)
  const cyclicLineageIds =
    precomputedCyclicLineageIds ?? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  return worktrees.filter((candidate) =>
    isEligibleWorktreeParent({
      child,
      candidateParent: candidate,
      lineageById,
      worktreeMap,
      repoMap,
      cyclicLineageIds,
      childHostId
    })
  )
}

export function isEligibleWorktreeParent({
  child,
  candidateParent,
  lineageById,
  worktreeMap,
  repoMap,
  cyclicLineageIds,
  childHostId = getWorktreeOwnerHostId(child, repoMap)
}: Omit<ParentCandidateArgs, 'worktrees'> & {
  candidateParent: Worktree
  childHostId?: string | null
}): boolean {
  // Why not the shared boundary: it treats an unknown host as a wildcard, but here each side's
  // owning repo resolves the host, so an unresolved one is ineligible rather than matching.
  return (
    childHostId !== null &&
    getWorktreeOwnerHostId(candidateParent, repoMap) === childHostId &&
    !candidateParent.isArchived &&
    canAssignWorktreeParent({
      child,
      candidateParent,
      lineageById,
      worktreeMap,
      cyclicLineageIds
    })
  )
}
