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
  repoOwners: ReadonlyMap<string, readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]>
  cyclicLineageIds?: ReadonlySet<string>
}

function getWorktreeOwnerHostId(
  worktree: Worktree,
  repoOwners: ParentCandidateArgs['repoOwners']
): string | null {
  if (worktree.hostId !== undefined) {
    return worktree.hostId
  }
  const owners = repoOwners.get(worktree.repoId) ?? []
  return owners.length === 1 ? getWorktreeExecutionHostId(worktree, owners[0]) : null
}

/** Lists valid parent targets within the child's effective execution-host boundary. */
export function getEligibleWorktreeParents({
  child,
  worktrees,
  lineageById,
  worktreeMap,
  repoOwners,
  cyclicLineageIds: precomputedCyclicLineageIds
}: ParentCandidateArgs): Worktree[] {
  const childHostId = getWorktreeOwnerHostId(child, repoOwners)
  const cyclicLineageIds =
    precomputedCyclicLineageIds ?? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  return worktrees.filter((candidate) =>
    isEligibleWorktreeParent({
      child,
      candidateParent: candidate,
      lineageById,
      worktreeMap,
      repoOwners,
      cyclicLineageIds,
      childHostId
    })
  )
}

/** Whether one candidate can become the child's parent without violating lineage invariants. */
export function isEligibleWorktreeParent({
  child,
  candidateParent,
  lineageById,
  worktreeMap,
  repoOwners,
  cyclicLineageIds,
  childHostId = getWorktreeOwnerHostId(child, repoOwners)
}: Omit<ParentCandidateArgs, 'worktrees'> & {
  candidateParent: Worktree
  childHostId?: string | null
}): boolean {
  return (
    childHostId !== null &&
    getWorktreeOwnerHostId(candidateParent, repoOwners) === childHostId &&
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
