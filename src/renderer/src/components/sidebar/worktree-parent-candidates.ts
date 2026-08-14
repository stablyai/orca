import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import { sharesResolvedWorktreeLineageBoundary } from '../../../../shared/resolved-worktree-lineage'
import type { Repo, Worktree, WorktreeLineage } from '../../../../shared/types'
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

function getWorktreeOwnerHostId(
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
  return (
    // Why: the shared boundary is the authority, but repo-derived host resolution is
    // stricter than its raw hostId, so both must agree before offering a parent the
    // runtime would then reject.
    sharesResolvedWorktreeLineageBoundary(child, candidateParent) &&
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
