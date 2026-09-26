import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { DelegatedWorktreeEdge } from '../../../../../../shared/worktree/delegated-worktree-edge'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'

export type DelegatedWorktreeNesting = {
  /** Child identity → parent identity, host-qualified on both ends (STA-4343). */
  parentIdentityByChildIdentity: ReadonlyMap<string, string>
  /** Child identity → the worktree whose section the child is rendered in. */
  sectionAnchorByChildIdentity: ReadonlyMap<string, Worktree>
}

const EMPTY_NESTING: DelegatedWorktreeNesting = {
  parentIdentityByChildIdentity: new Map(),
  sectionAnchorByChildIdentity: new Map()
}

/**
 * Which delegated edges the sidebar may actually draw.
 *
 * Git lineage wins wherever it exists: an edge is only a fallback for a card
 * whose real parent cannot be recorded because it sits on another host.
 */
export function resolveDelegatedWorktreeNesting(args: {
  worktrees: readonly Worktree[]
  edges: readonly DelegatedWorktreeEdge[]
  /** Host the runtime that published the edges stamps its own worktrees with. Not the
   *  focused host: focus is a filter over every host's rows, not a claim about the publisher. */
  homeHostId: ExecutionHostId
  /** Parent identity already proven by git lineage, when the row has one. */
  getLineageParentIdentity: (worktree: Worktree) => string | undefined
  /** The row's execution host with the repo fallback applied: a local row carries no `hostId`. */
  resolveHostId: (worktree: Worktree) => ExecutionHostId
}): DelegatedWorktreeNesting {
  const { worktrees, edges, homeHostId, getLineageParentIdentity, resolveHostId } = args
  if (edges.length === 0) {
    return EMPTY_NESTING
  }
  const byIdentity = new Map(
    worktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
  )
  // Edges name hosts the way the dispatching runtime saw them, so they match on resolved hosts;
  // everything returned stays keyed by the raw identity the row builders look up.
  const byEdgeIdentity = new Map<string, Worktree>()
  for (const worktree of worktrees) {
    byEdgeIdentity.set(composeWorktreeHostIdentity(resolveHostId(worktree), worktree.id), worktree)
  }
  for (const worktree of worktrees) {
    // An SSH worktree reached through a paired runtime keeps its `ssh:` host, but the
    // dispatch that created it recorded the runtime.
    if (worktree.runtimeOwnerEnvironmentId) {
      const alias = composeWorktreeHostIdentity(
        toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId),
        worktree.id
      )
      if (!byEdgeIdentity.has(alias)) {
        byEdgeIdentity.set(alias, worktree)
      }
    }
  }
  const parentIdentityByChildIdentity = new Map<string, string>()
  const sectionAnchorByChildIdentity = new Map<string, Worktree>()
  for (const edge of edges) {
    const child = byEdgeIdentity.get(
      composeWorktreeHostIdentity(edge.childHostId, edge.childWorktreeId)
    )
    if (!child) {
      continue
    }
    const childIdentity = getWorktreeHostIdentity(child)
    if (parentIdentityByChildIdentity.has(childIdentity) || getLineageParentIdentity(child)) {
      continue
    }
    // The coordinator's worktree belongs to the runtime that published the edge.
    const parent = byEdgeIdentity.get(
      composeWorktreeHostIdentity(homeHostId, edge.parentWorktreeId)
    )
    if (!parent || parent === child) {
      continue
    }
    const parentIdentity = getWorktreeHostIdentity(parent)
    if (
      reachesDescendant({
        fromIdentity: parentIdentity,
        targetIdentity: childIdentity,
        byIdentity,
        parentIdentityByChildIdentity,
        getLineageParentIdentity
      })
    ) {
      continue
    }
    parentIdentityByChildIdentity.set(childIdentity, parentIdentity)
    sectionAnchorByChildIdentity.set(childIdentity, parent)
  }
  return { parentIdentityByChildIdentity, sectionAnchorByChildIdentity }
}

/** Walks git lineage and delegated edges together: a cycle through both still hangs the emitter. */
function reachesDescendant(args: {
  fromIdentity: string
  targetIdentity: string
  byIdentity: ReadonlyMap<string, Worktree>
  parentIdentityByChildIdentity: ReadonlyMap<string, string>
  getLineageParentIdentity: (worktree: Worktree) => string | undefined
}): boolean {
  const { fromIdentity, targetIdentity, byIdentity, parentIdentityByChildIdentity } = args
  const visited = new Set<string>()
  let cursor: string | undefined = fromIdentity
  while (cursor && !visited.has(cursor)) {
    if (cursor === targetIdentity) {
      return true
    }
    visited.add(cursor)
    const worktree = byIdentity.get(cursor)
    cursor =
      parentIdentityByChildIdentity.get(cursor) ??
      (worktree ? args.getLineageParentIdentity(worktree) : undefined)
  }
  return false
}
