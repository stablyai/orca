import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { canAssignWorktreeParent } from './worktree-parent-eligibility'
import {
  getCyclicProjectedWorktreeLineageIds,
  type SidebarLineageParentIdentities
} from '../../../../../../shared/sidebar-list/worktree-lineage-projection'
import { lineageStoreKeyOfRow } from '../../../../../../shared/worktree/cross-store-lineage-resolution'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

type ParentCandidateArgs = {
  child: Worktree
  worktrees: readonly Worktree[]
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: ReadonlyMap<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
  cyclicLineageIds?: ReadonlySet<string>
  /** selectSidebarLineageParentIdentities; present only while some store holds a cross-store parent. */
  parentIdentities?: SidebarLineageParentIdentities
}

function getWorktreeOwnerHostId(
  worktree: Worktree,
  repoMap: ReadonlyMap<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
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
  cyclicLineageIds: precomputedCyclicLineageIds,
  parentIdentities
}: ParentCandidateArgs): Worktree[] {
  const childHostId = getWorktreeOwnerHostId(child, repoMap)
  const cyclicLineageIds =
    precomputedCyclicLineageIds ?? getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  const isCrossStoreParent = crossStoreParentEligibility(child, parentIdentities)
  const closesLoop = closesResolvedLoop(child, worktrees, parentIdentities)
  const sameMachine: Worktree[] = []
  const otherMachines: Worktree[] = []
  for (const candidate of worktrees) {
    if (closesLoop(candidate)) {
      continue
    }
    if (
      isEligibleWorktreeParent({
        child,
        candidateParent: candidate,
        lineageById,
        worktreeMap,
        repoMap,
        cyclicLineageIds,
        childHostId
      })
    ) {
      sameMachine.push(candidate)
    } else if (isCrossStoreParent(candidate)) {
      otherMachines.push(candidate)
    }
  }
  // The child's own machine first, so the usual parent isn't pushed below other machines' rows.
  return [...sameMachine, ...otherMachines]
}

/** A create-time parent in another Orca store; the create saves a ref to it built from verified ids. */
export function isCrossStoreCreateParent(
  childHostId: ExecutionHostId | undefined,
  candidate: Worktree
): boolean {
  const childStore = lineageStoreKeyOfRow({ id: '', hostId: childHostId })
  const store = lineageStoreKeyOfRow(candidate)
  return (
    childStore !== undefined &&
    store !== undefined &&
    store !== childStore &&
    Boolean(candidate.instanceId)
  )
}

/** Parents in another Orca store; chains may cross any number of machines. */
function crossStoreParentEligibility(
  child: Worktree,
  parentIdentities: SidebarLineageParentIdentities | undefined
): (candidate: Worktree) => boolean {
  const childStore = lineageStoreKeyOfRow(child)
  if (childStore === undefined || !child.instanceId) {
    return () => false
  }
  const currentParent = parentIdentities?.get(getWorktreeHostIdentity(child))
  return (candidate) => {
    const store = lineageStoreKeyOfRow(candidate)
    return (
      store !== undefined &&
      store !== childStore &&
      !candidate.isArchived &&
      Boolean(candidate.instanceId) &&
      getWorktreeHostIdentity(candidate) !== currentParent
    )
  }
}

/** A candidate already nested under the child in the resolved parent map would close a loop. */
function closesResolvedLoop(
  child: Worktree,
  worktrees: readonly Worktree[],
  parentIdentities: SidebarLineageParentIdentities | undefined
): (candidate: Worktree) => boolean {
  if (!parentIdentities) {
    return () => false
  }
  const childIdentity = getWorktreeHostIdentity(child)
  const rowsByIdentity = new Map<string, Worktree>(
    worktrees.map((row) => [getWorktreeHostIdentity(row), row])
  )
  return (candidate) => {
    const seen = new Set<string>()
    let identity: string | undefined = getWorktreeHostIdentity(candidate)
    while (identity !== undefined && !seen.has(identity)) {
      if (identity === childIdentity) {
        return true
      }
      seen.add(identity)
      const parentIdentity = parentIdentities.get(identity)
      identity =
        parentIdentity !== undefined && rowsByIdentity.has(parentIdentity)
          ? parentIdentity
          : undefined
    }
    return false
  }
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
