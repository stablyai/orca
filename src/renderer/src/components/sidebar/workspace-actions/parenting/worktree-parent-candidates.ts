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
  const isCrossStoreParent = crossStoreParentEligibility(child, worktrees, parentIdentities)
  return worktrees.filter(
    (candidate) =>
      isCrossStoreParent(candidate) ||
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

/** A create-time parent in another Orca store; its own store names it when the workspace is created. */
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

/** Parents in another Orca store. Its own store refuses one whose chain already reaches a third
 * store (a loop could close there), so those and the child's own descendants are left out here too. */
function crossStoreParentEligibility(
  child: Worktree,
  worktrees: readonly Worktree[],
  parentIdentities: SidebarLineageParentIdentities | undefined
): (candidate: Worktree) => boolean {
  const childStore = lineageStoreKeyOfRow(child)
  if (childStore === undefined || !child.instanceId) {
    return () => false
  }
  const childIdentity = getWorktreeHostIdentity(child)
  const rowsByIdentity = new Map<string, Worktree>(
    worktrees.map((row) => [getWorktreeHostIdentity(row), row])
  )
  const currentParent = parentIdentities?.get(childIdentity)
  return (candidate) => {
    const store = lineageStoreKeyOfRow(candidate)
    if (
      store === undefined ||
      store === childStore ||
      candidate.isArchived ||
      !candidate.instanceId ||
      getWorktreeHostIdentity(candidate) === currentParent
    ) {
      return false
    }
    const seen = new Set<string>()
    let cursor: Worktree | undefined = candidate
    while (cursor) {
      const identity = getWorktreeHostIdentity(cursor)
      if (identity === childIdentity || seen.has(identity)) {
        return false
      }
      seen.add(identity)
      const parentIdentity = parentIdentities?.get(identity)
      cursor = parentIdentity === undefined ? undefined : rowsByIdentity.get(parentIdentity)
      if (cursor && lineageStoreKeyOfRow(cursor) !== store) {
        return false
      }
    }
    return true
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
