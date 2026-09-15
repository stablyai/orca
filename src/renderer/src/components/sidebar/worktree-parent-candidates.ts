import { getWorktreeLineageRuntimeOwner } from '../../../../shared/resolved-worktree-lineage'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { canAssignWorktreeParent } from './worktree-parent-eligibility'
import { getCyclicProjectedWorktreeLineageIds } from './worktree-lineage-projection'
import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'

type ParentCandidateArgs = {
  child: Worktree
  worktrees: readonly Worktree[]
  lineageById: Record<string, WorktreeLineage>
  worktreeMap: Map<string, Worktree>
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>
  cyclicLineageIds?: ReadonlySet<string>
  repos?: readonly Repo[]
}

export function getWorktreeOwnerHostId(
  worktree: Worktree,
  repoMap: Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>,
  repos?: readonly Repo[]
): string | null {
  if (worktree.hostId) {
    return worktree.hostId
  }
  if (repos) {
    const summary = getRepoHostSummaries(repos).get(worktree.repoId)
    return summary?.count === 1 ? (summary.onlyHostId ?? null) : null
  }
  const repo = repoMap.get(worktree.repoId)
  return repo ? getWorktreeExecutionHostId(worktree, repo) : (worktree.hostId ?? null)
}

const ownerViews = new WeakMap<
  readonly Worktree[],
  WeakMap<object, Map<string, Map<string, Worktree>>>
>()

function getOwnerView(
  args: ParentCandidateArgs,
  childHostId: string | null
): Map<string, Worktree> {
  let byCatalog = ownerViews.get(args.worktrees)
  if (!byCatalog) {
    byCatalog = new WeakMap()
    ownerViews.set(args.worktrees, byCatalog)
  }
  const catalog = args.repos ?? args.repoMap
  let byHost = byCatalog.get(catalog)
  if (!byHost) {
    byHost = new Map()
    byCatalog.set(catalog, byHost)
  }
  const key = JSON.stringify([childHostId, getWorktreeLineageRuntimeOwner(args.child)])
  const cached = byHost.get(key)
  if (cached) {
    return cached
  }
  const view = new Map(
    args.worktrees
      .filter(
        (worktree) =>
          getWorktreeOwnerHostId(worktree, args.repoMap, args.repos) === childHostId &&
          getWorktreeLineageRuntimeOwner(worktree) === getWorktreeLineageRuntimeOwner(args.child)
      )
      .map((worktree) => [worktree.id, worktree])
  )
  byHost.set(key, view)
  return view
}

export function getEligibleWorktreeParents({
  child,
  worktrees,
  lineageById,
  worktreeMap,
  repoMap,
  repos
}: ParentCandidateArgs): Worktree[] {
  const childHostId = getWorktreeOwnerHostId(child, repoMap, repos)
  worktreeMap = getOwnerView(
    { child, worktrees, lineageById, worktreeMap, repoMap, repos },
    childHostId
  )
  const cyclicLineageIds = getCyclicProjectedWorktreeLineageIds(lineageById, worktreeMap)
  return worktrees.filter((candidate) =>
    isEligibleWorktreeParent({
      child,
      candidateParent: candidate,
      lineageById,
      worktreeMap,
      repoMap,
      repos,
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
  repos,
  cyclicLineageIds,
  childHostId = getWorktreeOwnerHostId(child, repoMap, repos)
}: Omit<ParentCandidateArgs, 'worktrees'> & {
  candidateParent: Worktree
  childHostId?: string | null
}): boolean {
  return (
    childHostId !== null &&
    getWorktreeOwnerHostId(candidateParent, repoMap, repos) === childHostId &&
    getWorktreeLineageRuntimeOwner(candidateParent) === getWorktreeLineageRuntimeOwner(child) &&
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
